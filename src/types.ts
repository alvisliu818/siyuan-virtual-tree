// 思源内核 /api/file/readDir 返回的目录项
export interface DirEntry {
    name: string;
    size: number;
    isDir: boolean;
    updated: string;
    path?: string; // 虚拟条目(思源文档树)自带完整虚拟路径,普通文件条目无此字段
}

// 全局搜索命中结果
export interface SearchResult {
    path: string;
    lineNo: number;
    line: string;
    preview: string;
    kind?: "name" | "content"; // 命中类型:名称匹配(文件名/文件夹名) / 内容匹配
    name?: string;              // 名称匹配时的条目名
    isDir?: boolean;            // 名称匹配时是否为文件夹
}

// 插件配置
export interface EditorConfig {
    fontSize: number;
    tabSize: number;
    wordWrap: "on" | "off";
    formatOnSave: boolean;
    searchMaxFileSize: number;
    fileTreeRoot: string; // 文件树根目录路径
    terminalBackend: "auto" | "builtin" | "server"; // 终端后端:auto(优先内置)|builtin(内置)|server(外部服务)
    terminalShell: string; // 终端 shell:auto|pwsh|powershell|cmd
    terminalServerUrl: string; // 终端服务 WebSocket 地址(仅 server 模式)
    siyuanWorkspacePath: string; // 思源工作空间系统路径(用于终端工作目录转换)
    colorTheme: string; // 代码主题:""=自动(优先扩展主题);"__siyuan__"=思源配色;其他=主题 name
    iconTheme: string; // 图标主题:""=自动(第一个);"__none__"=思源内置图标;其他=扩展 id
    markdownDefaultMode: "live" | "source" | "reading"; // Markdown 默认模式:实时预览 / 源码 / 阅读(对齐 Obsidian)
    newTabReplacePlus: boolean;      // 接管思源顶部「+」:点击改为打开新标签页(而非新建文档)
    newTabShowPinned: boolean;       // 新标签页显示「固定」区
    newTabShowRecent: boolean;       // 新标签页显示「最近打开」区
    newTabShowFavorites: boolean;    // 新标签页显示「收藏」区
}

// === 标签 ===
// 标签定义(支持嵌套、颜色、图标)
export interface TagDef {
    id: string;
    name: string;
    parentId?: string;  // 父标签 id(嵌套),空则为一层标签
    color?: string;     // 颜色,任意 CSS 颜色(如 #e74c3c)
    icon?: string;      // 图标:思源 svg id(如 iconStar)或单个字符/emoji
}

// 标签持久化数据结构
export interface TagData {
    version: number;
    tags: TagDef[];                      // 预设标签库(可嵌套)
    fileTags: Record<string, string[]>;  // 路径 → 标签 id 列表(支持多标签)
}

// 标签数据版本
export const TAG_DATA_VERSION = 1;

// 预设标签(首次使用时写入,用户可在设置里增删改)
export const DEFAULT_TAGS: TagDef[] = [
    {id: "t-important", name: "重要", color: "#e74c3c", icon: "iconStar"},
    {id: "t-todo", name: "待办", color: "#f39c12", icon: "iconList"},
    {id: "t-doing", name: "进行中", color: "#3498db", icon: "iconRefresh"},
    {id: "t-done", name: "已完成", color: "#27ae60", icon: "iconCheck"},
    {id: "t-archive", name: "归档", color: "#95a5a6", icon: "iconFolder"},
];

// 默认标签数据
export const DEFAULT_TAG_DATA: TagData = {
    version: TAG_DATA_VERSION,
    tags: DEFAULT_TAGS,
    fileTags: {},
};

// 默认配置
export const DEFAULT_CONFIG: EditorConfig = {
    fontSize: 14,
    tabSize: 4,
    wordWrap: "off",
    formatOnSave: false,
    searchMaxFileSize: 1024 * 1024, // 1MB
    fileTreeRoot: "/data", // 默认思源工作空间 data 目录
    terminalBackend: "auto", // 自动选择(桌面端优先内置)
    terminalShell: "auto", // auto 自动检测,可选 pwsh|powershell|cmd
    terminalServerUrl: "ws://127.0.0.1:9800",
    siyuanWorkspacePath: "", // 留空则自动从思源配置获取
    colorTheme: "", // 自动
    iconTheme: "", // 自动
    markdownDefaultMode: "live", // 实时预览(类 Obsidian Live Preview)
    newTabReplacePlus: true,        // 默认接管顶部「+」
    newTabShowPinned: true,
    newTabShowRecent: true,
    newTabShowFavorites: true,
};
