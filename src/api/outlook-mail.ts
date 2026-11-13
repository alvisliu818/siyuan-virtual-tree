// Outlook 邮箱接入(微软 Graph Mail + 设备码授权;架构对齐 api/onedrive.ts)。
//
// 与 OneDrive 的关系:同一个 Azure 应用(client_id 复用 OneDrive 配置,未配时在
// 挂载对话框内单独填写),但 Mail.ReadWrite 权限对应独立的令牌 —— 单独配置存储,
// 授权流程独立实现(设备码,scope 含 Mail.ReadWrite)。
//
// 邮箱挂载是只读源:
//   outlook:///              顶层邮件文件夹(Inbox、Sent Items、Drafts…)
//   outlook:///<folder>      该文件夹的邮件列表(文件 = YYYYMMDD-HHMM-发件人-主题.md)
//   邮件文件                 正文转 Markdown(HTML 剥离)+ 元信息头 + 附件清单
//   <邮件>.files/<附件名>    附件内容(Graph attachments/$value,懒下载)
// 写操作(writeFile/mkdir/rename/remove)一律拒绝 —— 邮件不提供编辑语义。
import {DirEntry} from "../types";
import {isOutlookPath, outlookPathBody, OUTLOOK_PREFIX} from "../utils/outlook-path";
import {httpRequest} from "./http";
import {STORAGE_MAIL_CONFIG} from "../constants";

export const GRAPH = "https://graph.microsoft.com/v1.0";
// 邮件 scope:Mail.ReadWrite(读文件夹与邮件)+ offline_access(刷新令牌)
export const MAIL_SCOPE = "offline_access Mail.ReadWrite User.Read";

export interface OutlookMailConfig {
    clientId: string;
    authority: string;   // common | consumers | organizations
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    account?: string;
}

const DEFAULT_CONFIG: OutlookMailConfig = {
    clientId: "",
    authority: "common",
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
};

let mailConfig: OutlookMailConfig = {...DEFAULT_CONFIG};
let mailSaver: ((data: string) => Promise<void>) | null = null;

export async function initOutlookMailStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    mailSaver = (data: string) => plugin.saveData(STORAGE_MAIL_CONFIG, data);
    mailConfig = {...DEFAULT_CONFIG};
    try {
        const raw = await plugin.loadData(STORAGE_MAIL_CONFIG);
        if (raw) {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            mailConfig = {...DEFAULT_CONFIG, ...parsed};
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载 Outlook 邮箱配置失败:", e);
    }
}

export function saveOutlookMailConfig(next: Partial<OutlookMailConfig>): Promise<void> {
    mailConfig = {...mailConfig, ...next};
    return mailSaver ? mailSaver(JSON.stringify(mailConfig)) : Promise.resolve();
}

export function getOutlookMailConfig(): OutlookMailConfig {
    return mailConfig;
}

export function isOutlookMailConfigured(): boolean {
    return !!(mailConfig.clientId && (mailConfig.refreshToken || (mailConfig.accessToken && mailConfig.expiresAt > Date.now())));
}

// ==== 设备码授权(独立于 onedrive.ts:scope 与令牌存储不同)====

export interface MailDeviceAuth {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
}

function formEncode(fields: Record<string, string>): string {
    const parts: string[] = [];
    for (const k of Object.keys(fields)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]));
    }
    return parts.join("&");
}

function decodeJson(resp: {bytes: ArrayBuffer; status: number}, op: string): any {
    const text = new TextDecoder().decode(new Uint8Array(resp.bytes));
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${op}失败:响应不是 JSON(HTTP ${resp.status})`);
    }
}

function tokenErrorText(json: any): string {
    const code = String(json.error || "");
    if (code === "authorization_expired") return "授权码已过期,请重新发起授权";
    if (code === "access_denied") return "你在微软页面拒绝了授权";
    if (code === "invalid_client") return "应用(client) ID 无效,请检查设置";
    return json.error_description || code || "授权失败";
}

export async function mailStartDeviceAuth(clientId: string, tenant: string): Promise<MailDeviceAuth> {
    const resp = await httpRequest(
        `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0/devicecode`,
        {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: formEncode({client_id: clientId, scope: MAIL_SCOPE}),
        },
    );
    const json = decodeJson(resp, "发起设备码授权");
    if (!json.device_code || !json.user_code) {
        throw new Error(`发起设备码授权失败: ${json.error_description || json.error || "响应缺少 device_code"}`);
    }
    return {
        deviceCode: json.device_code,
        userCode: json.user_code,
        verificationUrl: json.verification_uri || "https://microsoft.com/devicelogin",
        interval: Number(json.interval) || 5,
    };
}

// 轮询授权结果:pending/slow/done;致命错误抛出。成功时令牌写入邮箱配置。
export async function mailPollDeviceAuth(auth: MailDeviceAuth): Promise<"pending" | "slow" | "done"> {
    const resp = await httpRequest(
        `https://login.microsoftonline.com/${mailConfig.authority || "common"}/oauth2/v2.0/token`,
        {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: formEncode({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: mailConfig.clientId,
                device_code: auth.deviceCode,
            }),
        },
    );
    const json = decodeJson(resp, "令牌请求");
    if (json.error) {
        if (json.error === "authorization_pending") return "pending";
        if (json.error === "slow_down") return "slow";
        throw new Error(tokenErrorText(json));
    }
    await saveOutlookMailConfig({
        accessToken: json.access_token,
        refreshToken: json.refresh_token || mailConfig.refreshToken,
        expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    });
    return "done";
}

