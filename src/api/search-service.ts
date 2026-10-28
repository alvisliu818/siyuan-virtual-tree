// 本地搜索服务客户端:全局搜索面板的两个「服务」范围。
//
// 1. Everything(voidtools)—— 全盘文件名搜索
//    HTTP JSON 接口:GET http://<host>:<port>/?search=<关键词>&json=1&count=N&offset=M
//                    &path_column=1&size_column=1&date_modified_column=1
//    需在 Everything「工具→选项→HTTP 服务器」里启用(默认关闭,端口默认 80)。
//    返回 {totalResults, results:[{type:"file"|"folder", name, path, size, date_modified}]};
//    path 是所在目录(反斜杠),date_modified 是 FILETIME(1601 起 100ns)。
//
// 2. AnyTXT Searcher —— 全盘全文搜索
//    JSON-RPC 2.0:POST http://<host>:<port>/(桌面端 ATGUI 运行即有,本机实测端口 9920;
//    官方文档藏在 AnyTXT「菜单→帮助→API」,论坛只流传请求样例)
//      method: ATRpcServer.Searcher.V1.GetResult
//      params: {input:{pattern, filterDir:"*", filterExt:"*", lastModifyBegin:0,
//                      lastModifyEnd:2147483647, limit, offset, order:0}}
//      → result.data.output = {count, field:["fid","lastModify","size","file"], files:[[...],...]}
//      method: ATRpcServer.Searcher.V1.GetFragment  params:{input:{fid, pattern}}
//      → result.data.output.text(命中片段;AnyTXT 只给片段不给行号)
//    注意:AnyTXT 刚启动还在建索引时搜索恒返回 count=0,属正常现象。
//
// 传输层与 baidu-pan 同一套:桌面端 Node http 直连(本地服务无 CORS 顾虑);
// 浏览器端回退思源内核代理(/api/network/proxy 新版 / /api/fetch/proxy 旧版)。
import {getNativeRequire, isNodeModulesAvailable} from "../utils/native-require";

// 归一化后的一个命中
export interface ServiceHit {
    path: string;        // 完整路径(正斜杠)
    name: string;        // 文件名
    isDir: boolean;
    size?: number;       // 字节
    modifiedMs?: number; // 修改时间(ms)
    fid?: string;        // AnyTXT 文件 id(取片段用;Everything 无)
}

interface RawResp {
    status: number;
    bytes: ArrayBuffer;
}

// ==== 传输层 ====

function kernelAuthHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

function b64url(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Node http 请求(桌面端):本地服务都是 http,不需要 https/重定向
function nodeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
): Promise<RawResp> {
    return new Promise((resolve, reject) => {
        const req = getNativeRequire();
        let mod: any;
        try {
            mod = req!("http");
        } catch (e) {
            reject(new Error(`无法加载 Node http 模块: ${e}`));
            return;
        }
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            reject(new Error(`URL 无效: ${url}`));
            return;
        }
        const r = mod.request(u, {method, headers, timeout: timeoutMs}, (res: any) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                const out = new Uint8Array(buf.length);
                out.set(buf);
                resolve({status: res.statusCode || 0, bytes: out.buffer});
            });
        });
        r.on("timeout", () => r.destroy(new Error("请求超时")));
        r.on("error", reject);
        if (body !== null) {
            const payload = Buffer.from(body, "utf8");
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
): Promise<RawResp> {
    if (proxyMode !== "old") {
        try {
            const h = b64url(JSON.stringify(headers));
            const resp = await fetch(`/api/network/proxy?u=${b64url(url)}&h=${encodeURIComponent(h)}&t=30s`, {
                method,
                headers: {
                    ...kernelAuthHeaders(),
                    ...(body !== null ? {"Content-Type": headers["Content-Type"] || "application/json"} : {}),
                },
                body: body !== null ? body : undefined,
            });
            if (resp.status !== 404) {
                proxyMode = "new";
                return {status: resp.status, bytes: await resp.arrayBuffer()};
            }
        } catch {
            // 请求失败继续尝试旧端点
        }
        if (proxyMode === "") proxyMode = "old";
    }
    const resp = await fetch("/api/fetch/proxy", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...kernelAuthHeaders()},
        body: JSON.stringify({
            url,
            method,
            headers,
            timeout: 30000,
            ...(body !== null ? {contentType: headers["Content-Type"] || "application/json", payload: body} : {}),
        }),
    });
    if (resp.status === 404) {
        throw new Error("思源内核代理不可用,请使用思源桌面端");
    }
    proxyMode = "old";
    return {status: resp.status, bytes: await resp.arrayBuffer()};
}

async function localHttp(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs = 15000,
): Promise<RawResp> {
    if (isNodeModulesAvailable()) {
        return await nodeRequest(url, method, headers, body, timeoutMs);
    }
    return await proxyRequest(url, method, headers, body);
}

// 连接类错误(拒绝/超时/DNS)翻译成人话:多半是服务没开或地址不对
function friendlyError(url: string, service: string, hint: string, e: unknown): Error {
    const msg = String((e as Error)?.message || e);
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|Failed to fetch|网络|超时|timed? ?out/i.test(msg)) {
        return new Error(`无法连接 ${service}(${url})——请确认服务已启用。${hint}`);
    }
    return e instanceof Error ? e : new Error(msg);
}

