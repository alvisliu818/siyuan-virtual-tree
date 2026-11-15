// 局域网同步·设备隧道(agent):让跑不了 HTTP 服务端的一端(移动端没有 Node、
// 浏览器环境不能监听 TCP,思源 Android 内核也只听 127.0.0.1:6806)也能当**服务端角色**。
//
// 原理:agent 主动 WebSocket 连到对端 server(能连出,不需要被连),
// 注册自己要共享的任务根(rootId = "agent:<deviceId>:<taskId>");
// server 把对端客户端的 list/read/write/delete 请求经隧道转发给 agent,
// agent 用思源内核 API(readDir/getFile/putFile/removeFile)执行后回传。
// 对客户端完全透明 —— ping 的 roots 聚合了 agent 根,客户端任务选中即可同步,
// 双向/push/pull 全部成立(手机改动可被桌面拉取,桌面改动可推到手机)。
//
// 协议(JSON 文本帧):
//   agent → server  首帧 {type:"register", device, roots:[{id,name}]}
//   server → agent  {type:"req", reqId, op:"list"|"read"|"write"|"delete", rootId, rel?, dataBase64?, mtimeMs?}
//   agent → server  {type:"res", reqId, ok, files?|data?|...|error?}
// 心跳:server 30s 发 ping 帧(浏览器 WebSocket 自动回 pong),90s 无响应断开。
import {getNativeRequire} from "../utils/native-require";
import type {Plugin} from "siyuan";

// Plugin 泛型上没有 config 字段(插件实例才有),统一收窄
type PluginWithConfig = Plugin & {config: any};

// ===== agent 配置(存配置里的 lanSyncAgent JSON 串) =====

export interface LanSyncAgentConfig {
    enabled: boolean;
    serverUrl: string;   // 对端 server,http://IP:port(自动转 ws://)
    token: string;       // 对端 server 的同步令牌
    device: string;      // 设备名(默认 "移动端"/"Device")
    deviceId: string;    // 本机稳定 id(自动生成)
}

export function parseAgentConfig(raw: string | undefined): LanSyncAgentConfig {
    const fallback: LanSyncAgentConfig = {enabled: false, serverUrl: "", token: "", device: "", deviceId: ""};
    if (!raw) return fallback;
    try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object") return fallback;
        return {
            enabled: data.enabled === true,
            serverUrl: String(data.serverUrl || ""),
            token: String(data.token || ""),
            device: String(data.device || ""),
            deviceId: String(data.deviceId || ""),
        };
    } catch {
        return fallback;
    }
}

export function serializeAgentConfig(c: LanSyncAgentConfig): string {
    return JSON.stringify(c);
}

// ===== server 侧:手写 RFC6455 WebSocket(node socket) =====
// 不引第三方包:思源桌面没有可靠的 ws 模块来源,native require 不可依赖。

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// server → client 出站帧不加密掩码;支持 16/64-bit 扩展长度(大文件 base64 单帧可达数十 MB)
function wsEncodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN=1
    return Buffer.concat([header, payload]);
}

type WsMessageHandler = (data: string) => void;

class WsServerConn {
    private socket: any;
    private buffer: Buffer = Buffer.alloc(0);
    private fragments: Buffer[] = [];   // 分片拼接(opcode 1 起,0 续,FIN 收口)
    onMessage: WsMessageHandler | null = null;
    onClose: (() => void) | null = null;
    lastPongTs = Date.now();
    alive = true;

    constructor(socket: any) {
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => {
            this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
            this.drain();
        });
        socket.on("close", () => this.destroy());
        socket.on("error", () => this.destroy());
        socket.on("end", () => this.destroy());
    }

    private destroy(): void {
        if (!this.alive) return;
        this.alive = false;
        try {
            this.socket.destroy();
        } catch { /* 忽略 */ }
        this.onClose?.();
    }

    // 逐帧解析:while 循环消化缓冲区内所有完整帧
    private drain(): void {
        const buf = this.buffer;
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
        } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return; // 帧未收齐,等下一块
        let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
            const mask = buf.subarray(offset, offset + 4);
            const un = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
            payload = un;
        }
        this.buffer = buf.subarray(offset + maskLen + len);

        if (opcode === OP_PING) {
            this.sendRaw(wsEncodeFrame(OP_PONG, payload));
        } else if (opcode === OP_PONG) {
            this.lastPongTs = Date.now();
        } else if (opcode === OP_CLOSE) {
            this.sendRaw(wsEncodeFrame(OP_CLOSE, Buffer.alloc(0)));
            this.destroy();
            return;
        } else if (opcode === OP_TEXT || opcode === 0) {
            // 文本帧/延续帧:分片拼接,FIN 收口才交给 onMessage
            this.fragments.push(payload);
            if (fin) {
                const whole = Buffer.concat(this.fragments).toString("utf8");
                this.fragments = [];
                try {
                    this.onMessage?.(whole);
                } catch (e) {
                    console.error("[syfe-lan-agent] 处理 agent 消息失败:", e);
                }
            }
        }
        // 未知的控制帧忽略
        if (this.buffer.length >= 2 && this.alive) this.drain();
    }

    private sendRaw(frame: Buffer): void {
        if (!this.alive) return;
        try {
            this.socket.write(frame);
        } catch {
            this.destroy();
        }
    }

    sendText(text: string): void {
        this.sendRaw(wsEncodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
    }

    sendPing(): void {
        this.sendRaw(wsEncodeFrame(OP_PING, Buffer.alloc(0)));
    }
}

