import {openTab} from "siyuan";
import {Terminal} from "@xterm/xterm";
import {FitAddon} from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {TERMINAL_TAB_TYPE, DEFAULT_TERMINAL_SERVER_URL} from "../constants";
import {EditorConfig} from "../types";
import {basename} from "../utils/path";
import {toSystemPath} from "../utils/system-path";
import {getNativeRequire} from "../utils/native-require";
import {spawnBuiltinTerminal, isBuiltinTerminalAvailable, isPtyAvailable, BuiltinTerminalSession} from "../utils/builtin-terminal";

// 终端 Tab 所需的插件接口
export interface IPluginForTerminalTab {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
}

// 终端 Tab 实例上附加的字段
interface TerminalTabInstance {
    element: HTMLElement;
    data: { cwd?: string };
    parent?: { updateTitle?: (t: string) => void; close?: () => void; headElement?: HTMLElement };
    _cwd?: string;
    _term?: Terminal;
    _fit?: FitAddon;
    // 服务模式
    _ws?: WebSocket;
    _reconnectTimer?: number;
    // 内置模式
    _builtinSession?: BuiltinTerminalSession;
    // 通用
    _disposables?: Array<() => void>;
    _resizeObserver?: ResizeObserver;
    _statusEl?: HTMLElement;
    _closed?: boolean;
    _plugin?: IPluginForTerminalTab;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 推断插件在磁盘上的目录,供 node-pty 定位其预构建二进制。
// 思源插件位于 <工作空间>/data/plugins/<插件名>/,而工作空间目录能从
// window.siyuan.config.system.workspaceDir 拿到(真实文件系统路径),据此拼接。
// 拿不到时返回空串,node-pty 加载失败会自动回退管道模式。
function guessPluginDir(): string {
    try {
        const ws = (window as any).siyuan?.config?.system?.workspaceDir;
        if (ws) {
            const req = getNativeRequire();
            const p = req ? (req("path") as typeof import("path")) : null;
            const join = (a: string, b: string) => (p ? p.join(a, b) : `${a}/${b}`);
            return join(ws, join("data", join("plugins", "siyuan-file-editor")));
        }
    } catch {
        // ignore
    }
    return "";
}

// 注:路径转换已抽取到 ../utils/system-path 的 toSystemPath,此处直接复用

// 更新连接状态指示器
function setStatus(self: TerminalTabInstance, status: string, text: string): void {
    if (self._statusEl) {
        self._statusEl.dataset.status = status;
        self._statusEl.textContent = text;
    }
}

// 打开终端 Tab(同工作目录去重)
export function openTerminalTab(plugin: IPluginForTerminalTab, cwd?: string): void {
    const targetCwd = cwd || plugin.config.fileTreeRoot || "/data";
    const opened = plugin.getOpenedTab()[TERMINAL_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.cwd === targetCwd);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + TERMINAL_TAB_TYPE,
            icon: "iconTerminal",
            title: "终端",
            data: {cwd: targetCwd},
        },
    } as any);
}

