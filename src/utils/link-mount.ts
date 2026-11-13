// 链接挂载(纯语法层 + 收藏读取):
//   weblink://<encodeURIComponent(url)>  单链接叶子(挂载"链接/网址"生成;点击用
//                                        思源浏览器插件打开,未装则系统浏览器)
//   bmarks:///<encodeURIComponent(标签)> 思源浏览器插件(siyuan-plugin-browser)的
//                                        收藏虚拟目录:根 = 标签目录 + 未标签书签;
//                                        书签叶子条目的 path 是 weblink:// 叶子
// 书签数据来自浏览器插件存储(/storage/petal/siyuan-plugin-browser/bookmarks.json,
// 经内核 /api/file/getFile 读取 —— 内核路径含 /storage,桌面/移动端均可读)。
import {DirEntry} from "../types";
import {kernelAuthHeaders} from "../api/http";

export const WEBLINK_PREFIX = "weblink://";
export const BMARKS_PREFIX = "bmarks://";
const BMARKS_SOURCE_PATH = "/data/storage/petal/siyuan-plugin-browser/bookmarks.json";

// 单链接虚拟路径(URL 整体 encodeURIComponent,解码即原 URL)
export function makeWeblinkVPath(url: string): string {
    return WEBLINK_PREFIX + encodeURIComponent(String(url || "").trim());
}

export function isWeblinkPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(WEBLINK_PREFIX);
}

// weblink:// → 原始 URL
export function weblinkUrlOf(p: string): string {
    try {
        return decodeURIComponent(p.slice(WEBLINK_PREFIX.length));
    } catch {
        return p.slice(WEBLINK_PREFIX.length);
    }
}

// 是否浏览器收藏虚拟路径
export function isBmarksPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(BMARKS_PREFIX);
}

// 打开外部链接:优先思源浏览器插件(其插件实例有公开 openUrl),未装/失败走系统浏览器
export function openExternalUrl(url: string): void {
    const u = String(url || "").trim();
    if (!u) return;
    try {
        const plugins = (window as any).siyuan?.ws?.app?.plugins || [];
        const bp = plugins.find((p: any) => p.name === "siyuan-plugin-browser");
        if (bp && typeof bp.openUrl === "function") {
            bp.openUrl(u);
            return;
        }
    } catch {
        // 浏览器插件不可用:走系统打开
    }
    window.open(u, "_blank");
}

// 浏览器插件书签(与 siyuan-plugin-browser 的 Bookmark 类型结构一致,只取所需字段)
interface BookmarkItem {
    title: string;
    url: string;
    tags: string[];
    createdAt?: number;
}

// 读浏览器插件的收藏(未安装/为空返回 [])
async function loadBookmarks(): Promise<BookmarkItem[]> {
    try {
        const resp = await fetch("/api/file/getFile", {
            method: "POST",
            headers: {"Content-Type": "application/json", ...kernelAuthHeaders()},
            body: JSON.stringify({path: BMARKS_SOURCE_PATH}),
        });
        if (!resp.ok) return [];
        const text = await resp.text();
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as BookmarkItem[]) : [];
    } catch {
        return [];
    }
}

// 书签条目名(展示用;path 是 weblink:// 叶子,与名字无耦合)
function bookmarkEntryName(b: BookmarkItem): string {
    const t = String(b.title || "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
    return (t || b.url) + ".url";
}

// bmarks:// 目录列表:
//   根( body="" )     → 标签目录(按书签内标签聚合)+ 未打标签的书签叶子
//   body="/<encTag>"  → 该标签下的书签叶子
export async function linkMountReadDir(vPath: string): Promise<DirEntry[]> {
    const body = vPath.slice(BMARKS_PREFIX.length).replace(/\/+$/, "");
    const bookmarks = await loadBookmarks();
    const entries: DirEntry[] = [];
    if (!body) {
        // 根:标签目录
        const tags = new Set<string>();
        for (const b of bookmarks) for (const t of b.tags || []) if (t.trim()) tags.add(t.trim());
        for (const tag of Array.from(tags).sort()) {
            entries.push({
                name: tag,
                isDir: true,
                size: 0,
                updated: "",
                path: BMARKS_PREFIX + "/" + encodeURIComponent(tag),
            });
        }
        // 未打标签的书签平铺在根
        for (const b of bookmarks.filter(x => !(x.tags || []).some(t => t.trim()))) {
            entries.push({
                name: bookmarkEntryName(b),
                isDir: false,
                size: 0,
                updated: b.createdAt ? new Date(b.createdAt).toISOString() : "",
                path: makeWeblinkVPath(b.url),
            });
        }
        return entries;
    }
    // 标签目录:该标签下的书签
    let tag = "";
    try {
        tag = decodeURIComponent(body.slice(1));
    } catch {
        tag = body.slice(1);
    }
    for (const b of bookmarks.filter(x => (x.tags || []).some(t => t.trim() === tag))) {
        entries.push({
            name: bookmarkEntryName(b),
            isDir: false,
            size: 0,
            updated: b.createdAt ? new Date(b.createdAt).toISOString() : "",
            path: makeWeblinkVPath(b.url),
        });
    }
    return entries;
}

// weblink 叶子的文本内容 = URL 本身(文本编辑器打开也能看到;一般不这么用)
export function weblinkText(vPath: string): string {
    return weblinkUrlOf(vPath) + "\n";
}
