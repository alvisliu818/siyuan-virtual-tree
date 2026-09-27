import {extname} from "./path";
import {getFileIconFor as getExtFileIcon, getFolderIcon as getExtFolderIcon} from "../extensions/icon-theme-loader";

// 扩展名 → 思源内置 SVG icon id 映射(当无扩展图标主题时使用)
const ICON_MAP: Record<string, string> = {
    ".md": "iconMarkdown",
    ".markdown": "iconMarkdown",
    ".json": "iconCode",
    ".js": "iconCode",
    ".jsx": "iconCode",
    ".ts": "iconCode",
    ".tsx": "iconCode",
    ".css": "iconCode",
    ".scss": "iconCode",
    ".less": "iconCode",
    ".html": "iconCode",
    ".htm": "iconCode",
    ".xml": "iconCode",
    ".yaml": "iconCode",
    ".yml": "iconCode",
    ".toml": "iconCode",
    ".ini": "iconCode",
    ".py": "iconCode",
    ".go": "iconCode",
    ".rs": "iconCode",
    ".java": "iconCode",
    ".c": "iconCode",
    ".h": "iconCode",
    ".cpp": "iconCode",
    ".sh": "iconCode",
    ".sql": "iconCode",
    ".svg": "iconImage",
    ".png": "iconImage",
    ".jpg": "iconImage",
    ".jpeg": "iconImage",
    ".gif": "iconImage",
    ".bmp": "iconImage",
    ".webp": "iconImage",
    ".pdf": "iconFile",
    // 音视频:思源内置 iconVideo / iconRecord(NodeAudio 用的也是 iconRecord)
    ".mp4": "iconVideo",
    ".m4v": "iconVideo",
    ".webm": "iconVideo",
    ".ogv": "iconVideo",
    ".mov": "iconVideo",
    ".mkv": "iconVideo",
    ".avi": "iconVideo",
    ".wmv": "iconVideo",
    ".flv": "iconVideo",
    ".mp3": "iconRecord",
    ".wav": "iconRecord",
    ".ogg": "iconRecord",
    ".m4a": "iconRecord",
    ".aac": "iconRecord",
    ".flac": "iconRecord",
    ".wma": "iconRecord",
    ".opus": "iconRecord",
};

// 根据文件名返回思源内置 icon id,未知类型返回 iconFile
export function getFileIcon(name: string): string {
    const ext = extname(name);
    return ICON_MAP[ext] || "iconFile";
}

// 生成文件图标的 HTML
// 如果安装了 VSCode 图标主题扩展,优先使用其 SVG 图标,否则回退到思源内置图标
export function fileIconHTML(name: string): string {
    const extIcon = getExtFileIcon(name);
    if (extIcon) {
        return `<img class="syfe-tree__ext-icon" src="${extIcon}" alt="" />`;
    }
    return `<svg class="b3-list-item__graphic"><use xlink:href="#${getFileIcon(name)}"></use></svg>`;
}

// 生成文件夹图标的 HTML
// name: 文件夹名(用于按名称匹配特定图标,如 src → folder-src)
// expanded: 是否展开状态(展开状态使用不同图标)
export function folderIconHTML(name?: string, expanded?: boolean): string {
    const extIcon = getExtFolderIcon(name, expanded);
    if (extIcon) {
        return `<img class="syfe-tree__ext-icon" src="${extIcon}" alt="" />`;
    }
    return `<svg class="b3-list-item__graphic"><use xlink:href="#iconFolder"></use></svg>`;
}

// 生成带 icon 的 SVG HTML(兼容旧接口)
export function iconHTML(iconId: string): string {
    return `<svg class="b3-list-item__graphic"><use xlink:href="#${iconId}"></use></svg>`;
}
