// pyright 语言服务器宿主:进程生命周期 + 文档同步 + 功能封装
//
// 为什么 pyright 能在渲染进程直接跑(实测结论):
//   node-pty 因为要创建 worker_threads 而不能在渲染进程用,但 pyright 只需要
//   干净的 stdin/stdout 字节流(它的传输协议就是 LSP 的 Content-Length 帧),
//   child_process.spawn 完全够用 —— 同项目 utils/builtin-terminal.ts:476
//   的管道回退路径已验证渲染进程 spawn 成功。所以这里不绕 helper 进程,
//   省掉一层中转(也省掉 helper 需要转发的 base64 编解码开销)。
//
// 不用 monaco-languageclient 的理由见 ./lsp-client.ts 顶部注释。
//
// 部署方式:pyright 作为 npm 依赖装进 node_modules,打包时按需复制到插件目录
// 的 pyright/ 下(含 dist/typeshed-fallback —— 那是 Python 标准库类型存根,
// 不随包走的话 pyright 会对所有标准库符号报"未定义",实测确认)。

import {
    LspConnection, LspPosition, LspRange, LspDiagnostic, LspCompletionItem,
    LspSymbol, LspHover, LspSignatureHelp, LspLocation, pathToUri, uriToPath,
} from "./lsp-client";
import {getNativeRequire} from "./native-require";
import {getResolved} from "../settings/user-settings";

/**
 * 设置里配置的 Python 解释器(settings.json → python.pythonPath)。
 * 形如 D:\programs\anaconda3\envs\ai\python.exe;空串 = 未配置(自动检测)。
 * 每次调用现读 —— 配置可能在 server 启动之后才被 initUserSettings 载入。
 */
function configuredPythonPath(): string {
    try {
        return String(getResolved("python.pythonPath") || "").trim();
    } catch {
        return "";
    }
}

/** pyright 语言服务器状态 */
export type LspStatus = "stopped" | "starting" | "ready" | "error";

/** 诊断回调:某文件最新的诊断列表(空数组 = 无错) */
export type DiagnosticsListener = (fsPath: string, diagnostics: LspDiagnostic[]) => void;

/** 语言服务器日志(用于插件内的日志面板) */
export type LogListener = (text: string) => void;

/** CompletionItemKind 全量值(1..25),声明缺失会让 pyright 过滤掉部分补全 */
const ALL_COMPLETION_ITEM_KINDS = Array.from({length: 25}, (_, i) => i + 1);

/** 客户端可解码的语义 token 类型/修饰符(basedpyright 1.40 的 legend,实测探针取得)。
 *  服务端会用它自己的 legend 返回,这里声明只是能力握手的一部分。 */
const SEMANTIC_TOKEN_TYPES = [
    "namespace", "type", "class", "enum", "typeParameter", "parameter", "variable",
    "property", "enumMember", "function", "method", "keyword", "decorator",
    "selfParameter", "clsParameter",
];
const SEMANTIC_TOKEN_MODIFIERS = [
    "declaration", "definition", "readonly", "static", "async", "defaultLibrary",
    "builtin", "classMember", "parameter",
];

/** 客户端能力声明。
 *  只声明真正实现了的:monaco 侧要能消费 completion / hover / definition /
 *  references / signatureHelp / documentSymbol / diagnostics。
 *  声明了但没实现的会让 pyright 推一堆用不了的能力,反而浪费。 */
