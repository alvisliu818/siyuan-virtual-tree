// 思源内核 /api/file/readDir 返回的目录项
export interface DirEntry {
    name: string;
    size: number;
    isDir: boolean;
    updated: string;
}

// 全局搜索命中结果
export interface SearchResult {
    path: string;
    lineNo: number;
    line: string;
    preview: string;
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
}

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
};
