// 百度网盘后端:把网盘目录映射为 bdpan:// 虚拟路径,支持两种接入方式(mode):
//
// 1. official —— 百度网盘开放平台官方 API(推荐,合规稳定)
//    设备码授权:GET  https://openapi.baidu.com/oauth/2.0/device/code(用户在 openapi.baidu.com/device 输入验证码)
//    令牌:      刷新 https://openapi.baidu.com/oauth/2.0/token(grant_type=refresh_token,refresh_token 会轮换)
//    列目录:    GET  https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=&web=web&start=&limit=
//    下载:      GET  https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[]&dlink=1
//                    → dlink + &access_token=(请求 UA 必须为 pan.baidu.com)→ 302 → 文件内容
//    上传:      POST /xpan/file?method=precreate → d.pcs.baidu.com superfile2(分片)→ POST /xpan/file?method=create
//    建目录:    POST /xpan/file?method=create(isdir=1)  删除/改名:POST /xpan/file?method=filemanager
//    接口细节与 Alist 官方驱动(https://github.com/AlistGo/alist)对齐;errno 111/-6 自动刷新令牌重试。
//    注意:未过审应用只能访问 /apps/<应用名>/ 沙箱目录,且官方 API 无同步空间接口。
//
// 2. cookie —— 网页端接口(BDUSS/STOKEN 鉴权,与 BaiduPCS-Go 同源,非官方)
//    全盘可访问,支持同步空间(/apps/sync);请求被风控时会返回可读错误。
//
// 传输层:桌面端直接用 Node https(可自定义 UA、支持二进制上传,无大小限制);
// 浏览器端回退思源内核代理(/api/network/proxy 新版 / /api/fetch/proxy 旧版),响应上限 32MB、不支持二进制上传。
import {DirEntry} from "../types";
import {STORAGE_BD_CONFIG} from "../constants";
import {parseStoredData} from "../utils/stored-data";
import {decodeAuto} from "../utils/encoding";
import {getNativeRequire, isNodeModulesAvailable} from "../utils/native-require";
import {basename} from "../utils/path";
import {
    BDPAN_PREFIX,
    baiduChildVPath,
    baiduPathBody,
} from "../utils/baidu-path";

// ==== 配置(持久化到插件数据 baidu-pan.json)====
export type BdAuthMode = "official" | "cookie";

export interface BaiduPanConfig {
    mode: BdAuthMode;      // 接入方式
    bduss: string;         // cookie 模式:网盘 Cookie BDUSS
    stoken: string;        // cookie 模式:网盘 Cookie STOKEN
    appKey: string;        // official 模式:开放平台 AppKey
    secretKey: string;     // official 模式:开放平台 SecretKey
    accessToken: string;   // official 模式:授权令牌(设备码授权获得)
    refreshToken: string;  // official 模式:刷新令牌(轮换,须持久化)
    tokenExpiresAt: number; // official 模式:令牌过期时间(ms 时间戳)
    syncDir: string;       // cookie 模式:同步空间云端目录(默认 /apps/sync;官方 API 无同步空间)
}

export const DEFAULT_BD_SYNC_DIR = "/apps/sync";

const DEFAULT_CONFIG: BaiduPanConfig = {
    mode: "official",
    bduss: "",
    stoken: "",
    appKey: "",
    secretKey: "",
    accessToken: "",
    refreshToken: "",
    tokenExpiresAt: 0,
    syncDir: DEFAULT_BD_SYNC_DIR,
};

let bdConfig: BaiduPanConfig = {...DEFAULT_CONFIG};
let bdSaver: ((data: string) => Promise<void>) | null = null;

// 加载配置并设置持久化回调(插件 onLayoutReady 时调用)
// 兼容旧版数据:无 mode 字段时按已有凭据推断(有 accessToken → official,否则 cookie)
export async function initBaiduPanStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    bdSaver = (data: string) => plugin.saveData(STORAGE_BD_CONFIG, data);
    bdConfig = {...DEFAULT_CONFIG}; // 先重置,避免重新初始化时残留上一次的内存配置
    try {
        const raw = await plugin.loadData(STORAGE_BD_CONFIG);
        // 首次使用文件不存在时 loadData 返回空串,必须安全解析
        const parsed = parseStoredData(raw);
        if (parsed && typeof parsed === "object") {
            const mode: BdAuthMode = parsed.mode === "official"
                ? "official"
                : parsed.mode === "cookie"
                    ? "cookie"
                    : (parsed.accessToken ? "official" : "cookie");
            bdConfig = {
                mode,
                bduss: String(parsed.bduss || ""),
                stoken: String(parsed.stoken || ""),
                appKey: String(parsed.appKey || ""),
                secretKey: String(parsed.secretKey || ""),
                accessToken: String(parsed.accessToken || ""),
                refreshToken: String(parsed.refreshToken || ""),
                tokenExpiresAt: Number(parsed.tokenExpiresAt) || 0,
                syncDir: String(parsed.syncDir || DEFAULT_BD_SYNC_DIR).trim() || DEFAULT_BD_SYNC_DIR,
            };
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载百度网盘配置失败:", e);
    }
}