const CLIENT_CAPABILITIES = {
    textDocument: {
        // 2 = Incremental。我们只发全量 change(版本号递增),pyright 能处理;
        // 声明 Full(1) 更保险 —— 传全量文本时 server 会整体替换。
        synchronization: {
            dynamicRegistration: false,
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
        },
        completion: {
            dynamicRegistration: false,
            // 关键:让 pyright 返回 **不含 commit characters / insertText 的纯 label 列表**,
            // 避免它按 VS Code 的规则算插入文本,再和 monaco 的插入逻辑打架。
            completionItem: {
                snippetSupport: false,
                commitCharactersSupport: false,
                documentationFormat: ["markdown", "plaintext"],
                deprecatedSupport: true,
                preselectSupport: false,
                labelDetailsSupport: true,
            },
            completionItemKind: {
                valueSet: ALL_COMPLETION_ITEM_KINDS,
            },
            contextSupport: false,
        },
        hover: {dynamicRegistration: false, contentFormat: ["markdown", "plaintext"]},
        signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: {labelOffsetSupport: false},
            },
        },
        definition: {dynamicRegistration: false, linkSupport: false},
        declaration: {dynamicRegistration: false, linkSupport: false},
        typeDefinition: {dynamicRegistration: false, linkSupport: false},
        references: {dynamicRegistration: false},
        documentSymbol: {dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true},
        // 语义 token:basedpyright 实测 gate —— dynamicRegistration=false 时
        // initialize 结果里根本不会声明 semanticTokensProvider(探针两次对照),
        // 必须声明 true 才拿得到语义着色数据源。虽然我们不会处理服务端的
        // 动态注册通知(client/registerCapability 回 null),但 basedpyright
        // 是静态声明 provider 的,动态注册那一路实际不会走。
        semanticTokens: {
            dynamicRegistration: true,
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            formats: ["relative"],
            requests: {range: false, full: {delta: false}},
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
            serverCancelSupport: false,
            augmentsSyntaxTokens: true,
        },
        // 诊断走 push(publishDiagnostics),不 pull
        publishDiagnostics: {
            relatedInformation: true,
            versionSupport: false,
            tagSupport: {valueSet: [1, 2]},
        },
    },
    workspace: {
        workspaceFolders: true,
        // 手动管理文件事件:思源文件系统不是普通的磁盘目录树,
        // 让 server 自己去 fs.watch 会拿到一堆无意义事件。
        didChangeWatchedFiles: {dynamicRegistration: false},
    },
    general: {
        positionEncodings: ["utf-16"],  // 显式声明用 UTF-16,与 monaco 一致
    },
};

/** CompletionItemKind 全量值(1..25),声明缺失会让 pyright 过滤掉部分补全 */

interface OpenDocument {
    uri: string;
    fsPath: string;
    languageId: string;
    version: number;
    /** 本地最近一次文本,用于 diff 出增量改动 */
    text: string;
}

export class PythonLanguageServer {
    private proc: any = null;
    private conn: LspConnection | null = null;
    private status: LspStatus = "stopped";
    private startPromise: Promise<boolean> | null = null;
    private openDocs = new Map<string, OpenDocument>();
    private diagnosticsListeners = new Set<DiagnosticsListener>();
    private logListeners = new Set<LogListener>();
    private serverInfo: {name?: string; version?: string} = {};
    /** 关闭时的等待者(exit / shutdown 完成后兑现) */
    private shutdownWaiters: Array<() => void> = [];
    private intentionalShutdown = false;
    /** 本次 server 进程实际应用的解释器配置(doStart 时快照;空串 = 自动检测)。
     *  解释器设置变更后与现值比对,不同才重启 —— settings.json 的保存广播是不分项的。 */
    // 模块内的 maybeRestartForInterpreterChange 要读「进程已应用的值」,故不设 private
    appliedPythonPath = "";
    /** server 重启完成(新进程已就绪并重新打开文档)后的回调 */
    private restartedListeners = new Set<() => void>();

    constructor(private workspaceRoot = "") {
    }

    get currentStatus(): LspStatus {
        return this.status;
    }

    get isReady(): boolean {
        return this.status === "ready" && !!this.conn && !this.conn.isClosed;
    }

    get version(): string {
        return this.serverInfo.version || "";
    }

    /** 语义 token legend(server 就绪后才有值;null = 服务端不支持语义 token) */
    private semanticLegend: {tokenTypes: string[]; tokenModifiers: string[]} | null = null;

    get semanticTokensLegend(): {tokenTypes: string[]; tokenModifiers: string[]} | null {
        return this.semanticLegend;
    }

    onDiagnostics(cb: DiagnosticsListener): () => void {
        this.diagnosticsListeners.add(cb);
        return () => this.diagnosticsListeners.delete(cb);
    }

    onLog(cb: LogListener): () => void {
        this.logListeners.add(cb);
        return () => this.logListeners.delete(cb);
    }

    /** 订阅 server 重启完成事件(bridge 用它让 monaco 重拉语义 token) */
    onRestarted(cb: () => void): () => void {
        this.restartedListeners.add(cb);
        return () => this.restartedListeners.delete(cb);
    }

