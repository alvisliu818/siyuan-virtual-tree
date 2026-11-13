// IMAP 邮箱接入(QQ 邮箱 / 网易 163 / 126;桌面端专用)。
//
// 架构对齐 api/outlook-mail.ts,传输层换成 IMAP 协议(imapflow,纯 JS):
//   - 凭据:邮箱地址 + IMAP 授权码(QQ 设置→账户→开启 IMAP/SMTP;163 客户端授权密码)
//   - 连接:lazy connect + 会话内复用;QQ/163 要求客户端发送 ID 命令(imapflow
//     构造项 clientInfo 自动处理,否则报 Unsafe Login)
//   - 邮箱夹:client.list()(INBOX、Sent Messages、草稿箱…含中文自建夹)
//   - 邮件:邮箱夹内按 UID 倒序列 envelope(最新 200 封);正文取 text/plain,
//     缺失取 text/html 剥标签;附件按 bodyStructure disposition=attachment
//   - 只读源:邮件不提供编辑语义,写操作一律拒绝
//   - 移动端:webview 无 TCP 能力,所有操作报可读错误
// 虚拟路径:imap://<provider>/...(见 utils/imap-path.ts)。
import {DirEntry} from "../types";
import {imapPathParts, imapProviderRoot, isImapPath} from "../utils/imap-path";
import {isNodeModulesAvailable} from "../utils/native-require";
import {STORAGE_MAIL_CONFIG} from "../constants";

// ===== 配置 =====

export interface ImapMailConfig {
    provider: string;   // qq | 163 | 126
    user: string;       // 完整邮箱地址
    pass: string;       // IMAP 授权码(非登录密码)
    host?: string;      // 自定义服务器(可选;覆盖 provider 默认值)
    port?: number;
}

export interface ImapProviderInfo {
    key: string;
    label: string;
    host: string;
    port: number;
    domains: string[];
}

export const IMAP_PROVIDERS: ImapProviderInfo[] = [
    {key: "qq", label: "QQ 邮箱", host: "imap.qq.com", port: 993, domains: ["qq.com", "foxmail.com"]},
    {key: "163", label: "网易 163", host: "imap.163.com", port: 993, domains: ["163.com"]},
    {key: "126", label: "网易 126", host: "imap.126.com", port: 993, domains: ["126.com"]},
];

export function imapProviderOf(provider: string): ImapProviderInfo {
    return IMAP_PROVIDERS.find(p => p.key === provider) || IMAP_PROVIDERS[0];
}

// 模块状态挂 window 注册表:webpack 分块会把本模块求值两份(project_memory
// 「Monaco 单例」同款教训),连接成功后 mail 读取拿到的却是另一份空配置。
interface ImapMailState {
    config: ImapMailConfig;
    saver: ((data: string) => Promise<void>) | null;
    client: any;
    connectPromise: Promise<any> | null;
    connKey: string;
    listCache: Map<string, {ts: number; items: ImapMailListItem[]}>;
}

function imapStateOf(): ImapMailState {
    const w = window as any;
    if (!w.__syfeImapMail) {
        w.__syfeImapMail = {
            config: {provider: "qq", user: "", pass: ""},
            saver: null,
            client: null,
            connectPromise: null,
            connKey: "",
            listCache: new Map(),
        } as ImapMailState;
    }
    return w.__syfeImapMail;
}

function imapConfig(): ImapMailConfig {
    return imapStateOf().config;
}

export async function initImapMailStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    imapStateOf().saver = (data: string) => plugin.saveData(STORAGE_MAIL_CONFIG + "-imap", data);
    try {
        const raw = await plugin.loadData(STORAGE_MAIL_CONFIG + "-imap");
        if (raw) {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            imapStateOf().config = {...imapStateOf().config, ...parsed};
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载 IMAP 邮箱配置失败:", e);
    }
}

export function saveImapMailConfig(next: Partial<ImapMailConfig>): Promise<void> {
    imapStateOf().config = {...imapStateOf().config, ...next};
    // 配置变更:断开旧连接,下次操作重连
    void closeImapClient();
    const st = imapStateOf(); return st.saver ? st.saver(JSON.stringify(st.config)) : Promise.resolve();
}

export function getImapMailConfig(): ImapMailConfig {
    return imapStateOf().config;
}

export function isImapConfigured(): boolean {
    const cfg = imapConfig(); return !!(cfg.user && cfg.pass && cfg.provider);
}

