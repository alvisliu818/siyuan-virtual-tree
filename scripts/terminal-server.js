/*
 * 终端服务 - 为 siyuan-file-editor 插件提供 WebSocket 终端后端
 *
 * 使用方法:
 *   Windows: 双击 start-terminal.bat(首次运行自动安装依赖)
 *            或 PowerShell 运行 .\start-terminal.ps1
 *   通用:    node terminal-server.js [--port 9800] [--shell auto]
 *
 * 参数说明:
 *   --port <number>   WebSocket 监听端口,默认 9800
 *   --shell <name>    指定 shell:auto|pwsh|powershell|cmd|<路径>,默认 auto
 *   --host <addr>     监听地址,默认 127.0.0.1(仅本机访问)
 *   --list-shells     列出可用 shell 后退出
 *
 * 协议(JSON 文本帧):
 *   客户端 → 服务端:
 *     {type:"create", cwd:"<系统路径>", cols:80, rows:24, shell:"auto"}  创建终端会话
 *     {type:"input", data:"<字符串>"}                                    发送输入
 *     {type:"resize", cols:80, rows:24}                                 调整尺寸
 *     {type:"kill"}                                                      终止会话
 *   服务端 → 客户端:
 *     {type:"ready"}                                                     会话已创建
 *     {type:"output", data:"<字符串>"}                                   终端输出
 *     {type:"exit", code:<数字>}                                         进程已退出
 *     {type:"error", message:"<字符串>"}                                 错误信息
 */

"use strict";

const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

let WebSocketServer;
try {
    ({WebSocketServer} = require("ws"));
} catch (e) {
    console.error("[terminal-server] 缺少依赖 ws,请先运行: npm install");
    process.exit(1);
}

let pty;
try {
    pty = require("node-pty");
} catch (e) {
    console.error("[terminal-server] 缺少依赖 node-pty,请先运行: npm install");
    console.error("  Windows 可能需要安装 Visual Studio Build Tools:");
    console.error("  npm install --global windows-build-tools");
    process.exit(1);
}

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {port: 9800, host: "127.0.0.1", shell: "auto"};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port" && args[i + 1]) {
            opts.port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === "--host" && args[i + 1]) {
            opts.host = args[i + 1];
            i++;
        } else if (args[i] === "--shell" && args[i + 1]) {
            opts.shell = args[i + 1];
            i++;
        } else if (args[i] === "--list-shells") {
            const shells = detectShells();
            console.log("可用 shell:");
            shells.forEach(s => {
                console.log(`  ${s.name.padEnd(14)} ${s.path}`);
            });
            process.exit(0);
        } else if (args[i] === "--help" || args[i] === "-h") {
            console.log("用法: node terminal-server.js [选项]");
            console.log("");
            console.log("选项:");
            console.log("  --port <number>   WebSocket 监听端口,默认 9800");
            console.log("  --host <addr>     监听地址,默认 127.0.0.1");
            console.log("  --shell <name>    指定 shell:auto|pwsh|powershell|cmd|<路径>");
            console.log("                    auto   自动检测(默认)");
            console.log("                    pwsh   PowerShell 7");
            console.log("                    powershell  Windows PowerShell 5.1");
            console.log("                    cmd    命令提示符");
            console.log("  --list-shells     列出可用 shell 后退出");
            process.exit(0);
        }
    }
    return opts;
}

// 判断文件是否存在
function fileExists(p) {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        try {
            fs.accessSync(p);
            return true;
        } catch {
            return false;
        }
    }
}

// 枚举 Windows 上可用的 shell(按优先级排序)
function detectShells() {
    const result = [];
    if (process.platform === "win32") {
        const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
        // PowerShell 7
        const pf = process.env.ProgramFiles || "C:\\Program Files";
        const pf86 = process.env["ProgramFiles(x86)"] || pf;
        const pwsh7 = path.join(pf, "PowerShell", "7", "pwsh.exe");
        const pwsh7x86 = path.join(pf86, "PowerShell", "7", "pwsh.exe");
        if (fileExists(pwsh7)) result.push({name: "pwsh", path: pwsh7});
        else if (fileExists(pwsh7x86)) result.push({name: "pwsh", path: pwsh7x86});
        // Windows PowerShell 5.1
        const ps51 = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fileExists(ps51)) result.push({name: "powershell", path: ps51});
        // cmd
        const cmd = process.env.ComSpec || path.join(sysRoot, "System32", "cmd.exe");
        if (fileExists(cmd)) result.push({name: "cmd", path: cmd});
        else result.push({name: "cmd", path: cmd});
    } else {
        // Unix
        const shell = process.env.SHELL || "/bin/bash";
        result.push({name: path.basename(shell), path: shell});
        for (const s of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
            if (s !== shell && fileExists(s)) result.push({name: path.basename(s), path: s});
        }
    }
    return result;
}