    private log(text: string): void {
        this.logListeners.forEach((cb) => {
            try {
                cb(text);
            } catch {
                // ignore
            }
        });
        console.info(`[siyuan-file-editor][pyright] ${text}`);
    }

    // ===== 生命周期 =====

    /**
     * 启动(幂等):已在跑就直接返回 true;正在启动则等同一个 Promise。
     * 这样多个编辑器同时打开 .py 不会起一堆进程。
     */
    async start(): Promise<boolean> {
        if (this.isReady) return true;
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.doStart().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async doStart(): Promise<boolean> {
        const req = getNativeRequire();
        if (!req) {
            this.status = "error";
            this.log("当前环境不支持 Node 原生模块,无法启动 pyright");
            return false;
        }

        const entry = this.findPyrightEntry();
        if (!entry) {
            this.status = "error";
            this.log("找不到 pyright(插件目录/pyright/langserver.index.js 不存在)");
            return false;
        }

        this.status = "starting";
        this.intentionalShutdown = false;
        this.log(`启动 pyright: ${entry}`);

        // 声明的客户端能力:pyright 会按它裁剪返回内容(比如不带 insertText 的
        // 补全、没有 documentation 的 hover),字段名必须与 LSP spec 完全一致。
        const caps = JSON.parse(JSON.stringify(CLIENT_CAPABILITIES));
        // 让 pyright 输出结构化日志到 window/logMessage。
        // pythonPath 必须同时进 initializationOptions:obsidian 侧 my-code-editor
        // 的同款集成实测,initialize 时就要给;workspace/configuration 动态注入
        // 在部分场景(首次分析/索引)不生效。
        const pyPath = configuredPythonPath();
        // initializationOptions 只给 pythonPath(对齐 obsidian my-code-editor 实测:
        // diagnosticMode 在这里传会与 workspace/configuration 的 pyright 段
        // openFilesOnly:false 互相矛盾)
        (caps as any).initializationOptions = pyPath ? {pythonPath: pyPath} : {};

        // PATH 前置选定环境的目录:pyright 内部还会按 PATH 找 python 来解析
        // site-packages(obsidian my-code-editor 同款实测结论),渲染进程 PATH
        // 上的可能是别的 python,必须把选定环境覆盖到最前。
        const lspEnv: Record<string, string> = {...process.env, ELECTRON_RUN_AS_NODE: "1"};
        if (pyPath) {
            const req0 = getNativeRequire();
            const pathMod = req0 ? (req0("path") as typeof import("path")) : null;
            if (pathMod) {
                lspEnv.PATH = pathMod.dirname(pyPath) + pathMod.delimiter + (lspEnv.PATH || "");
            }
        }

        let child: any;
        try {
            child = req("child_process").spawn(
                process.execPath,
                [entry, "--stdio"],
                {
                    cwd: this.workspaceRoot || undefined,
                    // ELECTRON_RUN_AS_NODE:让思源 exe 以纯 Node 模式运行。
                    // pyright 是个 Node 程序,而思源 exe 默认是 Electron,
                    // 不加这个环境变量会用 Electron 的参数解析启动、直接退出。
                    env: lspEnv,
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
        } catch (e: any) {
            this.status = "error";
            this.log(`spawn 失败: ${e?.message || e}`);
            return false;
        }

        this.proc = child;
        const conn = new LspConnection(
            (bytes) => {
                try {
                    child.stdin.write(bytes);
                } catch {
                    // 服务端可能已退出
                }
            },
            "pyright",
        );
        this.conn = conn;
        // 处理器注册标志是**每条连接一份**:handlers 挂在 conn 的 Map 上,
        // dispose 时被清空。pyright 意外退出后重启会建新 conn,不重置的话
        // publishDiagnostics/workspace/configuration 全部没人接 —— 症状是
        // 补全/hover(请求-响应,不依赖这些 handlers)正常、诊断永远不来。
        this.handlersRegistered = false;
        // 快照本次进程应用的解释器:变更检测以此为基线(而非设置注册时的值)
        this.appliedPythonPath = configuredPythonPath();
        // handlers 必须在 initialize **之前**挂好:pyright 握完手立刻发
        // workspace/configuration 问 python.pythonPath,等 didOpen 再挂的话
        // 第一轮请求已经落空(回 -32601 → 配置走默认值)。
        this.registerHandlers();

        child.stdout.on("data", (chunk: Buffer) => {
            try {
                conn.feed(new Uint8Array(chunk));
            } catch (e) {
                this.log(`feed 失败: ${e}`);
            }
        });
        // pyright 把诊断日志写到 stderr;只在非预期退出时打印,避免刷屏
        let stderrTail = "";
        child.stderr.on("data", (chunk: Buffer) => {
            const s = chunk.toString();
            // 实时转发关键 stderr(排查 initialize 响应缺失时需要看 pyright 侧异常)
            if (/error|exception|warn/i.test(s)) console.info(`[syfe-semantic][stderr] ${s.slice(0, 200)}`);
            stderrTail = (stderrTail + s).slice(-2000);
        });
        child.on("error", (e: any) => {
            this.log(`进程错误: ${e?.message || e}`);
            this.status = "error";
        });
        child.on("exit", (code: number, signal: string) => {
            const wasIntentional = this.intentionalShutdown;
            this.proc = null;
            this.conn = null;
            this.openDocs.clear();
            this.status = wasIntentional ? "stopped" : "error";
            const waiters = this.shutdownWaiters;
            this.shutdownWaiters = [];
            waiters.forEach((fn) => {
                try {
                    fn();
                } catch {
                    // ignore
                }
            });
            if (!wasIntentional) {
                this.log(`进程意外退出 code=${code} signal=${signal || "-"}\n${stderrTail.slice(-500)}`);
            }
        });

        // ---- LSP 握手 ----
        try {
            // workspaceRoot 必须是合法 file:// URI。这里用 pathToUri 而不是
            // 手拼 —— 手拼会让盘符冒号被编码成 %3A,pyright 直接放弃索引
            // (症状:单文件补全正常,跨文件跳转全失效)。
            const rootUri = this.workspaceRoot ? pathToUri(this.workspaceRoot) : null;
            const result = await conn.request<any>("initialize", {
                processId: process.pid,
                clientInfo: {name: "siyuan-virtual-tree", version: "1.0.0"},
                rootUri,
                // 无 workspaceRoot 时给个占位,否则 pyright 会拿 cwd 当根,
                // 偶尔会扫到整个盘(实测日志:File or directory does not exist)
                workspaceFolders: rootUri ? [{uri: rootUri, name: "workspace"}] : null,
                capabilities: caps,
                trace: "off",
            }, 40000);

            this.serverInfo = result?.serverInfo || {};
            // 捕获语义 token legend(provider 在 server 就绪后才注册,见 bridge)
            const stp = result?.capabilities?.semanticTokensProvider;
            if (stp?.legend?.tokenTypes?.length) {
                this.semanticLegend = {
                    tokenTypes: stp.legend.tokenTypes,
                    tokenModifiers: stp.legend.tokenModifiers || [],
                };
                this.log(`semanticTokens 可用:${this.semanticLegend.tokenTypes.length} types`);
            }
            // initialized 必须在 initialize 响应之后发,少一步服务商会一直不响应
            conn.notify("initialized", {});

            this.status = "ready";
            this.log(`已就绪 ${this.serverInfo.name || "pyright"} ${this.serverInfo.version || ""}`);

            // 重开上次已登记的文档(重启后 server 侧状态是空的)
            const reopened = Array.from(this.openDocs.values());
            this.openDocs.clear();
            for (const doc of reopened) {
                this.didOpen(doc.fsPath, doc.languageId, doc.text);
            }
            return true;
        } catch (e: any) {
            this.status = "error";
            this.log(`握手失败: ${e?.message || e}\n${stderrTail.slice(-500)}`);
            this.kill();
            return false;
        }
    }

    /** 定位 pyright 入口(见模块级 locatePyrightEntry) */
    private findPyrightEntry(): string | null {
        return locatePyrightEntry();
    }

    async stop(): Promise<void> {
        if (!this.proc) {
            this.status = "stopped";
            return;
        }
        const conn = this.conn;
        this.intentionalShutdown = true;

        if (conn && !conn.isClosed) {
            // LSP 规范:先 shutdown(请求)再 exit(通知),顺序反了 server 可能不回
            const done = new Promise<void>((resolve) => this.shutdownWaiters.push(resolve));
            try {
                await conn.request("shutdown", null, 3000);
                conn.notify("exit");
            } catch {
                // 握手已经失败也要走下面的 kill,否则进程会一直挂着
            }
            // 给服务端一点时间走完自己的清理,超时就强杀
            await Promise.race([done, new Promise((r) => setTimeout(r, 1200))]);
        }
        this.kill();
        this.openDocs.clear();
        this.status = "stopped";
    }

    private kill(): void {
        const child = this.proc;
        const conn = this.conn;
        this.proc = null;
        this.conn = null;
        if (conn) conn.dispose();
        if (child) {
            try {
                child.kill();
            } catch {
                // ignore
            }
        }
    }

    /**
     * 用当前配置重启(解释器设置变更后调用)。
     *
     * 为什么不复用 stop()+start():stop 会清空 openDocs,重启后已打开的 .py
     * 在 server 侧变成"未登记"—— 语义 token/hover 全部失效,要等用户下一次
     * 输入触发 didChange→didOpen 才恢复。这里先把文档清单取出来,新进程就绪后
     * 逐个重发 didOpen,编辑器无感切换。
     */
    async restart(): Promise<boolean> {
        const docs = Array.from(this.openDocs.values()).map((d) => ({...d}));
        await this.stop();
        const ok = await this.start();
        if (ok) {
            for (const d of docs) {
                await this.didOpen(d.fsPath, d.languageId, d.text);
            }
            this.restartedListeners.forEach((cb) => {
                try {
                    cb();
                } catch {
                    // ignore
                }
            });
            this.log(`已按解释器配置重启: ${this.appliedPythonPath || "(自动检测)"}`);
        }
        return ok;
    }

    // ===== 文档同步 =====

    /**
     * 登记并打开一个文档。
     * @param fsPath 系统绝对路径
     * @param languageId monaco language id(python)
     * @param text 当前全文
     */
    async didOpen(fsPath: string, languageId: string, text: string): Promise<void> {
        if (!fsPath) return;
        // 首个打开文件的目录作为 workspace root(对齐 obsidian my-code-editor):
        // rootUri=null 会让 pyright 用 "\<default workspace root>" 占位并刷
        // "does not exist" 警告;指向文件目录则扫描范围小且消灭警告。
        // (lesson 15 的定案是别指向思源工作区根 —— 文件目录不违背)
        // ⚠ 只认**磁盘上真实存在**的文件:块内代码块的虚拟文档(tmp 路径、文件
        //   本身不存在)不能抢设 root —— 不存在的 cwd 会让下次 spawn 直接
        //   ENOENT,解释器重启/重试的 initialize 全挂(实测:md 代码块虚拟文档
        //   先于文件 didOpen 时,重启后 initialize 40s 无响应,症状是
        //   "pyright 时好时坏")。
        if (!this.workspaceRoot) {
            const req0 = getNativeRequire();
            const pathMod = req0 ? (req0("path") as typeof import("path")) : null;
            const fsMod = req0 ? (req0("fs") as typeof import("fs")) : null;
            if (pathMod && fsMod && fsMod.existsSync(fsPath)) {
                this.workspaceRoot = pathMod.dirname(fsPath);
            }
        }
        const uri = pathToUri(fsPath);
        // openDocs 的 key 一律小写:didOpen 与 semanticTokensFull/completion 等的
        // fsPath 来自不同源头(标签页 vs 编辑器 entry),盘符大小写可能不同,
        // 直接 has/get 会 miss → 语义 token 恒返回空(诊断是回传方向,已在
        // 1361f1d 修过归一化;这里是出站方向,同款病)
        const key = uri.toLowerCase();
        const existing = this.openDocs.get(key);
        if (existing) {
            // 已打开:走 change 而不是重复 open(重复 open server 会报错)
            this.didChange(fsPath, text);
            return;
        }
        // 先登记再发 —— 这样握手失败重连后能自动重开
        this.openDocs.set(key, {uri, fsPath, languageId, version: 1, text});
        if (!this.isReady) {
            const ok = await this.start();
            if (!ok) return;
            if (!this.openDocs.has(key)) return; // start() 里已重开过
        }
        const conn = this.conn;
        if (!conn) return;
        this.registerHandlers();
        conn.notify("textDocument/didOpen", {
            textDocument: {uri, languageId, version: 1, text},
        });
    }

    /**
     * 全文同步(Monaco 侧的模型变更)。
     * 用 **Full(全量)** 而不是 Incremental:monaco 的 `getValue()` 拿全文最省心,
     * 而 pyright 对全量 text 也能正确处理(它按行 diff)。几百行的 .py 每次
     * 全量发完全在可接受范围,省掉自己算 edit range 的一堆边界情况。
     */
    didChange(fsPath: string, text: string): void {
        const key = pathToUri(fsPath).toLowerCase();
        const doc = this.openDocs.get(key);
        if (!doc) {
            // 还没 open(可能是 server 重启后 openDocs 被清空)→ 补一次 open
            void this.didOpen(fsPath, "python", text);
            return;
        }
        if (doc.text === text) return; // 无变化就不发,减少服务端无谓计算
        doc.text = text;
        doc.version += 1;
        if (!this.isReady) return;
        this.conn?.notify("textDocument/didChange", {
            textDocument: {uri: doc.uri, version: doc.version},
            contentChanges: [{text}],  // 全量替换
        });
    }

    didSave(fsPath: string, text: string): void {
        this.didChange(fsPath, text);
        const uri = pathToUri(fsPath);
        if (this.isReady && this.openDocs.has(uri.toLowerCase())) {
            this.conn?.notify("textDocument/didSave", {textDocument: {uri}});
        }
    }

    didClose(fsPath: string): void {
        const uri = pathToUri(fsPath);
        this.openDocs.delete(uri.toLowerCase());
        if (this.isReady) {
            this.conn?.notify("textDocument/didClose", {textDocument: {uri}});
        }
    }

    private handlersRegistered = false;

    private registerHandlers(): void {
        if (this.handlersRegistered || !this.conn) return;
        this.handlersRegistered = true;
        const conn = this.conn;

        // 诊断:push 模式,pyright 主动推
        conn.onNotification("textDocument/publishDiagnostics", (params: any) => {
            if (!params?.uri) return;
            const list: LspDiagnostic[] = Array.isArray(params.diagnostics) ? params.diagnostics : [];
            // 清掉该文件上一轮诊断(空列表)
            const arr = this.diagnosticsListeners;
            arr.forEach((cb) => {
                try {
                    cb(uriToPath(params.uri), list);
                } catch (e) {
                    console.warn("[siyuan-file-editor] 诊断回调失败:", e);
                }
            });
        });

        // 服务端主动请求:必须响应,否则 pyright 一直等
        conn.onServerRequest("workspace/configuration", (params: any) => {
            // pyright 会问 python.* / python.analysis.* 一堆配置项。
            // "python" 段注入用户配置的解释器(python.pythonPath),pyright 据此
            // 去对应环境的 site-packages 找第三方库;没配置时回 null 走自动检测,
            // 与旧行为一致。其余段(诊断模式等)全部回 null = 用默认值。
            const items = params?.items;
            if (!Array.isArray(items)) return null;
            const pyPath = configuredPythonPath();
            return items.map((item: any) => {
                const section = String(item?.section || "");
                if (section === "python") {
                    return pyPath ? {pythonPath: pyPath} : null;
                }
                // pyright 自己的段:openFilesOnly=false + 提取库代码类型。
                // useLibraryCodeForTypes 是解析第三方库 API(如 langgraph 的
                // StateGraph.add_node)语义 token 的关键 —— 缺它 pyright 对
                // 纯 Python 库经常推不出成员类型(obsidian 侧同款实测配置)。
                if (section === "pyright") {
                    return pyPath
                        ? {pythonPath: pyPath, openFilesOnly: false, useLibraryCodeForTypes: true}
                        : null;
                }
                return null;
            });
        });
        conn.onServerRequest("client/registerCapability", () => null);
        conn.onServerRequest("client/unregisterCapability", () => null);
        conn.onServerRequest("workspace/workspaceFolders", () => {
            const root = this.workspaceRoot ? pathToUri(this.workspaceRoot) : null;
            return root ? [{uri: root, name: "workspace"}] : null;
        });
        conn.onServerRequest("window/workDoneProgress/create", () => null);

        conn.onNotification("window/logMessage", (params: any) => {
            this.log(params.message || "");
        });
        conn.onNotification("window/showMessage", (params: any) => {
            this.log(`[${params.type}] ${params.message || ""}`);
        });
        conn.onNotification("telemetry/event", () => {
            // pyright 默认会发匿名遥测;这里直接吞掉,不出网
        });
    }

    // ===== 功能封装(全部在 server 没就绪时快速返回 null,绝不阻塞 UI) =====

    private requireConn(): LspConnection | null {
        if (!this.isReady || !this.conn) return null;
        this.registerHandlers();
        return this.conn;
    }

    async completion(fsPath: string, pos: LspPosition): Promise<LspCompletionItem[] | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        const uri = pathToUri(fsPath);
        const doc = this.openDocs.get(uri.toLowerCase());
        if (!doc) return null;
        try {
            const result = await conn.request<any>("textDocument/completion", {
                textDocument: {uri},
                position: pos,
                // 不带 triggerCharacter:pyright 会自己判断该给什么
            }, 3000);
            if (!result) return [];
            // 两种形态:CompletionItem[] 或 {items: [...]}
            const items = Array.isArray(result) ? result : (result.items || []);
            return items as LspCompletionItem[];
        } catch {
            return null;
        }
    }

    async hover(fsPath: string, pos: LspPosition): Promise<LspHover | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<LspHover>("textDocument/hover", {
                textDocument: {uri: pathToUri(fsPath)},
                position: pos,
            }, 3000);
            return res ?? null;
        } catch {
            return null;
        }
    }

