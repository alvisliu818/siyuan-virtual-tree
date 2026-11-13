// OneDrive 网盘接入(微软 Graph API + 设备码授权)。
//
// 架构对齐 api/baidu-pan.ts:
//   - 配置与令牌存插件数据(STORAGE_OD_CONFIG),令牌自动刷新(expiresAt 前 60s / 401 兜底)
//   - 授权:OAuth2 设备码流(无需回调地址;用户在任意设备打开 microsoft.com/devicelogin 输码)
//     需要用户自己的 Azure 应用(Entra 管理中心注册,类型选"个人",重定向 URI 留空,
//     API 权限勾 Files.ReadWrite.All + User.Read + offline_access,并把
//     「允许公共客户端流」设为是)—— 插件无法替用户注册应用,client_id 由用户填入
//   - API:Graph v1.0 /me/drive(个人与企业版 OneDrive 通用)
//   - 传输:httpRequest 共享层。Graph 与登录端点都允许 CORS 且 Authorization 是可设头,
//     所以不 forceProxy:直连优先(下载可跟随 CDN 重定向,不受代理 32MB 响应上限约束),
//     直连失败(CORS/网络)回退内核代理(此时上传经代理流式转发,见 http.ts)
//   - 路径:onedrive:///<云端路径> 虚拟路径(见 utils/onedrive-path.ts)
import {DirEntry} from "../types";
import {isOneDrivePath, oneDrivePathBody, OD_PREFIX} from "../utils/onedrive-path";
import {basename, dirname} from "../utils/path";
import {httpRequest} from "./http";
import {STORAGE_OD_CONFIG} from "../constants";

export const GRAPH = "https://graph.microsoft.com/v1.0";
// 设备码授权默认 scope:offline_access(拿 refresh_token)+ 文件读写 + 基本信息
export const OD_SCOPE = "offline_access files.readwrite.all user.read";

export interface OneDriveConfig {
    clientId: string;
    authority: string;   // common | consumers | organizations(默认 common,个人+组织均可登录)
    accessToken: string;
    refreshToken: string;
    expiresAt: number;   // access token 过期时间(ms)
    account?: string;    // 登录账号(授权成功后回填,仅展示用)
}

const DEFAULT_OD_CONFIG: OneDriveConfig = {
    clientId: "",
    authority: "common",
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
};

let odConfig: OneDriveConfig = {...DEFAULT_OD_CONFIG};
let odSaver: ((data: string) => Promise<void>) | null = null;

export async function initOneDriveStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    odSaver = (data: string) => plugin.saveData(STORAGE_OD_CONFIG, data);
    odConfig = {...DEFAULT_OD_CONFIG};
    try {
        const raw = await plugin.loadData(STORAGE_OD_CONFIG);
        if (raw) {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            odConfig = {...DEFAULT_OD_CONFIG, ...parsed};
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载 OneDrive 配置失败:", e);
    }
}

export function saveOneDriveConfig(next: Partial<OneDriveConfig>): Promise<void> {
    odConfig = {...odConfig, ...next};
    return odSaver ? odSaver(JSON.stringify(odConfig)) : Promise.resolve();
}

export function getOneDriveConfig(): OneDriveConfig {
    return odConfig;
}

// 是否具备可用凭据(有 refresh token 或未过期的 access token)
export function isOneDriveConfigured(): boolean {
    return !!(odConfig.clientId && (odConfig.refreshToken || (odConfig.accessToken && odConfig.expiresAt > Date.now())));
}

// ==== 设备码授权(OAuth2 device flow)====

export interface OdDeviceAuth {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    expiresAt: number;
}

