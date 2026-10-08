// Jupyter 解释器探测(Phase 0)
//
// 为什么这个模块必须单独存在,而不是复用 python-kernel.ts 的 resolvePythonInterpreter():
//   现有探测是为「跑单个脚本 / 跑 syfe-kernel.py」设计的 —— 任何 Python 3 都能胜任,
//   所以它的候选顺序是「绝对路径 → PATH 上第一个 python」,拿不到再报「未找到 Python」。
//
//   而 Jupyter 后端要的是**装了 ipykernel 的那个 Python**,这是完全不同的判据:
//   实测本机 PATH 上第一个 python(某个隔离运行时自带)连 zmq 都没有,import jupyter_client
//   直接 ModuleNotFoundError;真正可用的那个装在 D:\programs\anaconda3,却因为排在 PATH
//   更靠后的位置,按现有逻辑永远轮不到它。
//
//   两者混用会导致一个极难归因的故障:Jupyter 后端静默起不来 → 被当成「没装所以不用」→
//   悄悄退回内置内核 → 用户只看到「切换内核没反应」。所以这里刻意与现有函数零耦合,
//   各管各的,互不影响。
//
// 判据:实际 spawn 一次 `-c "import ipykernel"`,能被 import 才算数。
//   不靠猜路径,因为 conda / vfox / scoop / uv 各有各的布局,枚举不完。
//
// 与方案 A 的关系:选了 Node 侧直连 zmq 后,Python 侧只需要能拉起
//   `python -m ipykernel_launcher -f connection.json`,所以 ipykernel 是硬性要求;
//   jupyter_client 用于列 kernelspec(它其实是 ipykernel 的依赖,通常一起存在)。

import {getNativeRequire, NativeRequire} from "../native-require";

/** stdout 里标识结果 JSON 的前缀 —— 第三方告警可能混进 stdout,靠前缀精确定位 */
const SENTINEL = "__SYFE_JUPYTER_JSON__";

/** 单次探测的默认超时。起解释器 + import 一般在 1s 内,给足余量但不至于卡住 UI */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** 一次成功探测的结果 */
export interface JupyterInterpreter {
    /** 可执行文件路径或 PATH 命令名 */
    cmd: string;
    /** 附加参数(例如 Windows py.exe 的 -3) */
    args: string[];
    /** 探测来源,报错时用于归因(例如 "PATH:D:\\programs\\anaconda3") */
    source: string;
    pythonVersion?: string;
    ipykernelVersion?: string;
    jupyterClientVersion?: string;
    /** sys.prefix —— kernelspec 搜索路径之一(<prefix>/share/jupyter/kernels) */
    sysPrefix?: string;
    /** site.getuserbase() —— 另一个 kernelspec 根目录(<userbase>/share/jupyter/kernels) */
    userbase?: string;
}

/** kernelspec 列表项 */
export interface KernelSpecInfo {
    name: string;
    resourceDir: string;
    displayName: string;
    language: string;
}

export interface ResolveOptions {
    /** 忽略缓存重新探测。用户改了默认 Python 之后应传 true */
    refresh?: boolean;
    /** 用户显式指定的解释器路径(插件设置项),优先级最高 */
    explicit?: string;
    timeoutMs?: number;
}

interface Candidate {
    cmd: string;
    args: string[];
    source: string;
}

// ===== 候选收集 =====

