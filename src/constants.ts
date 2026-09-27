// 插件内唯一类型标识与常量
// 注:WORKSPACE_ROOT 定义在 utils/path.ts(避免与 path.ts 形成循环依赖)
import {extname, SIYUAN_ROOT} from "./utils/path";

export const TAB_TYPE = "siyuan-file-editor-tab";
export const IMAGE_TAB_TYPE = "siyuan-file-editor-image";
export const OFFICE_TAB_TYPE = "siyuan-file-editor-office";
export const SEARCH_TAB_TYPE = "siyuan-file-editor-search";
export const TERMINAL_TAB_TYPE = "siyuan-file-editor-terminal";
export const MARKDOWN_TAB_TYPE = "siyuan-file-editor-markdown";
// 音视频播放器 Tab(视频/音频文件不进文本编辑器,也不再提示"二进制文件")
export const MEDIA_TAB_TYPE = "siyuan-file-editor-media";
// 新标签页(接管顶部「+」后打开的启动台:搜索 + 固定 + 最近打开 + 收藏)
export const START_TAB_TYPE = "siyuan-file-editor-start";
export const DOCK_TYPE = "siyuan-file-editor-dock";
// 侧边栏「最近使用」面板(展示最近打开的文件)
export const RECENT_DOCK_TYPE = "siyuan-file-editor-recent-dock";
// 侧边栏「标签」面板(按标签聚合文件/文件夹,文件夹可就地展开)
export const TAG_DOCK_TYPE = "siyuan-file-editor-tag-dock";

// Markdown 扩展名(由独立的 Markdown Tab 打开,支持所见即所得/源码双模式)
export const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

// 是否为 Markdown 文件
export function isMarkdownFile(path: string): boolean {
    return MARKDOWN_EXTENSIONS.has(extname(path));
}

// 终端服务默认 WebSocket 地址
export const DEFAULT_TERMINAL_SERVER_URL = "ws://127.0.0.1:9800";

// 插件数据存储键
export const STORAGE_CONFIG = "config.json";
// 思源文档挂载记录(挂到真实目录下的 sydoc:// 虚拟条目)
export const STORAGE_SY_MOUNTS = "sy-mounts.json";

// 文件浏览根目录(思源工作空间 data 目录)
export const WORKSPACE_ROOT = SIYUAN_ROOT;

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
// 用 extname(基于 basename)而非 split("/").pop(),才能正确处理 Windows 反斜杠路径
export function getExt(path: string): string {
    return extname(path);
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
    return IMAGE_EXTENSIONS.has(extname(path));
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
    return IMAGE_MIME_MAP[extname(path)] || "application/octet-stream";
}

// ===== 音视频支持 =====
// 视频扩展名(以播放器 Tab 打开)
export const VIDEO_EXTENSIONS = new Set([
    ".mp4", ".m4v", ".webm", ".ogv", ".mov", ".mkv", ".avi", ".wmv",
    ".flv", ".3gp", ".3g2", ".mpg", ".mpeg", ".mpe", ".ts", ".mts",
]);

// 音频扩展名(以播放器 Tab 打开)
export const AUDIO_EXTENSIONS = new Set([
    ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".wma",
    ".opus", ".weba", ".aiff", ".aif", ".aifc", ".mid", ".midi", ".amr",
]);

// 音视频类型
export type MediaKind = "video" | "audio";

// 判断路径属于哪种媒体;非音视频文件返回 null
export function getMediaKind(path: string): MediaKind | null {
    const ext = extname(path);
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    return null;
}

// 是否为视频文件
export function isVideoFile(path: string): boolean {
    return VIDEO_EXTENSIONS.has(extname(path));
}

// 是否为音频文件
export function isAudioFile(path: string): boolean {
    return AUDIO_EXTENSIONS.has(extname(path));
}

// 是否为音视频文件(由播放器 Tab 打开)
export function isMediaFile(path: string): boolean {
    return getMediaKind(path) !== null;
}

// 媒体扩展名 → MIME 类型映射(交给 <video>/<audio> 解码,让浏览器按容器类型探测)
const MEDIA_MIME_MAP: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".mpe": "video/mpeg",
    ".ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".wma": "audio/x-ms-wma",
    ".opus": "audio/ogg",
    ".weba": "audio/webm",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".aifc": "audio/aiff",
    ".mid": "audio/midi",
    ".midi": "audio/midi",
    ".amr": "audio/amr",
};

// 根据路径扩展名推断音视频 MIME 类型
export function getMediaMime(path: string): string {
    return MEDIA_MIME_MAP[extname(path)] || "application/octet-stream";
}

// 格式化文件体积
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