    async definition(fsPath: string, pos: LspPosition): Promise<LspLocation[] | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<any>("textDocument/definition", {
                textDocument: {uri: pathToUri(fsPath)},
                position: pos,
            }, 3000);
            if (!res) return [];
            // Location | Location[] | LocationLink[] | null
            if (Array.isArray(res)) return res.map(normalizeLocation).filter(Boolean) as LspLocation[];
            return [normalizeLocation(res)].filter(Boolean) as LspLocation[];
        } catch {
            return null;
        }
    }

    async references(fsPath: string, pos: LspPosition): Promise<LspLocation[] | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<LspLocation[]>("textDocument/references", {
                textDocument: {uri: pathToUri(fsPath)},
                position: pos,
                context: {includeDeclaration: true},
            }, 5000);
            return res || [];
        } catch {
            return null;
        }
    }

    async signatureHelp(fsPath: string, pos: LspPosition): Promise<LspSignatureHelp | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<LspSignatureHelp>("textDocument/signatureHelp", {
                textDocument: {uri: pathToUri(fsPath)},
                position: pos,
            }, 3000);
            return res ?? null;
        } catch {
            return null;
        }
    }

    async documentSymbols(fsPath: string): Promise<LspSymbol[] | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<LspSymbol[]>("textDocument/documentSymbol", {
                textDocument: {uri: pathToUri(fsPath)},
            }, 5000);
            return res || [];
        } catch {
            return null;
        }
    }

    /** 全文档语义 token(LSP 五元组 deltaLine/deltaStartChar/length/type/modifiers)。
     *  与 Monaco 期望的编码完全一致,bridge 层直接转 Uint32Array 即可。 */
    async semanticTokensFull(fsPath: string): Promise<number[] | null> {
        const conn = this.requireConn();
        if (!conn || !this.semanticLegend) {
            return null;
        }
        const uri = pathToUri(fsPath);
        // key 与 didOpen 同规范(小写),见 didOpen 注释
        if (!this.openDocs.has(uri.toLowerCase())) {
            return null;
        }
        try {
            const res = await conn.request<{data?: number[]}>(
                "textDocument/semanticTokens/full",
                {textDocument: {uri}},
                10000,
            );
            return res?.data ?? null;
        } catch {
            return null;
        }
    }

    /** 主动拉一次诊断(pull 模式)。
     *  pyright 默认 push,但切到 pull 时、或刚 didChange 后想立刻看结果时用。 */
    async pullDiagnostics(fsPath: string): Promise<LspDiagnostic[] | null> {
        const conn = this.requireConn();
        if (!conn) return null;
        try {
            const res = await conn.request<{items: LspDiagnostic[]}>(
                "textDocument/diagnostic",
                {textDocument: {uri: pathToUri(fsPath)}},
                10000,
            );
            return res?.items || [];
        } catch {
            return null;
        }
    }
}