async function persistBdConfig(): Promise<void> {
    if (!bdSaver) return;
    try {
        await bdSaver(JSON.stringify(bdConfig));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存百度网盘配置失败:", e);
    }
}

// 保存配置(清空列目录缓存:接入方式/同步目录调整后旧缓存失效)
export async function saveBaiduPanConfig(next: Partial<BaiduPanConfig>): Promise<void> {
    bdConfig = {
        ...bdConfig,
        ...next,
        mode: next.mode === "cookie" ? "cookie" : next.mode === "official" ? "official" : bdConfig.mode,
        bduss: (next.bduss ?? bdConfig.bduss).trim(),
        stoken: (next.stoken ?? bdConfig.stoken).trim(),
        appKey: (next.appKey ?? bdConfig.appKey).trim(),
        secretKey: (next.secretKey ?? bdConfig.secretKey).trim(),
        syncDir: (next.syncDir ?? bdConfig.syncDir).trim() || DEFAULT_BD_SYNC_DIR,
    };
    clearBaiduListCache();
    await persistBdConfig();
}

export function getBaiduPanConfig(): BaiduPanConfig {
    return {...bdConfig};
}

// 是否已配置好可用凭据(official:已授权;cookie:已填 BDUSS)
export function isBaiduConfigured(): boolean {
    return bdConfig.mode === "official" ? !!bdConfig.accessToken : !!bdConfig.bduss;
}

// 云端绝对路径归一化:统一正斜杠、以 / 开头、去结尾斜杠;"/" 表示根
function normCloudDir(p: string): string {
    const s = (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!s) return "/";
    return s.startsWith("/") ? s : "/" + s;
}

// 虚拟路径 → 网盘云端绝对路径("bdpan://sync/a" → <syncDir>/a)
export function baiduCloudPath(vPath: string): string {
    const body = baiduPathBody(vPath);
    if (!body) return "/";
    const syncDir = normCloudDir(bdConfig.syncDir || DEFAULT_BD_SYNC_DIR);
    if (body === "sync") return syncDir;
    if (body.startsWith("sync/")) {
        const rest = body.slice(5);
        return syncDir === "/" ? "/" + rest : syncDir + "/" + rest;
    }
    return normCloudDir(body);
}

// 取云端路径的父目录
function cloudParent(p: string): string {
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "/" : p.slice(0, idx);
}

// ==== 传输层 ====
const BD_APP_ID = "266719"; // cookie 模式 PCS 接口 app_id(与 BaiduPCS-Go 一致)
const BD_UA = "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;";
const OFFICIAL_UA = "pan.baidu.com"; // 官方下载链路要求的 UA

interface BdResp {
    status: number;
    bytes: ArrayBuffer;
    contentType: string;
}

function bdCookie(): string {
    const parts = [`BDUSS=${bdConfig.bduss}`];
    if (bdConfig.stoken) parts.push(`STOKEN=${bdConfig.stoken}`);
    return parts.join("; ");
}

// 按接入方式构造默认请求头(cookie:Cookie + 客户端 UA;official:pan.baidu.com UA,不带 Cookie)
function bdDefaultHeaders(): Record<string, string> {
    if (bdConfig.mode === "cookie") {
        return {
            Cookie: bdCookie(),
            "User-Agent": BD_UA,
            Referer: "https://pan.baidu.com/",
        };
    }
    return {"User-Agent": OFFICIAL_UA};
}

// 内核鉴权头(与 api/file.ts 一致;本地桌面端无需 token,此处防御性补充)
function kernelAuthHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

// RawURL base64(内核代理参数编码)
function b64url(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Node https/http 请求(桌面端):任意头、二进制 body,自动跟随 30x 跳转
function nodeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | null,
    redirects = 0,
): Promise<BdResp> {
    return new Promise((resolve, reject) => {
        const req = getNativeRequire()!;
        let mod: any;
        try {
            mod = req(url.startsWith("http://") ? "http" : "https");
        } catch (e) {
            reject(new Error(`无法加载 Node http(s) 模块: ${e}`));
            return;
        }
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            reject(new Error(`URL 无效: ${url}`));
            return;
        }
        const r = mod.request(u, {method, headers, timeout: 60000}, (res: any) => {
            const status = res.statusCode || 0;
            const loc = res.headers?.location;
            if (status >= 300 && status < 400 && loc && redirects < 5) {
                res.resume(); // 丢弃跳转响应体
                nodeRequest(new URL(loc, u).toString(), method, headers, body, redirects + 1).then(resolve, reject);
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                const out = new Uint8Array(buf.length);
                out.set(buf);
                resolve({status, bytes: out.buffer, contentType: String(res.headers?.["content-type"] || "")});
            });
            res.on("error", reject);
        });
        r.on("timeout", () => r.destroy(new Error("请求超时(60s)")));
        r.on("error", reject);
        if (body !== null) {
            const payload = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
            r.setHeader("Content-Length", payload.length);
            r.write(payload);
        }
        r.end();
    });
}

// 内核代理端点探测结果(浏览器端;"" = 未探测)
let proxyMode: "" | "new" | "old" = "";

