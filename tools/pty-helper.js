/*
 * pty-helper —— 为思源插件提供真 PTY 的独立进程
 *
 * 为什么需要它(实测结论,勿删):
 *   node-pty 在 Windows 上通过 `lib/windowsConoutConnection.js` 无条件创建
 *   `worker_threads.Worker` 来排空 conout socket(注释里写明:否则关闭伪控制台时死锁)。
 *   而 **Electron 渲染进程禁止创建 Worker**(V8 platform 不支持),实测报错:
 *       Failed to construct 'Worker': The V8 platform used by this instance of
 *       Node does not support creating Workers
 *   所以插件渲染进程里直接 require node-pty 必然 spawn 失败。
 *
 *   解决:用 ELECTRON_RUN_AS_NODE=1 把思源 exe 当**纯 Node 运行时**拉起本脚本,
 *   那是完整的 Node 环境(实测 worker_threads 可用、node-pty spawn 成功、有 ANSI 真彩色)。
 *
 * 通信:stdin/stdout 上的「按行 JSON」,不用端口也不用 WebSocket 依赖。
 *   宿主 → helper: {"type":"create","cwd":..,"cols":..,"rows":..,"shell":..}
 *                   {"type":"input","data":".."} / {"type":"resize",..} / {"type":"kill"}
 *   helper → 宿主: {"type":"ready"} / {"type":"output","data":".."} / {"type":"exit","code":n}
 *                   {"type":"error","message":".."}
 *
 * 用法(由插件自动拉起,无需手动):
 *   SiYuan.exe tools/pty-helper.js <node-pty 绝对路径>
 */
"use strict";

const readline = require("readline");
const path = require("path");

// argv[2] 由宿主传入 node-pty 绝对路径(插件目录内);退化到同级 node_modules
const ptyPath = process.argv[2] || path.join(__dirname, "node_modules", "node-pty");

let pty = null;
try {
    pty = require(ptyPath);
} catch (e) {
    send({type: "error", message: `无法加载 node-pty(${ptyPath}): ${e.message}`});
    process.exit(2);
}

let proc = null;

function send(msg) {
    try {
        process.stdout.write(JSON.stringify(msg) + "\n");
    } catch {
        // 宿主已断开
    }
}

// 解析 shell 选择:与插件 builtin-terminal.ts 的规则保持一致
function resolveShell(shell) {
    if (process.platform !== "win32") {
        if (!shell || shell === "auto") return {file: process.env.SHELL || "/bin/bash", args: ["-l"]};
        if (shell === "bash") return {file: "/bin/bash", args: ["-l"]};
        if (shell === "zsh") return {file: "/bin/zsh", args: ["-l"]};
        if (shell === "sh") return {file: "/bin/sh", args: []};
        return {file: shell, args: []};
    }
    const fs = require("fs");
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const exists = (f) => {
        try {
            return fs.existsSync(f);
        } catch {
            return false;
        }
    };
    const lower = (shell || "").toLowerCase();
    const ps51 = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const pwsh7 = `${pf}\\PowerShell\\7\\pwsh.exe`;

    if (!lower || lower === "auto") {
        if (exists(pwsh7)) return {file: pwsh7, args: ["-NoLogo", "-NoExit"]};
        if (exists(ps51)) return {file: ps51, args: ["-NoLogo", "-NoExit"]};
        return {file: process.env.ComSpec || `${sysRoot}\\System32\\cmd.exe`, args: ["/Q", "/K"]};
    }
    if (lower === "cmd" || lower === "cmd.exe") {
        return {file: process.env.ComSpec || `${sysRoot}\\System32\\cmd.exe`, args: ["/Q", "/K"]};
    }
    if (lower === "pwsh" || lower === "pwsh.exe") {
        // 用户显式选了 pwsh:装了就用,没装退回 5.1(插件侧已在选择前探测,这里兜底)
        return exists(pwsh7)
            ? {file: pwsh7, args: ["-NoLogo", "-NoExit"]}
            : {file: ps51, args: ["-NoLogo", "-NoExit"]};
    }
    if (lower === "powershell" || lower === "powershell.exe") {
        return exists(pwsh7)
            ? {file: pwsh7, args: ["-NoLogo", "-NoExit"]}
            : {file: ps51, args: ["-NoLogo", "-NoExit"]};
    }
    return {file: shell, args: []};
}

function createSession(msg) {
    if (proc) {
        try {
            proc.kill();
        } catch {
            // ignore
        }
        proc = null;
    }
    const {file, args} = resolveShell(msg.shell);
    const cols = Number(msg.cols) || 80;
    const rows = Number(msg.rows) || 24;
    const env = Object.assign({}, process.env, {
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
    });
    try {
        proc = pty.spawn(file, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: msg.cwd || process.cwd(),
            env,
        });
    } catch (e) {
        send({type: "error", message: `pty.spawn 失败: ${e.message}`});
        return;
    }
    proc.onData((d) => send({type: "output", data: d}));
    proc.onExit((e) => {
        proc = null;
        send({type: "exit", code: (e && e.exitCode) || 0});
    });
    send({type: "ready", shell: file, pid: proc.pid});
}

const rl = readline.createInterface({input: process.stdin});
rl.on("line", (line) => {
    if (!line || !line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    switch (msg.type) {
        case "create":
            createSession(msg);
            break;
        case "input":
            try {
                proc && proc.write(msg.data);
            } catch {
                // 进程可能已退出
            }
            break;
        case "resize":
            try {
                proc && proc.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
            } catch {
                // ignore
            }
            break;
        case "kill":
            try {
                proc && proc.kill();
            } catch {
                // ignore
            }
            proc = null;
            break;
        case "exit":
            try {
                proc && proc.kill();
            } catch {
                // ignore
            }
            process.exit(0);
            break;
        default:
            break;
    }
});

rl.on("close", () => {
    try {
        proc && proc.kill();
    } catch {
        // ignore
    }
    process.exit(0);
});