// ===== agent 注册表(server 侧) =====

interface AgentEntry {
    device: string;
    conn: WsServerConn;
    roots: Array<{id: string; name: string}>;
}

const agents = new Map<number, AgentEntry>();
let agentSeq = 0;
let heartbeatTimer: any = null;

export interface AgentRoot {
    id: string;
    name: string;
}

// 所有 agent 上报的共享根(ping 时与 server 本地根聚合)
export function agentRootsAll(): AgentRoot[] {
    const out: AgentRoot[] = [];
    for (const a of agents.values()) {
        for (const r of a.roots) out.push(r);
    }
    return out;
}

export function findAgentForRoot(rootId: string): AgentEntry | null {
    for (const a of agents.values()) {
        if (a.roots.some(r => r.id === rootId)) return a;
    }
    return null;
}

// 转发请求到 agent(60s 超时;reqId 单调递增,resp 按 reqId 配对)
let fwdSeq = 0;
const pendingFwd = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void; timer: any}>();

export function forwardToAgent(agent: AgentEntry, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!agent.conn.alive) {
            reject(new Error(`agent「${agent.device}」已断开`));
            return;
        }
        const reqId = ++fwdSeq;
        const timer = setTimeout(() => {
            pendingFwd.delete(reqId);
            reject(new Error(`agent「${agent.device}」响应超时`));
        }, 60000);
        pendingFwd.set(reqId, {resolve, reject, timer});
        agent.conn.sendText(JSON.stringify({type: "req", reqId, ...payload}));
    });
}

function handleAgentMessage(entry: AgentEntry, conn: WsServerConn, text: string): void {
    let msg: any;
    try {
        msg = JSON.parse(text);
    } catch {
        return;
    }
    if (msg.type === "register") {
        entry.device = String(msg.device || "agent");
        entry.roots = Array.isArray(msg.roots)
            ? msg.roots.filter((r: any) => r && typeof r.id === "string").map((r: any) => ({id: String(r.id), name: String(r.name || r.id)}))
            : [];
        return;
    }
    if (msg.type === "res" && typeof msg.reqId === "number") {
        const p = pendingFwd.get(msg.reqId);
        if (!p) return;
        pendingFwd.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "agent 执行失败")));
    }
}

// HTTP server 的 upgrade 事件入口:校验令牌(query token,浏览器 WebSocket 不能带自定义头)→ 完成握手
export function handleAgentUpgrade(req: any, socket: any, serverToken: string): void {
    const url = String(req.url || "");
    const query = new URLSearchParams(url.split("?")[1] || "");
    const token = query.get("token") || "";
    if (!serverToken || token !== serverToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
    }
    const key = String(req.headers["sec-websocket-key"] || "");
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
    }
    const nreq = getNativeRequire();
    if (!nreq) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
    }
    const crypto = nreq("crypto");
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new WsServerConn(socket);
    const entry: AgentEntry = {device: "agent", conn, roots: []};
    const id = ++agentSeq;
    conn.onMessage = (text) => handleAgentMessage(entry, conn, text);
    conn.onClose = () => {
        agents.delete(id);
        // 清掉挂在这个 agent 上的等待请求
        for (const [reqId, p] of Array.from(pendingFwd.entries())) {
            // 无法区分是哪个 agent 的请求;断线统一由 60s 超时兜底,这里不重复 reject
            void reqId;
            void p;
        }
        if (agents.size === 0) stopAgentHeartbeat();
    };
    agents.set(id, entry);
    startAgentHeartbeat();
}

function startAgentHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const a of Array.from(agents.values())) {
            if (!a.conn.alive || now - a.conn.lastPongTs > 90000) {
                a.conn.alive = false;
                try {
                    a.conn.sendText("");
                } catch { /* 忽略 */ }
                try {
                    (a.conn as any).socket?.destroy?.();
                } catch { /* 忽略 */ }
                continue;
            }
            a.conn.sendPing();
        }
    }, 30000);
    // 不占用事件循环(node http server 已持有引用)
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

function stopAgentHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ===== agent 客户端(浏览器/移动端通用:原生 WebSocket + 内核 API) =====
// 执行器由外部注入(index.ts 用 lan-sync.ts 导出的本地执行器装配),
// 本模块不 import lan-sync,避免模块循环。

let runtime: {
    execOp: (op: string, rootId: string, args: any) => Promise<any>;
    getRoots: () => AgentRoot[];
} | null = null;

export function initLanSyncAgentRuntime(r: {execOp: (op: string, rootId: string, args: any) => Promise<any>; getRoots: () => AgentRoot[]}): void {
    runtime = r;
}

let agentWs: WebSocket | null = null;
let agentReconnectTimer: any = null;
let agentState: "off" | "connecting" | "connected" | "error" = "off";
let agentLastError = "";

export function lanSyncAgentStatus(): {state: string; error: string} {
    return {state: agentState, error: agentLastError};
}

function agentServerWsUrl(serverUrl: string): string {
    const base = (serverUrl || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    const ws = /^https:\/\//i.test(base) ? "wss://" + base.slice(8) : "ws://" + base.replace(/^http:\/\//i, "");
    return ws + "/api/lan-sync/agent";
}

function agentConnect(plugin: PluginWithConfig): void {
    const cfg = parseAgentConfig(plugin.config?.lanSyncAgent);
    const url = agentServerWsUrl(cfg.serverUrl);
    if (!url || !runtime) {
        agentState = "error";
        agentLastError = !url ? "未配置服务端地址" : "agent 运行时未初始化";
        return;
    }
    agentState = "connecting";
    try {
        const ws = new WebSocket(url + `?token=${encodeURIComponent(cfg.token)}`);
        agentWs = ws;
        ws.onopen = () => {
            agentState = "connected";
            agentLastError = "";
            // 注册:本机全部任务作为共享根,rootId 带 agent: 前缀保证全局唯一
            const roots = (runtime!.getRoots() || []).map(r => ({
                id: r.id,
                name: (cfg.device || "设备") + " · " + r.name,
            }));
            ws.send(JSON.stringify({type: "register", device: cfg.device || "设备", roots}));
        };
        ws.onmessage = (ev) => {
            let msg: any;
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.type !== "req" || !runtime) return;
            const reqId = msg.reqId;
            void (async () => {
                try {
                    const result = await runtime!.execOp(String(msg.op || ""), String(msg.rootId || ""), msg);
                    ws.send(JSON.stringify({type: "res", reqId, ok: true, result}));
                } catch (e) {
                    ws.send(JSON.stringify({type: "res", reqId, ok: false, error: String((e as Error)?.message || e)}));
                }
            })();
        };
        ws.onclose = () => {
            if (agentWs === ws) {
                agentWs = null;
                scheduleReconnect(plugin);
            }
        };
        ws.onerror = () => {
            agentState = "error";
            agentLastError = "连接失败(检查服务端地址/令牌/防火墙)";
        };
    } catch (e) {
        agentState = "error";
        agentLastError = String((e as Error)?.message || e);
        scheduleReconnect(plugin);
    }
}

function scheduleReconnect(plugin: PluginWithConfig): void {
    if (agentReconnectTimer) return;
    agentState = agentState === "connected" ? "connecting" : agentState;
    agentReconnectTimer = setTimeout(() => {
        agentReconnectTimer = null;
        const cfg = parseAgentConfig(plugin.config?.lanSyncAgent);
        if (cfg.enabled) agentConnect(plugin);
    }, 5000);
}

// 启动 agent(幂等:已连接先断再连)
export function startLanSyncAgent(plugin: PluginWithConfig): void {
    stopLanSyncAgent();
    const cfg = parseAgentConfig(plugin.config?.lanSyncAgent);
    if (!cfg.enabled) return;
    if (!cfg.deviceId) {
        cfg.deviceId = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        plugin.config.lanSyncAgent = serializeAgentConfig(cfg);
        void import("../utils/config").then(async ({saveConfig}) => {
            await saveConfig(plugin, plugin.config);
        });
    }
    agentConnect(plugin);
}

export function stopLanSyncAgent(): void {
    if (agentReconnectTimer) {
        clearTimeout(agentReconnectTimer);
        agentReconnectTimer = null;
    }
    if (agentWs) {
        const ws = agentWs;
        agentWs = null;
        try {
            ws.onclose = null;
            ws.close();
        } catch { /* 忽略 */ }
    }
    agentState = "off";
    agentLastError = "";
}