// 浏览器端:经思源内核代理请求(新版透传方法与请求体,旧版 JSON 包裹)
async function proxyRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
): Promise<BdResp> {
    if (proxyMode !== "old") {
        // 新版内核(v3.8+):/api/network/proxy?u=<b64url>&h=<b64url(headers)>&t=<timeout>
        // 方法与请求体由本请求透传;响应为原始字节流(上限 32MB)
        try {
            const h = b64url(JSON.stringify(headers));
            const resp = await fetch(`/api/network/proxy?u=${b64url(url)}&h=${encodeURIComponent(h)}&t=90s`, {
                method,
                headers: {
                    ...kernelAuthHeaders(),
                    ...(body !== null ? {"Content-Type": headers["Content-Type"] || "application/x-www-form-urlencoded"} : {}),
                },
                body: body !== null ? body : undefined,
            });
            if (resp.status !== 404) {
                proxyMode = "new";
                return {status: resp.status, bytes: await resp.arrayBuffer(), contentType: resp.headers.get("content-type") || ""};
            }
        } catch {
            // 请求失败继续尝试旧端点
        }
        if (proxyMode === "") proxyMode = "old";
    }
    // 旧版内核:/api/fetch/proxy(JSON 包裹,payload 仅支持字符串)
    const resp = await fetch("/api/fetch/proxy", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...kernelAuthHeaders()},
        body: JSON.stringify({
            url,
            method,
            headers,
            timeout: 90000,
            ...(body !== null ? {contentType: headers["Content-Type"] || "application/x-www-form-urlencoded", payload: body} : {}),
        }),
    });
    if (resp.status === 404) {
        throw new Error("思源内核代理不可用,请升级思源或使用桌面端");
    }
    proxyMode = "old";
    return {status: resp.status, bytes: await resp.arrayBuffer(), contentType: resp.headers.get("content-type") || ""};
}

// 统一请求入口:桌面端走 Node https,浏览器端走内核代理
async function bdHttp(
    url: string,
    opts: {method?: string; headers?: Record<string, string>; body?: string | Uint8Array | null} = {},
): Promise<BdResp> {
    const method = opts.method || "GET";
    const headers = {
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "identity", // 避免 gzip,无需解压
        ...bdDefaultHeaders(),
        ...opts.headers,
    };
    const body = opts.body === undefined ? null : opts.body;
    if (isNodeModulesAvailable()) {
        return await nodeRequest(url, method, headers, body);
    }
    // 浏览器端:二进制 body(上传分片)无法经代理传输
    if (body instanceof Uint8Array) {
        throw new Error("浏览器端暂不支持上传网盘文件,请使用思源桌面端");
    }
    return await proxyRequest(url, method, headers, typeof body === "string" ? body : null);
}

// ==== 错误处理 ====
// 携带百度 errno 的错误(模块内部用于区分"响应其实是错误 JSON")
class BdErrnoError extends Error {
    errno: number;
    constructor(msg: string, errno: number) {
        super(msg);
        this.errno = errno;
    }
}

function errnoMessage(errno: number, op: string): string {
    if (errno === -6) return `${op}失败:百度网盘未登录或凭据已失效(${bdConfig.mode === "official" ? "请重新授权" : "请更新 BDUSS/STOKEN"})`;
    if (errno === 111) return `${op}失败:授权令牌已失效,请重新授权(设备码)`;
    if (errno === -62) return `${op}失败:请求被百度风控拦截,请稍后重试`;
    if (errno === 2 || errno === -9 || errno === -12) return `${op}失败:文件或目录不存在(errno=${errno})`;
    if (errno === 31023) return `${op}失败:无权访问该路径(未过审应用仅能访问 /apps/<应用名>/ 目录)`;
    if (errno === -7) return `${op}失败:文件或目录已存在或名称非法(errno=-7)`;
    if (errno === -8) return `${op}失败:同名文件已存在(errno=-8)`;
    return `${op}失败:errno=${errno}`;
}

// 请求并解析 JSON,校验 errno/error_code(0 成功);不注入 access_token,调用方自行拼接
async function bdJSON<T = any>(
    url: string,
    opts: {method?: string; headers?: Record<string, string>; body?: string | Uint8Array | null} = {},
    op = "操作",
): Promise<T> {
    const resp = await bdHttp(url, opts);
    const text = decodeAuto(new Uint8Array(resp.bytes));
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`${op}失败:响应不是 JSON(HTTP ${resp.status})`);
    }
    if (json && typeof json.errno === "number" && json.errno !== 0) {
        throw new BdErrnoError(errnoMessage(json.errno, op), json.errno);
    }
    if (json && typeof json.error_code === "number" && json.error_code !== 0) {
        throw new Error(`${op}失败: ${json.error_msg || "error_code=" + json.error_code}`);
    }
    if (json && typeof json.error === "string" && json.error) {
        throw new Error(`${op}失败: ${json.error_description || json.error}`);
    }
    return json as T;
}

function formEncode(fields: Record<string, string>): string {
    const parts: string[] = [];
    for (const k of Object.keys(fields)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]));
    }
    return parts.join("&");
}

