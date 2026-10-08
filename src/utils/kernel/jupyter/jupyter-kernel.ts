// Jupyter 后端(Task D / Phase 2,方案 A:Node 侧直连 zmq)
//
// 与 Legacy 后端(syfe-kernel.py 私有协议)的关键差异:
//   - 进程:spawn 的是 kernelspec 定义的启动器(python 内核即 `python -m ipykernel_launcher`),
//     连接参数经 connection.json 交给内核,不再用自有 JSON 行协议
//   - 通信:标准 Jupyter wire protocol v5.3(见 wire.ts),shell/control 走 DEALER、
//     iopub 走 SUB;**内核是 bind 方,我们是 connect 方**(见 connection.ts 顶部的订正说明)
//   - 中断:ipykernel 6.28 的 control 通道**没有** interrupt_request(已核实),
//     只能对内核进程发 CTRL_BREAK/SIGINT —— 这与 Legacy 的「杀进程+重放」完全不同,
//     内核状态(变量)在中断后保留,这正是选方案 A 的理由
//
// 为什么 loadZeromq 要走候选路径而不是 import "zeromq":
//   zeromq 是原生模块(.node 二进制),不能被 webpack 打包;与 node-pty 同一套约定,
//   运行时按绝对路径 require,构建期由 CopyPlugin 把 build/<platform> 复制进插件目录。

import {getNativeRequire} from "../../native-require";
import {
    CompleteOutcome, ExecuteOutcome, HistoryEntry, InspectOutcome,
    KernelClient, KernelEvent, KernelInfo, KernelListener, KernelStatus, StatusListener,
} from "../types";
import {resolveJupyterInterpreter} from "../interpreter";
import {KernelConnectionInfo, writeConnectionFile} from "./connection";
import {createWireSession, JupyterMsg, makeHeader, parseFrames, serializeMessage, WireSession} from "./wire";

/** 单次执行默认超时,与 Legacy 一致 */
const DEFAULT_EXECUTE_TIMEOUT = 300000;
/** kernel_info 握手超时 */
const START_TIMEOUT_MS = 30000;
/** control 通道请求超时 */
const CONTROL_TIMEOUT_MS = 10000;

interface PendingShell {
    resolve: (msg: JupyterMsg | null) => void;
    timer: any;
}

interface PendingExecute {
    acc: ExecuteOutcome;
    timer: any;
    resolve: (v: ExecuteOutcome | null) => void;
    gotReply: boolean;
}

interface Aggregate {
    acc: ExecuteOutcome;
    isTerminal: (ev: KernelEvent) => boolean;
    finish: (ev: KernelEvent, acc: ExecuteOutcome) => any;
}

/** zeromq 的候选加载位置(与 builtin-terminal.ts 的 node-pty 同一策略) */
const ZEROMQ_CANDIDATES = [
    "node_modules/zeromq",
];

let zmqCache: any | null | undefined;

