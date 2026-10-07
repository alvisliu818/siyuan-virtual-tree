// 持久 Python 内核的宿主端
//
// 为什么不用 Jupyter 的 messaging 协议(实测结论):
//   思源本体 650 条内核路由里**没有任何 Python 执行端点**,` ```python ` 只做
//   语法高亮。所以「在笔记里运行 Python」只能插件自己实现,而整个 Jupyter
//   协议(zmq + jupyter_client + ipykernel)依赖太重 —— 我们实际只需要
//   「发一段代码,拿 stdout / stderr / 结果值 / 异常」。
//   内核本体在 tools/syfe-kernel.py,零第三方依赖,协议是一行一个 JSON。
//
// 为什么直接 child_process.spawn 而不绕 pty-helper:
//   helper 的存在意义是承载 node-pty(它必须建 worker_threads,渲染进程建不了)。
//   内核只是普通管道子进程,不需要 PTY;而同项目 utils/builtin-terminal.ts 的
//   管道回退路径已验证渲染进程 spawn 成功。少一层中转就少一处 base64 编解码。
//
// 进程模型:内核是**持久**的(不是每次执行都起一个新 python)。
//   变量、import 的模块、函数定义都跨单元格保留,和 Jupyter 一致。
//
// 中断的实现(Windows 特有,别改):
//   Windows 上 signal 不能打断 Python 主线程(SIGINT 会直接杀进程),
//   也没法在同进程里另起线程去杀 GIL 中的执行。因此
//   **中断 = 杀进程 + 重建 + 重放历史代码**。历史 = 成功执行过的代码片段
//   (按 execution_order 排序)。代价:重启丢内存里的非代码副作用
//   (打开的文件句柄、注册的 atexit 回调),笔记本场景完全可接受。

import {getNativeRequire} from "./native-require";

/** 内核事件(与 syfe-kernel.py 发出的 JSON 一一对应) */
export type KernelEvent =
    | {type: "kernel_ready"; version: string; executable: string; pid: number}
    // stream 必须带 id:宿主按 pending[id] 分发事件,没有 id 的事件会被丢掉。
// (这不是"可选字段" —— 内核侧每个请求处理完都会把 id 清空,见 _current_request_id)
    | {type: "stream"; id: string; name: "stdout" | "stderr"; text: string}
    | {type: "status"; id: string; state: "busy" | "idle"; execution_count: number}
    | {
        type: "execute_result";
        id: string;
        execution_count: number;
        data: Record<string, string>;
        metadata?: Record<string, any>;
    }
| {
      type: "error";
      id: string;
    // 执行期错误必带序号。协议层错误(未知的请求类型、内核自身崩了)没有序号概念,
      // 所以它是可选的 —— 不能靠 status-idle 兜底,因为 error 本身就是终态,
      // 请求在收到 error 时就 resolve 了,后到的 idle 已经没人接。
      execution_count?: number;
  ename: string;
        evalue: string;
        traceback: string[];
    }
    | {
        type: "complete_result";
        id: string;
        matches: string[];
        cursor_start: number;
        cursor_end: number;
    }
    | {
        type: "inspect_result";
        id: string;
        kind: "hover" | "signature" | "definition";
        content: string;
        signature?: string;
        name?: string;
        start?: number;
        end?: number;
    }
    | {type: "reset_result"; id: string}
    | {type: "info_result"; id: string; version: string; executable: string};

export type KernelStatus = "stopped" | "starting" | "ready" | "error";

/** 一个执行请求的最终结果 */
export interface ExecuteOutcome {
    /** 是否成功(无异常) */
    ok: boolean;
    /** 该次执行的序号(Jupyter 的 In[n]) */
    executionCount: number;
    /** 标准输出 */
    stdout: string;
    /** 标准错误 */
    stderr: string;
    /** 最后一个表达式的值(text/plain) */
    result?: string;
    /** 富文本 / 图片结果(键是 mime type,如 text/html、image/png) */
    richData?: Record<string, string>;
    /** 异常信息 */
    error?: {ename: string; evalue: string; traceback: string[]};
}