// 构造单字段 multipart 表单体(param 字段为 JSON 文本,UTF-8 字符串直接编码)
function multipartParam(paramJson: string, boundary: string): string {
    return `--${boundary}\r\nContent-Disposition: form-data; name="param"\r\n\r\n${paramJson}\r\n--${boundary}--\r\n`;
}

function newBoundary(): string {
    return "----syfeBoundary" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 上传分片 multipart("file" 字段,二进制)
function multipartFile(fileName: string, chunk: Uint8Array, boundary: string): Uint8Array {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const headBytes = new TextEncoder().encode(head);
    const tailBytes = new TextEncoder().encode(tail);
    const body = new Uint8Array(headBytes.length + chunk.length + tailBytes.length);
    body.set(headBytes, 0);
    body.set(chunk, headBytes.length);
    body.set(tailBytes, headBytes.length + chunk.length);
    return body;
}

// ==== 官方模式:令牌管理 ====
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // 过期前 5 分钟主动刷新
const EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

let refreshPromise: Promise<void> | null = null;

// OAuth token 接口偶尔以查询串格式返回,兼容 JSON 与查询串两种形态
function parseTokenBody(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        return JSON.parse(trimmed);
    }
    const obj: any = {};
    for (const pair of trimmed.split("&")) {
        const idx = pair.indexOf("=");
        if (idx > 0) obj[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    }
    return obj;
}

// 用 refresh_token 换新令牌(注意:refresh_token 会轮换,必须持久化新值)
async function refreshOfficialToken(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        if (!bdConfig.refreshToken || !bdConfig.appKey || !bdConfig.secretKey) {
            throw new Error("百度网盘授权已失效,请重新完成设备码授权");
        }
        const url = "https://openapi.baidu.com/oauth/2.0/token?" + new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: bdConfig.refreshToken,
            client_id: bdConfig.appKey,
            client_secret: bdConfig.secretKey,
        }).toString();
        const resp = await bdHttp(url);
        let json: any;
        try {
            json = parseTokenBody(decodeAuto(new Uint8Array(resp.bytes)));
        } catch {
            throw new Error("刷新授权令牌失败:响应无法解析");
        }
        if (json.error || !json.access_token) {
            throw new Error(`百度网盘授权已失效(${json.error_description || json.error || "无 refresh_token"}),请重新完成设备码授权`);
        }
        bdConfig.accessToken = String(json.access_token);
        bdConfig.refreshToken = String(json.refresh_token || bdConfig.refreshToken);
        bdConfig.tokenExpiresAt = Date.now() + (Number(json.expires_in) || 2592000) * 1000;
        await persistBdConfig();
    })();
    try {
        await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

// 取有效令牌(过期前主动刷新)
async function ensureOfficialToken(): Promise<string> {
    if (!bdConfig.accessToken) {
        throw new Error("百度网盘尚未授权,请先在挂载对话框完成设备码授权");
    }
    if (Date.now() > bdConfig.tokenExpiresAt - TOKEN_REFRESH_MARGIN) {
        await refreshOfficialToken();
    }
    return bdConfig.accessToken;
}

// 官方接口请求:自动附加 access_token;errno 111/-6 刷新令牌后重试一次
async function officialJSON<T = any>(
    url: string,
    opts: {method?: string; form?: Record<string, string>} = {},
    op = "操作",
    retried = false,
): Promise<T> {
    const token = await ensureOfficialToken();
    const full = url + (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(token);
    const body = opts.form ? formEncode(opts.form) : null;
    try {
        return await bdJSON<T>(full, {
            method: opts.method || "GET",
            ...(body !== null ? {headers: {"Content-Type": "application/x-www-form-urlencoded"}, body} : {}),
        }, op);
    } catch (e) {
        if (!retried && e instanceof BdErrnoError && (e.errno === 111 || e.errno === -6)) {
            await refreshOfficialToken();
            return await officialJSON<T>(url, opts, op, true);
        }
        throw e;
    }
}

// 轮询中的临时错误(网络波动、响应异常等,应自动重试而非终止授权)
export class BdAuthTransientError extends Error {}

// ==== 官方模式:设备码授权 ====
export interface BdDeviceAuth {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    qrcodeUrl: string;
    interval: number;   // 轮询间隔(秒)
    expiresAt: number;  // 设备码过期时间(ms)
}

// 发起设备码授权(先持久化 AppKey/SecretKey)
export async function bdStartDeviceAuth(appKey: string, secretKey: string): Promise<BdDeviceAuth> {
    if (!appKey || !secretKey) throw new Error("请先填写 AppKey 与 SecretKey");
    await saveBaiduPanConfig({mode: "official", appKey, secretKey});
    const url = "https://openapi.baidu.com/oauth/2.0/device/code?" + new URLSearchParams({
        response_type: "device_code",
        client_id: appKey,
        scope: "basic,netdisk",
    }).toString();
    const json = await bdJSON<any>(url, {}, "发起设备码授权");
    if (!json.device_code || !json.user_code) {
        throw new Error(`发起授权失败: ${json.error_description || json.error || "响应缺少 device_code"}`);
    }
    return {
        deviceCode: String(json.device_code),
        userCode: String(json.user_code),
        verificationUrl: String(json.verification_url || "https://openapi.baidu.com/device"),
        qrcodeUrl: String(json.qrcode_url || ""),
        interval: Math.max(Number(json.interval) || 5, 3),
        expiresAt: Date.now() + (Number(json.expires_in) || 900) * 1000,
    };
}

// 轮询设备码授权结果:"pending"=等待用户确认 / "slow"=请求过快 / "done"=授权完成(令牌已持久化)。
// 临时异常(网络波动、响应无法解析等)抛 BdAuthTransientError,调用方应继续轮询;
// 设备码过期、密钥无效、用户拒绝等才抛普通 Error 终止授权。
// 注意:百度设备授权的 grant_type 是自定义的 device_token(非 RFC 的 URN),且必须带 openapi=xpansdk。
export async function bdPollDeviceAuth(auth: BdDeviceAuth): Promise<"pending" | "slow" | "done"> {
    if (Date.now() > auth.expiresAt) throw new Error("设备码已过期,请重新发起授权");
    const url = "https://openapi.baidu.com/oauth/2.0/token?" + new URLSearchParams({
        grant_type: "device_token",
        openapi: "xpansdk",
        code: auth.deviceCode,
        client_id: bdConfig.appKey,
        client_secret: bdConfig.secretKey,
    }).toString();
    let json: any;
    try {
        const resp = await bdHttp(url);
        json = parseTokenBody(decodeAuto(new Uint8Array(resp.bytes)));
    } catch (e) {
        throw new BdAuthTransientError(`网络波动,自动重试(${(e as any)?.message || e})`);
    }
    if (json.access_token) {
        bdConfig.accessToken = String(json.access_token);
        bdConfig.refreshToken = String(json.refresh_token || "");
        bdConfig.tokenExpiresAt = Date.now() + (Number(json.expires_in) || 2592000) * 1000;
        await persistBdConfig();
        return "done";
    }
    const err = String(json.error || "");
    if (err === "authorization_pending") return "pending";
    if (err === "slow_down") return "slow";
    if (err === "expired_token") throw new Error("设备码已过期,请重新发起授权");
    if (err === "invalid_client") throw new Error(`AppKey/SecretKey 无效(${json.error_description || err}),请检查后重填`);
    if (err === "access_denied") throw new Error("你拒绝了本次授权,如需继续请重新发起授权");
    throw new BdAuthTransientError(`临时异常,自动重试(${json.error_description || err || "未知错误"})`);
}

// ==== 列目录(带 TTL 缓存,写操作后失效)====
interface BdListCacheEntry {
    ts: number;
    entries: DirEntry[];
}
const listCache = new Map<string, BdListCacheEntry>();   // key = 云端目录路径
const fsidCache = new Map<string, number>();             // 云端文件路径 → fs_id(官方下载用)
const LIST_TTL = 30 * 1000;

// 清空列目录缓存(文件树刷新按钮调用;不传 dir 清空全部)
export function clearBaiduListCache(dir?: string): void {
    if (!dir) {
        listCache.clear();
        fsidCache.clear();
        return;
    }
    const key = normCloudDir(dir);
    listCache.delete(key);
    for (const p of Array.from(fsidCache.keys())) {
        if (p === key || p.startsWith(key + "/")) fsidCache.delete(p);
    }
}

// cookie 模式:pan.baidu.com/api/list 列目录(翻页)
async function cookieListItems(cloudDir: string): Promise<any[]> {
    let all: any[] = [];
    for (let page = 1; page <= 10; page++) {
        const url = "https://pan.baidu.com/api/list?" + new URLSearchParams({
            dir: cloudDir,
            order: "name",
            desc: "0",
            clienttype: "0",
            web: "1",
            num: "1000",
            page: String(page),
        }).toString();
        const json = await bdJSON<any>(url, {}, "读取网盘目录");
        const list = Array.isArray(json.list) ? json.list : [];
        all = all.concat(list);
        if (list.length < 1000) break;
    }
    return all;
}

// official 模式:xpan file?method=list 列目录(start/limit 翻页)
async function officialListItems(cloudDir: string): Promise<any[]> {
    let all: any[] = [];
    const limit = 200;
    let start = 0;
    for (let guard = 0; guard < 50; guard++) {
        const url = "https://pan.baidu.com/rest/2.0/xpan/file?method=list&" + new URLSearchParams({
            dir: cloudDir,
            web: "web",
            order: "name",
            start: String(start),
            limit: String(limit),
        }).toString();
        const json = await officialJSON<any>(url, {}, "读取网盘目录");
        const list = Array.isArray(json.list) ? json.list : [];
        all = all.concat(list);
        if (list.length < limit) break;
        start += limit;
    }
    return all;
}

// 列出 bdpan:// 虚拟目录下的条目(条目自带 bdpan:// 子路径)
export async function bdListDir(vPath: string): Promise<DirEntry[]> {
    const cloudDir = baiduCloudPath(vPath);
    const vBase = BDPAN_PREFIX + baiduPathBody(vPath);
    const cached = listCache.get(cloudDir);
    if (cached && Date.now() - cached.ts < LIST_TTL) return cached.entries;

    const items = bdConfig.mode === "official" ? await officialListItems(cloudDir) : await cookieListItems(cloudDir);
    const entries: DirEntry[] = items.map((it: any) => {
        const name = String(it.server_filename || "").replace(/\/+$/, "") || String(it.path || "").split("/").pop() || "";
        const fsId = Number(it.fs_id) || 0;
        if (fsId && it.path) fsidCache.set(normCloudDir(String(it.path)), fsId);
        return {
            name,
            isDir: Number(it.isdir) === 1,
            size: Number(it.size) || 0,
            updated: it.local_mtime ? new Date(Number(it.local_mtime) * 1000).toISOString() : "",
            path: baiduChildVPath(vBase, name),
        };
    }).filter(e => !!e.name);
    if (listCache.size > 300) listCache.clear();
    listCache.set(cloudDir, {ts: Date.now(), entries});
    return entries;
}

// ==== 配额(用于验证凭据是否有效)====
export async function bdQuota(): Promise<{quota: number; used: number}> {
    if (bdConfig.mode === "official") {
        const json = await officialJSON<any>("https://pan.baidu.com/api/quota?checkfree=1&checkexpire=1", {}, "获取网盘配额");
        return {quota: Number(json.total) || 0, used: Number(json.used) || 0};
    }
    const url = "https://pcs.baidu.com/rest/2.0/pcs/quota?app_id=" + BD_APP_ID + "&method=info";
    const json = await bdJSON<any>(url, {}, "获取网盘配额");
    return {quota: Number(json.quota) || 0, used: Number(json.used) || 0};
}

// ==== 下载 ====
// 官方模式:解析路径 → fs_id(优先用列目录缓存,缺失时列父目录)→ filemetas 取 dlink → 下载
async function resolveFsid(cloud: string): Promise<number> {
    const hit = fsidCache.get(cloud);
    if (hit) return hit;
    await bdListDir(BDPAN_PREFIX + cloudParent(cloud)); // 列父目录填充 fsidCache
    const fsid = fsidCache.get(cloud);
    if (!fsid) throw new Error(`网盘中未找到文件: ${cloud}`);
    return fsid;
}

// 官方模式:filemetas(dlink)→ 下载(UA 必须 pan.baidu.com)
async function officialDownload(cloud: string): Promise<ArrayBuffer> {
    const fsid = await resolveFsid(cloud);
    const url = "https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=" +
        encodeURIComponent(`[${fsid}]`) + "&dlink=1";
    const json = await officialJSON<any>(url, {}, "获取下载链接");
    const dlink = String(json?.list?.[0]?.dlink || "");
    if (!dlink) throw new Error("获取下载链接失败:响应缺少 dlink");
    const token = await ensureOfficialToken();
    const u = dlink + (dlink.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(token);
    const resp = await bdHttp(u, {headers: {"User-Agent": OFFICIAL_UA}});
    if (resp.status >= 400) throw new Error(`下载失败: HTTP ${resp.status}`);
    return sniffErrorJSON(resp);
}

// 下载失败时百度可能返回 200 + JSON(errno),按内容嗅探避免把错误 JSON 当文件内容
function sniffErrorJSON(resp: BdResp): ArrayBuffer {
    const bytes = new Uint8Array(resp.bytes);
    if (bytes.length > 0 && bytes.length < 64 * 1024 && (bytes[0] === 0x7b /* { */ || bytes[0] === 0x20 || bytes[0] === 0x0a)) {
        try {
            const json = JSON.parse(decodeAuto(bytes));
            if (json && typeof json.errno === "number" && json.errno !== 0) {
                throw new BdErrnoError(errnoMessage(json.errno, "下载"), json.errno);
            }
            if (json && typeof json.code === "number" && json.code !== 0 && json.msg) {
                throw new Error(`下载失败: ${json.msg}`);
            }
        } catch (e) {
            if (e instanceof BdErrnoError) throw e;
            // 非 JSON(如恰好以 { 开头的真实文件)按原样返回
        }
    }
    return resp.bytes;
}

// 下载网盘文件(cookie:pcs 路径直下;official:filemetas → dlink;代理端响应上限 32MB)
export async function bdDownloadFile(vPath: string): Promise<ArrayBuffer> {
    const cloud = baiduCloudPath(vPath);
    if (!cloud || cloud === "/") throw new Error("不能下载目录");
    if (bdConfig.mode === "official") return await officialDownload(cloud);
    const url = "https://pcs.baidu.com/rest/2.0/pcs/file?app_id=" + BD_APP_ID +
        "&method=download&path=" + encodeURIComponent(cloud);
    const resp = await bdHttp(url);
    if (resp.status >= 400) throw new Error(`下载失败: HTTP ${resp.status}`);
    return sniffErrorJSON(resp);
}

// ==== 上传(precreate → superfile2 分片 → create;二进制分片仅桌面端)====
const UPLOAD_CHUNK = 4 * 1024 * 1024;    // 分片大小(官方非会员上限 4MB)
const SLICE_MD5_SIZE = 256 * 1024;       // slice-md5 取前 256KB

// 标准 MD5(上传分片校验用;SubtleCrypto 不支持 MD5)
function md5Hex(bytes: Uint8Array): string {
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    }
    const len = bytes.length;
    const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bits % 4294967296, true);
    dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F: number, g: number;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            F = (F + A + K[i] + M[g]) | 0;
            A = D;
            D = C;
            C = B;
            B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
        }
        a0 = (a0 + A) | 0;
        b0 = (b0 + B) | 0;
        c0 = (c0 + C) | 0;
        d0 = (d0 + D) | 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    out.setInt32(0, a0, true);
    out.setInt32(4, b0, true);
    out.setInt32(8, c0, true);
    out.setInt32(12, d0, true);
    const hexBytes = new Uint8Array(out.buffer);
    let hex = "";
    for (let i = 0; i < 16; i++) hex += hexBytes[i].toString(16).padStart(2, "0");
    return hex;
}

