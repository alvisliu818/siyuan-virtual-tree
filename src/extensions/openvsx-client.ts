// Open VSX Registry API 客户端
// 文档: https://open-vsx.org/swagger-ui
// 关键端点:
//   搜索: GET /api/-/search?query={q}&size={n}&offset={o}
//   元数据: GET /api/{namespace}/{extension}/{version}
//   文件: GET /api/{namespace}/{extension}/{version}/file/{path}
import {SearchEntry, SearchResult} from "./types";

const BASE_URL = "https://open-vsx.org/api";

// 搜索扩展
export async function searchExtensions(
    query: string,
    size: number = 20,
    offset: number = 0,
): Promise<SearchResult> {
    const url = `${BASE_URL}/-/search?query=${encodeURIComponent(query)}&size=${size}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`搜索失败: HTTP ${resp.status}`);
    const data = await resp.json();
    const extensions: SearchEntry[] = (data.extensions || []).map((e: any) => ({
        namespace: e.namespace,
        name: e.name,
        version: e.version,
        displayName: e.displayName || e.name,
        description: e.description || "",
        downloadLink: e.files?.download || "",
        iconLink: e.files?.icon || e.files?.resource || "",
        averageRating: e.averageRating,
        reviewCount: e.reviewCount,
        timestamp: e.timestamp,
    }));
    return {
        extensions,
        offset: data.offset || offset,
        totalSize: data.totalSize || extensions.length,
    };
}

// 获取扩展元数据(最新版本)
export async function getExtensionMetadata(
    namespace: string,
    extension: string,
): Promise<any> {
    const url = `${BASE_URL}/${namespace}/${extension}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`获取扩展信息失败: HTTP ${resp.status}`);
    return resp.json();
}

// 获取特定版本的扩展元数据
export async function getExtensionVersion(
    namespace: string,
    extension: string,
    version: string,
): Promise<any> {
    const url = `${BASE_URL}/${namespace}/${extension}/${version}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`获取扩展版本信息失败: HTTP ${resp.status}`);
    return resp.json();
}

// 下载 .vsix 文件(返回 ArrayBuffer)
export async function downloadVsix(downloadLink: string): Promise<ArrayBuffer> {
    if (!downloadLink) throw new Error("下载链接为空");
    const resp = await fetch(downloadLink);
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    return resp.arrayBuffer();
}

// 获取扩展文件内容(直接从 Open VSX,无需下载整个 vsix)
export async function fetchExtensionFile(
    namespace: string,
    extension: string,
    version: string,
    filePath: string,
): Promise<string> {
    const url = `${BASE_URL}/${namespace}/${extension}/${version}/file/${filePath}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`获取文件失败: HTTP ${resp.status} - ${filePath}`);
    return resp.text();
}
