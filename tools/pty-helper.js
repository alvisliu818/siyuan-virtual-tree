/*
 * pty-helper —— 为思源插件提供真 PTY / 任意子进程的独立进程
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
 *   顺带好处:同一个 helper 也能 spawn 任意子进程(Python 内核、LSP server),
 *   走的是完全一样的通道,不必再写第二个 helper。
 *
 * 两类会话(用 sessionId 区分,可共存):
 *   [pty]真 PTY,用于终端:
 *     宿主 → helper: {"type":"create","cwd":..,"cols":..,"rows":..,"shell":..}
 *       {"type":"input","data":".."} / {"type":"resize",..} / {"type":"kill"}
 *     helper → 宿主: {"type":"ready"} / {"type":"output","data":".."} / {"type":"exit","code":n}
 *
 *   [raw]普通子进程(管道),用于 Python 内核 / LSP:
 *     宿主 → helper: {"type":"spawn","sessionId":"..","cmd":"python","args":[..],"cwd":..,"env":{..}}
 *       {"type":"stdin","sessionId":"..","data":".."}   (UTF-8 字符串)
 *       {"type":"stdinRaw","sessionId":"..","base64":".."} (LSP 用,避免 JSON 转义破协议)
 *     helper → 宿主: {"type":"spawned","sessionId":"..","pid":n}
 *       {"type":"stdout","sessionId":"..","data":".."} / {"type":"stderr","sessionId":"..","data":".."}
 *       {"type":"exit","sessionId":"..","code":n}
 *       全部消息都带 sessionId 回显;不带 sessionId 的沿用旧 PTY 语义(单会话)
 *
 * 用法(由插件自动拉起,无需手动):
 *   SiYuan.exe tools/pty-helper.js <node-pty 绝对路径>
 */
"use strict";

const readline = require("readline");
const path = require("path");
const {spawn} = require("child_process");

// 临时调试日志(排查多会话路由,验证完删除)
const dbgLog = "E:\\HOME\\Local\\_siyuan-debug\\pty-helper-debug.log";
function dbg(m) {
    try {
        require("fs").appendFileSync(dbgLog, new Date().toISOString() + " " + m + "\n");
    } catch {
        // ignore
    }
}
dbg("boot pid=" + process.pid + " ptyPath=" + (process.argv[2] || ""));

// argv[2] 由宿主传入 node-pty 绝对路径(插件目录内);退化到同级 node_modules
const ptyPath = process.argv[2] || path.join(__dirname, "node_modules", "node-pty");

let pty = null;
try {
    pty = require(ptyPath);
} catch (e) {
    // node-pty 缺失不致命:raw 会话(Python 内核 / LSP)不依赖它,
    // 只有终端功能会退化。宿主侧会根据 ready 消息里 hasPty 决定要不要提示。
    send({type: "error", message: `无法加载 node-pty(${ptyPath}): ${e.message}`});
}

let proc = null;   // 旧协议的单会话 PTY(仅兼容 legacy 调用方,新代码用 ptySessions)

// PTY 会话表:sessionId -> {proc} —— 一个 helper 承载多个终端,
// 避免「每开一个终端都冷启动一个 Electron-as-Node 进程(实测 2-3s)」
const ptySessions = new Map();
let ptySeq = 0;

// raw 子进程表: sessionId -> {proc, exited}
const rawSessions = new Map();
let rawSeq = 0;

function send(msg) {
    try {
        process.stdout.write(JSON.stringify(msg) + "\n");
    } catch (e) {
        try {
            require("fs").appendFileSync(dbgLog, new Date().toISOString() + " SEND FAIL: " + e.message + "\n");
        } catch {
            // ignore
        }
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
    // 多会话:同一 helper 可承载多个终端;不传 sessionId 视为 "default"(旧协议兼容)
    const sessionId = String(msg.sessionId || "default");
    const old = ptySessions.get(sessionId);
    if (old) {
        try {
            old.proc.kill();
        } catch {
            // ignore
        }
        ptySessions.delete(sessionId);
    }
    const {file, args} = resolveShell(msg.shell);
    const cols = Number(msg.cols) || 80;
    const rows = Number(msg.rows) || 24;
    const env = Object.assign({}, process.env, {
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
    });
    let p;
    try {
        p = pty.spawn(file, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: msg.cwd || process.cwd(),
            env,
        });
    } catch (e) {
        send({type: "error", sessionId, message: `pty.spawn 失败: ${e.message}`});
        return;
    }
    const entry = {proc: p};
    ptySessions.set(sessionId, entry);
    dbg(`create sid=${sessionId} file=${file} pid=${p.pid}`);
    let outLogged = 0;
    p.onData((d) => {
        if (outLogged < 3) {
            dbg(`onData sid=${sessionId} len=${d.length}`);
            outLogged++;
        }
        send({type: "output", sessionId, data: d});
    });
    p.onExit((e) => {
        ptySessions.delete(sessionId);
        send({type: "exit", sessionId, code: (e && e.exitCode) || 0});
    });
    send({type: "ready", sessionId, shell: file, pid: p.pid, hasPty: true});
}