/**
 * 定位 pyright 的 langserver 入口(只读文件探测,不启动进程)。
 *
 * 候选顺序:
 *   1. <插件目录>/pyright/langserver.index.js —— 打包时复制进去的(发布态)
 *   2. <cwd>/node_modules/pyright/...          —— 开发态从仓库直接跑
 * pyright 必须整包复制(含 dist/typeshed-fallback),缺了它会对所有标准库符号
 * 报"未定义"。
 */
function locatePyrightEntry(): string | null {
    const req = getNativeRequire();
    if (!req) return null;
    let fs: typeof import("fs");
    let path: typeof import("path");
    try {
        fs = req("fs") as typeof import("fs");
        path = req("path") as typeof import("path");
    } catch {
        return null;
    }

    const candidates: string[] = [];
    try {
        const pluginDir = (window as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
        if (pluginDir) {
            candidates.push(path.join(pluginDir, "pyright", "langserver.index.js"));
        }
        // 开发态:basedpyright(语义 token 数据源)优先,pyright 作为旧安装兜底
        candidates.push(path.join(process.cwd(), "node_modules", "basedpyright", "langserver.index.js"));
        candidates.push(path.join(process.cwd(), "node_modules", "pyright", "langserver.index.js"));
    } catch {
        // ignore
    }

    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // 试下一个
        }
    }
    return null;
}