// 动态引入 imapflow(纯 JS;桌面端 Node 环境可用)
async function loadImapFlow(): Promise<any> {
    if (!isNodeModulesAvailable()) {
        throw new Error("邮箱挂载仅桌面端可用(移动端 webview 没有 TCP/Node 能力)");
    }
    return await import("imapflow");
}

// ==== 连接管理 ====



function connKeyOf(cfg: ImapMailConfig = imapConfig()): string {
    const info = imapProviderOf(cfg.provider);
    return `${cfg.user}@${cfg.host || info.host}:${cfg.port || info.port}`;
}

async function closeImapClient(): Promise<void> {
    const st = imapStateOf();
    const c = st.client;
    st.client = null;
    st.connectPromise = null;
    st.connKey = "";
    if (c) {
        try {
            c.close();
        } catch {
            // 忽略
        }
    }
}

async function getImapClient(): Promise<any> {
    if (!isNodeModulesAvailable()) {
        throw new Error("邮箱挂载仅桌面端可用(移动端 webview 没有 TCP/Node 能力)");
    }
    if (!isImapConfigured()) {
        throw new Error("IMAP 邮箱未配置,请先填写邮箱地址与授权码");
    }
    const key = connKeyOf();
    const st2 = imapStateOf(); if (st2.client && st2.connKey === key) return st2.client;
    if (st2.connectPromise) return st2.connectPromise;
    const mod = await loadImapFlow();
    const ImapFlow = mod?.ImapFlow || mod?.default;
    if (typeof ImapFlow !== "function") throw new Error("imapflow 模块加载失败(构造器缺失)");
    const cfg = imapConfig();
    const info = imapProviderOf(cfg.provider);
    const client = new ImapFlow({
        host: cfg.host || info.host,
        port: cfg.port || info.port,
        secure: (cfg.port || info.port) === 993,
        auth: {user: cfg.user, pass: cfg.pass},
        clientInfo: {name: "SiYuan Virtual Tree", version: "1.0", vendor: "siyuan-virtual-tree"},
        logger: false,
        emitLogs: false,
    });
    client.on("error", () => {
        // 连接级错误(断网/超时):置空让下次操作重连
        if (imapStateOf().client === client) {
            imapStateOf().client = null;
            imapStateOf().connKey = "";
        }
    });
    const stC = imapStateOf();
    stC.connectPromise = (async () => {
        try {
            await client.connect();
            stC.client = client;
            stC.connKey = key;
            return client;
        } catch (e) {
            stC.connectPromise = null;
            const msg = String((e as any)?.message || e);
            console.error("[syfe-imap] connect failed:", msg);
            if (/auth|login|credentials/i.test(msg)) {
                throw new Error(`IMAP 登录失败(检查邮箱地址与授权码): ${msg}`);
            }
            throw new Error(`IMAP 连接失败: ${msg}`);
        }
    })();
    return stC.connectPromise;
}

// 在邮箱夹锁内执行操作(imapflow 要求 select/getMailboxLock)
async function withMailbox<T>(mailbox: string, fn: (client: any) => Promise<T>): Promise<T> {
    const client = await getImapClient();
    const lock = await client.getMailboxLock(mailbox);
    try {
        return await fn(client);
    } finally {
        lock.release();
    }
}

// 邮箱夹名转 vPath 路径段
function encSeg(s: string): string {
    return encodeURIComponent(String(s || ""));
}

function mailboxOf(provider: string, encMailbox: string): string {
    try {
        return decodeURIComponent(encMailbox);
    } catch {
        return encMailbox;
    }
}

// ==== 邮箱夹列表 ====

export async function imapListFolders(vPath: string): Promise<DirEntry[]> {
    const {provider} = imapPathParts(vPath);
    const client = await getImapClient();
    const list = await client.list();
    const entries: DirEntry[] = [];
    for (const box of list) {
        if (box.flags.has("\\Noselect")) continue; // 不可选中(层级占位)
        entries.push({
            name: String(box.name || box.path),
            isDir: true,
            size: 0,
            updated: "",
            path: imapProviderRoot(provider) + encSeg(String(box.path)),
        });
    }
    return entries;
}

// ==== 邮件列表 ====

export interface ImapMailListItem {
    uid: number;
    fileName: string;
    from: string;
    subject: string;
    received: string; // ISO
    hasAttachments: boolean;
}

const MAILBOX_LIST_RECENT = 200;

