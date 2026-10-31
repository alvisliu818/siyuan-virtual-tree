// 本机 Python 环境枚举 + 解释器选择菜单
//
// 服务对象:代码智能(basedpyright)的解释器设置(settings.json → python.pythonPath)。
// 场景:项目依赖装在某个 conda 环境(如 ai)里,PATH 上的默认 Python 没有这些包 ——
// pyright 解析不到 import,诊断报 unresolved import、receiver 类型 Unknown,
// 补全退化、语义 token 缺失(method 不着色)。选对环境后 pyright 直接从该解释器的
// site-packages 拿类型,一切恢复。
//
// 设计约束:
//   - 环境枚举必须**毫秒级、纯 fs 扫描**:conda 有标准清单文件
//     ~/.conda/environments.txt(一行一个环境根目录),缺失时用 CONDA_EXE 反推
//     安装根再扫 envs/*。与 kernel/interpreter.ts 的 scanCondaKernelSpecs 思路
//     同源,但那边是给 Jupyter kernelspec 用的,判据不同,互不复用。
//   - 版本展示用 `python --version` 并行探测,单个 2.5s 上限;超时的环境只显示
//     路径,不阻塞菜单。
import {Menu, showMessage} from "siyuan";
import {getNativeRequire} from "./native-require";

/** 一个可选的 Python 环境 */
export interface PythonEnvInfo {
    /** 解释器可执行文件绝对路径(python.pythonPath 需要的就是它) */
    path: string;
    /** 显示名,如 conda:ai / conda:base / python(anaconda3) */
    name: string;
    source: "conda" | "path" | "root";
    /** 版本描述(如 "Python 3.11.9"),探测失败为 null */
    version?: string | null;
}

/** 菜单最多列出多少个环境(异常机器上 PATH 里可能混进一堆存根,截断保底) */
const MAX_ENVS = 12;

/** conda 环境根目录清单(environments.txt 优先,CONDA_EXE 反推兜底) */
function condaEnvRoots(fs: typeof import("fs"), pathMod: typeof import("path")): Array<{root: string; name: string}> {
    const out: Array<{root: string; name: string}> = [];
    // 安装根(CONDA_EXE = <root>\Scripts\conda.exe 的上两级):用于把 base 环境认出来
    let installRoot = "";
    if (process.env.CONDA_EXE) {
        installRoot = pathMod.dirname(pathMod.dirname(process.env.CONDA_EXE));
    }

    const pushRoot = (raw: string) => {
        const root = raw.replace(/^"|"$/g, "").trim();
        if (!root) return;
        const isBase = !!installRoot && root.toLowerCase() === installRoot.toLowerCase();
        out.push({root, name: isBase ? "conda:base" : `conda:${pathMod.basename(root) || "env"}`});
    };

    let lines: string[] = [];
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const envFile = home ? pathMod.join(home, ".conda", "environments.txt") : "";
    try {
        if (envFile && fs.existsSync(envFile)) {
            lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/)
                .map((l: string) => l.trim())
                .filter((l: string) => l && !l.startsWith("#"));
        }
    } catch {
        lines = [];
    }
    for (const l of lines) pushRoot(l);

    // environments.txt 缺失(conda 从未跑过 `conda info` 之类)时才走反推扫描
    if (out.length === 0 && installRoot) {
        pushRoot(installRoot);
        try {
            const envsDir = pathMod.join(installRoot, "envs");
            if (fs.existsSync(envsDir)) {
                for (const n of fs.readdirSync(envsDir)) {
                    pushRoot(pathMod.join(envsDir, n));
                }
            }
        } catch {
            // ignore
        }
    }
    return out;
}