/** LSP 返回的 Location 有 Location 和 LocationLink 两种形态,统一成前者 */
function normalizeLocation(loc: any): LspLocation | null {
    if (!loc) return null;
    if (loc.targetUri) {
        // LocationLink:{targetUri, targetRange, targetSelectionRange}
        return {uri: loc.targetUri, range: loc.targetSelectionRange || loc.targetRange};
    }
    if (loc.uri && loc.range) return {uri: loc.uri, range: loc.range};
    return null;
}

// ===== 全局单例 =====

let globalServer: PythonLanguageServer | null = null;

/**
 * 取全局语言服务器(懒创建)。
 * workspaceRoot 保持为空(用户定案):不指向任何磁盘目录。openFilesOnly 模式下
 * 打开文件的语义分析不受影响,只是没有 workspace 枚举;root 为空时 pyright
 * 会打 <default workspace root> 占位符日志,属预期行为,不做过滤。
 */
export function getPythonLanguageServer(workspaceRoot?: string): PythonLanguageServer {
    if (!globalServer) {
        globalServer = new PythonLanguageServer(workspaceRoot || "");
    }
    return globalServer;
}

export async function stopPythonLanguageServer(): Promise<void> {
    if (!globalServer) return;
    await globalServer.stop();
    globalServer = null;
}