// 上传单个分片(cookie:pcs superfile2 + BDUSS;official:pcs superfile2 + access_token)
async function uploadChunk(uploadid: string, cloud: string, seq: number, chunk: Uint8Array): Promise<void> {
    const boundary = newBoundary();
    const body = multipartFile(basename(cloud), chunk, boundary);
    const common = {
        app_id: BD_APP_ID,
        method: "upload",
        type: "tmpfile",
        path: cloud,
        partseq: String(seq),
        uploadid,
    };
    if (bdConfig.mode === "cookie") {
        const url = "https://pcs.baidu.com/rest/2.0/pcs/superfile2?" + new URLSearchParams({
            ...common,
            partoffset: String(seq * UPLOAD_CHUNK),
            vip: "1",
        }).toString();
        await bdJSON(url, {
            method: "POST",
            headers: {"Content-Type": `multipart/form-data; boundary=${boundary}`},
            body,
        }, "上传网盘文件(分片)");
        return;
    }
    const token = await ensureOfficialToken();
    const url = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?" + new URLSearchParams({
        method: "upload",
        access_token: token,
        type: "tmpfile",
        path: cloud,
        uploadid,
        partseq: String(seq),
    }).toString();
    await bdJSON(url, {
        method: "POST",
        headers: {"Content-Type": `multipart/form-data; boundary=${boundary}`, "User-Agent": OFFICIAL_UA},
        body,
    }, "上传网盘文件(分片)");
}

