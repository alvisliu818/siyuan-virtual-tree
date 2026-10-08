// 内置终端后端:真 PTY 优先(独立 helper 进程),拿不到时回退 child_process.spawn
//
// 为什么不用 child_process 管道(实测结论):
//   管道模式下 PowerShell **不进交互模式**,PSReadLine 不加载,没有行编辑/命令历史/
//   Tab 补全/真彩色,vim、git 交互式子命令、fzf 等都不可用。
//
// 为什么不能在渲染进程里直接用 node-pty(实测,勿改回去):
//   node-pty 在 Windows 上通过 lib/windowsConoutConnection.js **无条件**创建
//   `worker_threads.Worker` 排空 conout socket(源码注释:否则关闭伪控制台时死锁),
//   而 Electron 渲染进程的 V8 platform 不支持创建 Worker,实测抛:
//     Failed to construct 'Worker': The V8 platform used by this instance of Node
//     does not support creating Workers
//   即「模块能 require 成功,但 spawn 必失败」——很容易误判成代码 bug。
//
// 采用方案:用 ELECTRON_RUN_AS_NODE=1 把思源 exe 当纯 Node 运行时拉起 tools/pty-helper.js,
// 那个进程里 worker_threads 与 node-pty 都可用(实测 ANSI 真彩色正常)。通信走 stdio 的按行 JSON,
// 不占端口、不依赖 WebSocket。helper 起不来时回退管道模式,保证开箱即用不破。

import {getNativeRequire} from "../utils/native-require";

export interface BuiltinTerminalSession {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (code: number) => void): void;
    /** 实际使用的后端类型,用于界面提示 */
    backend?: "pty" | "pipe";
}

interface ChildProcessLike {
    stdin: { write(s: string): boolean; end(): void; } | null;
    stdout: { on(event: string, cb: (chunk: Buffer) => void): void; } | null;
    stderr: { on(event: string, cb: (chunk: Buffer) => void): void; } | null;
    on(event: string, cb: (...args: any[]) => void): void;
    kill(signal?: string): void;
    pid: number;
}

// node-pty 预构建二进制与 JS 包装层的候选位置
// node-pty 无法被 webpack 静态打包(原生 .node + 平台相关 prebuilds 目录),
// 因此必须在运行时按绝对路径 require。
const NODE_PTY_CANDIDATES = [
    // 插件目录同级:发布时随包携带
    "node_modules/node-pty",
    // 开发仓库:scripts/ 下装依赖
    "../../scripts/node_modules/node-pty",
];

let nodePtyCache: any | null | undefined;

/**
 * 运行时尝试加载 node-pty。
 * 解析顺序:window.require(思源 Electron 可用)→ 绝对路径拼接候选目录。
 * 成功返回模块对象,失败返回 null(调用方回退管道模式)。
 * 注意:成功结果缓存;失败**不缓存** —— 插件目录全局变量可能在首次检测后才就绪,
 * 缓存 null 会把「时序未到」永久固化成「不可用」。
 */