// 检测默认 shell(取可用列表中的第一个)
function detectShell() {
    const shells = detectShells();
    return shells.length > 0 ? shells[0].path : (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
}

// 解析 shell 参数:支持别名(pwsh/powershell/cmd/auto)或绝对路径
function resolveShell(shellArg) {
    if (!shellArg || shellArg === "auto") {
        return detectShell();
    }
    // 别名匹配
    const lower = shellArg.toLowerCase();
    if (process.platform === "win32") {
        if (lower === "pwsh" || lower === "powershell7" || lower === "ps7") {
            const shells = detectShells();
            const found = shells.find(s => s.name === "pwsh");
            if (found) return found.path;
            console.error(`[terminal-server] 未找到 PowerShell 7,回退到自动检测`);
            return detectShell();
        }
        if (lower === "powershell" || lower === "ps" || lower === "windows-powershell") {
            const shells = detectShells();
            const found = shells.find(s => s.name === "powershell");
            if (found) return found.path;
            console.error(`[terminal-server] 未找到 Windows PowerShell,回退到自动检测`);
            return detectShell();
        }
        if (lower === "cmd" || lower === "cmd.exe") {
            const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
            return process.env.ComSpec || path.join(sysRoot, "System32", "cmd.exe");
        }
    } else {
        if (lower === "bash") return "/bin/bash";
        if (lower === "zsh") return "/bin/zsh";
        if (lower === "sh") return "/bin/sh";
    }
    // 视为绝对路径
    if (fileExists(shellArg)) return shellArg;
    console.error(`[terminal-server] shell 路径不存在: ${shellArg},回退到自动检测`);
    return detectShell();
}

function main() {
    const opts = parseArgs();
    const shellPath = resolveShell(opts.shell);
    const shellName = path.basename(shellPath);
    const availableShells = detectShells();

    const server = http.createServer((req, res) => {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({service: "siyuan-file-editor-terminal", status: "running"}));
    });

    const wss = new WebSocketServer({server});

    wss.on("connection", (ws, req) => {
        let ptyProcess = null;
        let closed = false;
        const clientIP = req.socket.remoteAddress;
        console.log(`[terminal-server] 新连接: ${clientIP}`);

        const send = (obj) => {
            if (closed || ws.readyState !== ws.OPEN) return;
            try {
                ws.send(JSON.stringify(obj));
            } catch {
                // 连接已断开,忽略
            }
        };

        const cleanup = () => {
            if (closed) return;
            closed = true;
            if (ptyProcess) {
                try {
                    ptyProcess.kill();
                } catch {
                    // 进程可能已退出
                }
                ptyProcess = null;
            }
        };

        ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                send({type: "error", message: "无效的 JSON 消息"});
                return;
            }

            switch (msg.type) {
                case "create": {
                    if (ptyProcess) {
                        // 已有会话,先终止
                        try {
                            ptyProcess.kill();
                        } catch {
                            // 忽略
                        }
                        ptyProcess = null;
                    }
                    // 验证 cwd:必须存在且为目录,否则回退到 process.cwd()
                    let cwd = msg.cwd || process.cwd();
                    try {
                        const stat = fs.statSync(cwd);
                        if (!stat.isDirectory()) {
                            console.warn(`[terminal-server] cwd 不是目录: ${cwd},回退到 ${process.cwd()}`);
                            cwd = process.cwd();
                        }
                    } catch {
                        console.warn(`[terminal-server] cwd 路径无效: ${cwd},回退到 ${process.cwd()}`);
                        cwd = process.cwd();
                    }
                    const cols = msg.cols || 80;
                    const rows = msg.rows || 24;
                    // 支持每个会话独立指定 shell(别名或路径),为空则用服务启动时的默认 shell
                    const sessionShell = msg.shell ? resolveShell(msg.shell) : shellPath;
                    try {
                        ptyProcess = pty.spawn(sessionShell, [], {
                            name: "xterm-color",
                            cols: cols,
                            rows: rows,
                            cwd: cwd,
                            env: process.env,
                        });
                    } catch (e) {
                        send({type: "error", message: `无法启动 shell (${sessionShell}): ${e.message}`});
                        return;
                    }
                    ptyProcess.onData((data) => {
                        send({type: "output", data: data});
                    });
                    ptyProcess.onExit(({exitCode}) => {
                        send({type: "exit", code: exitCode});
                        ptyProcess = null;
                    });
                    send({type: "ready"});
                    console.log(`[terminal-server] 会话已创建: ${path.basename(sessionShell)} @ ${cwd}`);
                    break;
                }
                case "input": {
                    if (ptyProcess && typeof msg.data === "string") {
                        try {
                            ptyProcess.write(msg.data);
                        } catch {
                            // 忽略写入失败
                        }
                    }
                    break;
                }
                case "resize": {
                    if (ptyProcess && msg.cols > 0 && msg.rows > 0) {
                        try {
                            ptyProcess.resize(msg.cols, msg.rows);
                        } catch {
                            // 忽略调整失败
                        }
                    }
                    break;
                }
                case "kill": {
                    cleanup();
                    break;
                }
            }
        });

        ws.on("close", () => {
            console.log(`[terminal-server] 连接关闭: ${clientIP}`);
            cleanup();
        });

        ws.on("error", (err) => {
            console.error(`[terminal-server] 连接错误: ${err.message}`);
            cleanup();
        });
    });

    server.listen(opts.port, opts.host, () => {
        console.log("╔════════════════════════════════════════════════════════════╗");
        console.log("║  siyuan-file-editor 终端服务                                ║");
        console.log("╠════════════════════════════════════════════════════════════╣");
        console.log(`║  当前 Shell:  ${shellName.padEnd(45)}║`);
        console.log(`║  路径:        ${shellPath.padEnd(45)}║`);
        console.log("║  可用 Shell:                                                ║");
        availableShells.forEach(s => {
            const line = `    --shell ${s.name.padEnd(10)} → ${s.path}`;
            console.log(`║${line.padEnd(60)}║`);
        });
        console.log(`║  地址:        ws://${opts.host}:${opts.port}`.padEnd(61) + "║");
        console.log("║  按 Ctrl+C 停止服务                                         ║");
        console.log("╚════════════════════════════════════════════════════════════╝");
    });

    // 优雅关闭
    process.on("SIGINT", () => {
        console.log("\n[terminal-server] 正在关闭...");
        wss.clients.forEach((ws) => {
            try {
                ws.close();
            } catch {
                // 忽略
            }
        });
        server.close(() => {
            process.exit(0);
        });
    });

    process.on("SIGTERM", () => {
        server.close();
        process.exit(0);
    });
}

main();