/** 枚举本机 Python 环境(纯 fs,毫秒级;conda 环境在前、base 最前) */
export function listPythonEnvs(): PythonEnvInfo[] {
    const req = getNativeRequire();
    if (!req) return [];
    let fs: typeof import("fs");
    let pathMod: typeof import("path");
    try {
        fs = req("fs") as typeof import("fs");
        pathMod = req("path") as typeof import("path");
    } catch {
        return [];
    }
    const isWin = process.platform === "win32";
    const envExe = (root: string) => pathMod.join(root, isWin ? "python.exe" : pathMod.join("bin", "python3"));
    const out: PythonEnvInfo[] = [];
    const seen = new Set<string>();

    const push = (path: string, name: string, source: PythonEnvInfo["source"]) => {
        try {
            if (!path || out.length >= MAX_ENVS) return;
            if (!fs.existsSync(path)) return;
            // Windows 商店的 python.exe 存根是 0 字节 reparse 点,执行会弹商店;
            // 真解释器至少几百 KB,用大小过滤掉
            if (isWin && (fs.statSync(path).size || 0) === 0) return;
            const key = path.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push({path, name, source});
        } catch {
            // ignore
        }
    };

    // 1) conda 环境(base 在前,其余按名称排)
    const conda = condaEnvRoots(fs, pathMod);
    conda.sort((a, b) => {
        if (a.name === "conda:base") return -1;
        if (b.name === "conda:base") return 1;
        return a.name.localeCompare(b.name);
    });
    for (const c of conda) push(envExe(c.root), c.name, "conda");

    // 2) 常见安装根(没进 environments.txt 的独立 CPython / 其他 conda 安装)
    const home = process.env.USERPROFILE || process.env.HOME || "";
    for (const base of [home, process.env.ProgramData || ""]) {
        if (!base) continue;
        for (const dir of ["anaconda3", "miniconda3"]) {
            const root = pathMod.join(base, dir);
            push(envExe(root), `python(${dir})`, "root");
        }
    }

    // 3) PATH 上的 python(独立安装的 CPython / vfox / scoop 等)
    for (const entry of (process.env.PATH || "").split(pathMod.delimiter)) {
        const clean = entry.replace(/^"|"$/g, "");
        if (!clean) continue;
        push(
            pathMod.join(clean, isWin ? "python.exe" : "python3"),
            `python(${pathMod.basename(clean) || "PATH"})`,
            "path",
        );
    }

    return out;
}

/** 探测解释器版本(`python --version`),2.5s 上限;失败/超时返回 null */
export function probePythonVersion(path: string): Promise<string | null> {
    const req = getNativeRequire();
    if (!req) return Promise.resolve(null);
    return new Promise((resolve) => {
        let child: any;
        try {
            child = req("child_process").spawn(path, ["--version"], {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            resolve(null);
            return;
        }
        let out = "";
        const done = (v: string | null) => {
            clearTimeout(timer);
            resolve(v);
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // 已经退出
            }
            done(null);
        }, 2500);
        child.stdout?.on?.("data", (d: any) => {
            out += String(d);
        });
        child.on("error", () => done(null));
        child.on("close", () => {
            const m = /Python\s+(\S+)/.exec(out);
            done(m ? `Python ${m[1]}` : null);
        });
    });
}

/**
 * 弹出解释器选择菜单(设置面板「Python 解释器」行的「选择」按钮)。
 * 选中后写回 input 并触发 change —— 沿用行控件既有的保存链路
 * (change 监听 → setUserValue → settings.json)。
 */
export async function openPythonEnvPicker(input: HTMLInputElement, anchor: HTMLElement): Promise<void> {
    // 版本并行探测(每个 2.5s 上限,整体约等于最慢那个);菜单内容一次成型
    const envs = await Promise.all(listPythonEnvs().map(async (e) => ({
        ...e,
        version: await probePythonVersion(e.path),
    })));

    const cur = (input.value || "").trim().toLowerCase();
    const menu = new Menu("syfe-python-env");
    const apply = (value: string) => {
        if ((input.value || "") === value) return;
        input.value = value;
        input.dispatchEvent(new Event("change"));
    };

    menu.addItem({
        iconHTML: "",
        label: (cur === "" ? "✓ " : "") + "自动检测(默认)",
        click: () => apply(""),
    });
    if (envs.length) menu.addSeparator();
    for (const e of envs) {
        const isCur = cur === e.path.toLowerCase();
        const ver = e.version ? ` · ${e.version}` : "";
        menu.addItem({
            iconHTML: "",
            label: (isCur ? "✓ " : "") + `${e.name}${ver} · ${e.path}`,
            click: () => apply(e.path),
        });
    }
    menu.addSeparator();
    menu.addItem({
        iconHTML: "",
        label: "手动输入路径…",
        click: () => {
            input.focus();
            showMessage("在输入框粘贴 python 可执行文件的完整路径(如 D:\\programs\\anaconda3\\envs\\ai\\python.exe)", 4000, "info");
        },
    });

    // 菜单贴着按钮下沿弹出;太宽时右缘留出屏幕空间
    const rect = anchor.getBoundingClientRect();
    menu.open({
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 460)),
        y: rect.bottom + 4,
    });
}