async function refreshAccessToken(): Promise<void> {
    if (!mailConfig.refreshToken) throw new Error("Outlook 邮箱未授权或凭据已失效,请重新授权");
    const resp = await httpRequest(
        `https://login.microsoftonline.com/${mailConfig.authority || "common"}/oauth2/v2.0/token`,
        {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: formEncode({
                grant_type: "refresh_token",
                client_id: mailConfig.clientId,
                refresh_token: mailConfig.refreshToken,
                scope: MAIL_SCOPE,
            }),
        },
    );
    const json = decodeJson(resp, "刷新令牌");
    if (json.error) throw new Error(tokenErrorText(json));
    await saveOutlookMailConfig({
        accessToken: json.access_token,
        refreshToken: json.refresh_token || mailConfig.refreshToken,
        expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    });
}

async function ensureAccessToken(): Promise<string> {
    if (!mailConfig.accessToken || Date.now() > mailConfig.expiresAt - 60_000) {
        await refreshAccessToken();
    }
    return mailConfig.accessToken;
}

// ==== Graph Mail 请求 ====

function graphError(json: any, op: string, status: number): Error {
    const code = String(json?.error?.code || "");
    const msg = String(json?.error?.message || "");
    if (status === 401) return new Error(`${op}失败:令牌无效或已过期(401),请重新授权`);
    if (status === 404) return new Error(`${op}失败:邮件或文件夹不存在(404)`);
    return new Error(`${op}失败: ${msg || code || "HTTP " + status}`);
}

async function mailGraph<T = any>(method: string, graphPath: string): Promise<T> {
    const doReq = async (token: string) => await httpRequest(GRAPH + graphPath, {
        method,
        headers: {Authorization: `Bearer ${token}`, Accept: "application/json"},
    });
    let resp = await doReq(await ensureAccessToken());
    if (resp.status === 401) {
        await refreshAccessToken();
        resp = await doReq(await ensureAccessToken());
    }
    if (resp.status >= 400) {
        throw graphError(decodeJson(resp, "Graph Mail"), "Graph Mail", resp.status);
    }
    return decodeJson(resp, "Graph Mail") as T;
}

async function mailGraphBytes(graphPath: string): Promise<ArrayBuffer> {
    const doReq = async (token: string) => await httpRequest(GRAPH + graphPath, {
        method: "GET",
        headers: {Authorization: `Bearer ${token}`},
    });
    let resp = await doReq(await ensureAccessToken());
    if (resp.status === 401) {
        await refreshAccessToken();
        resp = await doReq(await ensureAccessToken());
    }
    if (resp.status >= 400) {
        throw graphError(decodeJson(resp, "Graph Mail"), "Graph Mail", resp.status);
    }
    return resp.bytes;
}

// ==== 邮件文件夹 ====

export interface MailFolder {
    id: string;
    name: string;
    total: number;
}

