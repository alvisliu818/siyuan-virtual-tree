// VSCode Marketplace API 客户端(非官方)
// 注意:VSCode Marketplace 的 API 是非公开的,仅供 VSCode 客户端使用
//   使用此 API 存在法律风险,建议优先使用 Open VSX Registry
//
// 关键端点:
//   搜索: POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery
//   下载: GET https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/vsextensions/{extension}/{version}/vspackage
//
// 搜索请求体格式(VSCode 特有的查询协议):
//   {
//     "filters": [{
//       "pageNumber": 1,
//       "pageSize": 20,
//       "criteria": [
//         {"filterType": 8, "value": "搜索关键词"},   // 8 = SearchText
//         {"filterType": 5, "value": "Microsoft.VisualStudio.Code"}  // 5 = Target
//       ]
//     }],
//     "assetTypes": ["Microsoft.VisualStudio.Services.VSIXPackage"],
//     "flags": 0x192
//   }
import {SearchEntry, SearchResult} from "./types";

const BASE_URL = "https://marketplace.visualstudio.com/_apis/public/gallery";

// 搜索扩展
export async function searchMarketplaceExtensions(
    query: string,
    size: number = 20,
    pageNumber: number = 1,
): Promise<SearchResult> {
    const body = {
        filters: [{
            pageNumber,
            pageSize: size,
            criteria: [
                {filterType: 8, value: query}, // 8 = SearchText
                {filterType: 5, value: "Microsoft.VisualStudio.Code"}, // 5 = Target
            ],
        }],
        assetTypes: ["Microsoft.VisualStudio.Services.VSIXPackage"],
        // flags: 0x192 = IncludeVersionProperties | IncludeAssetUri | IncludeStatistics | IncludeLatestVersionOnly
        flags: 0x192,
    };

    const resp = await fetch(`${BASE_URL}/extensionquery`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json;api-version=3.0-preview.1",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Marketplace 搜索失败: HTTP ${resp.status}`);

    const data = await resp.json();
    const results = data.results || [];
    const extensions: SearchEntry[] = [];

    for (const result of results) {
        const items = result.extensions || [];
        for (const ext of items) {
            const publisher = ext.publisher?.publisherName || "";
            const name = ext.extensionName || "";
            const versions = ext.versions || [];
            const latestVersion = versions[0];
            if (!latestVersion) continue;

            // 提取下载链接
            const asset = (latestVersion.files || []).find(
                (f: any) => f.assetType === "Microsoft.VisualStudio.Services.VSIXPackage",
            );
            const downloadLink = asset?.source;

            // 提取图标
            const iconAsset = (latestVersion.files || []).find(
                (f: any) => f.assetType === "Microsoft.VisualStudio.Services.Icons.Default",
            );
            const iconLink = iconAsset?.source;

            // 提取统计信息
            const statistics = ext.statistics || [];
            const ratingStat = statistics.find((s: any) => s.statisticName === "averagerating");
            const ratingCountStat = statistics.find((s: any) => s.statisticName === "ratingcount");

            // 提取版本属性
            const properties = latestVersion.properties || [];
            const descProp = properties.find((p: any) => p.key === "Microsoft.VisualStudio.Code.ExtensionProperties.Description");

            extensions.push({
                namespace: publisher,
                name,
                version: latestVersion.version || "0.0.0",
                displayName: ext.displayName || name,
                description: descProp?.value || ext.shortDescription || "",
                downloadLink,
                iconLink,
                averageRating: ratingStat?.value,
                reviewCount: ratingCountStat?.value,
                timestamp: latestVersion.lastUpdated,
                source: "vscode-marketplace",
            });
        }
    }

    return {
        extensions,
        offset: (pageNumber - 1) * size,
        totalSize: extensions.length,
    };
}

// 获取扩展最新版本号(用于下载前确定版本)
export async function getLatestVersion(
    publisher: string,
    extension: string,
): Promise<string> {
    // 通过查询 API 获取特定扩展的最新版本
    const body = {
        filters: [{
            pageNumber: 1,
            pageSize: 1,
            criteria: [
                {filterType: 7, value: `${publisher}.${extension}`}, // 7 = ExtensionName
                {filterType: 5, value: "Microsoft.VisualStudio.Code"},
            ],
        }],
        assetTypes: [],
        flags: 0x192,
    };

    const resp = await fetch(`${BASE_URL}/extensionquery`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json;api-version=3.0-preview.1",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`获取版本失败: HTTP ${resp.status}`);

    const data = await resp.json();
    const results = data.results || [];
    const firstResult = results[0];
    const ext = firstResult?.extensions?.[0];
    const version = ext?.versions?.[0]?.version;
    if (!version) throw new Error(`未找到扩展 ${publisher}.${extension}`);
    return version;
}

// 下载 VSIX 文件(返回 ArrayBuffer)
// Marketplace 的下载链接可能返回 gzip 压缩的内容,需要正确处理
export async function downloadMarketplaceVsix(
    publisher: string,
    extension: string,
    version: string,
): Promise<ArrayBuffer> {
    const url = `${BASE_URL}/publishers/${publisher}/vsextensions/${extension}/${version}/vspackage`;
    const resp = await fetch(url, {
        headers: {
            "Accept-Encoding": "gzip",
        },
    });
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    return resp.arrayBuffer();
}