// 切分上传分片
function splitChunks(bytes: Uint8Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < bytes.length; off += UPLOAD_CHUNK) {
        chunks.push(bytes.subarray(off, Math.min(off + UPLOAD_CHUNK, bytes.length)));
    }
    return chunks;
}

// 官方模式上传:precreate(rtype=3 覆盖)→ 分片(秒传命中跳过)→ create
// 注意:官方上传接口不支持 0 字节文件,先尝试以空 md5 秒传直建,失败则给出可读错误
async function officialUpload(cloud: string, bytes: Uint8Array): Promise<void> {
    const blockList = bytes.length > 0
        ? splitChunks(bytes).map(c => md5Hex(c))
        : [EMPTY_MD5];
    if (bytes.length === 0) {
        try {
            await officialJSON("https://pan.baidu.com/rest/2.0/xpan/file?method=create", {
                method: "POST",
                form: {path: cloud, size: "0", isdir: "0", rtype: "3", block_list: JSON.stringify(blockList)},
            }, "创建网盘文件");
            clearBaiduListCache(cloudParent(cloud));
            return;
        } catch (e) {
            throw new Error(`官方接口不支持创建空文件,请打开文件输入内容后保存(${(e as any)?.message || e})`);
        }
    }
    const sliceMd5 = md5Hex(bytes.subarray(0, Math.min(SLICE_MD5_SIZE, bytes.length)));
    const pre = await officialJSON<any>("https://pan.baidu.com/rest/2.0/xpan/file?method=precreate", {
        method: "POST",
        form: {
            path: cloud,
            size: String(bytes.length),
            isdir: "0",
            autoinit: "1",
            rtype: "3", // 覆盖同名文件
            block_list: JSON.stringify(blockList),
            "content-md5": md5Hex(bytes),
            "slice-md5": sliceMd5,
            local_mtime: String(Math.floor(Date.now() / 1000)),
        },
    }, "上传网盘文件(precreate)");
    // 分片上传(秒传命中 return_type=2 时跳过)
    if (pre.return_type === 1 && pre.uploadid) {
        const chunks = splitChunks(bytes);
        const pending: number[] = Array.isArray(pre.block_list) && typeof pre.block_list[0] === "number"
            ? pre.block_list.filter((n: number) => n >= 0 && n < chunks.length)
            : chunks.map((_, i) => i);
        for (const seq of pending) {
            await uploadChunk(pre.uploadid, cloud, seq, chunks[seq]);
        }
    }
    await officialJSON("https://pan.baidu.com/rest/2.0/xpan/file?method=create", {
        method: "POST",
        form: {
            path: cloud,
            size: String(bytes.length),
            isdir: "0",
            rtype: "3",
            uploadid: String(pre.uploadid || ""),
            block_list: JSON.stringify(blockList),
            local_mtime: String(Math.floor(Date.now() / 1000)),
        },
    }, "上传网盘文件(create)");
    clearBaiduListCache(cloudParent(cloud));
}