export interface CompleteOutcome {
    matches: string[];
    /** 待替换区间的起点(模型内字符偏移) */
    cursorStart: number;
    /** 待替换区间的终点 */
    cursorEnd: number;
}

export interface InspectOutcome {
    content: string;
    signature?: string;
    name?: string;
    start?: number;
    end?: number;
}

export type KernelListener = (ev: KernelEvent) => void;
export type StatusListener = (status: KernelStatus, detail?: string) => void;

/** 内核运行信息 */
export interface KernelInfo {
    version: string;
    executable: string;
}

/**
 * 一次请求的聚合器。
 * 内核的事件是流式的(多次 stream + 一个终态),所以每个请求都要把
 * 收到的事件累积起来,遇到终态事件才 resolve。
 */
interface Aggregate {
    /** 已累积的输出 */
    acc: ExecuteOutcome;
    /** 终态判定 */
    isTerminal: (ev: KernelEvent) => boolean;
    /** 从终态事件里取最终结果 */
    finish: (ev: KernelEvent, acc: ExecuteOutcome) => any;
}

interface HistoryEntry {
    code: string;
    executionOrder: number;
}

/** 单次执行默认超时:5 分钟。跑训练/下载这类脚本合理,又不至于永远挂着。 */
const DEFAULT_EXECUTE_TIMEOUT = 300000;

export class PythonKernel {
    private proc: any = null;
    private status: KernelStatus = "stopped";
    private startPromise: Promise<boolean> | null = null;
    private seq = 0;
    /** 请求 id → 聚合器 */
    private pending = new Map<string, {agg: Aggregate; timer: number; resolve: (v: any) => void}>();
    private listeners = new Set<KernelListener>();
    private statusListeners = new Set<StatusListener>();
    private readyWaiters = new Set<(ok: boolean) => void>();
    /** 成功执行过的代码,中断重启后按序重放 */
    private history: HistoryEntry[] = [];
    private info: KernelInfo | null = null;
    private disposed = false;
    /** 重放历史期间:结果不该再进 history(否则会自我复制) */
    private replaying = false;
    /** 内核工作目录:设为笔记本所在目录,让相对路径读写与用户预期一致 */
    workspaceCwd = "";

    // ===== 状态与监听 =====

    get currentStatus(): KernelStatus {
        return this.status;
    }

    get isReady(): boolean {
        return this.status === "ready";
    }

    get kernelInfo(): KernelInfo | null {
        return this.info;
    }

    /** 已重放/累积的代码历史(只读副本) */
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
                console.warn("[siyuan-file-editor] 内核事件回调失败:", e);
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

        const script = this.findKernelScript();
        if (!script) {
            this.setStatus("error", "找不到内核脚本 syfe-kernel.py(插件目录不完整?)");
            return false;
        }

        const python = this.resolvePython();
        if (!python) {
            // 这条错误要让用户看见 —— 静默失败会表现为"点了运行没反应"
            this.setStatus("error", "未找到 Python。请安装 Python 3 并确保 python 在 PATH 中");
            return false;
        }

        this.setStatus("starting");