// 创建终端 Tab 配置
export function createTerminalTabConfig(plugin: IPluginForTerminalTab) {
    return {
        type: TERMINAL_TAB_TYPE,
        init(this: TerminalTabInstance) {
            const siyuanCwd = this.data?.cwd || "/data";
            this._cwd = siyuanCwd;
            this._disposables = [];
            this._closed = false;
            this._plugin = plugin;
            this.element.classList.add("syfe-terminal-tab");

            // 判断后端模式:auto 优先内置(若可用),否则用服务模式
            const backendPref = plugin.config.terminalBackend || "auto";
            const useBuiltin = backendPref === "builtin" || (backendPref === "auto" && isBuiltinTerminalAvailable());
            // 内置模式下再分真 PTY(node-pty)与管道(child_process)两种
            const ptyAvailable = useBuiltin && isPtyAvailable();
            const backendLabel = useBuiltin ? (ptyAvailable ? "PTY" : "管道") : "服务";
            // 注入插件目录,供 node-pty 运行时定位预构建二进制(见 utils/builtin-terminal)
            try {
                (window as any).__SIYUAN_FILE_EDITOR_DIR__ = (window as any).__SIYUAN_FILE_EDITOR_DIR__
                    || guessPluginDir();
            } catch {
                // ignore
            }

            this.element.innerHTML = `
                <div class="syfe-terminal">
                    <div class="syfe-terminal__header">
                        <span class="syfe-terminal__title">${escapeHTML(basename(siyuanCwd) || siyuanCwd)}</span>
                        <span class="syfe-terminal__status" data-status="connecting">连接中...</span>
                        <span class="syfe-terminal__backend">${backendLabel}</span>
                        <span class="fn__flex-1"></span>
                        <span class="block__icon ariaLabel" data-action="restart" aria-label="重启终端" data-position="north">
                            <svg><use xlink:href="#iconRefresh"></use></svg>
                        </span>
                    </div>
                    <div class="syfe-terminal__container"></div>
                </div>`;

            const container = this.element.querySelector(".syfe-terminal__container") as HTMLElement;
            this._statusEl = this.element.querySelector(".syfe-terminal__status") as HTMLElement;

            // 初始化 xterm.js
            const term = new Terminal({
                fontSize: plugin.config.fontSize || 14,
                fontFamily: "Menlo, Consolas, 'Courier New', monospace",
                cursorBlink: true,
                // 仅管道模式需要:shell 输出为 \n,xterm 需要补 \r;
                // 真 PTY 输出自带 \r\n,再补会变成 \r\r\n 产生空行
                convertEol: !ptyAvailable,
                theme: {
                    background: "#1e1e1e",
                    foreground: "#d4d4d4",
                    cursor: "#d4d4d4",
                    cursorAccent: "#1e1e1e",
                    selectionBackground: "#264f78",
                    black: "#000000",
                    red: "#cd3131",
                    green: "#0dbc79",
                    yellow: "#e5e510",
                    blue: "#2472c8",
                    magenta: "#bc3fbc",
                    cyan: "#11a8cd",
                    white: "#e5e5e5",
                    brightBlack: "#666666",
                    brightRed: "#f14c4c",
                    brightGreen: "#23d18b",
                    brightYellow: "#f5f543",
                    brightBlue: "#3b8eea",
                    brightMagenta: "#d670d6",
                    brightCyan: "#29b8db",
                    brightWhite: "#ffffff",
                },
            });
            this._term = term;

            const fit = new FitAddon();
            this._fit = fit;
            term.loadAddon(fit);
            term.open(container);
            try {
                fit.fit();
            } catch {
                // 容器可能还未布局,忽略
            }

            const self = this;
            // 本地引用,避免 self._disposables 的可选属性窄化报错
            const disposables: Array<() => void> = self._disposables || [];
            self._disposables = disposables;

            // 用户输入 → 后端
            const onDataDisp = term.onData(data => {
                if (useBuiltin) {
                    if (self._builtinSession?.backend === "pty") {
                        // 真 PTY:原样发送即可,回车就是 \r(转成 \r\n 会多出空行)
                        self._builtinSession.write(data);
                    } else {
                        // 管道模式:Windows shell(cmd/powershell)按行读 stdin,
                        // 需要把 xterm 的 \r 转成 \r\n 才认为是一次回车
                        const normalized = data.replace(/\r/g, "\r\n");
                        self._builtinSession?.write(normalized);
                    }
                } else if (self._ws && self._ws.readyState === WebSocket.OPEN) {
                    self._ws.send(JSON.stringify({type: "input", data}));
                }
            });
            disposables.push(() => onDataDisp.dispose());

            // 终端尺寸变化 → 通知后端
            const sendResize = () => {
                try {
                    fit.fit();
                } catch {
                    // 忽略
                }
                if (useBuiltin) {
                    self._builtinSession?.resize(term.cols, term.rows);
                } else if (self._ws && self._ws.readyState === WebSocket.OPEN) {
                    self._ws.send(JSON.stringify({type: "resize", cols: term.cols, rows: term.rows}));
                }
            };

            // ResizeObserver 监听容器尺寸变化
            self._resizeObserver = new ResizeObserver(() => {
                sendResize();
            });
            self._resizeObserver.observe(container);
            disposables.push(() => {
                self._resizeObserver?.disconnect();
                self._resizeObserver = undefined;
            });

            // 工具栏事件
            const header = this.element.querySelector(".syfe-terminal__header") as HTMLElement;
            header.addEventListener("click", (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const actionEl = target.closest("[data-action]") as HTMLElement;
                if (!actionEl) return;
                if (actionEl.dataset.action === "restart") {
                    if (useBuiltin) {
                        connectBuiltin(self, true);
                    } else {
                        connectServer(self, true);
                    }
                }
            });

            // 建立连接
            if (useBuiltin) {
                connectBuiltin(self, false);
            } else {
                connectServer(self, false);
            }
        },
        resize(this: TerminalTabInstance) {
            try {
                this._fit?.fit();
                // 内置模式 resize 通过 session 传递
                if (this._builtinSession && this._term) {
                    this._builtinSession.resize(this._term.cols, this._term.rows);
                } else if (this._ws && this._ws.readyState === WebSocket.OPEN && this._term) {
                    this._ws.send(JSON.stringify({type: "resize", cols: this._term.cols, rows: this._term.rows}));
                }
            } catch {
                // 忽略
            }
        },
        destroy(this: TerminalTabInstance) {
            this._closed = true;
            // 清理服务模式 WebSocket
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = undefined;
            }
            if (this._ws) {
                try {
                    if (this._ws.readyState === WebSocket.OPEN) {
                        this._ws.send(JSON.stringify({type: "kill"}));
                    }
                    this._ws.onopen = null;
                    this._ws.onmessage = null;
                    this._ws.onerror = null;
                    this._ws.onclose = null;
                    this._ws.close();
                } catch {
                    // 忽略
                }
                this._ws = undefined;
            }
            // 清理内置模式 session
            if (this._builtinSession) {
                try {
                    this._builtinSession.kill();
                } catch {
                    // 忽略
                }
                this._builtinSession = undefined;
            }
            // 清理 xterm
            this._disposables?.forEach(d => {
                try {
                    d();
                } catch {
                    // 忽略
                }
            });
            this._disposables = [];
            try {
                this._term?.dispose();
            } catch {
                // 忽略
            }
            this._term = undefined;
            this._fit = undefined;
            this._plugin = undefined;
        },
    };
}