// 地址规整:去空白与结尾斜杠;无协议时补 http://(用户常只填 127.0.0.1:9920)
export function normalizeServiceUrl(raw: string): string {
    let s = (raw || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    return s;
}

function decodeBody(bytes: ArrayBuffer): string {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

// FILETIME(1601-01-01 起 100ns)→ ms
function filetimeToMs(v: unknown): number | undefined {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n / 10000 - 11644473600000;
}

// 秒/毫秒时间戳容错归一(Everything 给 FILETIME,AnyTXT 给秒)
function unixToMs(v: unknown): number | undefined {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n > 1e12 ? n : n * 1000;
}

// ==== Everything ====

export async function searchEverything(
    keyword: string,
    opts: {url: string; limit: number; offset?: number},
): Promise<ServiceHit[]> {
    const base = normalizeServiceUrl(opts.url);
    if (!base) throw new Error("未配置 Everything 服务地址(设置 → 文件树)");
    const params = new URLSearchParams({
        search: keyword,
        json: "1",
        count: String(opts.limit),
        offset: String(opts.offset || 0),
        path_column: "1",
        size_column: "1",
        date_modified_column: "1",
    });
    let resp: RawResp;
    try {
        resp = await localHttp(`${base}/?${params.toString()}`, "GET", {Accept: "application/json"}, null);
    } catch (e) {
        throw friendlyError(base, "Everything 服务", "需在 Everything「工具→选项→HTTP 服务器」中启用", e);
    }
    if (resp.status !== 200) {
        throw new Error(`Everything 服务返回 HTTP ${resp.status}(需在 Everything「工具→选项→HTTP 服务器」中启用)`);
    }
    let data: any;
    try {
        data = JSON.parse(decodeBody(resp.bytes));
    } catch {
        throw new Error("Everything 服务响应不是有效 JSON(该端口可能不是 Everything HTTP 服务)");
    }
    const rows = Array.isArray(data?.results) ? data.results : [];
    return rows.map((r: any) => {
        const dir = String(r?.path || "").replace(/\\/g, "/");
        const name = String(r?.name || "");
        return {
            path: dir ? `${dir}/${name}` : name,
            name,
            isDir: r?.type === "folder",
            size: Number(r?.size) || undefined,
            modifiedMs: filetimeToMs(r?.date_modified),
        };
    });
}

// ==== AnyTXT ====

function anytxtPayload(method: string, input: Record<string, unknown>): string {
    return JSON.stringify({id: 1, jsonrpc: "2.0", method, params: {input}});
}

async function anytxtRpc(url: string, method: string, input: Record<string, unknown>): Promise<any> {
    let resp: RawResp;
    try {
        resp = await localHttp(url + "/", "POST", {
            "Content-Type": "application/json",
            Accept: "application/json",
        }, anytxtPayload(method, input), method.includes("Fragment") ? 20000 : 30000);
    } catch (e) {
        throw friendlyError(url, "AnyTXT 服务", "需保持 AnyTXT Searcher 运行(其内建 SDK 服务)", e);
    }
    if (resp.status !== 200) {
        throw new Error(`AnyTXT 服务返回 HTTP ${resp.status}`);
    }
    let data: any;
    try {
        data = JSON.parse(decodeBody(resp.bytes));
    } catch {
        throw new Error("AnyTXT 服务响应不是有效 JSON(该端口可能不是 AnyTXT SDK 服务)");
    }
    if (data?.error) {
        throw new Error(`AnyTXT: ${data.error?.message || "invalid request"}`);
    }
    return data?.result?.data;
}

export async function searchAnyTxt(
    keyword: string,
    opts: {url: string; limit: number; offset?: number},
): Promise<ServiceHit[]> {
    const base = normalizeServiceUrl(opts.url);
    if (!base) throw new Error("未配置 AnyTXT 服务地址(设置 → 文件树)");
    const data = await anytxtRpc(base, "ATRpcServer.Searcher.V1.GetResult", {
        pattern: keyword,
        filterDir: "*",
        filterExt: "*",
        lastModifyBegin: 0,
        lastModifyEnd: 2147483647,
        limit: String(opts.limit),
        offset: opts.offset || 0,
        order: 0,
    });
    const output = data?.output || {};
    // files 是二维数组,列名在 field 里(缺省按 ["fid","lastModify","size","file"] 解)
    const fields: string[] = Array.isArray(output.field) && output.field.length > 0
        ? output.field.map(String)
        : ["fid", "lastModify", "size", "file"];
    const rows: any[] = Array.isArray(output.files) ? output.files : [];
    return rows.map((row: any) => {
        const rec: Record<string, any> = {};
        if (Array.isArray(row)) {
            fields.forEach((f, i) => { rec[f] = row[i]; });
        } else if (row && typeof row === "object") {
            // 防御:万一某个版本直接给对象
            Object.assign(rec, row);
        }
        const full = String(rec.file || "").replace(/\\/g, "/");
        return {
            path: full,
            name: full.split("/").pop() || full,
            isDir: false,
            size: Number(rec.size) || undefined,
            modifiedMs: unixToMs(rec.lastModify),
            fid: rec.fid !== undefined && rec.fid !== null ? String(rec.fid) : undefined,
        };
    });
}

// 取某文件的命中片段(AnyTXT 只给片段,不给行号;失败返回空串,由调用方降级为只列文件)
export async function fetchAnyTxtFragment(url: string, fid: string, pattern: string): Promise<string> {
    const base = normalizeServiceUrl(url);
    try {
        const data = await anytxtRpc(base, "ATRpcServer.Searcher.V1.GetFragment", {fid, pattern});
        const text = data?.output?.text;
        return typeof text === "string" ? text : "";
    } catch {
        return "";
    }
}