function loadZeromq(): any | null {
    if (zmqCache) return zmqCache;
    const req = getNativeRequire();
    if (!req) return null;
    const pathMod = req("path") as typeof import("path");
    // 1) 裸包名(插件目录带了 node_modules 时)
    try {
        zmqCache = req("zeromq");
        return zmqCache;
    } catch {
        // 继续按绝对路径找
    }
    // 2) 插件目录下的 node_modules
    const pluginDir = (globalThis as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
    if (pluginDir) {
        try {
            zmqCache = req(pathMod.join(pluginDir, "node_modules", "zeromq"));
            return zmqCache;
        } catch {
            // 目录里没带 → 最后试仓库开发路径
        }
    }
    try {
        zmqCache = req(pathMod.resolve(__dirname, "..", "..", "node_modules", "zeromq"));
        return zmqCache;
    } catch {
        return null;
    }
}

/** kernelspec 的 kernel.json → 实际启动命令 */
function specArgv(specResourceDir: string, connectionFile: string): {cmd: string; args: string[]} | null {
    const req = getNativeRequire();
    if (!req) return null;
    try {
        const fs = req("fs") as typeof import("fs");
        const pathMod = req("path") as typeof import("path");
        const jsonPath = pathMod.join(specResourceDir, "kernel.json");
        const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const argv: string[] = raw?.argv || [];
        if (!argv.length) return null;
        const args = argv.slice(1).map((a) => a.replace(/\{connection_file\}/g, connectionFile));
        return {cmd: argv[0], args};
    } catch {
        return null;
    }
}

/** 该启动命令是否为 ipykernel(只有它监听 JPY_INTERRUPT_EVENT 中断事件) */
function isIpykernelArgv(args: string[]): boolean {
    const i = args.indexOf("-m");
    return i >= 0 && args[i + 1] === "ipykernel_launcher";
}

/** 启动器脚本位置:部署后在插件根(CopyPlugin 复制),开发仓库在 tools/ 下 */
function findLauncherPath(): string | null {
    const req = getNativeRequire();
    if (!req) return null;
    const fs = req("fs") as typeof import("fs");
    const pathMod = req("path") as typeof import("path");
    const pluginDir = (globalThis as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
    for (const cand of [
        pluginDir ? pathMod.join(pluginDir, "jupyter-launch.py") : "",
        pluginDir ? pathMod.join(pluginDir, "tools", "jupyter-launch.py") : "",
    ]) {
        try {
            if (cand && fs.existsSync(cand)) return cand;
        } catch {
            // 下一个
        }
    }
    return null;
}

export class JupyterKernel implements KernelClient {
    readonly kind: "jupyter" = "jupyter";

    private proc: any = null;
    private status: KernelStatus = "stopped";
    private startPromise: Promise<boolean> | null = null;
    private disposed = false;
    /** Windows 上经由启动器(tools/jupyter-launch.py)拉起内核时为 true,中断走 stdin 命令 */
    private useLauncher = false;

    private connPath = "";
    private conn: KernelConnectionInfo | null = null;
    private session: WireSession | null = null;
    private shellSock: any = null;
    private iopubSock: any = null;
    private controlSock: any = null;

    private info: KernelInfo | null = null;
    private history: HistoryEntry[] = [];
    private execOrder = 0;

    private listeners = new Set<KernelListener>();
    private statusListeners = new Set<StatusListener>();

    /** shell 通道上挂起的 execute 请求,按 parent msg_id 聚合 */
    private pendingExecute = new Map<string, PendingExecute>();
    /** shell 通道上的 complete/inspect/kernel_info */
    private pendingShell = new Map<string, PendingShell>();
    /** control 通道上的 shutdown 等 */
    private pendingControl = new Map<string, PendingShell>();
    /** start 阶段的 kernel_info 握手 */
    private startWaiter: ((ok: boolean) => void) | null = null;
    /** 中断重试/兜底循环的句柄(同一时刻只允许一个) */
    private interruptWatchdog: any = null;

    /** 后端实例对应的 kernelspec(Phase 3 UI 会按文档切换) */
    specName = "python3";
    specResourceDir = "";
    /** 内核工作目录,与 Legacy 同义 */
    workspaceCwd = "";

    // ===== 状态与监听(与 Legacy 同名同语义) =====

    get currentStatus(): KernelStatus {
        return this.status;
    }

    get isReady(): boolean {
        return this.status === "ready";
    }

    get kernelInfo(): KernelInfo | null {
        return this.info;
    }

    get executedHistory(): ReadonlyArray<HistoryEntry> {
        return this.history;
    }

    onEvent(cb: KernelListener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    onStatus(cb: StatusListener): () => void {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
    }

    private emit(ev: KernelEvent): void {
        this.listeners.forEach((cb) => {
            try {
                cb(ev);
            } catch (e) {
                console.warn("[siyuan-file-editor] jupyter 内核事件回调失败:", e);
            }
        });
    }

    private setStatus(s: KernelStatus, detail?: string): void {
        if (this.status === s) return;
        this.status = s;
        this.statusListeners.forEach((cb) => {
            try {
                cb(s, detail);
            } catch {
                // ignore
            }
        });
    }

    // ===== 启动 =====

    async start(): Promise<boolean> {
        if (this.isReady) return true;
        if (this.disposed) return false;
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.doStart().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async doStart(): Promise<boolean> {
        const req = getNativeRequire();
        if (!req) {
            this.setStatus("error", "当前环境不支持 Node 原生模块");
            return false;
        }
        const zmq = loadZeromq();
        if (!zmq) {
            this.setStatus("error", "无法加载 zeromq(插件目录缺少 node_modules/zeromq?)");
            return false;
        }
        this.setStatus("starting");

        // 1. connection.json(内核 bind 端口必须空闲,由我们分配并写入)
        let conn: {path: string; info: KernelConnectionInfo};
        try {
            conn = await writeConnectionFile(this.specName);
        } catch (e: any) {
            this.setStatus("error", `生成 connection.json 失败: ${e?.message || e}`);
            return false;
        }
        this.connPath = conn.path;
        this.conn = conn.info;
        // ⚠️ key 必须用 hex 字符串的 **UTF-8 字节**,不能 unhex!
        // 参考实现 jupyter_client/connect.py:559-564 是 `key = info["key"]; key = key.encode()`,
        // 即 hmac 的 key 就是 "8a1f..." 这串文本本身的字节。用 hex 解码会签出完全不同的
        // HMAC,内核侧校验失败后**静默丢弃消息**(无任何 stderr 线索,只能靠排除法定位)
        this.session = createWireSession(Buffer.from(conn.info.key, "utf8"));

        // 2. 启动内核进程。python 内核走 ipykernel_launcher;其他内核读 kernelspec 的 argv
        let argv: {cmd: string; args: string[]} | null;
        if (this.specResourceDir) {
            argv = specArgv(this.specResourceDir, conn.path) || (await this.pythonLaunchArgv(conn.path));
        } else {
            argv = await this.pythonLaunchArgv(conn.path);
        }
        if (!argv) {
            this.setStatus("error", "没有可用的 Jupyter 解释器(需要装了 ipykernel 的 Python)");
            return false;
        }

        // Windows 的中断必须经启动器(渲染进程无法创建/触发 Win32 事件,见 tools/jupyter-launch.py);
        // 只对 ipykernel 路径生效,自定义 kernelspec(deno 等)不监听那个事件,起了也没用
        this.useLauncher = false;
        if (process.platform === "win32" && argv && isIpykernelArgv(argv.args)) {
            const launcher = findLauncherPath();
            if (launcher) {
                this.useLauncher = true;
                argv = {cmd: argv.cmd, args: ["-u", launcher, conn.path]};
            }
        }

        const cp = req("child_process");
        try {
            this.proc = cp.spawn(argv.cmd, argv.args, {
                cwd: this.workspaceCwd || undefined,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: "utf-8",
                },
                windowsHide: true,
                // 启动器模式要留 stdin 作为命令通道
                stdio: [this.useLauncher ? "pipe" : "ignore", "pipe", "pipe"],
            });
        } catch (e: any) {
            this.setStatus("error", `启动内核失败: ${e?.message || e}`);
            return false;
        }
        let stderrTail = "";
        this.proc.stderr?.setEncoding?.("utf8");
        this.proc.stderr?.on?.("data", (chunk: string) => {
            if (stderrTail.length < 4000) stderrTail += chunk;
        });
        this.proc.on("error", (e: any) => {
            this.setStatus("error", `内核进程异常: ${e?.message || e}`);
        });
        this.proc.on("exit", (code: number) => {
            if (this.disposed) return;
            // 内核自己退出:所有挂起请求作废(与 Legacy 的 failAllPending 同语义)
            this.failAllPending(`内核进程已退出(code=${code})${stderrTail ? `; ${stderrTail.slice(-200)}` : ""}`);
            if (this.status !== "error") this.setStatus("stopped");
        });

        // 3. 连接四个通道(内核 bind,我们 connect)
        const url = (chan: string) => `${conn.info.transport}://${conn.info.ip}:${(conn.info as any)[chan + "_port"]}`;
        try {
            this.shellSock = new zmq.Dealer();
            await this.shellSock.connect(url("shell"));
        } catch (e: any) {
            this.setStatus("error", `连接 shell 通道失败(${url("shell")}): ${e?.message || e}`);
            return false;
        }
        try {
            this.controlSock = new zmq.Dealer();
            await this.controlSock.connect(url("control"));
        } catch (e: any) {
            this.setStatus("error", `连接 control 通道失败(${url("control")}): ${e?.message || e}`);
            return false;
        }
        try {
            this.iopubSock = new zmq.Subscriber();
            this.iopubSock.subscribe("");
            await this.iopubSock.connect(url("iopub"));
        } catch (e: any) {
            this.setStatus("error", `连接 iopub 通道失败(${url("iopub")}): ${e?.message || e}`);
            return false;
        }

        this.runLoop(this.shellSock, (m) => this.onShellMsg(m), "shell");
        this.runLoop(this.iopubSock, (m) => this.onIopubMsg(m), "iopub");
        this.runLoop(this.controlSock, (m) => this.onControlMsg(m), "control");

        // 4. kernel_info 握手:拿到语言信息才算就绪(ZMQ 会排队,内核起来后会处理)
        const ok = await new Promise<boolean>((resolve) => {
            this.startWaiter = resolve;
            const timer = setTimeout(() => {
                this.startWaiter = null;
                resolve(false);
            }, START_TIMEOUT_MS);
            try {
                this.sendShellRequest("kernel_info_request", {}).then((id) => {
                    // 发送失败时立刻判定失败
                    if (!id) {
                        clearTimeout(timer);
                        this.startWaiter = null;
                        resolve(false);
                    }
                }).catch(() => {
                    clearTimeout(timer);
                    this.startWaiter = null;
                    resolve(false);
                });
            } catch (e) {
                clearTimeout(timer);
                this.startWaiter = null;
                resolve(false);
            }
        });
        if (!ok) {
            this.setStatus("error", `内核握手超时(${START_TIMEOUT_MS}ms)${stderrTail ? `; ${stderrTail.slice(-300)}` : ""}`);
            return false;
        }
        this.setStatus("ready");
        return true;
    }

    private async pythonLaunchArgv(connectionFile: string): Promise<{cmd: string; args: string[]} | null> {
        const interpreter = await resolveJupyterInterpreter();
        if (!interpreter) return null;
        // 用 -m 模块入口而不是 kernelspec 里的绝对 python 路径:解释器是我们探测出来的,
        // ipykernel_launcher 一定在它自己的环境里
        return {cmd: interpreter.cmd, args: [...interpreter.args, "-m", "ipykernel_launcher", "-f", connectionFile]};
    }

    // ===== 消息循环 =====

    private runLoop(sock: any, handler: (m: JupyterMsg) => void, chan: string): void {
        (async () => {
            try {
                for await (const frames of sock) {
                    const msg = parseFrames(this.session!, frames as Buffer[]);
                    if (msg) handler(msg);
                }
            } catch {
                // socket 被关闭(shutdown)时迭代器抛错,属正常退出路径
            }
        })();
        void chan; // 仅日志用,避免 noUnused 参数报错
    }

    private onShellMsg(m: JupyterMsg): void {
        const type = m.header.msg_type;
        const parentId = m.parent_header?.msg_id || "";

        if (type === "kernel_info_reply" && this.startWaiter) {
            const content = m.content as any;
            this.info = {
                version: content?.language_info?.version || content?.implementation_version || "",
                executable: `${content?.implementation || "kernel"}/${content?.implementation_version || "?"}`,
            };
            const w = this.startWaiter;
            this.startWaiter = null;
            w(true);
            return;
        }

        if (type === "execute_reply") {
            const p = this.pendingExecute.get(parentId);
            if (p) {
                const c = m.content as any;
                p.acc.executionCount = typeof c?.execution_count === "number" ? c.execution_count : p.acc.executionCount;
                if (c?.status === "error" && c?.ename) {
                    p.acc.error = {ename: String(c.ename), evalue: String(c.evalue), traceback: (c.traceback || []).map(String)};
                }
                p.gotReply = true;
                // 等待 iopub 的终态(error/status-idle),留一小拍合并 execute_reply 的信息。
                // 若 iopub 已经终态完成,这里直接完成
                if (p.acc.error || c?.status === "aborted") this.finishExecute(parentId, p);
            }
            return;
        }

        if (type === "complete_reply" || type === "inspect_reply") {
            const p = this.pendingShell.get(parentId);
            if (p) {
                this.pendingShell.delete(parentId);
                clearTimeout(p.timer);
                p.resolve(m);
            }
        }
    }

    private onIopubMsg(m: JupyterMsg): void {
        const type = m.header.msg_type;
        const parentId = m.parent_header?.msg_id || "";
        const content = m.content as any;

        if (type === "status") {
            // 状态广播没有 parent(或 parent 非当前请求),仅对挂起中的 execute 有意义
            const p = this.pendingExecute.get(parentId);
            if (p && content?.execution_state === "idle") {
                this.finishExecute(parentId, p);
            }
            return;
        }

        const p = this.pendingExecute.get(parentId);
        if (!p) return;

        if (type === "stream") {
            const text = String(content?.text ?? "");
            if (content?.name === "stderr") p.acc.stderr += text;
            else p.acc.stdout += text;
        } else if (type === "execute_result") {
            const data = (content?.data || {}) as Record<string, string>;
            if (typeof data["text/plain"] === "string") p.acc.result = data["text/plain"];
            p.acc.richData = {...(p.acc.richData || {}), ...data};
            if (typeof content?.execution_count === "number") p.acc.executionCount = content.execution_count;
        } else if (type === "display_data") {
            const data = (content?.data || {}) as Record<string, string>;
            p.acc.richData = {...(p.acc.richData || {}), ...data};
        } else if (type === "error") {
            p.acc.error = {
                ename: String(content?.ename ?? "Error"),
                evalue: String(content?.evalue ?? ""),
                traceback: (content?.traceback || []).map(String),
            };
        }

        // 向事件订阅者转发(与 Legacy 的 KernelEvent 语义对齐)
        if (type === "stream") {
            this.emit({type: "stream", id: parentId, name: content?.name === "stderr" ? "stderr" : "stdout", text: String(content?.text ?? "")});
        } else if (type === "execute_result") {
            this.emit({
                type: "execute_result", id: parentId,
                execution_count: Number(content?.execution_count ?? 0),
                data: (content?.data || {}) as Record<string, string>,
                metadata: (content?.metadata || {}) as Record<string, any>,
            });
        } else if (type === "error") {
            this.emit({
                type: "error", id: parentId,
                execution_count: typeof content?.execution_count === "number" ? content.execution_count : undefined,
                ename: String(content?.ename ?? "Error"), evalue: String(content?.evalue ?? ""),
                traceback: (content?.traceback || []).map(String),
            });
        }
    }

    private finishExecute(msgId: string, p: PendingExecute): void {
        if (!this.pendingExecute.has(msgId)) return;
        this.pendingExecute.delete(msgId);
        clearTimeout(p.timer);
        p.acc.ok = !p.acc.error;
        p.resolve({...p.acc});
    }

    private onControlMsg(m: JupyterMsg): void {
        const parentId = m.parent_header?.msg_id || "";
        const p = this.pendingControl.get(parentId);
        if (p) {
            this.pendingControl.delete(parentId);
            clearTimeout(p.timer);
            p.resolve(m);
        }
    }

    // ===== 发送 =====

    private async sendShellRequest(msgType: string, content: Record<string, unknown>): Promise<string | null> {
        if (!this.session || !this.shellSock) return null;
        const header = makeHeader(this.session, msgType);
        const frames = serializeMessage(this.session, header, null, null, content);
        await this.shellSock.send(frames);
        return header.msg_id;
    }

    private async sendControlRequest(msgType: string, content: Record<string, unknown>): Promise<string | null> {
        if (!this.session || !this.controlSock) return null;
        const header = makeHeader(this.session, msgType);
        const frames = serializeMessage(this.session, header, null, null, content);
        await this.controlSock.send(frames);
        return header.msg_id;
    }

    private requestShell<T = JupyterMsg>(msgType: string, content: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
        return new Promise<T | null>((resolve) => {
            let settled = false;
            this.sendShellRequest(msgType, content).then((msgId) => {
                if (!msgId || settled) {
                    if (!settled) resolve(null);
                    return;
                }
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    this.pendingShell.delete(msgId);
                    resolve(null);
                }, timeoutMs);
                this.pendingShell.set(msgId, {
                    resolve: (m) => {
                        if (settled) return;
                        settled = true;
                        resolve(m as unknown as T);
                    },
                    timer,
                });
            }).catch(() => resolve(null));
        });
    }

    // ===== KernelClient 接口实现 =====

    async execute(code: string, opts?: {silent?: boolean; timeoutMs?: number}): Promise<ExecuteOutcome | null> {
        if (!(await this.start())) return null;
        if (!this.session || !this.shellSock) return null;
        const timeout = opts?.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT;

        const header = makeHeader(this.session, "execute_request");
        const msgId = header.msg_id;
        const acc: ExecuteOutcome = {ok: false, executionCount: 0, stdout: "", stderr: ""};
        const order = ++this.execOrder;

        return new Promise<ExecuteOutcome | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingExecute.delete(msgId);
                resolve(null);
            }, timeout);
            this.pendingExecute.set(msgId, {
                acc,
                timer,
                resolve,
                gotReply: false,
            });
            const frames = serializeMessage(this.session!, header, null, null, {
                code,
                silent: !!opts?.silent,
                store_history: !opts?.silent,
                user_expressions: {},
                allow_stdin: false,
                stop_on_error: false,
            });
            this.shellSock.send(frames).catch(() => {
                clearTimeout(timer);
                this.pendingExecute.delete(msgId);
                resolve(null);
            });
            void order;
        });
    }

    async complete(code: string, cursor: number): Promise<CompleteOutcome | null> {
        if (!(await this.start())) return null;
        const reply = await this.requestShell("complete_request", {code, cursor_pos: cursor}, 15000);
        if (!reply) return null;
        const c = reply.content as any;
        if (c?.status !== "ok") return null;
        return {
            matches: (c?.matches || []).map(String),
            cursorStart: Number(c?.cursor_start ?? 0),
            cursorEnd: Number(c?.cursor_end ?? 0),
        };
    }

    async inspect(
        code: string,
        cursor: number,
        kind?: "hover" | "signature" | "definition",
    ): Promise<InspectOutcome | null> {
        if (!(await this.start())) return null;
        // Jupyter 的 detail_level:0 简略、1 详细。hover 用 0,signature 用 1;definition 无对应,取 0
        const detail = kind === "signature" ? 1 : 0;
        const reply = await this.requestShell("inspect_request", {code, cursor_pos: cursor, detail_level: detail}, 15000);
        if (!reply) return null;
        const c = reply.content as any;
        if (c?.status !== "ok" || !c?.found) return null;
        const data = (c?.data || {}) as Record<string, string>;
        const content = typeof data["text/plain"] === "string" ? data["text/plain"] : "";
        if (!content) return null;
        return {content};
    }

    async reset(): Promise<boolean> {
        if (!(await this.start())) return false;
        // Jupyter 没有 reset 请求,用内置魔法清命名空间(-f 跳过确认)。
        // 注意它不卸载已 import 的模块,这点与 Legacy 的「杀进程重建」不同,但编辑器场景够用
        const r = await this.execute("%reset -f", {silent: true, timeoutMs: 30000});
        return !!r && r.ok;
    }

    async info2(): Promise<KernelInfo | null> {
        if (!(await this.start())) return null;
        const reply = await this.requestShell("kernel_info_request", {}, 15000);
        if (!reply) return this.info;
        const c = reply.content as any;
        this.info = {
            version: c?.language_info?.version || c?.implementation_version || "",
            executable: `${c?.implementation || "kernel"}/${c?.implementation_version || "?"}`,
        };
        return this.info;
    }

    async interrupt(): Promise<void> {
        // ipykernel 6.28(Windows)的结构性限制:执行期间 SIGINT handler 被换成
        // handle_sigint(ipkernel.py:_cancel_on_sigint),它只是「往事件循环排回调」;
        // 而同步 CPU 代码会一直占着事件循环,回调永远执行不到,信号就被吞了。
        // 所以事件中断是「尽力而为」,这里用监视循环兜底:
        //   发中断 → 每 1.5s 检查,还有挂起请求就重发(最多 2 次) → 仍不停就杀内核。
        // 杀内核后 exit 处理器会 failAllPending(错误为 KernelGone),下一次 execute
        // 的 start() 会自动拉起新内核 —— 单元格一定停得下来,代价是变量丢失。
        const fire = () => {
            if (this.useLauncher && this.proc?.stdin?.writable) {
                try {
                    this.proc.stdin.write("interrupt\n");
                    return;
                } catch {
                    // 启动器可能已退出
                }
            }
            if (!this.proc) return;
            try {
                if (process.platform === "win32") this.proc.kill("SIGBREAK");
                else this.proc.kill("SIGINT");
            } catch {
                // 进程可能已经退出
            }
        };
        if (this.interruptWatchdog) {
            // 已有监视循环在跑(连续点中断按钮):只补发一次事件
            fire();
            return;
        }
        fire();
        let attempts = 0;
        this.interruptWatchdog = setInterval(() => {
            attempts++;
            if (this.pendingExecute.size === 0 || this.disposed) {
                clearInterval(this.interruptWatchdog);
                this.interruptWatchdog = null;
                return;
            }
            if (attempts <= 2) {
                fire();
                return;
            }
            clearInterval(this.interruptWatchdog);
            this.interruptWatchdog = null;
            // 确定性兜底:中断必须让单元格停下来
            this.killProcess();
        }, 1500);
    }

    async shutdown(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        // 先礼貌请求内核退出(control 通道 shutdown_request + 启动器 quit),再清本地资源
        try {
            if (this.session && this.controlSock) {
                await this.sendControlRequest("shutdown_request", {restart: false});
            }
        } catch {
            // 内核可能已死
        }
        if (this.useLauncher && this.proc?.stdin?.writable) {
            try {
                this.proc.stdin.write("quit\n");
            } catch {
                // ignore
            }
        }
        this.failAllPending("内核已关闭");
        if (this.interruptWatchdog) {
            clearInterval(this.interruptWatchdog);
            this.interruptWatchdog = null;
        }
        try {
            this.shellSock?.close();
            this.iopubSock?.close();
            this.controlSock?.close();
        } catch {
            // ignore
        }
        this.shellSock = this.iopubSock = this.controlSock = null;
        this.killProcess();
        this.connPath = "";
        this.setStatus("stopped");
    }

    private failAllPending(reason: string): void {
        const e: ExecuteOutcome = {ok: false, executionCount: 0, stdout: "", stderr: "", error: {ename: "KernelGone", evalue: reason, traceback: []}};
        for (const [, p] of this.pendingExecute) {
            clearTimeout(p.timer);
            p.resolve({...e});
        }
        this.pendingExecute.clear();
        for (const [, p] of this.pendingShell) {
            clearTimeout(p.timer);
            p.resolve(null);
        }
        this.pendingShell.clear();
        for (const [, p] of this.pendingControl) {
            clearTimeout(p.timer);
            p.resolve(null);
        }
        this.pendingControl.clear();
    }

    private killProcess(): void {
        const child = this.proc;
        this.proc = null;
        if (!child) return;
        try {
            child.kill();
        } catch {
            // ignore
        }
        if (process.platform === "win32") {
            try {
                const pid = child.pid;
                const req = getNativeRequire();
                if (pid && req) {
                    req("child_process").execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {stdio: "ignore"});
                }
            } catch {
                // 进程可能已自行退出
            }
        }
    }
}