function existsFile(req: NativeRequire, p: string): boolean {
    try {
        const fs = req("fs") as typeof import("fs");
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

/**
 * 扫 PATH 的每个条目,找出其中自带 python 的那些。
 *
 * 这是本机最有效的一条线索:conda 安装时会把自己的根目录整条塞进 PATH
 * (本机就是 /d/programs/anaconda3),直接 join("python.exe") 即可命中,
 * 不需要知道它是 conda、vfox 还是 uv 装的。
 */
function candidatesFromPath(req: NativeRequire, pathMod: typeof import("path")): Candidate[] {
    const rawPath = process.env.PATH || "";
    const out: Candidate[] = [];
    const names = process.platform === "win32" ? ["python.exe"] : ["python3", "python"];

    for (const entry of rawPath.split(pathMod.delimiter)) {
        if (!entry) continue;
        // Windows 上 PATH 条目偶尔带引号导致 join 结果无效,顺手去掉
        const clean = entry.replace(/^"|"$/g, "");
        if (!clean) continue;
        for (const name of names) {
            const full = pathMod.join(clean, name);
            if (existsFile(req, full)) {
                out.push({cmd: full, args: [], source: `PATH:${clean}`});
                break; // 一个目录只需一个解释器
            }
        }
    }
    return out;
}

/** conda 专项线索:CONDA_EXE(<root>/Scripts/conda.exe)与 CONDA_PREFIX */
function candidatesFromCondaEnv(req: NativeRequire, pathMod: typeof import("path")): Candidate[] {
    const out: Candidate[] = [];
    const pushRoot = (root: string, why: string) => {
    const cmd = process.platform === "win32"
        ? pathMod.join(root, "python.exe")
        : pathMod.join(root, "bin", "python3");
        if (existsFile(req, cmd)) out.push({cmd, args: [], source: `${why}:${root}`});
    };

    const condaExe = process.env.CONDA_EXE;
    if (condaExe) {
        // <root>/Scripts/conda.exe → <root>
        pushRoot(pathMod.dirname(pathMod.dirname(condaExe)), "CONDA_EXE");
    }
    if (process.env.CONDA_PREFIX) pushRoot(process.env.CONDA_PREFIX, "CONDA_PREFIX");
    // conda activate 后会把当前环境的 bin/Scripts 放进来
    const condaPrefixes = [process.env.CONDA_PREFIX_1, process.env.CONDA_PREFIX_2].filter(Boolean) as string[];
    for (const p of condaPrefixes) pushRoot(p, "CONDA_PREFIX_N");
    return out;
}

/** 常见安装根目录兜底(用户没把 python 放进 PATH 的情况) */
function candidatesFromStandardRoots(req: NativeRequire, pathMod: typeof import("path")): Candidate[] {
    const out: Candidate[] = [];
    const isWin = process.platform === "win32";
    const roots: Array<{base: string; sub: string[]}> = [];

    if (isWin) {
        const home = process.env.USERPROFILE || "";
        const pd = process.env.ProgramData || "";
        for (const base of [home, pd]) {
            if (!base) continue;
            for (const dir of ["anaconda3", "miniconda3"]) roots.push({base, sub: [dir]});
        }
    } else {
        const home = process.env.HOME || "";
        if (home) for (const dir of ["anaconda3", "miniconda3"]) roots.push({base: home, sub: [dir, "bin"]});
        roots.push({base: "/opt", sub: ["conda", "bin"]});
    }

    for (const r of roots) {
        const name = isWin ? "python.exe" : "python3";
        const cmd = pathMod.join(r.base, ...r.sub, name);
        if (existsFile(req, cmd)) out.push({cmd, args: [], source: `ROOT:${r.base}`});
    }

    // Windows py.exe 启动器:它能枚举已安装的 Python 发行版
    if (isWin) {
        const py = pathMod.join(process.env.SystemRoot || "C:\\Windows", "py.exe");
        if (existsFile(req, py)) out.push({cmd: py, args: ["-3"], source: "PY_LAUNCHER"});
    }
    return out;
}

/** 按优先级收集候选并去重 */
function collectCandidates(req: NativeRequire, explicit?: string): Candidate[] {
    const pathMod = req("path") as typeof import("path") | null;
    // 拿不到原生 path 说明当前环境完全没有 Node 集成(例如纯浏览器上下文)。
    // 这里必须优雅降级返回空列表,由上层报「未找到」,而不是让 TypeError 冒出去
    if (!pathMod) return [];
    const ordered: Candidate[] = [];

    if (explicit && existsFile(req, explicit)) {
        ordered.push({cmd: explicit, args: [], source: "EXPLICIT"});
    }

    ordered.push(...candidatesFromCondaEnv(req, pathMod));
    ordered.push(...candidatesFromPath(req, pathMod));
    ordered.push(...candidatesFromStandardRoots(req, pathMod));

    // 裸 PATH 命令兜底:上面的扫描都失败时至少让 spawn 自己去试
    for (const name of ["python3", "python"]) {
        ordered.push({cmd: name, args: [], source: `CMD:${name}`});
    }

    const seen = new Set<string>();
    return ordered.filter((c) => {
        const key = `${c.cmd.toLowerCase()}|${c.args.join(" ")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ===== 执行 Python 并取回 JSON =====

// 为什么要顺手把 sys.prefix / userbase 带回来:kernelspec 的搜索路径里有两个是
// Python 相关的(<prefix>/share/jupyter/kernels 与 <userbase>/share/jupyter/kernels),
// 不知道它们就漏内核。而跑一次 python 要 2 秒以上,绝不能为查路径再起一个进程,
// 所以搭探测的顺风车一次性取回。
const PROBE_SCRIPT = [
    "import json, sys, site",
    "try:",
    "    import ipykernel",
    "    import jupyter_client",
    "except Exception as e:",
    "    sys.stderr.write('IMPORT_FAIL: %r\\n' % (e,))",
    "    sys.exit(97)",
    "try:",
    "    userbase = site.getuserbase()",
    "except Exception:",
    "    userbase = ''",
    "print(" + JSON.stringify(SENTINEL) + " + json.dumps({",
    "    'pythonVersion': sys.version.split()[0],",
    "    'ipykernelVersion': ipykernel.__version__,",
    "    'jupyterClientVersion': jupyter_client.__version__,",
    "    'sysPrefix': sys.prefix,",
    "    'userbase': userbase,",
    "}))",
].join("\n");

const LIST_SPECS_SCRIPT = [
    "import json, sys",
    "from jupyter_client.kernelspec import KernelSpecManager",
    "try:",
    "    m = KernelSpecManager()",
    "    specs = []",
    "    for name, resource_dir in sorted(m.find_kernel_specs().items()):",
    "        try:",
    "            s = m.get_kernel_spec(name)",
    "            display, lang = s.display_name, s.language",
    "        except Exception:",
    "            display, lang = name, ''",
    "        specs.append({'name': name, 'resourceDir': resource_dir, 'displayName': display, 'language': lang})",
    "    print(" + JSON.stringify(SENTINEL) + " + json.dumps(specs))",
    "except Exception as e:",
    "    sys.stderr.write('SPECS_FAIL: %r\\n' % (e,))",
    "    sys.exit(98)",
].join("\n");

/** spawn 一次 python -c <script>,从 stdout 里取出 SENTINEL 后的 JSON */
function runPythonJson(req: NativeRequire, cand: Candidate, script: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        let child: any;
        try {
            // stdio 的 stdin 必须 ignore:某些 python 构建在 stdin 被 pipe 时
            // 会一直等输入,导致超时而不是快速失败
            child = req("child_process").spawn(cand.cmd, [...cand.args, "-c", script], {
                env: {
                    ...process.env,
                    PYTHONIOENCODING: "utf-8",
                    // 有意**不**设 PYTHONNOUSERSITE:有些环境的包就装在 user site-packages 里,
                    // 设了会把其实可用的解释器误判为不可用
                },
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (e: any) {
            reject(new Error(`启动 ${cand.cmd} 失败: ${e?.message || e}`));
            return;
        }

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
            stdout += d;
        });
        child.stderr.on("data", (d: string) => {
            // stderr 单独收集,绝不混进 stdout —— 那会污染 sentinel 行
            if (stderr.length < 2000) stderr += d;
        });

        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // 已经退出了
            }
            finish(() => reject(new Error(`探测 ${cand.cmd} 超时(${timeoutMs}ms)`)));
        }, timeoutMs);

        child.on("error", (e: any) => {
            finish(() => reject(new Error(`无法执行 ${cand.cmd}: ${e?.message || e}`)));
        });

        child.on("close", (code: number) => {
            finish(() => {
                const line = stdout.split(/\r?\n/).find((l: string) => l.indexOf(SENTINEL) >= 0);
                if (!line) {
                    const hint = (stderr || "").trim().slice(-300);
                    reject(new Error(`${cand.cmd} 无有效输出(退出码 ${code})${hint ? `; stderr: ${hint}` : ""}`));
                    return;
                }
                try {
                    resolve(JSON.parse(line.slice(line.indexOf(SENTINEL) + SENTINEL.length)));
                } catch (e: any) {
                    reject(new Error(`解析 ${cand.cmd} 输出失败: ${e?.message || e}`));
                }
            });
        });
    });
}

// ===== 对外 API =====

let cached: JupyterInterpreter | null = null;
let cacheValid = false;

/** 找一台能跑 Jupyter 的 Python;找不到返回 null */
export async function resolveJupyterInterpreter(opts: ResolveOptions = {}): Promise<JupyterInterpreter | null> {
    if (cacheValid && !opts.refresh && cached) return cached;

    const req = getNativeRequire();
    if (!req) {
        cacheValid = true;
        cached = null;
        return null;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const candidates = collectCandidates(req, opts.explicit);

    // 所有候选**同时探测**,再按优先级取第一个成功的那个。
    // 串行的话失败候选的开销会累加(每个要「起解释器 + import 失败」约 0.8~1s),
    // 本机从 4.9s 降到 3.6s。
    //
    // 注意 3.6s 已经接近理论下限:这个下限由**成功那个解释器自身**的
    // 启动(约 0.8s)+ import jupyter_client(约 2.3s)决定,并行消不掉。
    // 想让第二次以后秒开,唯一的办法是把结果持久化到插件存储(见 ResolveOptions.explicit),
    // 下次直接用上次确认可用的解释器去探测 —— 那是接入 UI 时要做的事,不在本模块职责内。
    // 候选通常只有个位数,同时起几个短命进程是可以接受的。
    const pending = candidates.map((cand) => ({
        cand,
        promise: runPythonJson(req, cand, PROBE_SCRIPT, timeoutMs).catch(() => null),
    }));

    for (const item of pending) {
        const info = await item.promise;
        if (!info) continue;
        const cand = item.cand;
        const result: JupyterInterpreter = {
            cmd: cand.cmd,
            args: cand.args,
            source: cand.source,
            pythonVersion: info?.pythonVersion,
            ipykernelVersion: info?.ipykernelVersion,
            jupyterClientVersion: info?.jupyterClientVersion,
            sysPrefix: info?.sysPrefix || undefined,
            userbase: info?.userbase || undefined,
        };
        cacheValid = true;
        cached = result;
        return result;
    }

    cacheValid = true;
    cached = null;
    return null;
}

/**
 * kernelspec 的搜索目录(复刻 jupyter_core 的搜索顺序)。
 *
 * **顺序即优先级:靠后的覆盖靠前的** —— 这是实测出来的。本机 conda 的
 * `<anaconda3>/share/jupyter/kernels` 和 user-site 的
 * `%APPDATA%\Python\share\jupyter\kernels` 里都有一份 python3,而
 * jupyter_client 实际选中的是后者,所以排在后面的必须赢。
 * 搞反了会静默指向错误的内核,而且两个都能跑 py 语言、很难被发现。
 */
function kernelSearchDirs(interpreter: JupyterInterpreter, pathMod: typeof import("path")): string[] {
    const dirs: string[] = [];
    const push = (p: string) => {
        if (p && dirs.indexOf(p) < 0) dirs.push(p);
    };
    const kernels = (base: string) => pathMod.join(base, "share", "jupyter", "kernels");

    if (interpreter.sysPrefix) push(kernels(interpreter.sysPrefix));
    if (interpreter.userbase) push(kernels(interpreter.userbase));

    // JUPYTER_PATH 环境变量指定的额外搜索根
    const jupyterPath = process.env.JUPYTER_PATH || "";
    for (const entry of jupyterPath.split(pathMod.delimiter)) {
        if (entry) push(pathMod.join(entry.replace(/^"|"$/g, ""), "kernels"));
    }

    if (process.platform === "win32") {
        const appData = process.env.APPDATA || "";
        const pd = process.env.ProgramData || "";
        if (appData) push(pathMod.join(appData, "jupyter", "kernels"));
        if (pd) push(pathMod.join(pd, "jupyter", "kernels"));
    } else {
        const home = process.env.HOME || "";
        const xdg = process.env.XDG_DATA_HOME || (home ? pathMod.join(home, ".local", "share") : "");
        if (xdg) push(pathMod.join(xdg, "jupyter", "kernels"));
        push("/usr/local/share/jupyter/kernels");
        push("/usr/share/jupyter/kernels");
    }
    return dirs;
}

/**
 * Node 侧直接扫目录拿 kernelspec —— **毫秒级,不起任何子进程**。
 *
 * 为什么必须这么干:走 Python 侧 KernelSpecManager 实测要 13 秒
 * (起解释器 import jupyter_client 约 2.3s + find_kernel_specs 扫目录约 6.7s
 * + 逐个 get_kernel_spec 约 1.3s/个)。13 秒放在下拉列表的展开动作里是完全不可用的,
 * 放在插件启动里也会拖慢启动。而这份信息本质是「扫目录 + 读 kernel.json」,
 * Node 自己就能做,没必要付 spawn 的代价。
 */
function listKernelSpecsFs(req: NativeRequire, interpreter: JupyterInterpreter): KernelSpecInfo[] {
    const fs = req("fs") as typeof import("fs");
    const pathMod = req("path") as typeof import("path");
    const found = new Map<string, KernelSpecInfo>();

    for (const dir of kernelSearchDirs(interpreter, pathMod)) {
        let names: string[];
        try {
            if (!fs.existsSync(dir)) continue;
            names = fs.readdirSync(dir);
        } catch {
            continue; // 权限等异常一律跳过这个目录
        }
        for (const name of names) {
            const specDir = pathMod.join(dir, name);
            const jsonPath = pathMod.join(specDir, "kernel.json");
            let displayName = name;
            let language = "";
            try {
                if (fs.existsSync(jsonPath)) {
                    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
                    displayName = String(raw?.display_name || name);
                    language = String(raw?.language || "");
                }
            } catch {
                // kernel.json 损坏或不可读:至少 Name 还能用
            }
            // 后遇到的覆盖先遇到的(见 kernelSearchDirs 的优先级说明)
            found.set(name, {name, resourceDir: specDir, displayName, language});
        }
    }
    return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 列出本机所有 kernelspec。
 *
 * 先走 Node 侧扫目录(毫秒级);拿不到任何结果时才退回 Python 侧的权威实现
 * —— 那条路径慢而且要 30 秒超时保护,只在 Node 侧完全扫不到时兜底。
 */
export async function listKernelSpecs(opts: ResolveOptions = {}): Promise<KernelSpecInfo[]> {
    const interpreter = await resolveJupyterInterpreter(opts);
    const req = getNativeRequire();
    if (!interpreter || !req) return [];

    const fast = listKernelSpecsFs(req, interpreter);
    if (fast.length) return fast;

    try {
        const rows = await runPythonJson(req, interpreter, LIST_SPECS_SCRIPT, opts.timeoutMs ?? 30000);
        if (!Array.isArray(rows)) return [];
        return rows.map((r: any) => ({
            name: String(r?.name ?? ""),
            resourceDir: String(r?.resourceDir ?? ""),
            displayName: String(r?.displayName ?? r?.name ?? ""),
            language: String(r?.language ?? ""),
        }));
    } catch {
        return [];
    }
}

/** 只扫目录、不 spawn,用于 UI 需要立刻出结果的场合 */
export function listKernelSpecsFast(): KernelSpecInfo[] {
    const req = getNativeRequire();
    if (!req || !cached) return [];
    return listKernelSpecsFs(req, cached);
}

/** 用户改了 Python 配置后清缓存,下次调用重新探测 */
export function invalidateJupyterInterpreterCache(): void {
    cacheValid = false;
    cached = null;
}
