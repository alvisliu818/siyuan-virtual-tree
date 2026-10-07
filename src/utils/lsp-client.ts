// 零依赖 LSP(Language Server Protocol)客户端
//
// 为什么不用 monaco-languageclient(实测结论,勿改回去):
//   它硬依赖 `vscode@20.2.1` —— 一整套 VS Code API 垫片,里面有大量对 Node
//   环境的假设(global、require、Buffer 的用法)和对 DOM 的假设。思源是
//   Electron 渲染进程,没有 `global`,这套垫片跑不起来。连带还会拖进
//   vscode-languageclient / vscode-jsonrpc 等 9 个 vscode* 包。
//
// 为什么不用 vscode-languageserver-protocol:
//   它把协议编解码放在 node 子路径下,主入口只导出类型(编译期就没了),
//   运行时拿不到 StreamMessageReader,等于还是得自己写流处理。
//
// 而 LSP 的传输协议本身极简(实测跑通 pyright 1.1.414 全部核心能力):
//   请求: Content-Length: <字节数>\r\n\r\n<JSON>
//   响应: 同格式;通知无 id;服务端请求也带 id(需要回 result 或 error)
//
// 所以这里手写:`LspConnection` 负责帧协议与请求-响应配对,
// `PythonLanguageServer` 负责 pyright 的启动/初始化/文档同步。

import {getNativeRequire} from "./native-require";

// ===== LSP 协议常量(只声明用得到的,避免照抄整份 spec) =====

/** LSP 的 Position:行/列都是 **0-based**,列是 UTF-16 码元数(不是字节!) */
export interface LspPosition {
    line: number;
    character: number;
}

export interface LspRange {
    start: LspPosition;
    end: LspPosition;
}

export interface LspLocation {
    uri: string;
    range: LspRange;
}

export interface LspDiagnostic {
    range: LspRange;
    severity?: number;  // 1=Error 2=Warning 3=Info 4=Hint
    code?: string | number;
    source?: string;
    message: string;
}

export interface LspCompletionItem {
    label: string;
    kind?: number;
    detail?: string;
    documentation?: string | {kind: string; value: string};
    sortText?: string;
    filterText?: string;
    insertText?: string;
    insertTextFormat?: number;  // 1=PlainText 2=Snippet
    textEdit?: {range: LspRange; newText: string};
    data?: any;
}

export interface LspSymbol {
    name: string;
    kind: number;
    range: LspRange;
    selectionRange: LspRange;
    detail?: string;
    children?: LspSymbol[];
}

export interface LspHover {
    contents: string | {kind: string; value: string} | Array<string | {kind: string; value: string}>;
    range?: LspRange;
}

export interface LspSignatureHelp {
    signatures: Array<{
        label: string;
        documentation?: string | {kind: string; value: string};
        parameters?: Array<{label: string | [number, number]; documentation?: string}>;
    }>;
    activeSignature?: number;
    activeParameter?: number;
}

// ===== JSON-RPC 连接 =====

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: number;
    method: string;
}

/**
 * 一条 LSP 连接。
 *
 * 帧处理要点(踩过的坑):
 *   1. `Content-Length` 是**字节数**,不是字符数。中文注释会让字符串长度
 *      小于字节数,算错了服务端就解析失败。这里全程用 Buffer 算。
 *   2. 粘包:一次 `data` 事件可能带多个完整帧,也可能只带半个。必须循环切分,
 *      剩下的挂到下一次。
 *   3. 服务端也会**主动发请求**(如 `workspace/configuration`、`client/registerCapability`),
 *      带 id 但没有 result —— 必须回响应,否则服务端会一直等,表现为「补全能用
 *      但诊断永远不返回」。
 */
export class LspConnection {
    private seq = 0;
    private buffer: Uint8Array = new Uint8Array(0);
    private pending = new Map<number, Pending>();
    /** method -> handler。handler 返回值会作为 result 回给服务端 */
    private serverRequestHandlers = new Map<string, (params: any) => any>();
    private notificationHandlers = new Map<string, (params: any) => void>();
    private closed = false;

    constructor(
        private readonly writeBytes: (data: Uint8Array) => void,
        private readonly debugPrefix = "lsp",
    ) {
    }

    /** 注册服务端->客户端请求的处理(如 client/registerCapability) */
    onServerRequest(method: string, handler: (params: any) => any): void {
        this.serverRequestHandlers.set(method, handler);
    }

    /** 注册服务端->客户端通知的处理(如 textDocument/publishDiagnostics) */
    onNotification(method: string, handler: (params: any) => void): void {
        this.notificationHandlers.set(method, handler);
    }

