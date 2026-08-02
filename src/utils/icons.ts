import {extname} from "./path";

// 扩展名 → 思源内置 SVG icon id 映射
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
};

// 根据文件名返回思源 icon id,未知类型返回 iconFile
export function getFileIcon(name: string): string {
    const ext = extname(name);
    return ICON_MAP[ext] || "iconFile";
}

// 生成带 icon 的 SVG HTML
export function iconHTML(iconId: string): string {
    return `<svg class="b3-list-item__graphic"><use xlink:href="#${iconId}"></use></svg>`;
}