function loadNodePty(): any | null {
    if (nodePtyCache) return nodePtyCache;

    const req = getNativeRequire();
    if (!req) return null;
    const path = req("path") as typeof import("path");

    // 1) 先试裸包名(若插件目录带了 node_modules)
    try {
        nodePtyCache = req("node-pty");
        return nodePtyCache;
    } catch {
        // 继续尝试绝对路径
    }

    // 2) 绝对路径候选:相对当前插件 index.js 所在目录
    let baseDir = "";
    try {
        // 思源把插件目录挂到 /plugins/<name>/,取当前脚本 URL 反推磁盘目录不可靠,
        // 因此退而用「插件静态资源根」——由调用方注入的全局线索拿。
        baseDir = (window as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
    } catch {
        baseDir = "";
    }
    if (baseDir) {
        for (const cand of NODE_PTY_CANDIDATES) {
            const full = path.resolve(baseDir, cand);
            try {
                if (req("fs").existsSync(full)) {
                    nodePtyCache = req(full);
                    return nodePtyCache;
                }
            } catch {
                // 试下一个
            }
        }
    }
    // 失败不缓存:目录全局可能尚未就绪,下次调用重试
    return null;
}

// Windows shell 探测:返回可执行文件绝对路径,不存在则回退
function whichWindows(req: (m: string) => any, file: string): string | null {
    try {
        const fs = req("fs") as typeof import("fs");
        if (fs.existsSync(file)) return file;
    } catch {
        // ignore
    }
    return null;
}

function sysRoot(): string {
    return (window as any).process?.env?.SystemRoot || "C:\\Windows";
}

// 解析 shell → {cmd, args}
// 注意:PowerShell 必须带 -NoExit,否则 -Command 执行完立刻退出(实测确认);
// 且不能只加 -Command 不加 -NoExit。
function resolveWindowsShell(shell: string, req: (m: string) => any): { cmd: string; args: string[]; name: string } | null {
    const lower = (shell || "").toLowerCase();
    if (lower === "cmd" || lower === "cmd.exe") {
        const comspec = (window as any).process?.env?.ComSpec || `${sysRoot()}\\System32\\cmd.exe`;
        // /Q 关闭回显, /K 保持运行
        return {cmd: comspec, args: ["/Q", "/K"], name: "cmd"};
    }
    if (lower === "pwsh" || lower === "pwsh.exe" || lower === "powershell" || lower === "powershell.exe") {
        // 优先 PowerShell 7(pwsh),回退 Windows PowerShell 5.1
        const pf = (window as any).process?.env?.ProgramFiles || "C:\\Program Files";
        const candidates = lower.startsWith("pwsh")
            ? [`${pf}\\PowerShell\\7\\pwsh.exe`]
            : [
                `${pf}\\PowerShell\\7\\pwsh.exe`,
                `${sysRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
            ];
        for (const c of candidates) {
            const found = whichWindows(req, c);
            if (found) {
                return {
                    cmd: found,
                    // -NoLogo 去横幅, -NoExit 保持交互(关键,否则 -Command 后立即退出)
                    args: ["-NoLogo", "-NoExit"],
                    name: found.toLowerCase().includes("pwsh") ? "pwsh" : "powershell",
                };
            }
        }
        return null;
    }
    if (!shell || shell === "auto") return null; // 交给 auto 分支
    // 当作可执行路径/自定义命令
    return {cmd: shell, args: [], name: shell};
}

function resolveUnixShell(shell: string): { cmd: string; args: string[]; name: string } {
    const lower = (shell || "").toLowerCase();
    if (!shell || shell === "auto") {
        const sh = (window as any).process?.env?.SHELL || "/bin/bash";
        return {cmd: sh, args: ["-l"], name: sh};
    }
    if (lower === "bash") return {cmd: "/bin/bash", args: ["-l"], name: "bash"};
    if (lower === "zsh") return {cmd: "/bin/zsh", args: ["-l"], name: "zsh"};
    if (lower === "sh") return {cmd: "/bin/sh", args: [], name: "sh"};
    return {cmd: shell, args: [], name: shell};
}

// 解析最终要跑的 shell(平台无关)
function resolveShell(shell: string, req: (m: string) => any): { cmd: string; args: string[]; name: string } {
    const isWin = (window as any).process?.platform === "win32";
    if (!isWin) return resolveUnixShell(shell);

    if (!shell || shell === "auto") {
        const pf = (window as any).process?.env?.ProgramFiles || "C:\\Program Files";
        const auto = [
            {f: `${pf}\\PowerShell\\7\\pwsh.exe`, n: "pwsh"},
            {f: `${sysRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, n: "powershell"},
            {f: (window as any).process?.env?.ComSpec || `${sysRoot()}\\System32\\cmd.exe`, n: "cmd"},
        ];
        for (const a of auto) {
            if (whichWindows(req, a.f)) {
                return {
                    cmd: a.f,
                    args: a.n === "cmd" ? ["/Q", "/K"] : ["-NoLogo", "-NoExit"],
                    name: a.n,
                };
            }
        }
        return {cmd: `${sysRoot()}\\System32\\cmd.exe`, args: ["/Q", "/K"], name: "cmd"};
    }
    return resolveWindowsShell(shell, req) || {cmd: `${sysRoot()}\\System32\\cmd.exe`, args: ["/Q", "/K"], name: "cmd"};
}


// ===== helper 客户端:用独立 Node 进程承载 node-pty =====

// 插件目录(由 index.ts 的 onload 注入),helper 与 node-pty 都在它下面
function getPluginDir(): string {
    try {
        return (window as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
    } catch {
        return "";
    }
}

// helper 脚本与 node-pty 是否就位(就位才尝试拉起,避免无谓的进程创建)
function isHelperReady(): boolean {
    const req = getNativeRequire();
    const dir = getPluginDir();
    if (!req || !dir) return false;
    try {
        const fs = req("fs") as typeof import("fs");
        const path = req("path") as typeof import("path");
        return fs.existsSync(path.join(dir, "pty-helper.js"))
            && fs.existsSync(path.join(dir, "node_modules", "node-pty"));
    } catch {
        return false;
    }
}

/**
 * 拉起 pty-helper 子进程,用 stdio 按行 JSON 收发,得到一个真 PTY 会话。
 * 失败(文件缺失/进程起不来)返回 null,由调用方回退管道模式。
 */
// ===== 共享 pty-helper:一个进程承载多个 PTY 会话 =====
// 每个终端各拉一个 helper 的话,新终端要等 Electron 以纯 Node 模式冷启动
// (实测 2-3s,用户感知就是「点 + 之后黑屏等很久」)。常驻复用后:
// 第一个终端付冷启动成本,之后的终端在现成 helper 里开新 PTY,毫秒级。
// helper 侧空闲 5 分钟自动退出,宿主下次用时重新拉起,不会常驻空耗内存。
const SYFE_DEBUG_HOST = true; // 临时调试,验证完删除
interface SharedHelper {
    child: any;
    ready: boolean;
    ptyCallbacks: Map<string, {data?: (d: string) => void; exit?: (c: number) => void}>;
    died: boolean;
}

let sharedHelper: SharedHelper | null = null;
// helper 冷启动失败(退出且从未 ready)后 60s 内不再尝试 helper,直接走管道
let helperBootFailedUntil = 0;

function spawnSharedHelper(): SharedHelper | null {
    const req = getNativeRequire();
    const dir = getPluginDir();
    if (!req || !dir || !isHelperReady()) return null;

    let childProcess: any;
    let pathMod: typeof import("path");
    try {
        childProcess = req("child_process");
        pathMod = req("path") as typeof import("path");
    } catch {
        return null;
    }

    // ELECTRON_RUN_AS_NODE=1 让思源 exe 以纯 Node 模式运行(绕开渲染进程禁 Worker 的限制)
    const execPath = (window as any).process?.execPath;
    if (!execPath) return null;

    const helperPath = pathMod.join(dir, "pty-helper.js");
    const ptyPath = pathMod.join(dir, "node_modules", "node-pty");
    const env = {...(window as any).process?.env, ELECTRON_RUN_AS_NODE: "1"};

    let child: any;
    try {
        child = childProcess.spawn(execPath, [helperPath, ptyPath], {
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch {
        return null;
    }
    if (!child || !child.stdout || !child.stdin) {
        return null;
    }

    const helper: SharedHelper = {
        child,
        ready: false,
        ptyCallbacks: new Map(),
        died: false,
    };
    sharedHelper = helper;

    let pending = "";      // stdout 按行缓冲
    child.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        let idx: number;
        while ((idx = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, idx).trim();
            pending = pending.slice(idx + 1);
            if (!line) continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            const sid = msg.sessionId != null ? String(msg.sessionId) : "";
            const cbs = sid ? helper.ptyCallbacks.get(sid) : undefined;
            switch (msg.type) {
                case "ready":
                    if (!helper.ready) {
                        helper.ready = true;
                    }
                    break;
                case "output":
                    if (SYFE_DEBUG_HOST) console.warn("[syfe-debug] output sid=" + sid + " hasCbs=" + (!!cbs) + " len=" + String(msg.data ?? "").length);
                    if (cbs?.data) cbs.data(String(msg.data ?? ""));
                    break;
                case "exit": {
                    const code = Number(msg.code) || 0;
                    if (cbs?.exit) cbs.exit(code);
                    helper.ptyCallbacks.delete(sid);
                    break;
                }
                case "error":
                    // 会话级错误写进对应终端;helper 级错误没有 sessionId,只能丢给日志
                    if (cbs?.data) {
                        cbs.data(String.fromCharCode(13, 10, 27) + "[31m[helper] " + String(msg.message).replace(/[<>]/g, "") + String.fromCharCode(13, 10));
                    } else {
                        console.warn("[siyuan-file-editor] pty-helper:", msg.message);
                    }
                    break;
                default:
                    break;
            }
        }
    });

    child.stderr.on("data", () => {
        // helper 的 stderr 只用于诊断,不污染终端
    });

    child.on("exit", () => {
        helper.died = true;
        if (sharedHelper === helper) sharedHelper = null;
        // helper 死亡:所有还挂着的 PTY 会话报 exit(tab 会显示已退出),
        // 下一个终端 spawn 时 ensureSharedHelper 会重新拉起
        for (const [, cbs] of helper.ptyCallbacks) {
            if (cbs.exit) cbs.exit(0);
        }
        helper.ptyCallbacks.clear();
    });
    child.on("error", () => {
        helper.died = true;
        if (sharedHelper === helper) sharedHelper = null;
    });
    return helper;
}

function ensureSharedHelper(): SharedHelper | null {
    if (sharedHelper && !sharedHelper.died) return sharedHelper;
    return spawnSharedHelper();
}

// 启动内置终端会话
// shell: shell 别名(cmd/powershell/pwsh/auto)或绝对路径
// cwd: 系统绝对路径(工作目录)
// cols/rows: 终端尺寸
// 优先走 pty-helper 真 PTY;不可用时回退 child_process 管道模式
export function spawnBuiltinTerminal(
    shell: string,
    cwd: string,
    cols: number,
    rows: number,
): BuiltinTerminalSession {
    const req = getNativeRequire();
    if (!req) {
        throw new Error("当前环境不支持 Node 原生模块(非 Electron 桌面端?)");
    }
    const nodeFs = req("fs") as typeof import("fs");

    // 验证 cwd
    let workDir = cwd;
    try {
        const stat = nodeFs.statSync(workDir);
        if (!stat.isDirectory()) {
            workDir = (window as any).process?.cwd() || ".";
        }
    } catch {
        workDir = (window as any).process?.cwd() || ".";
    }

    const resolved = resolveShell(shell, req);
    const {cmd, args} = resolved;

    // 环境变量:TERM 让 shell/子程序输出真彩色与交互式控制序列
    const env = {...(window as any).process?.env};
    env.COLUMNS = String(cols);
    env.LINES = String(rows);
    env.TERM = "xterm-256color";

    // ---- 首选:共享 pty-helper(常驻复用,一个进程承载多个 PTY 会话)----
    const helper = Date.now() < helperBootFailedUntil ? null : ensureSharedHelper();
    if (helper) {
        // 会话对象立即可用:create 命令进 helper 的 stdin 管道,helper 启动完成后处理。
        // 冷启动(首个终端)期间 helper 要 2-3s,写进 xterm 的「正在启动 shell…」负责反馈
        const sessionId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const callbacks: {data?: (d: string) => void; exit?: (c: number) => void} = {};
        helper.ptyCallbacks.set(sessionId, callbacks);
        const sendMsg = (msg: Record<string, unknown>) => {
            try {
                helper.child.stdin.write(JSON.stringify(msg) + "\n");
            } catch {
                // helper 可能已退出(exit 回调会触发)
            }
        };
        sendMsg({type: "create", sessionId, cwd: workDir, cols, rows, shell});
        return {
            backend: "pty",
            write(data: string): void {
                sendMsg({type: "input", sessionId, data});
            },
            resize(c: number, r: number): void {
                sendMsg({type: "resize", sessionId, cols: c, rows: r});
            },
            kill(): void {
                // 只杀自己的 PTY;helper 是共享的,可能有别的终端还活着
                sendMsg({type: "kill", sessionId});
                helper.ptyCallbacks.delete(sessionId);
            },
            onData(cb: (d: string) => void): void {
                callbacks.data = cb;
            },
            onExit(cb: (c: number) => void): void {
                callbacks.exit = cb;
            },
        };
    }

    // ---- 次选:直接在渲染进程 require node-pty ----
    // 当前 Electron 渲染进程禁 worker_threads,这里几乎必然失败;
    // 保留仅为将来 Electron 放开该限制时能自动用上,失败则继续回退管道。
    const pty = loadNodePty();
    if (pty) {
        try {
            const proc = pty.spawn(cmd, args, {
                name: "xterm-256color",
                cols,
                rows,
                cwd: workDir,
                env,
            });
            const ptyListeners: {data?: (d: string) => void; exit?: (c: number) => void} = {};
            proc.onData((d: string) => {
                if (ptyListeners.data) ptyListeners.data(d);
            });
            proc.onExit((e: {exitCode?: number; signal?: number}) => {
                if (ptyListeners.exit) ptyListeners.exit(e?.exitCode ?? e?.signal ?? 0);
            });
            return {
                backend: "pty",
                write(data: string): void {
                    try {
                        proc.write(data);
                    } catch {
                        // 进程可能已退出
                    }
                },
                resize(c: number, r: number): void {
                    // 真 PTY:resize 真正生效,全屏程序与进度条能正确重绘
                    try {
                        proc.resize(c, r);
                    } catch {
                        // 忽略
                    }
                },
                kill(): void {
                    try {
                        proc.kill();
                    } catch {
                        // 忽略
                    }
                },
                onData(cb: (d: string) => void): void {
                    ptyListeners.data = cb;
                },
                onExit(cb: (c: number) => void): void {
                    ptyListeners.exit = cb;
                },
            };
        } catch {
            // node-pty 存在但 spawn 失败(ABI 不匹配/ConPTY 不可用),继续回退管道
        }
    }

    // ---- 回退:child_process 管道(无 PTY)----
    const childProcess = req("child_process") as any;
    let proc: ChildProcessLike;
    try {
        proc = childProcess.spawn(cmd, args, {
            cwd: workDir,
            env,
            shell: false,
            windowsHide: true,
        }) as ChildProcessLike;
    } catch (e: any) {
        throw new Error(`无法启动 ${cmd}: ${e.message}`);
    }

    const listeners: {data?: (data: string) => void; exit?: (code: number) => void} = {};

    // stdout + stderr 合并输出
    if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
            if (listeners.data) listeners.data(chunk.toString());
        });
    }
    if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
            if (listeners.data) listeners.data(chunk.toString());
        });
    }
    proc.on("exit", (code: number) => {
        if (listeners.exit) listeners.exit(code ?? 0);
    });

    return {
        backend: "pipe",
        write(data: string): void {
            try {
                proc.stdin?.write(data);
            } catch {
                // stdin 可能已关闭,忽略
            }
        },
        resize(c: number, r: number): void {
            // 无 PTY,只能靠环境变量 COLUMNS/LINES 影响后续行为
            void c;
            void r;
        },
        kill(): void {
            try {
                proc.kill("SIGTERM");
            } catch {
                // 忽略
            }
            // Windows 上 SIGTERM 可能不够,强制 kill
            try {
                proc.kill();
            } catch {
                // 忽略
            }
        },
        onData(cb: (data: string) => void): void {
            listeners.data = cb;
        },
        onExit(cb: (code: number) => void): void {
            listeners.exit = cb;
        },
    };
}

// 检测内置终端是否可用(渲染进程是否有 Node 集成)
export function isBuiltinTerminalAvailable(): boolean {
    const req = getNativeRequire();
    if (!req) return false;
    try {
        req("child_process");
        return true;
    } catch {
        return false;
    }
}

// 真 PTY 是否可用:pty-helper 就位即可(helper 跑在纯 Node 进程里,不受渲染进程限制)
export function isPtyAvailable(): boolean {
    return isHelperReady();
}

