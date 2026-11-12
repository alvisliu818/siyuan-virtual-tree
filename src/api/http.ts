// 远程 HTTP 传输层(网盘 / Git 仓库等云端后端共用)。
// 桌面端直接用 Node https:可自定义任意请求头(Cookie / User-Agent / Authorization)、
// 支持二进制请求体、自动跟随 30x 跳转,无响应大小限制;
// 浏览器端(无 Node 集成)回退思源内核代理,响应上限 32MB、不支持二进制请求体。
import {getNativeRequire, isNodeModulesAvailable} from "../utils/native-require";

export interface HttpResponse {
    status: number;
    bytes: ArrayBuffer;
    contentType: string;
}

export interface HttpRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | null;
}

// 内核鉴权头(与 api/file.ts 一致;本地桌面端无需 token,此处防御性补充)
export function kernelAuthHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

// RawURL base64(内核代理参数编码)
export function b64url(s: string): string {
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
): Promise<HttpResponse> {
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
): Promise<HttpResponse> {
    if (proxyMode !== "old") {
        // 新版内核(v3.8+):/api/network/proxy?u=<b64url>&h=<b64url(headers)>&t=<timeout>
        // 方法与请求体由本请求透传;响应为原始字节流(上限 32MB)
        try {
            // 内核要求 h 是 map[string][]string(Go http.Header 的形状),
            // 传扁平的 string 值会被拒:parse [h] failed: cannot unmarshal string into []string
            const multi: Record<string, string[]> = {};
            for (const [k, v] of Object.entries(headers)) multi[k] = [v];
            const h = b64url(JSON.stringify(multi));
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
                // 代理把自身 Content-Type 固定成 application/octet-stream(防嗅探),
                // 上游真实类型在 Siyuan-Proxy-Content-Type 里
                return {
                    status: resp.status,
                    bytes: await resp.arrayBuffer(),
                    contentType: resp.headers.get("siyuan-proxy-content-type") || resp.headers.get("content-type") || "",
                };
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

// 统一请求入口:桌面端走 Node https,浏览器端走内核代理。
// 调用方负责注入自己的默认头(鉴权 / UA / Accept-Encoding)。
export async function httpRequest(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    const method = opts.method || "GET";
    const headers = opts.headers || {};
    const body = opts.body === undefined ? null : opts.body;
    if (isNodeModulesAvailable()) {
        return await nodeRequest(url, method, headers, body);
    }
    // 浏览器端:二进制 body(如网盘上传分片)无法经代理传输
    if (body instanceof Uint8Array) {
        throw new Error("浏览器端暂不支持该操作(二进制请求体),请使用思源桌面端");
    }
    return await proxyRequest(url, method, headers, typeof body === "string" ? body : null);
}