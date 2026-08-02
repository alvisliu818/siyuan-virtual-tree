// 插件内唯一类型标识与常量
export const TAB_TYPE = "siyuan-file-editor-tab";
export const SEARCH_TAB_TYPE = "siyuan-file-editor-search";
export const DOCK_TYPE = "siyuan-file-editor-dock";

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