// ===== 内置模式:用 child_process.spawn =====
function connectBuiltin(self: TerminalTabInstance, restart: boolean): void {
    // 清理旧会话
    if (self._builtinSession) {
        try {
            self._builtinSession.kill();
        } catch {
            // 忽略
        }
        self._builtinSession = undefined;
    }

    const plugin = self._plugin;
    const shell = plugin?.config?.terminalShell || "auto";
    const workspacePath = plugin?.config?.siyuanWorkspacePath || "";
    const systemCwd = toSystemPath(self._cwd || "/data", workspacePath);
    const cols = self._term?.cols || 80;
    const rows = self._term?.rows || 24;

    setStatus(self, "connecting", "启动中...");

    if (!isBuiltinTerminalAvailable()) {
        setStatus(self, "error", "不可用");
        if (self._term) {
            self._term.write("\r\n\x1b[31m[内置终端不可用:当前环境不支持 Node 原生模块]\x1b[0m\r\n");
            self._term.write("\x1b[90m[请在设置中切换为「服务」模式,并启动外部终端服务]\x1b[0m\r\n");
        }
        return;
    }

    try {
        if (restart && self._term) {
            self._term.clear();
        }
        const session = spawnBuiltinTerminal(shell, systemCwd, cols, rows);
        self._builtinSession = session;

        session.onData(data => {
            if (self._closed) return;
            if (self._term) self._term.write(data);
        });
        session.onExit(code => {
            if (self._closed) return;
            if (self._term) {
                self._term.write(`\r\n\x1b[90m[进程已退出,代码 ${code}]\x1b[0m\r\n`);
            }
            setStatus(self, "exited", "已退出");
            self._builtinSession = undefined;
        });

        setStatus(self, "connected", "已连接");
        if (self._term) {
            const kind = session.backend === "pty"
                ? "真 PTY(支持行编辑/历史/真彩色)"
                : "管道模式(无行编辑,建议启用 node-pty)";
            self._term.write(`\x1b[90m[终端已启动 · ${kind} · shell: ${shell} · cwd: ${systemCwd}]\x1b[0m\r\n`);
        }
    } catch (e: any) {
        setStatus(self, "error", "错误");
        if (self._term) {
            self._term.write(`\r\n\x1b[31m[启动失败: ${escapeHTML(e.message || String(e))}]\x1b[0m\r\n`);
        }
    }
}