// cookie 模式上传:precreate → superfile2 → pan create(与 BaiduPCS-Go 一致)
async function cookieUpload(cloud: string, bytes: Uint8Array): Promise<void> {
    const chunks = bytes.length > 0 ? splitChunks(bytes) : [bytes.subarray(0, 0)];
    const blockList = chunks.map(c => md5Hex(c));
    const sliceMd5 = md5Hex(bytes.subarray(0, Math.min(SLICE_MD5_SIZE, bytes.length)));
    const pre = await bdJSON<any>("https://pan.baidu.com/api/precreate", {
        method: "POST",
        body: formEncode({
            path: cloud,
            size: String(bytes.length),
            isdir: "0",
            autoinit: "1",
            "content-md5": md5Hex(bytes),
            "slice-md5": sliceMd5,
            "contentCrc32": "",
            block_list: JSON.stringify(blockList),
            rtype: "2", // 与 BaiduPCS-Go 一致(precreate 阶段);覆盖在 create 阶段决定
        }),
    }, "上传网盘文件(precreate)");
    // 分片上传(秒传命中时跳过;空文件无分片可传)
    if (bytes.length > 0 && pre.return_type === 1 && pre.uploadid) {
        for (let i = 0; i < chunks.length; i++) {
            await uploadChunk(pre.uploadid, cloud, i, chunks[i]);
        }
    }
    await bdJSON("https://pan.baidu.com/api/create", {
        method: "POST",
        body: formEncode({
            path: cloud,
            size: String(bytes.length),
            isdir: "0",
            rtype: "3",
            uploadid: String(pre.uploadid || ""),
            block_list: JSON.stringify(blockList),
            target_path: cloudParent(cloud),
        }),
    }, "上传网盘文件(create)");
    clearBaiduListCache(cloudParent(cloud));
}

