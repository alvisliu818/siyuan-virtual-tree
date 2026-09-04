// 内置终端后端:直接用 Node.js child_process.spawn 在渲染进程中启动 shell
// 优势:无需外部服务,开箱即用
// 限制:无 PTY,不支持 vim/htop 等全屏交互程序,无真彩色
// 适用场景:日常命令执行、脚本运行、目录操作等

import {getNativeRequire} from "../utils/native-require";

export interface BuiltinTerminalSession {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (code: number) => void): void;
}

interface ChildProcessLike {
    stdin: { write(s: string): boolean; end(): void; } | null;
    stdout: { on(event: string, cb: (chunk: Buffer) => void): void; } | null;
    stderr: { on(event: string, cb: (chunk: Buffer) => void): void; } | null;
    on(event: string, cb: (...args: any[]) => void): void;
    kill(signal?: string): void;
    pid: number;
}

// Windows shell 路径解析(与服务端逻辑一致)
function resolveWindowsShell(shell: string): {cmd: string; args: string[]} {
    const lower = shell.toLowerCase();
    if (lower === "cmd" || lower === "cmd.exe") {
        const sysRoot = (window as any).process?.env?.SystemRoot || "C:\\Windows";
        const cmd = (window as any).process?.env?.ComSpec || `${sysRoot}\\System32\\cmd.exe`;
        // /Q 关闭回显, /K 保持运行
        return {cmd, args: ["/Q", "/K"]};
    }
    if (lower === "powershell" || lower === "powershell.exe") {
        const sysRoot = (window as any).process?.env?.SystemRoot || "C:\\Windows";
        return {cmd: `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ["-NoLogo"]};
    }
    if (lower === "pwsh" || lower === "pwsh.exe") {
        const pf = (window as any).process?.env?.ProgramFiles || "C:\\Program Files";
        return {cmd: `${pf}\\PowerShell\\7\\pwsh.exe`, args: ["-NoLogo"]};
    }
    // 默认视为可执行路径
    return {cmd: shell, args: []};
}

function resolveUnixShell(shell: string): {cmd: string; args: string[]} {
    const lower = shell.toLowerCase();
    if (lower === "bash") return {cmd: "/bin/bash", args: ["--login"]};
    if (lower === "zsh") return {cmd: "/bin/zsh", args: ["--login"]};
    if (lower === "sh") return {cmd: "/bin/sh", args: []};
    return {cmd: shell, args: []};
}

// 启动内置终端会话
// shell: shell 别名(cmd/powershell/pwsh/auto)或绝对路径
// cwd: 系统绝对路径(工作目录)
// cols/rows: 终端尺寸(用于设置环境变量 COLUMNS/LINES)
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
    const childProcess = req("child_process") as any;
    const nodePath = req("path") as typeof import("path");
    const nodeFs = req("fs") as typeof import("fs");

    // 解析 shell
    const isWin = (window as any).process?.platform === "win32";
    let resolvedShell = shell;
    if (!shell || shell === "auto") {
        // 自动检测:Windows 优先 powershell,Unix 用 $SHELL
        if (isWin) {
            const sysRoot = (window as any).process?.env?.SystemRoot || "C:\\Windows";
            const psPath = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
            resolvedShell = nodeFs.existsSync(psPath) ? "powershell" : "cmd";
        } else {
            resolvedShell = (window as any).process?.env?.SHELL || "bash";
        }
    }

    const {cmd, args} = isWin
        ? resolveWindowsShell(resolvedShell)
        : resolveUnixShell(resolvedShell);

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

    // 构造环境变量
    const env = {...(window as any).process?.env};
    env.COLUMNS = String(cols);
    env.LINES = String(rows);
    env.TERM = "xterm-256color";

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
        write(data: string): void {
            try {
                proc.stdin?.write(data);
            } catch {
                // stdin 可能已关闭,忽略
            }
        },
        resize(cols: number, rows: number): void {
            // 无 PTY,只能通过环境变量影响子进程后续行为
            // 已运行的进程无法修改环境变量,这里仅作记录
            // 大多数命令行工具不依赖 COLUMNS/LINES 实时变化
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