// ===== 服务模式:用 WebSocket 连接外部 terminal-server =====
function connectServer(self: TerminalTabInstance, restart: boolean): void {
    // 清理旧连接
    if (self._ws) {
        try {
            self._ws.onopen = null;
            self._ws.onmessage = null;
            self._ws.onerror = null;
            self._ws.onclose = null;
            if (self._ws.readyState === WebSocket.OPEN || self._ws.readyState === WebSocket.CONNECTING) {
                self._ws.close();
            }
        } catch {
            // 忽略
        }
        self._ws = undefined;
    }
    if (self._reconnectTimer) {
        clearTimeout(self._reconnectTimer);
        self._reconnectTimer = undefined;
    }

    const plugin = self._plugin;
    const serverUrl = plugin?.config?.terminalServerUrl || DEFAULT_TERMINAL_SERVER_URL;
    const workspacePath = plugin?.config?.siyuanWorkspacePath || "";
    const systemCwd = toSystemPath(self._cwd || "/data", workspacePath);

    setStatus(self, "connecting", "连接中...");

    let ws: WebSocket;
    try {
        ws = new WebSocket(serverUrl);
    } catch (e) {
        setStatus(self, "error", "地址无效");
        scheduleReconnect(self);
        return;
    }
    self._ws = ws;

    ws.onopen = () => {
        if (self._closed) {
            ws.close();
            return;
        }
        setStatus(self, "connected", "已连接");
        if (restart && self._term) {
            self._term.clear();
        }
        // 发送创建会话请求(带 shell 选择)
        const cols = self._term?.cols || 80;
        const rows = self._term?.rows || 24;
        const shell = plugin?.config?.terminalShell || "auto";
        ws.send(JSON.stringify({type: "create", cwd: systemCwd, cols, rows, shell}));
    };

    ws.onmessage = (event: MessageEvent) => {
        if (self._closed) return;
        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case "ready":
                    setStatus(self, "connected", "已连接");
                    break;
                case "output":
                    if (self._term && typeof msg.data === "string") {
                        self._term.write(msg.data);
                    }
                    break;
                case "exit":
                    if (self._term && typeof msg.code !== "undefined") {
                        self._term.write(`\r\n\x1b[90m[进程已退出,代码 ${msg.code}]\x1b[0m\r\n`);
                    }
                    setStatus(self, "exited", "已退出");
                    break;
                case "error":
                    if (self._term && typeof msg.message === "string") {
                        self._term.write(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m\r\n`);
                    }
                    setStatus(self, "error", "错误");
                    break;
            }
        } catch {
            // 非 JSON 消息,忽略
        }
    };

    ws.onerror = () => {
        setStatus(self, "error", "连接错误");
    };

    ws.onclose = () => {
        if (self._closed) return;
        setStatus(self, "disconnected", "已断开");
        scheduleReconnect(self);
    };
}

function scheduleReconnect(self: TerminalTabInstance): void {
    if (self._closed) return;
    if (self._reconnectTimer) clearTimeout(self._reconnectTimer);
    self._reconnectTimer = window.setTimeout(() => {
        if (self._closed) return;
        if (self._term) {
            self._term.write("\r\n\x1b[90m[正在重连...]\x1b[0m\r\n");
        }
        connectServer(self, false);
    }, 3000);
}