const MAIL_LIST_TTL = 60 * 1000;

function sanitizeFileName(s: string, max = 60): string {
    return s.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() || "(无主题)";
}

function imapMailFileName(from: string, subject: string, date: Date | string | undefined): string {
    const d = date ? new Date(date) : new Date(NaN);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = isFinite(d.getTime())
        ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
        : "00000000-0000";
    return `${stamp}-${sanitizeFileName(from, 24)}-${sanitizeFileName(subject, 48)}.md`;
}

// 列邮箱夹下的邮件(最新 MAILBOX_LIST_RECENT 封,时间倒序)
export async function imapListMessages(vPath: string): Promise<ImapMailListItem[]> {
    const {provider, segs} = imapPathParts(vPath);
    const mailbox = mailboxOf(provider, segs[0] || "INBOX");
    const cacheKey = provider + "/" + mailbox;
    const cached = imapStateOf().listCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MAIL_LIST_TTL) return cached.items;

    const items = await withMailbox(mailbox, async (client) => {
        const mb = client.mailbox; // 已选中
        const count = Number(mb?.exists) || 0;
        if (count === 0) return [];
        const seqFrom = Math.max(1, count - MAILBOX_LIST_RECENT + 1);
        const out: ImapMailListItem[] = [];
        for await (const msg of client.fetch(`${seqFrom}:*`, {uid: true, envelope: true, bodyStructure: true})) {
            const env = msg.envelope || {};
            const from = String(env.from?.[0]?.name || env.from?.[0]?.address || "(未知发件人)");
            const subject = String(env.subject || "(无主题)");
            const date = env.date || new Date();
            const hasAtt = (function walk(node) {
                if (!node) return false;
                if (node.disposition === "attachment") return true;
                return (node.childNodes || []).some(walk);
            })(msg.bodyStructure);
            const seen = out.some(x => x.fileName === imapMailFileName(from, subject, date));
            let fn = imapMailFileName(from, subject, date);
            if (seen) fn = fn.replace(/(\.md)?$/, "") + "-r.md";
            out.push({
                uid: Number(msg.uid) || 0,
                fileName: fn,
                from,
                subject,
                received: new Date(date).toISOString(),
                hasAttachments: hasAtt,
            });
        }
        // IMAP 序号升序 = 时间正序;树里最新在前
        out.reverse();
        return out;
    });
    const stL = imapStateOf(); if (stL.listCache.size > 60) stL.listCache.clear();
    imapStateOf().listCache.set(cacheKey, {ts: Date.now(), items});
    return items;
}

// 文件名 → uid(列表缓存反查)
async function resolveMailUid(vPath: string): Promise<{mailbox: string; uid: number; item: ImapMailListItem}> {
    const {provider, segs} = imapPathParts(vPath);
    const mailbox = mailboxOf(provider, segs[0] || "INBOX");
    const fileName = segs[1] || "";
    const items = await imapListMessages(imapProviderRoot(provider) + encSeg(mailbox));
    const hit = items.find(it => it.fileName === fileName);
    if (!hit) throw new Error(`邮件不存在或列表已过期: ${fileName}`);
    return {mailbox, uid: hit.uid, item: hit};
}

// ==== 正文与附件 ====

// HTML → 纯文本(与 outlook-mail.ts 同款规则)
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function streamToBuffer(stream: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on("data", (c: any) => chunks.push(c));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}

// 邮件正文 → Markdown(元信息头 + 正文 + 附件清单)
export async function imapRenderMarkdown(vPath: string): Promise<string> {
    try {
        return await imapRenderMarkdownInner(vPath);
    } catch (e) {
        console.error("[syfe-imap] render failed:", (e as Error)?.stack || (e as Error)?.message || e);
        throw e;
    }
}