// 写入网盘文件(覆盖语义);完成后失效父目录缓存
export async function bdUploadFile(vPath: string, data: Uint8Array): Promise<void> {
    const cloud = baiduCloudPath(vPath);
    if (!cloud || cloud === "/") throw new Error("上传路径无效");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bdConfig.mode === "official") return await officialUpload(cloud, bytes);
    return await cookieUpload(cloud, bytes);
}

// ==== 目录与文件管理 ====
// 创建目录
export async function bdCreateDir(vPath: string): Promise<void> {
    const cloud = baiduCloudPath(vPath);
    if (!cloud || cloud === "/") throw new Error("目录路径无效");
    if (bdConfig.mode === "official") {
        await officialJSON("https://pan.baidu.com/rest/2.0/xpan/file?method=create", {
            method: "POST",
            form: {path: cloud, size: "0", isdir: "1", rtype: "3"},
        }, "创建网盘目录");
    } else {
        const url = "https://pcs.baidu.com/rest/2.0/pcs/file?app_id=" + BD_APP_ID +
            "&method=mkdir&path=" + encodeURIComponent(cloud);
        await bdJSON(url, {method: "POST"}, "创建网盘目录");
    }
    clearBaiduListCache(cloudParent(cloud));
}

// 删除文件或目录(递归)
export async function bdRemove(vPath: string): Promise<void> {
    const cloud = baiduCloudPath(vPath);
    if (!cloud || cloud === "/") throw new Error("不能删除网盘根目录");
    if (bdConfig.mode === "official") {
        await officialJSON("https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete", {
            method: "POST",
            form: {async: "0", filelist: JSON.stringify([cloud]), ondup: "fail"},
        }, "删除网盘文件");
    } else {
        const boundary = newBoundary();
        await bdJSON("https://pcs.baidu.com/rest/2.0/pcs/file?app_id=" + BD_APP_ID + "&method=delete", {
            method: "POST",
            headers: {"Content-Type": `multipart/form-data; boundary=${boundary}`},
            body: multipartParam(JSON.stringify({list: [cloud]}), boundary),
        }, "删除网盘文件");
    }
    clearBaiduListCache(cloudParent(cloud));
}

// 重命名(同目录改名;跨目录移动不在文件树操作范围内)
export async function bdRename(vPath: string, newVPath: string): Promise<void> {
    const from = baiduCloudPath(vPath);
    const to = baiduCloudPath(newVPath);
    if (cloudParent(from) !== cloudParent(to)) throw new Error("网盘暂不支持跨目录移动,请使用官方客户端");
    if (bdConfig.mode === "official") {
        await officialJSON("https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=rename", {
            method: "POST",
            form: {async: "0", filelist: JSON.stringify([{path: from, newname: basename(to)}]), ondup: "fail"},
        }, "重命名网盘文件");
    } else {
        const boundary = newBoundary();
        await bdJSON("https://pcs.baidu.com/rest/2.0/pcs/file?app_id=" + BD_APP_ID + "&method=move", {
            method: "POST",
            headers: {"Content-Type": `multipart/form-data; boundary=${boundary}`},
            body: multipartParam(JSON.stringify({list: [{from, to}]}), boundary),
        }, "重命名网盘文件");
    }
    clearBaiduListCache(cloudParent(from));
}