// 发起设备码授权。tenant 为登录端点租户段(common/consumers/organizations/租户 ID)
export async function odStartDeviceAuth(clientId: string, tenant: string): Promise<OdDeviceAuth> {
    const resp = await httpRequest(
        `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0/devicecode`,
        {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: formEncode({client_id: clientId, scope: OD_SCOPE}),
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
        expiresAt: Date.now() + (Number(json.expires_in) || 900) * 1000,
    };
}

// 轮询授权结果:pending=继续等;slow=请求过快;done=拿到令牌(已写配置)。
// 致命错误(authorization_expired/access_denied 等)直接抛出。
export async function odPollDeviceAuth(auth: OdDeviceAuth): Promise<"pending" | "slow" | "done"> {
    return await tokenRequest(formEncode({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: odConfig.clientId,
        device_code: auth.deviceCode,
    }), async (json) => {
        if (json.error === "authorization_pending") return "pending";
        if (json.error === "slow_down") return "slow";
        throw new Error(tokenErrorText(json));
    }, async (tokens) => {
        await saveOneDriveConfig({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || odConfig.refreshToken,
            expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        });
        return "done";
    });
}

function tokenErrorText(json: any): string {
    const code = String(json.error || "");
    if (code === "authorization_expired") return "授权码已过期,请重新发起授权";
    if (code === "access_denied") return "你在微软页面拒绝了授权";
    if (code === "invalid_client") return "应用(client) ID 无效,请检查设置";
    return json.error_description || code || "授权失败";
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

// 令牌请求通用形:提交表单 → 错误处理 → 成功回调
async function tokenRequest(
    body: string,
    onResult: (json: any) => Promise<"pending" | "slow" | "done">,
    onSuccess: (tokens: any) => Promise<"pending" | "slow" | "done">,
): Promise<"pending" | "slow" | "done"> {
    const resp = await httpRequest(
        `https://login.microsoftonline.com/${odConfig.authority || "common"}/oauth2/v2.0/token`,
        {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body,
        },
    );
    const json = decodeJson(resp, "令牌请求");
    if (json.error) return await onResult(json);
    return await onSuccess(json);
}

// 用 refresh token 换新 access token;失败抛错(调用方降级为未登录提示)
async function refreshAccessToken(): Promise<void> {
    if (!odConfig.refreshToken) throw new Error("OneDrive 未授权或凭据已失效,请重新授权");
    await tokenRequest(formEncode({
        grant_type: "refresh_token",
        client_id: odConfig.clientId,
        refresh_token: odConfig.refreshToken,
        scope: OD_SCOPE,
    }), async (json) => {
        throw new Error(tokenErrorText(json));
    }, async (tokens) => {
        await saveOneDriveConfig({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || odConfig.refreshToken,
            expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        });
        return "done";
    });
}

// 确保访问令牌可用(过期前 60s 自动刷新)
async function ensureAccessToken(): Promise<string> {
    if (!odConfig.accessToken || Date.now() > odConfig.expiresAt - 60_000) {
        await refreshAccessToken();
    }
    return odConfig.accessToken;
}

// ==== Graph API 封装 ====

// Graph 错误转可读信息
function graphError(json: any, op: string, status: number): Error {
    const code = String(json?.error?.code || "");
    const msg = String(json?.error?.message || "");
    if (status === 401) return new Error(`${op}失败:令牌无效或已过期(401)`);
    if (status === 404) return new Error(`${op}失败:文件或目录不存在(404)`);
    if (code === "nameAlreadyExists") return new Error(`${op}失败:同名文件或目录已存在`);
    if (code === "invalidAuthenticationToken") return new Error(`${op}失败:令牌无效,请重新授权`);
    return new Error(`${op}失败: ${msg || code || "HTTP " + status}`);
}

// Graph 请求(JSON 响应);401 时刷新令牌重试一次
async function odGraph<T = any>(method: string, graphPath: string, body?: string | Uint8Array, contentType?: string): Promise<{status: number; json: T | null; bytes: ArrayBuffer}> {
    const doReq = async (token: string) => await httpRequest(GRAPH + graphPath, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined && contentType ? {"Content-Type": contentType} : {}),
        },
        body: body ?? null,
    });
    let resp = await doReq(await ensureAccessToken());
    if (resp.status === 401) {
        await refreshAccessToken();
        resp = await doReq(await ensureAccessToken());
    }
    if (resp.status >= 400) {
        throw graphError(decodeJson(resp, "Graph 请求"), "Graph 请求", resp.status);
    }
    const json = decodeJson(resp, "Graph 请求");
    return {status: resp.status, json, bytes: resp.bytes};
}

// Graph 请求(二进制响应,如文件下载)
async function odGraphBytes(method: string, graphPath: string): Promise<ArrayBuffer> {
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
        throw graphError(decodeJson(resp, "Graph 请求"), "Graph 请求", resp.status);
    }
    return resp.bytes;
}

// ==== 路径与条目 ====

// 云端绝对路径 → Graph 路径段:根返回 "/root",其他 "/root:/path"(无结尾冒号情形已归一)
function graphItemPath(cloud: string): string {
    const p = cloud.replace(/\/+$/, "");
    if (!p || p === "/") return "/root";
    return "/root:" + encodeGraphPath(p);
}

// Graph 的 path: 段里 "/" 合法但 ":" 等保留字符需编码;只编码冒号/百分号,保留 "/"
function encodeGraphPath(p: string): string {
    return p.replace(/%/g, "%25").replace(/:/g, "%3A");
}

// 云端路径 → driveItem id(缓存:列目录与按路径查询都回填)
const idCache = new Map<string, string>();

// ==== 目录列表 ====

// 列目录缓存(cloudDir → entries),TTL 与百度一致
const listCache = new Map<string, {ts: number; entries: DirEntry[]}>();
const LIST_TTL = 30 * 1000;

function cloudDirOf(vPath: string): string {
    return oneDrivePathBody(vPath) || "/";
}

export function clearOneDriveListCache(dir?: string): void {
    if (dir) {
        const cloud = cloudDirOf(dir);
        for (const k of Array.from(listCache.keys())) {
            if (k === cloud || k.startsWith(cloud === "/" ? "/" : cloud + "/")) listCache.delete(k);
        }
        // 子树内的 id 缓存一并失效(删除/改名后可能陈旧)
        for (const k of Array.from(idCache.keys())) {
            if (k === cloud || k.startsWith(cloud === "/" ? "/" : cloud + "/")) idCache.delete(k);
        }
    } else {
        listCache.clear();
        idCache.clear();
    }
}