async function imapRenderMarkdownInner(vPath: string): Promise<string> {
    const {provider, segs} = imapPathParts(vPath);
    const mailbox = mailboxOf(provider, segs[0] || "INBOX");
    const fileName = segs[1] || "";
    const items = await imapListMessages(vPath);
    const item = items.find(it => it.fileName === fileName);
    if (!item) throw new Error(`邮件不存在或列表已过期: ${fileName}`);

    const info = await withMailbox(mailbox, async (client) => {
        // bodyStructure 找 text/plain 与附件
        let text = "";
        let toAddr = "";
        let attachments: {part: string; name: string; size: number}[] = [];
        for await (const msg of client.fetch(String(item.uid), {uid: true, bodyStructure: true, envelope: true})) {
            const env = msg.envelope || {};
            toAddr = ((env.to || []) as any[]).map(a => a.address || "").filter(Boolean).join(", ");
            // 递归找 text/plain 叶子
            const findPlain = (node: any, id: string): string | null => {
                if (!node) return null;
                // imapflow 的 bodyStructure 节点没有 textContent 属性,按 type/subtype 判定
                if (node.type === "text" && node.subtype !== "html") return id;
                for (let i = 0; i < (node.childNodes || []).length; i++) {
                    const hit = findPlain(node.childNodes[i], id ? `${id}.${i + 1}` : String(i + 1));
                    if (hit) return hit;
                }
                return null;
            };
            // 单段邮件的根节点自身就是 part "1"(multipart 根无 id,子段才编号)
            const isMultipart = !!(msg.bodyStructure && msg.bodyStructure.childNodes && msg.bodyStructure.childNodes.length);
            const plainPart = findPlain(msg.bodyStructure, isMultipart ? "" : "1");
            if (plainPart) {
                const dl = await client.download(String(item.uid), plainPart, {uid: true});
                if (dl?.content) text = (await streamToBuffer(dl.content)).toString("utf8");
            } else {
                // text/plain 缺失:取 text/html 剥标签
                const findHtml = (node: any, id: string): string | null => {
                    if (!node) return null;
                    if (node.type === "text" && node.subtype === "html") return id;
                    for (let i = 0; i < (node.childNodes || []).length; i++) {
                        const hit = findHtml(node.childNodes[i], id ? `${id}.${i + 1}` : String(i + 1));
                        if (hit) return hit;
                    }
                    return null;
                };
                const htmlPart = findHtml(msg.bodyStructure, isMultipart ? "" : "1");
                if (htmlPart) {
                    const dl = await client.download(String(item.uid), htmlPart, {uid: true});
                    if (dl?.content) text = htmlToText((await streamToBuffer(dl.content)).toString("utf8"));
                }
            }
            // 附件
            const walkAtts = (node: any, id: string) => {
                if (!node) return;
                const myId = id;
                if (node.disposition === "attachment") {
                    attachments.push({
                        part: myId,
                        name: String(node.dispositionParams?.filename || node.name || `attachment-${myId}`),
                        size: Number(node.size) || 0,
                    });
                }
                (node.childNodes || []).forEach((c: any, i: number) => walkAtts(c, id ? `${id}.${i + 1}` : String(i + 1)));
            };
            walkAtts(msg.bodyStructure, "");
            void env;
        }
        return {text, attachments, toAddr};
    });

    const received = item.received ? new Date(item.received).toLocaleString() : "";
    const lines = [
        `# ${item.subject}`,
        "",
        `- 发件人: ${item.from}`,
        info.toAddr ? `- 收件人: ${info.toAddr}` : "",
        `- 时间: ${received}`,
        info.attachments.length ? `- 附件: ${info.attachments.map(a => `${a.name}(${formatSize(a.size)})`).join("、")}(同目录 .files/ 下可查看)` : "",
        "",
        "---",
        "",
        info.text || "(无正文)",
    ];
    return lines.filter(l => l !== "").join("\n");
}

function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ==== 附件 ====

export interface ImapAttachment {
    part: string;
    name: string;
    size: number;
}

export async function imapListAttachments(vPath: string): Promise<ImapAttachment[]> {
    const {provider, segs} = imapPathParts(vPath);
    const mailbox = mailboxOf(provider, segs[0] || "INBOX");
    const fileName = segs[1] || "";
    const items = await imapListMessages(vPath);
    const item = items.find(it => it.fileName === fileName);
    if (!item) throw new Error(`邮件不存在或列表已过期: ${fileName}`);
    return await withMailbox(mailbox, async (client) => {
        const attachments: ImapAttachment[] = [];
        for await (const msg of client.fetch(String(item.uid), {uid: true, bodyStructure: true})) {
            const walkAtts = (node: any, id: string) => {
                if (!node) return;
                if (node.disposition === "attachment") {
                    attachments.push({
                        part: id,
                        name: String(node.dispositionParams?.filename || node.name || `attachment-${id}`),
                        size: Number(node.size) || 0,
                    });
                }
                (node.childNodes || []).forEach((c: any, i: number) => walkAtts(c, id ? `${id}.${i + 1}` : String(i + 1)));
            };
            walkAtts(msg.bodyStructure, "");
        }
        return attachments;
    });
}

