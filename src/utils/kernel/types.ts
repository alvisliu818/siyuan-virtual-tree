// 内核抽象层的类型定义(Phase 1)
//
// 这一层的意义:思源加载插件只有一次机会、失败还是静默的(异常被 try/catch 吞掉),
// 所以 backend 切换必须在**编译期**就被约束住,不能靠运行时试错。
//
// KernelClient 的成员是照 LegacyPythonKernel(原 python-kernel.ts 的 PythonKernel)
// 的现有公开 API 逐个抄下来的 —— 不虚构、不精简。抄完之后两者的差异就是
// Jupyter 后端真正需要补齐的东西,不会再有「以为对齐了结果漏了一个方法」的情况。

export type KernelStatus = "stopped" | "starting" | "ready" | "error";

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

/** 一次成功执行过的代码,中断重启后用于重放历史 */
export interface HistoryEntry {
    code: string;
    executionOrder: number;
}

/** 内核后端的种类 */
export type KernelKind = "jupyter" | "syfe";

/**
 * 内核后端必须实现的接口。
 *
 * 现有唯一实现是 LegacyPythonKernel(syfe-kernel.py 那条自用协议);
 * Phase 2 会加 JupiterKernel(Node 侧 zmq 直连)。两者在此接口下可互换,
 * 调用点只依赖 KernelClient,不需要知道背后是谁。
 */
export interface KernelClient {
    /** 后端标识,用于日志与 UI 展示 */
    readonly kind: KernelKind;

    /** 启动内核(幂等:已就绪直接返回 true) */
    start(): Promise<boolean>;
    execute(code: string, opts?: {silent?: boolean; timeoutMs?: number}): Promise<ExecuteOutcome | null>;
    complete(code: string, cursor: number): Promise<CompleteOutcome | null>;
    /**
     * 内省。
     * kind 在原实现里是必填 third param —— 界面上的 hover / 函数签名提示 /
     * 跳转定义三种用途由它区分。这里标成可选是为了让 Jupyter 后端可以按需忽略,
     * 但 Legacy 实现仍然要求它。
     */
    inspect(code: string, cursor: number, kind?: "hover" | "signature" | "definition"): Promise<InspectOutcome | null>;
    reset(): Promise<boolean>;
    info2(): Promise<KernelInfo | null>;
    interrupt(): Promise<void>;
    shutdown(): Promise<void>;

    onEvent(cb: KernelListener): () => void;
    onStatus(cb: StatusListener): () => void;

    readonly kernelInfo: KernelInfo | null;
    readonly currentStatus: KernelStatus;
    readonly isReady: boolean;
    readonly executedHistory: ReadonlyArray<HistoryEntry>;
}
