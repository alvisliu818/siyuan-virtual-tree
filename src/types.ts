// 思源内核 /api/file/readDir 返回的目录项
export interface DirEntry {
    name: string;
    size: number;
    isDir: boolean;
    updated: string;
    path?: string; // 虚拟条目(思源文档树)自带完整虚拟路径,普通文件条目无此字段
    // 以下仅虚拟条目(sydoc://)携带:文档自定义图标与子文档数(渲染思源文档树同款图标用)
    icon?: string;
    subFileCount?: number;
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
    // 导入 Markdown 到思源时,是否把源文件作为资源插入到文档顶部的引述块(保留出处,便于回溯原文件)
    importMdSourceAsset: boolean;
    // 侧边栏是否显示「文件」面板。文件浏览/重命名/删除等能力已由「虚拟文档树」面板承接,
    // 故**默认关闭**;打开后可恢复原来的文件树面板
    showFileTreeDock: boolean;
    // 「虚拟文档树」面板顶部的**引用关系树**(按文档首块引用链接自动构建,与手动挂载共存)。
    // 关系树结构是只读派生视图(不落盘,每次现查);这里只持久化用户的显式意图:
    // 开关、排序设置、拖拽顺序(customOrder)、折叠状态(collapsed)。
    mountTreeRelation: RelationTreeConfig;
}

/** 引用关系树配置(移植自独立插件 siyuan-virtual-tree) */
export interface RelationTreeConfig {
    enabled: boolean;
    sortMethod: "name" | "weight" | "custom"; // 排序:name=名称 | weight=属性权重 | custom=拖拽自定义
    weightAttrName: string;   // 权重属性名(文档自定义属性,缺失视为 0)
    caseSensitive: boolean;   // 排序是否区分大小写
    maxDepth: number;         // 最大递归深度(防无限递归)
    maxNodes: number;         // 最大节点数(防失控)
    includePhysicalSubtree: boolean; // 是否并入思源原生层级的物理子文档
    defaultExpandLevel: number;      // 默认展开层级:0=全折叠 -1=全展开 N=展开前 N 层
    customOrder: Record<string, string[]>; // 拖拽顺序:父 docId(或 "__root__") → 有序子 id 数组
    collapsed: string[];             // 折叠的节点 docId
}

// === 自定义「打开方式」===
// 一条自定义打开方式:把选中的文件/文件夹交给指定程序处理。
//
// 设计取舍:
//   - command + args 而不是一整条命令字符串:用户填 "code" 与 args ["-g"]
//     比填 `code -g {file}` 更不容易出转义问题,也不必实现占位符替换。
//     {file} 只在「把路径放最后」这个最常见场景下需要,由 launchOpenWith 补。
//   - kind 区分文件/文件夹:同一个命令对二者的语义往往不同
//     (code 打开文件夹 = 打开工作区,打开文件 = 编辑该文件)。
//   - builtin:内置的知名编辑器预置,用户可在设置里改 command;非 builtin 的项
//     可自由增删。分这个字段是为了让 UI 能把预置项与自定义项分开呈现。
export interface OpenWithItem {
    id: string;
    /** 菜单里显示的文案,如 "用 VS Code 打开" */
    label: string;
    /** 可执行文件名或命令名(在 PATH 里找,或填绝对路径) */
    command: string;
    /**
     * 命令行参数,支持 {file} 占位符。
     * 不含 {file} 时,目标路径自动追加到参数末尾
     * (VS Code / JetBrains 这类"把文件丢给它就行"的命令不需要写占位符)。
     */
    args?: string[];
    /** 作用对象:文件 / 文件夹 / 两者 */
    kind: "file" | "dir" | "both";
    /**
     * 只对这些扩展名生效(小写,含点,如 [".py", ".ipynb"])。
     * 空或未设 = 不限。用于"只用它打开 ipynb"这类场景。
     */
    extensions?: string[];
    /** 内置预置项:设置里可改 command,但不能删(避免用户把自己唯一的出口删掉) */
    builtin?: boolean;
    /** 菜单图标(siyuan svg id);空则用默认 */
    icon?: string;
}

// 打开方式数据版本(结构不兼容时 +1,加载时按版本迁移)
export const OPEN_WITH_VERSION = 1;

export interface OpenWithData {
    version: number;
    items: OpenWithItem[];
}

/**
 * 内置预置的打开方式。
 *
 * command 填的是**通用命令名**而不是绝对路径 —— 命令名在 PATH 里找不到时,
 * launchOpenWith 会退回到 Windows 的常见安装位置再试(见 external-app.ts 的
 * 候选探测)。写死路径会让换机器/换安装位置的用户直接失效。
 */
export const DEFAULT_OPEN_WITH: OpenWithItem[] = [
    {
        id: "ow-vscode",
        label: "用 VS Code 打开",
        command: "code",
        kind: "both",
        builtin: true,
        icon: "iconCode",
    },
    {
        id: "ow-cursor",
        label: "用 Cursor 打开",
        command: "cursor",
        kind: "both",
        builtin: true,
        icon: "iconCode",
    },
    {
        id: "ow-windsurf",
        label: "用 Windsurf 打开",
        command: "windsurf",
        kind: "both",
        builtin: true,
        icon: "iconCode",
    },
    {
        id: "ow-notepad",
        label: "用记事本打开",
        // Windows 内置,macOS/Linux 上多半没有 —— 找不到就报"未找到命令",可接受
        command: "notepad",
        kind: "both",
        builtin: true,
    },
    {
        id: "ow-explorer",
        label: "在资源管理器中打开",
        // 用 explorer 而不是"系统默认应用":文件夹场景下语义更明确
        command: "explorer",
        kind: "both",
        builtin: true,
        icon: "iconFolder",
    },
];

export const DEFAULT_OPEN_WITH_DATA: OpenWithData = {
    version: OPEN_WITH_VERSION,
    items: DEFAULT_OPEN_WITH,
};

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
    importMdSourceAsset: false,      // 默认不插入源文件资源引述块
    showFileTreeDock: false,         // 默认不显示「文件」面板(功能已由虚拟文档树承接)
    // 引用关系树默认关闭(按需在设置里开启)
    mountTreeRelation: {
        enabled: false,
        sortMethod: "name",
        weightAttrName: "weight",
        caseSensitive: false,
        maxDepth: 10,
        maxNodes: 500,
        includePhysicalSubtree: false,
        defaultExpandLevel: -1,
        customOrder: {},
        collapsed: [],
    },
};