export async function imapDownloadAttachment(vPath: string): Promise<ArrayBuffer> {
    const {provider, segs} = imapPathParts(vPath);
    const mailbox = mailboxOf(provider, segs[0] || "INBOX");
    const fileName = segs[1] || "";
    const attName = segs[2] || "";
    const items = await imapListMessages(vPath);
    const item = items.find(it => it.fileName === fileName);
    if (!item) throw new Error(`邮件不存在或列表已过期: ${fileName}`);
    return await withMailbox(mailbox, async (client) => {
        const attachments: ImapAttachment[] = [];
        for await (const msg of client.fetch(String(item.uid), {uid: true, bodyStructure: true})) {
            const walkAtts = (node: any, id: string) => {
                if (!node) return;
                if (node.disposition === "attachment") {
                    attachments.push({
                        part: id,
                        name: String(node.dispositionParams?.filename || node.name || `attachment-${id}`),
                        size: Number(node.size) || 0,
                    });
                }
                (node.childNodes || []).forEach((c: any, i: number) => walkAtts(c, id ? `${id}.${i + 1}` : String(i + 1)));
            };
            walkAtts(msg.bodyStructure, "");
        }
        const att = attachments.find(a => a.name === attName) || attachments.find(a => a.name.toLowerCase() === attName.toLowerCase());
        if (!att) throw new Error(`附件不存在: ${attName}`);
        const dl = await client.download(String(item.uid), att.part, {uid: true});
        if (!dl?.content) throw new Error(`附件下载失败: ${attName}`);
        const buf = await streamToBuffer(dl.content);
        const ab = new ArrayBuffer(buf.length);
        new Uint8Array(ab).set(buf);
        return ab;
    });
}

// ==== 虚拟树目录装配(readDir 入口)====

export async function imapListDir(vPath: string): Promise<DirEntry[]> {
    if (!isNodeModulesAvailable()) {
        throw new Error("邮箱挂载仅桌面端可用(移动端 webview 没有 TCP/Node 能力)");
    }
    if (!isImapPath(vPath)) throw new Error(`不是 IMAP 邮箱路径: ${vPath}`);
    const {provider, segs} = imapPathParts(vPath);
    // 根:邮箱夹列表
    if (!segs.length) return await imapListFolders(vPath);
    // 附件目录:"/<mailbox>/<邮件>.files"
    if (segs[1] && segs[1].endsWith(".files")) {
        const mailVPath = imapProviderRoot(provider) + encSeg(segs[0]) + "/" + encSeg(segs[1].replace(/\.files$/, ""));
        const atts = await imapListAttachments(mailVPath);
        return atts.map(a => ({
            name: a.name,
            isDir: false,
            size: a.size,
            updated: "",
            path: imapProviderRoot(provider) + encSeg(segs[0]) + "/" + encSeg(segs[1]) + "/" + encSeg(a.name),
        }));
    }
    // 邮箱夹:邮件列表(带附件邮件附加 .files 目录)
    const items = await imapListMessages(vPath);
    const entries: DirEntry[] = [];
    for (const it of items) {
        entries.push({
            name: it.fileName,
            isDir: false,
            size: 0,
            updated: it.received,
            path: imapProviderRoot(provider) + encSeg(segs[0]) + "/" + encSeg(it.fileName),
        });
        if (it.hasAttachments) {
            entries.push({
                name: it.fileName.replace(/\.md$/, "") + ".files",
                isDir: true,
                size: 0,
                updated: it.received,
                path: imapProviderRoot(provider) + encSeg(segs[0]) + "/" + encSeg(it.fileName.replace(/\.md$/, "") + ".files"),
            });
        }
    }
    return entries;
}

// 读邮件文件(.md)或附件
export async function imapReadFile(vPath: string): Promise<string | ArrayBuffer> {
    if (!isNodeModulesAvailable()) {
        throw new Error("邮箱挂载仅桌面端可用(移动端 webview 没有 TCP/Node 能力)");
    }
    if (!isImapPath(vPath)) throw new Error(`不是 IMAP 邮箱路径: ${vPath}`);
    const {segs} = imapPathParts(vPath);
    if (segs[1] && segs[1].endsWith(".files") && segs[2]) {
        return await imapDownloadAttachment(vPath);
    }
    return await imapRenderMarkdown(vPath);
}
