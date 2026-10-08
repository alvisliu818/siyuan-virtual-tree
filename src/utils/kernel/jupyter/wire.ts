// Jupyter wire protocol v5.3 编解码
//
// 帧结构(在 identities 之后):
//   <IDS|MSG 分隔符> <HMAC> <header> <parent_header> <metadata> <content> [buffer...]
// 其中四个 JSON 段都是 UTF-8 序列化的 JSON,HMAC-SHA256 按
//   header || parent_header || metadata || content
// 的顺序拼接待签字节,hexdigest 十六进制文本作为 HMAC 帧。
// 参考实现:jupyter_client/session.py 的 sign()/serialize()/deserialize()
// (已核对,sign 的是 msg_list[0:4] 四段,不是 docstring 里写的三段 —— docstring 过时了)。
//
// 为什么不直接 import "crypto":webpack 5 不自动 polyfill Node 内置模块,
// 插件里所有 Node 能力统一走 getNativeRequire()(见 native-require.ts),
// 这里的 crypto/net/fs 也一样,否则打包阶段就报错。

import {getNativeRequire} from "../../native-require";

/** 会话分隔符帧。收发双方都以它为界切掉 identity 部分 */
export const WIRE_DELIM = "<IDS|MSG>";

/** 我们实现的协议版本 */
const PROTOCOL_VERSION = "5.3";

/** 一个 Jupyter 消息头 */
export interface JupyterHeader {
    msg_id: string;
    session: string;
    username: string;
    date: string;
    msg_type: string;
    version: string;
}

/** 解析后的一条完整消息 */
export interface JupyterMsg {
    /** ROUTER 侧收到的 identity 帧(DEALER 侧收到时为空 —— 自己的 identity 已被剥掉) */
    identities: Buffer[];
    header: JupyterHeader;
    parent_header: Partial<JupyterHeader>;
    metadata: Record<string, unknown>;
    content: Record<string, unknown>;
    buffers: Buffer[];
}

/** 会话级参数:HMAC key 与本端 session id,构造后不再变 */
export interface WireSession {
    key: Buffer;
    sessionId: string;
    username: string;
}

let cachedCrypto: any = null;

function getCrypto(): any {
    if (cachedCrypto) return cachedCrypto;
    const req = getNativeRequire();
    if (!req) return null;
    try {
        cachedCrypto = req("crypto");
        return cachedCrypto;
    } catch {
        return null;
    }
}

/** 新建会话(每次 start 内核时调一次) */
export function createWireSession(key: Buffer): WireSession {
    const crypto = getCrypto();
    const sessionId = crypto ? crypto.randomBytes(8).toString("hex") : "session";
    return {key, sessionId, username: "siyuan-virtual-tree"};
}

/** 生成 msg_id。只需唯一,不需要符合 uuid 形态 */
export function newMsgId(): string {
    const crypto = getCrypto();
    return crypto ? crypto.randomBytes(16).toString("hex") : `id-${Date.now()}-${Math.random()}`;
}

/** 构造一个 header */
export function makeHeader(session: WireSession, msgType: string): JupyterHeader {
    return {
        msg_id: newMsgId(),
        session: session.sessionId,
        username: session.username,
        date: new Date().toISOString(),
        msg_type: msgType,
        version: PROTOCOL_VERSION,
    };
}

/**
 * 计算四段 JSON 的 HMAC-SHA256 hex。
 * 与 jupyter_client Session.sign 一致:对 header/parent/metadata/content 顺序拼接后求 hexdigest。
 */
export function signMessage(session: WireSession, parts: Buffer[]): string {
    if (!session.key || session.key.length === 0) return "";
    const crypto = getCrypto();
    if (!crypto) return "";
    const h = crypto.createHmac("sha256", session.key);
    for (const p of parts) h.update(p);
    return h.digest("hex");
}

function toBuffer(v: unknown): Buffer {
    const req = getNativeRequire()!;
    const b = req("buffer") as typeof import("buffer");
    if (b.Buffer.isBuffer(v)) return v as Buffer;
    return b.Buffer.from(typeof v === "string" ? v : JSON.stringify(v ?? {}), "utf8");
}

/**
 * 序列化一条消息为帧数组(**不含** identity 帧)。
 * DEALER 发给内核的 ROUTER 时,ZMQ 会自动在最前面加上我们的 identity。
 */
export function serializeMessage(
    session: WireSession,
    header: JupyterHeader,
    parentHeader: Partial<JupyterHeader> | null,
    metadata: Record<string, unknown> | null,
    content: Record<string, unknown> | null,
    buffers: Buffer[] = [],
): Buffer[] {
    const headerB = toBuffer(header);
    const parentB = toBuffer(parentHeader ?? {});
    const metaB = toBuffer(metadata ?? {});
    const contentB = toBuffer(content ?? {});
    const sig = signMessage(session, [headerB, parentB, metaB, contentB]);
    const req = getNativeRequire()!;
    const b = req("buffer") as typeof import("buffer");
    const frames: Buffer[] = [b.Buffer.from(WIRE_DELIM, "utf8"), b.Buffer.from(sig, "utf8"), headerB, parentB, metaB, contentB];
    for (const buf of buffers) frames.push(buf);
    return frames;
}

/**
 * 解析一帧序列。
 * @param frames 完整多帧(可能含 identity);至少要有 [DELIM, sig, header, parent, meta, content]
 * @returns 解析失败(HMAC 不符/段数不够)返回 null
 */
export function parseFrames(session: WireSession, frames: Buffer[]): JupyterMsg | null {
    // 找到 DELIM:之前的都是 identity
    let delimIdx = -1;
    const req = getNativeRequire()!;
    const b = req("buffer") as typeof import("buffer");
    for (let i = 0; i < frames.length; i++) {
        if (frames[i].toString("utf8") === WIRE_DELIM) {
            delimIdx = i;
            break;
        }
    }
    if (delimIdx < 0 || frames.length < delimIdx + 5) return null;

    const identities = frames.slice(0, delimIdx);
    const sig = frames[delimIdx + 1].toString("utf8");
    const headerB = frames[delimIdx + 2];
    const parentB = frames[delimIdx + 3];
    const metaB = frames[delimIdx + 4];
    const contentB = frames[delimIdx + 5];
    const buffers = frames.slice(delimIdx + 6);

    // 校验签名。签名不符直接丢弃 —— 内核和我们都用同一个 key,签不上说明串话了
    const expect = signMessage(session, [headerB, parentB, metaB, contentB]);
    if (session.key.length > 0 && expect !== sig) return null;

    try {
        const header = JSON.parse(headerB.toString("utf8")) as JupyterHeader;
        let parent: Partial<JupyterHeader> = {};
        try {
            parent = JSON.parse(parentB.toString("utf8")) || {};
        } catch {
            parent = {};
        }
        const metadata = JSON.parse(metaB.toString("utf8") || "{}") || {};
        const content = JSON.parse(contentB.toString("utf8") || "{}") || {};
        return {identities, header, parent_header: parent, metadata, content, buffers};
    } catch {
        return null;
    }
}