    /**
     * 发请求并等响应。
     * timeoutMs 到期 reject —— 绝不能无限等:pyright 首次索引大目录要几十秒,
     * UI 上表现为"卡住",不如超时后走兜底(内核的静态补全)。
     */
    request<T = any>(method: string, params: any, timeoutMs = 15000): Promise<T> {
        if (this.closed) return Promise.reject(new Error("LSP 连接已关闭"));
        const id = ++this.seq;
        const payload = {jsonrpc: "2.0", id, method, params};
        return new Promise<T>((resolve, reject) => {
            const timer = (window as any).setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} 超时(${timeoutMs}ms)`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: resolve as any,
                reject,
                timer,
                method,
            });
            this.send(payload);
        });
    }

    /** 发通知(无响应) */
    notify(method: string, params?: any): void {
        this.send({jsonrpc: "2.0", method, params});
    }

    private send(obj: any): void {
        const json = JSON.stringify(obj);
        const body = new TextEncoder().encode(json);
        const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
        const out = new Uint8Array(header.length + body.length);
        out.set(header, 0);
        out.set(body, header.length);
        try {
            this.writeBytes(out);
        } catch (e) {
            console.warn(`[siyuan-file-editor] ${this.debugPrefix} 写入失败:`, e);
        }
    }

    /** 喂入一段来自服务端的原始字节(内部按 Content-Length 切帧) */
    feed(chunk: Uint8Array): void {
        // 拼进缓冲区
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;

        const decoder = new TextDecoder("utf-8");
        for (;;) {
            // 找头结束
            let headerEnd = -1;
            for (let i = 0; i + 3 < this.buffer.length; i++) {
                // \r\n\r\n
                if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 &&
                    this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) {
                    headerEnd = i;
                    break;
                }
            }
            if (headerEnd < 0) return; // 头还没收全

            const headerStr = decoder.decode(this.buffer.subarray(0, headerEnd));
            const m = /content-length:\s*(\d+)/i.exec(headerStr);
            if (!m) {
                // 头里没有 Content-Length:丢弃这段头,继续找下一帧
                // (不应该发生;真发生了也不能死循环)
                console.warn(`[siyuan-file-editor] ${this.debugPrefix} 帧头缺少 Content-Length:`, headerStr);
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            const contentLength = Number(m[1]);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + contentLength) {
                return; // 体还没收全,等下一批
            }
            const body = decoder.decode(this.buffer.subarray(bodyStart, bodyStart + contentLength));
            this.buffer = this.buffer.subarray(bodyStart + contentLength);
            try {
                this.handleMessage(JSON.parse(body));
            } catch (e) {
                console.warn(`[siyuan-file-editor] ${this.debugPrefix} 消息解析失败:`, body.slice(0, 200), e);
            }
        }
    }

    private handleMessage(msg: any): void {
        // 1) 有 id 且有 result/error → 对我们请求的响应
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            (window as any).clearTimeout(p.timer);
            if (msg.error) {
                p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
            } else {
                p.resolve(msg.result);
            }
            return;
        }
        // 2) 有 id 无 result → 服务端请求,要回响应
        if (msg.id !== undefined && msg.method) {
            const handler = this.serverRequestHandlers.get(msg.method);
            if (!handler) {
                // 未处理:回 MethodNotFound(-32601),别让服务端干等
                this.send({jsonrpc: "2.0", id: msg.id, error: {code: -32601, message: "method not found"}});
                return;
            }
            try {
                const result = handler(msg.params);
                this.send({jsonrpc: "2.0", id: msg.id, result: result ?? null});
            } catch (e: any) {
                this.send({jsonrpc: "2.0", id: msg.id, error: {code: -32603, message: String(e?.message || e)}});
            }
            return;
        }
        // 3) 通知
        if (msg.method) {
            const handler = this.notificationHandlers.get(msg.method);
            if (handler) {
                try {
                    handler(msg.params);
                } catch (e) {
                    console.warn(`[siyuan-file-editor] ${this.debugPrefix} 通知处理失败:`, e);
                }
            }
        }
    }

    /** 连接已断:所有在途请求立即失败,否则调用方会一直等超时 */
    dispose(reason = "连接关闭"): void {
        this.closed = true;
        this.pending.forEach((p) => {
            (window as any).clearTimeout(p.timer);
            p.reject(new Error(reason));
        });
        this.pending.clear();
        this.serverRequestHandlers.clear();
        this.notificationHandlers.clear();
        this.buffer = new Uint8Array(0);
    }

    get isClosed(): boolean {
        return this.closed;
    }
}

// ===== 文件路径 <-> URI =====

/**
 * 系统绝对路径 → `file://` URI。
 *
 * 必须用 Node 的 `url.pathToFileURL`,不能手拼字符串(实测踩过):
 * 手拼 `"file:///" + p.replace(/\\/g, "/")` 在 Windows 上会得到
 * `file:///d%3A/C/...` —— 盘符的冒号被编码了。pyright 会因此报
 * `File or directory does not exist` 并放弃索引,症状是
 * **单文件补全能用、但跳转定义找不到跨文件符号**,极具迷惑性。
 */
export function pathToUri(fsPath: string): string {
    const req = getNativeRequire();
    if (req) {
        try {
            const urlMod = req("url") as typeof import("url");
            return urlMod.pathToFileURL(fsPath).toString();
        } catch {
            // 落到下面的手工实现
        }
    }
    // 兜底:至少把冒号和空格处理对
    let p = fsPath.split("\\").join("/");
    if (!p.startsWith("/")) p = "/" + p;
    return "file://" + encodeURI(p).replace(/#/g, "%23");
}

/** `file://` URI → 系统绝对路径 */
export function uriToPath(uri: string): string {
    const req = getNativeRequire();
    if (req) {
        try {
            const urlMod = req("url") as typeof import("url");
            return urlMod.fileURLToPath(uri);
        } catch {
            // 落到下面
        }
    }
    let p = uri.replace(/^file:\/\//, "");
    try {
        p = decodeURIComponent(p);
    } catch {
        // 保持原样
    }
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p.split("/").join("\\");
}