// 顶层邮件文件夹(收件箱排前,与 Outlook 侧栏一致)
export async function mailListFolders(): Promise<MailFolder[]> {
    const json = await mailGraph<any>("GET", "/me/mailFolders?$top=100");
    const folders = ((json?.value || []) as any[]).map(f => ({
        id: String(f.id || ""),
        name: String(f.displayName || ""),
        total: Number(f.totalItemCount) || 0,
    }));
    const wellKnown = ["inbox", "drafts", "sentitems", "deleteditems", "archive"];
    return folders.sort((a, b) => {
        const ia = wellKnown.findIndex(w => a.name.toLowerCase().includes(w));
        const ib = wellKnown.findIndex(w => b.name.toLowerCase().includes(w));
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

// 内部路径 → 文件夹(顶层按名匹配;大小写不敏感,Outlook 中文名直接匹配)
const folderCache = new Map<string, MailFolder>(); // key = 内部路径段(如 "/Inbox")

async function resolveFolder(segPath: string): Promise<MailFolder> {
    const key = segPath || "/";
    const hit = folderCache.get(key);
    if (hit) return hit;
    const folders = await mailListFolders();
    for (const f of folders) {
        folderCache.set("/" + f.name, f);
    }
    const found = folderCache.get(key);
    if (!found) throw new Error(`邮件文件夹不存在: ${key.slice(1)}`);
    return found;
}

// ==== 邮件列表(文件夹 → 伪文件条目)====

export interface MailListItem {
    messageId: string;
    fileName: string;   // 展示/定位用文件名(含 .md)
    from: string;
    subject: string;
    received: string;   // ISO
    hasAttachments: boolean;
}

// 文件名清洗:替换文件系统/虚拟路径非法字符,截断长度
function sanitizeFileName(s: string, max = 60): string {
    return s.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() || "(无主题)";
}

function mailFileName(from: string, subject: string, received: string): string {
    const d = new Date(received);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = isFinite(d.getTime())
        ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
        : "00000000-0000";
    const who = sanitizeFileName(from, 24);
    const subj = sanitizeFileName(subject, 48);
    return `${stamp}-${who}-${subj}.md`;
}

const mailListCache = new Map<string, {ts: number; items: MailListItem[]}>();
const MAIL_LIST_TTL = 60 * 1000;

// 文件夹路径段(如 "/Inbox") → 邮件条目(最新 200 封,时间倒序)
export async function mailListMessages(folderSeg: string): Promise<MailListItem[]> {
    const cached = mailListCache.get(folderSeg);
    if (cached && Date.now() - cached.ts < MAIL_LIST_TTL) return cached.items;
    const folder = await resolveFolder(folderSeg);
    const json = await mailGraph<any>(
        "GET",
        `/me/mailFolders/${folder.id}/messages?$top=200&$orderby=receivedDateTime desc` +
        `&$select=id,subject,from,receivedDateTime,hasAttachments`,
    );
    const seen = new Set<string>();
    const items: MailListItem[] = [];
    for (const m of (json?.value || []) as any[]) {
        const fromAddr = String(m?.from?.emailAddress?.name || m?.from?.emailAddress?.address || "(未知发件人)");
        const subject = String(m?.subject || "(无主题)");
        let fn = mailFileName(fromAddr, subject, String(m?.receivedDateTime || ""));
        while (seen.has(fn)) fn = fn.replace(/(\.md)?$/, "") + "-r.md"; // 同分钟同主题去重
        seen.add(fn);
        items.push({
            messageId: String(m?.id || ""),
            fileName: fn,
            from: fromAddr,
            subject,
            received: String(m?.receivedDateTime || ""),
            hasAttachments: !!m?.hasAttachments,
        });
    }
    if (mailListCache.size > 60) mailListCache.clear();
    mailListCache.set(folderSeg, {ts: Date.now(), items});
    return items;
}

// 文件名 → messageId(从列表缓存反查;列表未含时再拉一次)
async function resolveMail(folderSeg: string, fileName: string): Promise<MailListItem> {
    const items = await mailListMessages(folderSeg);
    const hit = items.find(it => it.fileName === fileName);
    if (hit) return hit;
    const fresh = await mailListMessages(folderSeg + " ");
    const hit2 = fresh.find(it => it.fileName === fileName);
    if (!hit2) throw new Error(`邮件不存在或已从列表过期: ${fileName}`);
    return hit2;
}

// ==== 正文与附件 ====

// HTML → 纯文本(邮件正文用;去掉 script/style,块标签转换行)
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

// 邮件正文 → Markdown 文本(元信息头 + 正文 + 附件清单)
export async function mailRenderMarkdown(folderSeg: string, fileName: string): Promise<string> {
    const mail = await resolveMail(folderSeg, fileName);
    const json = await mailGraph<any>(
        "GET",
        `/me/messages/${mail.messageId}?$select=subject,from,toRecipients,receivedDateTime,body,hasAttachments`,
    );
    const bodyHtml = String(json?.body?.content || "");
    const text = json?.body?.contentType === "html" ? htmlToText(bodyHtml) : bodyHtml;
    const from = json?.from?.emailAddress?.address || mail.from;
    const to = ((json?.toRecipients || []) as any[]).map(r => r?.emailAddress?.address || "").filter(Boolean).join(", ");
    const received = json?.receivedDateTime ? new Date(json.receivedDateTime).toLocaleString() : mail.received;
    let atts: string[] = [];
    if (json?.hasAttachments) {
        try {
            const attJson = await mailGraph<any>("GET", `/me/messages/${mail.messageId}/attachments?$select=name,size`);
            atts = ((attJson?.value || []) as any[]).map(a => `${a.name}(${formatSize(Number(a.size) || 0)})`);
        } catch {
            atts = [];
        }
    }
    const lines = [
        `# ${json?.subject || mail.subject}`,
        "",
        `- 发件人: ${from}`,
        to ? `- 收件人: ${to}` : "",
        `- 时间: ${received}`,
        mail.hasAttachments && atts.length ? `- 附件: ${atts.join("、")}(同目录 .files/ 下可查看)` : "",
        "",
        "---",
        "",
        text,
    ];
    return lines.filter(l => l !== "").join("\n");
}

function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 邮件的附件清单
export interface MailAttachment {
    id: string;
    name: string;
    size: number;
}

export async function mailListAttachments(folderSeg: string, fileName: string): Promise<MailAttachment[]> {
    const mail = await resolveMail(folderSeg, fileName);
    const json = await mailGraph<any>("GET", `/me/messages/${mail.messageId}/attachments?$select=id,name,size`);
    return ((json?.value || []) as any[]).map(a => ({
        id: String(a.id || ""),
        name: String(a.name || "attachment"),
        size: Number(a.size) || 0,
    }));
}

// 下载单个附件内容(懒加载;附件文件在文件树里以 <邮件>.files/<名> 呈现)
export async function mailDownloadAttachment(folderSeg: string, fileName: string, attachmentName: string): Promise<ArrayBuffer> {
    const mail = await resolveMail(folderSeg, fileName);
    const atts = await mailListAttachments(folderSeg, fileName);
    const att = atts.find(a => a.name === attachmentName) || atts.find(a => a.name.toLowerCase() === attachmentName.toLowerCase());
    if (!att) throw new Error(`附件不存在: ${attachmentName}`);
    return await mailGraphBytes(`/me/messages/${mail.messageId}/attachments/${att.id}/$value`);
}

// ==== 虚拟树目录装配(readDir 入口)====

// 列出 outlook:// 虚拟路径下的条目(文件夹列表 / 邮件列表 / 附件目录)
export async function mailListDir(vPath: string): Promise<DirEntry[]> {
    if (!isOutlookPath(vPath)) throw new Error(`不是 Outlook 邮箱路径: ${vPath}`);
    const seg = outlookPathBody(vPath);
    // 根:顶层文件夹
    if (!seg) {
        const folders = await mailListFolders();
        return folders.map(f => ({
            name: f.name,
            isDir: true,
            size: 0,
            updated: "",
            path: OUTLOOK_PREFIX + "/" + f.name,
        }));
    }
    // ".files/" 结尾的附件目录:列出该邮件的附件
    if (seg.endsWith(".files")) {
        const parentSeg = seg.slice(0, -6); // 去掉 ".files"
        const folderSeg = "/" + parentSeg.split("/")[0];
        const fileName = parentSeg.slice(parentSeg.indexOf("/") + 1);
        const atts = await mailListAttachments(folderSeg, fileName);
        return atts.map(a => ({
            name: a.name,
            isDir: false,
            size: a.size,
            updated: "",
            path: OUTLOOK_PREFIX + seg + "/" + a.name,
        }));
    }
    // 目录段 = 文件夹(内含邮件文件与带附件邮件的 .files 子目录)
    const folderSeg = "/" + seg.split("/")[0];
    const items = await mailListMessages(folderSeg);
    const entries: DirEntry[] = [];
    for (const it of items) {
        const filePath = OUTLOOK_PREFIX + seg + "/" + it.fileName;
        entries.push({
            name: it.fileName,
            isDir: false,
            size: 0,
            updated: it.received ? new Date(it.received).toISOString() : "",
            path: filePath,
        });
        if (it.hasAttachments) {
            entries.push({
                name: it.fileName.replace(/\.md$/, "") + ".files",
                isDir: true,
                size: 0,
                updated: it.received ? new Date(it.received).toISOString() : "",
                path: OUTLOOK_PREFIX + seg + "/" + it.fileName.replace(/\.md$/, "") + ".files",
            });
        }
    }
    return entries;
}

// 读邮件文件内容(.md 渲染)或附件内容
export async function mailReadFile(vPath: string): Promise<string | ArrayBuffer> {
    if (!isOutlookPath(vPath)) throw new Error(`不是 Outlook 邮箱路径: ${vPath}`);
    const seg = outlookPathBody(vPath);
    if (!seg) throw new Error("Outlook 根目录不可读");
    // 附件:"/Inbox/<邮件>.files/<附件名>"
    const filesIdx = seg.indexOf(".files/");
    if (filesIdx >= 0) {
        const parentSeg = seg.slice(0, filesIdx + 6); // "/Inbox/<邮件>.files"
        const folderSeg = "/" + parentSeg.slice(1).split("/")[0];
        const mailName = parentSeg.slice(parentSeg.indexOf("/") + 1).replace(/\.files$/, "");
        const attName = seg.slice(filesIdx + 7);
        return await mailDownloadAttachment(folderSeg, mailName, attName);
    }
    // 邮件 .md:"/Inbox/<邮件>.md"
    const folderSeg = "/" + seg.split("/")[0];
    const fileName = seg.slice(seg.indexOf("/") + 1);
    return await mailRenderMarkdown(folderSeg, fileName);
}
