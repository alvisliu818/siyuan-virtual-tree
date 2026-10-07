// 内置终端后端:优先用 node-pty 拿到真 PTY,拿不到时回退 child_process.spawn
//
// 为什么要 node-pty(实测结论,见 tools/_probe-*.js):
//   - child_process 管道模式下 PowerShell **不进交互模式**,PSReadLine 不加载,
//     没有行编辑/命令历史/Tab 补全/真彩色,vim、git 交互式子命令、fzf 等都不可用;
//   - node-pty(Windows 走 ConPTY)实测输出含 ANSI 真彩色与光标控制序列,PSReadLine 正常,
//     中文无乱码(管道模式的中文其实也不乱码,别被用错编码解码的测试误导)。
//
// 代价:node-pty 是原生模块,依赖 electron-rebuild 或匹配的 prebuild 二进制;
// 加载不到时静默回退管道模式,保证「开箱即用」不破。

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
 */
function loadNodePty(): any | null {
    if (nodePtyCache !== undefined) return nodePtyCache;

    const req = getNativeRequire();
    if (!req) {
        nodePtyCache = null;
        return null;
    }
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
    nodePtyCache = null;
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


// 启动内置终端会话
// shell: shell 别名(cmd/powershell/pwsh/auto)或绝对路径
// cwd: 系统绝对路径(工作目录)
// cols/rows: 终端尺寸
// 优先走 node-pty 真 PTY;node-pty 不可用时自动回退 child_process 管道模式
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

    // ---- 优先 node-pty(真 PTY)----
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

// 检测 node-pty 是否可用(真 PTY 可用时才有行编辑/真彩色)
export function isPtyAvailable(): boolean {
    return loadNodePty() !== null;
}