// 列目录(支持 onedrive:// 虚拟路径;分页拉全,条目 path 为子虚拟路径)
export async function odListDir(vPath: string): Promise<DirEntry[]> {
    if (!isOneDrivePath(vPath)) throw new Error(`不是 OneDrive 路径: ${vPath}`);
    const cloud = cloudDirOf(vPath);
    const cached = listCache.get(cloud);
    if (cached && Date.now() - cached.ts < LIST_TTL) return cached.entries;

    const vBase = OD_PREFIX + (cloud === "/" ? "" : cloud);
    const entries: DirEntry[] = [];
    let next: string | null = graphItemPath(cloud) + "/children?$top=200";
    let guard = 0;
    while (next && guard++ < 50) {
        const page: any = await odGraph<any>("GET", next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next);
        const json: any = page.json;
        for (const it of (json?.value || []) as any[]) {
            const name = String(it.name || "");
            if (!name) continue;
            const isDir = !!it.folder;
            const childCloud = (cloud === "/" ? "" : cloud) + "/" + name;
            if (it.id) idCache.set(childCloud, String(it.id));
            entries.push({
                name,
                isDir,
                size: Number(it.size) || 0,
                updated: it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime).toISOString() : "",
                path: vBase + "/" + name,
            });
        }
        next = json?.["@odata.nextLink"] || null;
    }
    if (listCache.size > 300) listCache.clear();
    listCache.set(cloud, {ts: Date.now(), entries});
    return entries;
}

// ==== 配额(验证凭据用)====

export async function odQuota(): Promise<{quota: number; used: number}> {
    const {json} = await odGraph<any>("GET", "/me/drive?$select=quota");
    const q = json?.quota || {};
    return {quota: Number(q.total) || 0, used: Number(q.used) || 0};
}

// ==== 下载 ====

export async function odDownloadFile(vPath: string): Promise<ArrayBuffer> {
    const cloud = cloudDirOf(vPath);
    if (!cloud || cloud === "/") throw new Error("OneDrive 根目录不是文件");
    return await odGraphBytes("GET", graphItemPath(cloud) + ":/content");
}

// ==== 上传(简单 PUT;Graph 单请求上限 250MB)====

export async function odUploadFile(vPath: string, data: Uint8Array): Promise<void> {
    const cloud = cloudDirOf(vPath);
    if (!cloud || cloud === "/") throw new Error("OneDrive 根目录不可作为文件写入");
    if (data.length > 250 * 1024 * 1024) {
        throw new Error("OneDrive 简单上传上限 250MB,更大的文件请使用官方客户端或上传会话接口");
    }
    // 父目录必须存在(Graph 不会自动建父链;与本地 writeFile 语义差异点)
    await odGraph<any>("PUT", graphItemPath(cloud) + ":/content", data, "application/octet-stream");
    clearOneDriveListCache(dirname(vPath));
}

// ==== 新建目录 ====

export async function odCreateDir(vPath: string): Promise<void> {
    const cloud = cloudDirOf(vPath);
    if (!cloud || cloud === "/") throw new Error("OneDrive 根目录无需创建");
    const parent = dirname(cloud) || "/";
    const name = basename(cloud);
    await odGraph<any>("POST", graphItemPath(parent) + "/children", JSON.stringify({name, folder: {}}), "application/json");
    clearOneDriveListCache(dirname(vPath));
}

// ==== 删除 / 改名(经 driveItem id)====

async function resolveItemId(cloud: string): Promise<string> {
    const hit = idCache.get(cloud);
    if (hit) return hit;
    const {json} = await odGraph<any>("GET", graphItemPath(cloud) + "?$select=id");
    const id = String(json?.id || "");
    if (!id) throw new Error("无法解析 OneDrive 条目 ID");
    idCache.set(cloud, id);
    return id;
}

export async function odRemove(vPath: string): Promise<void> {
    const cloud = cloudDirOf(vPath);
    if (!cloud || cloud === "/") throw new Error("OneDrive 根目录不可删除");
    const id = await resolveItemId(cloud);
    await odGraph<any>("DELETE", `/me/drive/items/${id}`);
    clearOneDriveListCache(dirname(vPath));
}

export async function odRename(vPath: string, newVPath: string): Promise<void> {
    const cloud = cloudDirOf(vPath);
    const newCloud = cloudDirOf(newVPath);
    if (!cloud || cloud === "/") throw new Error("OneDrive 根目录不可改名");
    // 仅支持同目录改名(Graph 跨目录是 move = PATCH parentReference;这里与百度一致先不做)
    if (dirname(newCloud) !== (dirname(cloud) || "/")) {
        throw new Error("OneDrive 暂不支持跨目录改名/移动,请使用官方客户端");
    }
    const id = await resolveItemId(cloud);
    await odGraph<any>("PATCH", `/me/drive/items/${id}`, JSON.stringify({name: basename(newCloud)}), "application/json");
    clearOneDriveListCache(dirname(vPath));
    clearOneDriveListCache(dirname(newVPath));
}
