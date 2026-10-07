// 思源文档树同款图标:渲染逻辑与思源 app/src/emoji/fileTreeIcon.ts 对齐,
// 保证插件里显示的文档/笔记本图标和思源文档树一模一样:
//   1) 文档设了自定义图标(icon 属性)→ 显示该图标(emoji 字符 / 自定义表情图片 / 网络图片)
//   2) 未设自定义图标 → 跟随思源设置:开启 useSVGDefaultIcon 用 SVG(iconFile/iconFileText/iconNotebook),
//      否则用默认 emoji(📄 1f4c4 / 📑 1f4d1 / 🗃 1f5c3,可用 window.siyuan.storage["local-images"] 覆盖)
import {getBlockAttrs, lsNotebooks} from "../api/file";

export type TSiyuanDefaultIcon = "notebook" | "folder" | "file";

// 与思源 FILE_TREE_SVG_ICONS 一致
const SVG_ICONS: Record<TSiyuanDefaultIcon, string> = {
    notebook: "iconNotebook",
    folder: "iconFileText",
    file: "iconFile",
};

// 与思源 defaultStorage[LOCAL_IMAGES] 出厂值一致(file 📄 / note 🗃 / folder 📑)
const DEFAULT_EMOJI: Record<TSiyuanDefaultIcon, string> = {
    file: "1f4c4",
    folder: "1f4d1",
    notebook: "1f5c3",
};

const DYNAMIC_ICON_PREFIX = "api/icon/getDynamicIcon";

function escapeAttr(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 图标值类型(与思源 getIconValueKind 一致)
function iconValueKind(value: string): "dynamic" | "network" | "custom" | "invalid" | "unicode" {
    if (value.startsWith(DYNAMIC_ICON_PREFIX)) return "dynamic";
    if (/^https?:\/\/[^\s/.$#?].[^\s]*$/i.test(value)) return "network";
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//")) return "invalid";
    if (value.includes(".")) return "custom"; // 自定义表情(emoji 目录里的图片文件名)
    return "unicode";
}

// emoji 值 → HTML(与思源 unicode2Emoji + genEmojiImageHTML 一致)
export function unicode2Emoji(value: string, className = ""): string {
    if (!value) return "";
    const kind = iconValueKind(value);
    const cls = className ? ` class="${escapeAttr(className)}"` : "";
    if (kind === "custom") {
        return `<img${cls} src="/emojis/${escapeAttr(value)}" />`;
    }
    if (kind === "network") {
        return `<img${cls} src="${escapeAttr(value)}" referrerpolicy="no-referrer" />`;
    }
    if (kind === "dynamic") {
        return `<img${cls} src="${escapeAttr(value.replaceAll("&amp;", "&"))}" />`;
    }
    if (kind === "invalid") return "";
    // unicode 码点十六进制,可多段(如 "1f1e6-1f1e8");不足 4 位思源补前导 0
    try {
        let emoji = "";
        value.split("-").forEach(item => {
            emoji += String.fromCodePoint(parseInt(item.length < 5 ? "0" + item : item, 16));
        });
        return className ? `<span${cls}>${emoji}</span>` : emoji;
    } catch {
        return "";
    }
}

// 文档树图标 HTML(icon=文档自定义图标,可为空;defaultIcon=未设图标时的默认类型)
export function docTreeIconHTML(icon: string, defaultIcon: TSiyuanDefaultIcon): string {
    if (icon) return unicode2Emoji(icon, "b3-list-item__graphic");
    const sy = (window as any).siyuan;
    if (sy?.config?.fileTree?.useSVGDefaultIcon === true) {
        return `<svg class="b3-list-item__graphic"><use xlink:href="#${SVG_ICONS[defaultIcon]}"></use></svg>`;
    }
    const images = sy?.storage?.["local-images"] || {};
    const key = defaultIcon === "notebook" ? "note" : defaultIcon;
    return unicode2Emoji(String(images[key] || DEFAULT_EMOJI[defaultIcon]), "b3-list-item__graphic");
}

// ===== 文档/笔记本自定义图标的获取(带全局缓存) =====
// 挂载的思源文档、标签面板里的 sydoc:// 条目在渲染时是同步的,图标先按缓存画,
// 未缓存的由 ensureDocIcons 后台补齐后回调重绘一次。

const docIconCache = new Map<string, string>(); // docId → 自定义图标(""=未设置)

export function cachedDocIcon(docId: string): string | undefined {
    return docIconCache.get(docId);
}

export async function getDocIcon(docId: string): Promise<string> {
    if (docIconCache.has(docId)) return docIconCache.get(docId)!;
    let icon = "";
    try {
        const attrs = await getBlockAttrs(docId);
        icon = String((attrs && attrs.icon) || "");
    } catch {
        icon = "";
    }
    docIconCache.set(docId, icon);
    return icon;
}

// 批量确保文档图标已缓存(并发去重),取到后 onChange 一次(用于同步渲染后补绘)
const pendingDocs = new Set<string>();
export function ensureDocIcons(docIds: string[], onChange: () => void): void {
    const todo = Array.from(new Set(docIds.filter(id => id && !docIconCache.has(id) && !pendingDocs.has(id))));
    if (todo.length === 0) return;
    todo.forEach(id => pendingDocs.add(id));
    void (async () => {
        for (const id of todo) {
            try {
                await getDocIcon(id);
            } finally {
                pendingDocs.delete(id);
            }
        }
        onChange();
    })();
}

// 文档图标可能变化(菜单里改过图标/文档被删),提供清缓存入口
export function clearDocIconCache(): void {
    docIconCache.clear();
}

let notebookIcons: Map<string, string> | null = null;
let notebookIconsLoading: Promise<Map<string, string>> | null = null;

// 笔记本 id → 自定义图标(一次 lsNotebooks 全量缓存;失败/无图标返回 "")
async function loadNotebookIcons(): Promise<Map<string, string>> {
    if (notebookIcons) return notebookIcons;
    if (!notebookIconsLoading) {
        notebookIconsLoading = (async () => {
            const map = new Map<string, string>();
            try {
                const list = await lsNotebooks();
                for (const nb of Array.isArray(list) ? list : []) {
                    if (nb && nb.id) map.set(String(nb.id), String(nb.icon || ""));
                }
            } catch {
                // 读不到就全部用默认图标
            }
            notebookIcons = map;
            return map;
        })();
    }
    return notebookIconsLoading;
}

export async function getNotebookIcon(nbId: string): Promise<string> {
    const map = await loadNotebookIcons();
    return map.get(nbId) || "";
}