        let child: any;
        try {
            child = req("child_process").spawn(python.cmd, [...python.args, "-u", script], {
                cwd: this.workspaceCwd || undefined,
                env: {
                    ...process.env,
                    // 内核自己会把 stdout/stderr 改成 UTF-8,这里是双保险
                    PYTHONIOENCODING: "utf-8",
                    // 去掉用户 site-packages 里的 .pth 影响,保证启动可预测
                    PYTHONNOUSERSITE: "1",
                },
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (e: any) {
            this.setStatus("error", `启动失败: ${e?.message || e}`);
            return false;
        }

        this.proc = child;
        // -u 已保证无缓冲;这里再把解码固定为 UTF-8,
        // 否则 Windows 上 Node 会按 locale(cp936)解码,中文输出变乱码
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        // 内核的告警(比如 DeprecationWarning)走 stderr,单独收集便于排查,
        // 但**不能混进 stdout** —— 那会污染内核的 JSON 协议流
        let stderrTail = "";
        child.stderr.on("data", (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-4000);
        });

        let pendingLine = "";
        child.stdout.on("data", (chunk: string) => {
            pendingLine += chunk;
            let idx: number;
            while ((idx = pendingLine.indexOf("\n")) >= 0) {
                const line = pendingLine.slice(0, idx).trim();
                pendingLine = pendingLine.slice(idx + 1);
                if (!line) continue;
                try {
                    this.handleEvent(JSON.parse(line) as KernelEvent);
                } catch (e) {
                    console.warn("[siyuan-file-editor] 内核消息解析失败:", line.slice(0, 200), e);
                }
            }
        });

        child.on("error", (e: any) => {
            this.setStatus("error", `进程错误: ${e?.message || e}`);
        });
        child.on("exit", (code: number) => {
            this.proc = null;
            this.failAllPending("内核进程已退出");
            this.readyWaiters.forEach((fn) => fn(false));
            this.readyWaiters.clear();
            if (!this.disposed) {
                const hint = stderrTail.trim() ? `\n${stderrTail.trim().slice(-300)}` : "";
                this.setStatus("error", `内核退出(code=${code})${hint}`);
            }
        });

        const ready = await this.waitForReady(15000);
        if (!ready) {
            this.setStatus("error", "内核启动超时(15s)");
            this.killProcess();
            return false;
        }
        this.setStatus("ready");
        return true;
    }

    /** 内核脚本位置:<插件目录>/syfe-kernel.py(打包时复制进去) */
    private findKernelScript(): string | null {
        const req = getNativeRequire();
        if (!req) return null;
        const fs = req("fs") as typeof import("fs");
        const path = req("path") as typeof import("path");
        const pluginDir = (window as any).__SIYUAN_FILE_EDITOR_DIR__ || "";
        if (!pluginDir) return null;
        const p = path.join(pluginDir, "syfe-kernel.py");
        try {
            return fs.existsSync(p) ? p : null;
        } catch {
            return null;
        }
    }

    /**
     * 探测可用的 Python。
     * 返回的第一个 PATH 命令直接交给 spawn 试(它自己会失败并给出 ENOENT),
     * 绝对路径候选则必须真实存在才算数。
     */
    private resolvePython(): {cmd: string; args: string[]} | null {
        const req = getNativeRequire();
        if (!req) return null;
        const fs = req("fs") as typeof import("fs");
        const path = req("path") as typeof import("path");
        const isWin = process.platform === "win32";

        // 绝对路径候选:存在才用
        const absCandidates: Array<{cmd: string; args: string[]}> = [];
        // PATH 命令候选:直接返回第一个,让 spawn 去试
        const pathCandidates: Array<{cmd: string; args: string[]}> = [];

        if (isWin) {
            const sysRoot = process.env.SystemRoot || "C:\\Windows";
            const pf = process.env.ProgramFiles || "C:\\Program Files";
            const localApp = process.env.LOCALAPPDATA || "";
            pathCandidates.push({cmd: "python", args: []});
            pathCandidates.push({cmd: "python3", args: []});
            absCandidates.push({cmd: path.join(sysRoot, "py.exe"), args: ["-3"]});
            for (const v of ["313", "312", "311", "310"]) {
                absCandidates.push({cmd: path.join(pf, `Python${v}`, "python.exe"), args: []});
                absCandidates.push({cmd: path.join(localApp, "Programs", "Python", `Python${v}`, "python.exe"), args: []});
            }
        } else {
            pathCandidates.push({cmd: "python3", args: []});
            pathCandidates.push({cmd: "python", args: []});
            absCandidates.push({cmd: "/usr/bin/python3", args: []});
            absCandidates.push({cmd: "/usr/local/bin/python3", args: []});
        }

        for (const c of absCandidates) {
            try {
                if (fs.existsSync(c.cmd)) return c;
            } catch {
                // 试下一个
            }
        }
        // PATH 上的命令无法预先探测,返回第一个让 spawn 决定;
        // 若它 ENOENT,child 的 error 事件会给出足够信息
        return pathCandidates[0] || null;
    }

    private waitForReady(timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            let done = false;
            const timer = (window as any).setTimeout(() => {
                if (done) return;
                done = true;
                this.readyWaiters.delete(fn);
                resolve(false);
            }, timeoutMs);
            const fn = (ok: boolean) => {
                if (done) return;
                done = true;
                (window as any).clearTimeout(timer);
                this.readyWaiters.delete(fn);
                resolve(ok);
            };
            this.readyWaiters.add(fn);
        });
    }

    // ===== 事件分发 =====

    private handleEvent(ev: KernelEvent): void {
        // 先记下 id —— switch 之后 TS 会把 ev 收窄到残余分支,
        // 直接用 ev.id 会被判成不存在,所以提前取出来。
        const evId = (ev as {id?: string}).id;

        switch (ev.type) {
            case "kernel_ready":
                this.info = {version: ev.version, executable: ev.executable};
                this.readyWaiters.forEach((fn) => fn(true));
                this.readyWaiters.clear();
                break;
            case "info_result":
                this.info = {version: ev.version, executable: ev.executable};
                break;
            default:
                break;
        }

// 把事件推给该 id 的请求(如果有)
   if (typeof evId === "string") {
     const entry = this.pending.get(evId);
         if (entry) {
    // 流式事件先累积(终态判定交给 isTerminal)。
      // **stream 的累加只能在这里做**:它是宿主端唯一收到 stream 的地方 ——
  // stream 不是终态事件,不会进 finish()。曾经漏了这个分支,
    // 表现为「代码执行成功、execution_count 也涨了,但 print 的内容一行都不显示」。
    // 内核侧有 80ms 节流,一次执行通常只来一两条,不会太碎。
     const e2 = ev as KernelEvent;
          if (e2.type === "stream") {
                if (e2.name === "stdout") entry.agg.acc.stdout += e2.text || "";
            else entry.agg.acc.stderr += e2.text || "";
       } else if (e2.type === "status" && e2.state === "idle") {
            if (typeof e2.execution_count === "number") {
        entry.agg.acc.executionCount = e2.execution_count;
                }
       }
                if (entry.agg.isTerminal(e2)) {
                    this.pending.delete(evId);
                    (window as any).clearTimeout(entry.timer);
                    let out: any;
                    try {
                        out = entry.agg.finish(e2, entry.agg.acc);
                    } catch {
                        out = null;
                    }
                    entry.resolve(out);
                }
            }
        }

        this.emit(ev);
    }

    private failAllPending(reason: string): void {
        this.pending.forEach((entry) => {
            (window as any).clearTimeout(entry.timer);
            entry.resolve({error: {ename: "KernelError", evalue: reason, traceback: []}});
        });
        this.pending.clear();
    }

    /**
     * 发一条请求,等它的终态事件。
     * @param isTerminal 哪个事件算"这次请求结束了"
     * @param finish 从终态事件算出返回值
     * @param timeoutMs 超时后 resolve 一个带错误的结果(不 reject,免得调用方到处 try/catch)
     * @param initial 累积器的初始值
     */
    private send<T>(
        msg: Record<string, any>,
        isTerminal: (ev: KernelEvent) => boolean,
        finish: (ev: KernelEvent, acc: ExecuteOutcome) => T,
        timeoutMs: number,
        initial?: Partial<ExecuteOutcome>,
    ): Promise<T | null> {
        const id = `r${++this.seq}`;
        const payload = {...msg, id};
        return new Promise<T | null>((resolve) => {
            const timer = (window as any).setTimeout(() => {
                this.pending.delete(id);
                resolve(null);
            }, timeoutMs);
            this.pending.set(id, {
                timer,
                resolve: resolve as (v: any) => void,
                agg: {
                    acc: {ok: false, executionCount: 0, stdout: "", stderr: "", ...(initial || {})},
                    isTerminal,
                    finish,
                },
            });
            try {
                this.proc?.stdin?.write(JSON.stringify(payload) + "\n");
            } catch (e) {
                this.pending.delete(id);
                (window as any).clearTimeout(timer);
                resolve(null);
            }
        });
    }

    // ===== 公开能力 =====

    /**
     * 执行一段代码。
     * 终态:execute_result(有返回值)/ error(抛异常)/ status-idle(什么都没有)。
     */
    async execute(
        code: string,
        opts?: {silent?: boolean; timeoutMs?: number},
    ): Promise<ExecuteOutcome | null> {
        if (!(await this.start())) return null;
        const timeout = opts?.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT;

        const outcome = await this.send<ExecuteOutcome>(
            {type: "execute", code, silent: !!opts?.silent},
            (ev) => ev.type === "execute_result" || ev.type === "error" ||
                (ev.type === "status" && ev.state === "idle"),
            (ev, acc) => {
                // 注意:这里**只处理终态事件**(execute_result / error / status-idle)。
                // stream 的累加在 handleEvent() 里做 —— stream 不是终态,
                // 不会走到这个函数,写在这里是死代码(曾经漏了 handleEvent 那边的
                // 分支,导致 print 输出全丢:表现为「执行成功、序号也涨了,
                // 但一行输出都没有」)。
                if (ev.type === "execute_result") {
                    acc.ok = true;
                    acc.executionCount = ev.execution_count;
                    acc.result = ev.data?.["text/plain"];
                    acc.richData = ev.data;
} else if (ev.type === "error") {
     acc.ok = false;
   // 出错的执行同样占一个序号(Jupyter 行为:报错的格也显示 In[n])。
        // 不取的话这一格会显示 In[0],而且序号会"卡住"不再递增 ——
  // 后面几格接着跑时用的还是同一个 count,序号就跟真实执行历史脱节了。
       if (typeof ev.execution_count === "number") {
   acc.executionCount = ev.execution_count;
    }
        acc.error = {ename: ev.ename, evalue: ev.evalue, traceback: ev.traceback || []};
   } else if (ev.type === "status") {
                    // status(busy 和 idle 都带 execution_count)才是序号的权威来源:
                    // execute_result 只在有末表达式时才有,整格只有 print 时就取不到号,
                    // 会把 In[n] 写成 In[0]。
                    if (typeof ev.execution_count === "number") {
                        acc.executionCount = ev.execution_count;
                    }
                    if (ev.state === "idle") {
                        // 本轮结束。没有 execute_result 说明没有末表达式
                        // (如整格只有 print),这是正常路径,不是失败。
                        acc.ok = acc.ok !== false;
                    }
                }
                return acc;
            },
            timeout,
        );

        if (!outcome) {
            // 超时:返回已累积的部分输出,用户能看到卡在哪
            const partial: ExecuteOutcome = {
                ok: false,
                executionCount: 0,
                stdout: "",
                stderr: "",
                error: {ename: "TimeoutError", evalue: `执行超过 ${timeout}ms 未完成`, traceback: []},
            };
            return partial;
        }

        // 成功且有代码 → 记进历史,供中断后重放
        if (!this.replaying && outcome.ok && code.trim()) {
            this.history.push({code, executionOrder: outcome.executionCount});
        }
        return outcome;
    }

    /** 补全。cursor 是模型内的字符偏移(不是行列)。 */
    async complete(code: string, cursor: number): Promise<CompleteOutcome | null> {
        if (!(await this.start())) return null;
        const res = await this.send<CompleteOutcome>(
            {type: "complete", code, cursor},
            (ev) => ev.type === "complete_result",
            (ev) => {
                const r = ev as Extract<KernelEvent, {type: "complete_result"}>;
                return {
                    matches: r.matches || [],
                    cursorStart: r.cursor_start,
                    cursorEnd: r.cursor_end,
                };
            },
            2500,
        );
        return res;
    }

    /** 内省(hover / signature / definition)。cursor 是字符偏移。 */
    async inspect(
        code: string,
        cursor: number,
        kind: "hover" | "signature" | "definition",
    ): Promise<InspectOutcome | null> {
        if (!(await this.start())) return null;
        // 泛型传 InspectOutcome | null:inspect_result 可能既无 content 也无
        // signature(光标位置没有可内省的东西),那时返回 null 表示"没有"
        const res = await this.send<InspectOutcome | null>(
            {type: "inspect", code, cursor, kind},
            (ev) => ev.type === "inspect_result",
            (ev) => {
                const r = ev as Extract<KernelEvent, {type: "inspect_result"}>;
                if (!r.content && !r.signature) return null;
                return {
                    content: r.content || "",
                    signature: r.signature,
                    name: r.name,
                    start: r.start,
                    end: r.end,
                };
            },
            2500,
        );
        return res;
    }

    /** 重置命名空间(对应 Jupyter 的「Restart Kernel」) */
    async reset(): Promise<boolean> {
        if (!(await this.start())) return false;
        const res = await this.send<boolean>(
            {type: "reset"},
            (ev) => ev.type === "reset_result",
            () => true,
            8000,
        );
        if (res) this.history = [];
        return !!res;
    }

    /** 取内核信息(Python 版本 + 可执行文件路径) */
    async info2(): Promise<KernelInfo | null> {
        if (!(await this.start())) return null;
        const res = await this.send<KernelInfo>(
            {type: "info"},
            (ev) => ev.type === "info_result",
            (ev) => {
                const r = ev as Extract<KernelEvent, {type: "info_result"}>;
                return {version: r.version, executable: r.executable};
            },
            5000,
        );
        if (res) this.info = res;
        return res || this.info;
    }

    /**
     * 中断当前执行。
     * 实现:杀进程 → 重建 → 按 execution_order 重放历史。
     */
    async interrupt(): Promise<void> {
        if (!this.proc) return;
        this.killProcess();
        const ok = await this.start();
        if (!ok || this.history.length === 0) return;

        this.replaying = true;
        try {
            const sorted = [...this.history].sort((a, b) => a.executionOrder - b.executionOrder);
            for (const h of sorted) {
                // 单格短超时:某段历史代码在新环境下出问题(比如文件没了)
                // 不能拖死整个重放
                await this.execute(h.code, {silent: true, timeoutMs: 15000});
            }
        } finally {
            this.replaying = false;
        }
    }

    /** 关闭内核(不重放) */
    async shutdown(): Promise<void> {
        this.disposed = true;
        this.killProcess();
        this.failAllPending("内核已关闭");
        this.status = "stopped";
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
        // Windows 上 SIGTERM 对 python 偶尔不生效,兜底强杀。
        // 只对自己 spawn 出来的 pid 调用 taskkill,不会波及无关进程。
        if (process.platform === "win32") {
            try {
                const pid = child.pid;
                if (pid && getNativeRequire()) {
                    getNativeRequire()!("child_process").execFileSync(
                        "taskkill",
                        ["/pid", String(pid), "/T", "/F"],
                        {stdio: "ignore"},
                    );
                }
            } catch {
                // 进程可能已自行退出
            }
        }
    }
}

// ===== 全局单例 =====

let singleton: PythonKernel | null = null;

/** 取全局内核(懒创建) */
export function getPythonKernel(): PythonKernel | null {
    if (!singleton) singleton = new PythonKernel();
    return singleton;
}

/** 关闭并清掉单例(插件卸载时调) */
export async function disposePythonKernel(): Promise<void> {
    if (!singleton) return;
    await singleton.shutdown();
    singleton = null;
}

/** Python 是否可用(探测解释器是否存在,不启动内核) */
export function isPythonAvailable(): boolean {
    const k = new PythonKernel();
    try {
        // 复用内核内部的探测逻辑:能解析出解释器就说明有
        return (k as any).resolvePython() !== null;
    } catch {
        return false;
    }
}