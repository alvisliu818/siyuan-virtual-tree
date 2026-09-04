// 插件内唯一类型标识与常量
export const TAB_TYPE = "siyuan-file-editor-tab";
export const IMAGE_TAB_TYPE = "siyuan-file-editor-image";
export const OFFICE_TAB_TYPE = "siyuan-file-editor-office";
export const SEARCH_TAB_TYPE = "siyuan-file-editor-search";
export const TERMINAL_TAB_TYPE = "siyuan-file-editor-terminal";
export const DOCK_TYPE = "siyuan-file-editor-dock";

// 终端服务默认 WebSocket 地址
export const DEFAULT_TERMINAL_SERVER_URL = "ws://127.0.0.1:9800";

// 插件数据存储键
export const STORAGE_CONFIG = "config.json";

// 文件浏览根目录(思源工作空间 data 目录)
export const WORKSPACE_ROOT = "/data";

// 搜索时识别为文本的扩展名
export const TEXT_EXTENSIONS = new Set([
    ".md", ".markdown", ".txt", ".json", ".json5", ".js", ".jsx", ".ts", ".tsx",
    ".css", ".scss", ".less", ".html", ".htm", ".xml", ".svg", ".yaml", ".yml",
    ".toml", ".ini", ".conf", ".cfg", ".py", ".go", ".rs", ".java", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".sql",
    ".graphql", ".gql", ".vue", ".svelte", ".env", ".gitignore", ".log",
]);

// 二进制扩展名(不在编辑器中打开)
export const BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
    ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z",
    ".mp3", ".mp4", ".wav", ".webm", ".mov", ".avi",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".exe", ".dll", ".so", ".dylib", ".class",
]);

// 图片扩展名(以图片查看 Tab 打开,而非文本编辑器)
export const IMAGE_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".jfif", ".pjpeg", ".gif", ".bmp", ".ico",
    ".webp", ".tif", ".tiff", ".svg", ".apng", ".avif",
]);

// ===== Office 文档支持 =====
// 电子表格:可在内嵌表格编辑器中编辑
export const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".csv", ".tsv"]);
// 文档:docx → HTML 富文本编辑
export const DOCUMENT_EXTENSIONS = new Set([".docx"]);
// 演示文稿:pptx 渲染预览 + 文本级编辑
export const PRESENTATION_EXTENSIONS = new Set([".pptx"]);
// 旧版二进制格式(Office 97-2003 / WPS),JS 无法可靠解析,走外部应用打开
export const LEGACY_OFFICE_EXTENSIONS = new Set([
    ".doc", ".xls", ".ppt", ".wps", ".et", ".dps", ".dot", ".xlt", ".pot",
]);

// Office 文档类型
export type OfficeKind = "spreadsheet" | "document" | "presentation" | "legacy";

// 取小写扩展名(含点)
export function getExt(path: string): string {
    const name = path.split("/").pop() || "";
    const i = name.lastIndexOf(".");
    return i <= 0 ? "" : name.slice(i).toLowerCase();
}

// 判断路径属于哪种 Office 文档;非 Office 文件返回 null
export function getOfficeKind(path: string): OfficeKind | null {
    const ext = getExt(path);
    if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
    if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
    if (PRESENTATION_EXTENSIONS.has(ext)) return "presentation";
    if (LEGACY_OFFICE_EXTENSIONS.has(ext)) return "legacy";
    return null;
}

// 是否为需要走 Office Tab 的文档
export function isOfficeFile(path: string): boolean {
    return getOfficeKind(path) !== null;
}

// 根据路径扩展名判断是否为图片文件
export function isImageFile(path: string): boolean {
    const ext = "." + (path.split(".").pop() || "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

// 图片扩展名 → MIME 类型映射
const IMAGE_MIME_MAP: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".pjpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".apng": "image/apng",
    ".avif": "image/avif",
};

// 根据路径扩展名推断图片 MIME 类型
export function getImageMime(path: string): string {
    return IMAGE_MIME_MAP["." + (path.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
}

// 格式化文件体积
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
