// VSCode 扩展相关类型定义

// VSCode 扩展 package.json 的 contributes 字段
export interface Contributes {
    languages?: LanguageContribution[];
    grammars?: GrammarContribution[];
    themes?: ThemeContribution[];
    snippets?: SnippetContribution[];
    iconThemes?: IconThemeContribution[];
}

// 文件图标主题贡献
// Material Icon Theme / vscode-icons 等扩展使用此贡献点
export interface IconThemeContribution {
    id: string;
    label: string;
    path: string;
}

// 语言贡献
export interface LanguageContribution {
    id: string;
    extensions?: string[];
    aliases?: string[];
    filenames?: string[];
    firstLine?: string;
}

// 语法贡献(TextMate 语法)
export interface GrammarContribution {
    language?: string;
    scopeName: string;
    path: string;
    embeddedLanguages?: Record<string, string>;
    injectTo?: string[];
}

// 主题贡献
export interface ThemeContribution {
    label: string;
    uiTheme?: "vs" | "vs-dark" | "hc-black" | "hc-light";
    path: string;
}

// 代码片段贡献
export interface SnippetContribution {
    language?: string;
    path?: string;
    languageId?: string;
}

// 已安装扩展的元数据
export interface InstalledExtension {
    id: string; // namespace.name
    namespace: string;
    name: string;
    version: string;
    displayName: string;
    description: string;
    icon?: string; // base64 编码的图标
    enabled: boolean;
    installedAt: number;
    // 解压后的文件内容(path → content),用于懒加载
    files: Record<string, string>;
    contributes: Contributes;
    // 安装来源(用于重装时回到同一个市场),缺省视为 openvsx
    source?: ExtensionSource;
}

// Open VSX 搜索结果
export interface SearchEntry {
    namespace: string;
    name: string;
    version: string;
    displayName?: string;
    description?: string;
    downloadLink?: string;
    iconLink?: string;
    averageRating?: number;
    reviewCount?: number;
    versionTag?: string;
    timestamp?: string;
    source?: ExtensionSource; // 扩展来源
}

export interface SearchResult {
    extensions: SearchEntry[];
    offset: number;
    totalSize: number;
}

// 扩展来源市场
export type ExtensionSource = "openvsx" | "vscode-marketplace";

// 扩展加载状态
export type ExtensionLoadStatus =
    | "idle"
    | "loading"
    | "loaded"
    | "error";

// 扩展加载结果
export interface LoadResult {
    extensionId: string;
    status: ExtensionLoadStatus;
    message?: string;
    loadedGrammars: number;
    loadedThemes: number;
    loadedSnippets: number;
    loadedLSP: number;
    loadedIconThemes: number;
}