/**
 * 解释器设置可能变了:与当前 server 进程实际应用的值比对,不同才重启。
 *
 * 以「进程已应用的值」为基线而不是"上次事件时的值",三个触发源都安全:
 *   - 设置面板改解释器(GUI change 事件)
 *   - settings.json 被保存(广播不分项,值没变时零开销)
 *   - initUserSettings 晚于 server 启动(布局恢复的 .py 先开、settings.json
 *     后读到 → 启动时 applied 为空,载入后这里补一次重启)
 * server 尚未创建时直接返回 —— 下次 start 现读配置,天然是新值。
 */
export async function maybeRestartForInterpreterChange(): Promise<void> {
    if (!globalServer) return;
    const cur = configuredPythonPath();
    if (cur === globalServer.appliedPythonPath) return;
    const ok = await globalServer.restart();
    if (!ok) {
        console.warn("[siyuan-file-editor] 切换 Python 解释器后语言服务器重启失败");
    }
}

/** pyright 是否可用:入口文件存在即可(不启动进程,只读文件,代价极小)。
 *  未安装时功能降级 —— 编辑器用内核的静态补全兜底。 */
export function isPyrightAvailable(): boolean {
    return !!locatePyrightEntry();
}

/** 位置转换辅助:monaco 的 position(LSP 同为 0-based,直接传) */
export function toLspPosition(pos: {lineNumber: number; column: number}): LspPosition {
    return {line: pos.lineNumber - 1, character: pos.column - 1};
}

/** LSP range → monaco range */
export function fromLspRange(r: LspRange): {startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number} {
    return {
        startLineNumber: r.start.line + 1,
        startColumn: r.start.character + 1,
        endLineNumber: r.end.line + 1,
        endColumn: r.end.character + 1,
    };
}