// ===== raw 子进程(管道模式):Python 内核 / LSP server=====
// 不用 PTY:LSP 的 stdio 是干净的字节流,套 PTY 会插入 CRLF 转换把协议搞坏。
// Python 内核同理——它靠 stdin/stdout 传 JSON,任何额外字节都是协议污染。
function spawnRaw(msg) {
    const sessionId = msg.sessionId || `raw${++rawSeq}`;
    // 同 id 重复 spawn:先杀掉旧的,避免僵尸进程堆积
    const old = rawSessions.get(sessionId);
    if (old) {
        try {
            old.proc.kill();
        } catch {
            // ignore
        }
    }

    const cmd = msg.cmd;
    if (!cmd) {
        send({type: "error", sessionId, message: "spawn 缺少 cmd"});
        return;
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    // 默认不注入 shell,避免 Windows 下 cmd 层的引号转义把 LSP 路径搞坏
    const env = Object.assign({}, process.env, msg.env || {});
    let child;
    try {
        child = spawn(cmd, args, {
            cwd: msg.cwd || process.cwd(),
            env,
            shell: !!msg.shell,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (e) {
        send({type: "error", sessionId, message: `spawn ${cmd} 失败: ${e.message}`});
        return;
    }

    const session = {proc: child, exited: false};
    rawSessions.set(sessionId, session);

    // stdout/stderr 按 UTF-8 解码,按块回传(不在 helper 里攒,避免大输出延迟)
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => send({type: "stdout", sessionId, data: d}));
    child.stderr.on("data", (d) => send({type: "stderr", sessionId, data: d}));

    child.on("error", (e) => {
        send({type: "error", sessionId, message: e.message});
    });
    child.on("exit", (code, signal) => {
        session.exited = true;
        send({type: "exit", sessionId, code: code === null ? -1 : code, signal: signal || ""});
        // 保留条目一小会儿,让宿主能区分"刚退出"和"从来没存在过"
        setTimeout(() => rawSessions.delete(sessionId), 30000);
    });

    send({type: "spawned", sessionId, pid: child.pid});
}

function writeRaw(sessionId, data) {
    const s = rawSessions.get(sessionId);
    if (!s || s.exited || !s.proc.stdin || s.proc.stdin.destroyed) return false;
    try {
        s.proc.stdin.write(data);
        return true;
    } catch {
        return false;
    }
}

function killRaw(sessionId, signal) {
    const s = rawSessions.get(sessionId);
    if (!s) return;
    try {
        s.proc.kill(signal || undefined);
    } catch {
        // ignore
    }
    // SIGTERM kill() 在 Windows 上对 python 这类进程偶尔不生效(忽略 signal 参数),
    // 兜底强杀。taskkill /F 只对自己 spawn 出来的 pid 调用,不会波及无关进程。
    if (process.platform === "win32" && !s.exited) {
        try {
            require("child_process").execFileSync("taskkill", ["/pid", String(s.proc.pid), "/T", "/F"], {
                stdio: "ignore",
            });
        } catch {
            // 进程可能已经自己退了
        }
    }
    rawSessions.delete(sessionId);
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
        case "input": {
            const sid = String(msg.sessionId || "default");
            const s = ptySessions.get(sid);
            dbg(`input sid=${sid} found=${!!s} len=${String(msg.data || "").length}`);
            try {
                s && s.proc.write(msg.data);
            } catch {
                // 进程可能已退出
            }
            break;
        }
        case "resize": {
            const sid = String(msg.sessionId || "default");
            const s = ptySessions.get(sid);
            try {
                s && s.proc.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
            } catch {
                // ignore
            }
            break;
        }
        case "kill": {
            const sid = String(msg.sessionId || "default");
            const s = ptySessions.get(sid);
            try {
                s && s.proc.kill();
            } catch {
                // ignore
            }
            ptySessions.delete(sid);
            break;
        }
        // ===== raw 子进程 =====
        case "spawn":
            spawnRaw(msg);
            break;
        case "stdin":
            if (!writeRaw(msg.sessionId, typeof msg.data === "string" ? msg.data : String(msg.data ?? ""))) {
                send({type: "error", sessionId: msg.sessionId, message: "stdin 写入失败(会话不存在或已退出)"});
            }
            break;
        case "stdinRaw":
            // LSP 用:base64 传字节,避免 JSON 字符串转义把 Content-Length 头算错
            try {
                writeRaw(msg.sessionId, Buffer.from(msg.base64 || "", "base64"));
            } catch (e) {
                send({type: "error", sessionId: msg.sessionId, message: `stdinRaw 解码失败: ${e.message}`});
            }
            break;
        case "killRaw":
            killRaw(msg.sessionId, msg.signal);
            break;
        case "exit":
            try {
                proc && proc.kill();
            } catch {
                // ignore
            }
            for (const sid of Array.from(rawSessions.keys())) killRaw(sid);
            process.exit(0);
            break;
        default:
            break;
    }
});

rl.on("close", () => {
    for (const [, s] of ptySessions) {
        try {
            s.proc.kill();
        } catch {
            // ignore
        }
    }
    for (const sid of Array.from(rawSessions.keys())) killRaw(sid);
    process.exit(0);
});

// 空闲自退:没有任何会话持续 5 分钟就退出,宿主下次用时重新拉起。
// 否则关掉所有终端后,一个 200M 的 Electron-as-Node 进程会一直挂着。
let idleChecks = 0;
setInterval(() => {
    const busy = ptySessions.size > 0 || rawSessions.size > 0;
    idleChecks = busy ? 0 : idleChecks + 1;
    if (idleChecks >= 5) process.exit(0);
}, 60000);
