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
    // 命中类型:名称匹配(文件名/文件夹名) / 内容匹配 / 虚拟文档树(思源文档或块)命中
    kind?: "name" | "content" | "sydoc";
    name?: string;              // 名称匹配时的条目名
    isDir?: boolean;            // 名称匹配时是否为文件夹
    docId?: string;             // kind=sydoc:思源文档/块 id(点击走 openSiyuanDoc 定位)
}

// 插件配置
export interface EditorConfig {
    fontSize: number;
    tabSize: number;
    wordWrap: "on" | "off";
    // 代码编辑器右侧的导航窗格(Monaco 的 minimap 缩略图,点击可跳转)。
    // 默认开(与改动前一致);关掉后编辑区变宽,适合窄屏或不需要缩略导航的场景
    showMinimap: boolean;
    formatOnSave: boolean;
    searchMaxFileSize: number;
    fileTreeRoot: string; // 文件树根目录路径
    terminalBackend: "auto" | "builtin" | "server"; // 终端后端:auto(优先内置)|builtin(内置)|server(外部服务)
    terminalShell: string; // 终端 shell:auto|pwsh|powershell|cmd
    terminalServerUrl: string; // 终端服务 WebSocket 地址(仅 server 模式)
    siyuanWorkspacePath: string; // 思源工作空间系统路径(用于终端工作目录转换)
    colorTheme: string; // 代码主题:""=自动(优先扩展主题);"__siyuan__"=思源配色;其他=主题 name
    iconTheme: string; // 图标主题:""=自动(第一个);"__none__"=思源内置图标;其他=扩展 id
    marketTopBarIcon: boolean; // 顶栏「扩展市场」图标:false=隐藏(仍可用命令 ⇧⌘E 打开)
    markdownDefaultMode: "live" | "source" | "reading"; // Markdown 默认模式:实时预览 / 源码 / 阅读(对齐 Obsidian)
    newTabReplacePlus: boolean;      // 接管思源顶部「+」:点击改为打开新标签页(而非新建文档)
    newTabShowPinned: boolean;       // 新标签页显示「固定」区
    newTabShowRecent: boolean;       // 新标签页显示「最近打开」区
    // 关闭未保存页签时的行为:ask = 提示保存或放弃(默认);discard = 不提示直接放弃;save = 不提示直接保存
    closeUnsavedAction: "ask" | "discard" | "save";
    // 思源文档内点击链接被接管打开文件时,用右侧分栏打开(文档与文件同屏);默认在当前页签区打开
    takeoverSplitOpen: boolean;
    // 「虚拟文档树」行末是否显示「查看引用」链接图标(hover 出反链弹窗)
    treeBacklinkIcon: boolean;
    newTabShowFavorites: boolean;    // 新标签页显示「收藏」区
    // 导入 Markdown 到思源时,是否把源文件作为资源插入到文档顶部的引述块(保留出处,便于回溯原文件)
    importMdSourceAsset: boolean;
    // 「文件」面板是否显示。文件浏览/重命名/删除等能力已由「虚拟文档树」面板承接,
    // 故**默认关闭**;打开后可恢复原来的文件树面板
    showFileTreeDock: boolean;
    // 接管思源文档内打开文件:点击文档里的 assets/ 链接、file:// 本地链接、裸本地路径时,
    // 不走思源默认查看器,改用本插件的对应页签(markdown/图片/媒体/office/文本)打开。
    // off=不接管;exts=仅接管指定扩展名;all=全部接管
    docOpenTakeover: "off" | "exts" | "all";
    // 接管的扩展名白名单(仅 exts 模式生效),逗号分隔,如 "md,txt,log";忽略点/空格/大小写
    docOpenTakeoverExts: string;
    // 全局阅读模式:开启时所有 Markdown 文件默认以「阅读」(只读渲染)打开,
    // 需要编辑时再用页签顶部按钮切到实时预览/源码。优先级高于 markdownDefaultMode
    globalReadingMode: boolean;
    // 版本控制:每次保存时把修改前的内容存为历史版本,保留的条数;0 = 关闭版本控制。
    // 文本文件通用(含代码文件);历史存独立的 file-versions.json,不放配置里
    versionKeepCount: number;
    // 删除方式(没有"直接删除"选项 —— 删除必须可恢复):
    //   plugin = 移入插件回收站(工作空间 .siyuan/virtual-tree-trash,按原路径镜像,可一键恢复,默认)
    //   system = 移入操作系统回收站
    deleteMode: "plugin" | "system";
    // 「虚拟文档树」面板顶部的**引用关系树**(按文档首块引用链接自动构建,与手动挂载共存)。
    // 关系树结构是只读派生视图(不落盘,每次现查);这里只持久化用户的显式意图:
    // 开关、排序设置、折叠状态(collapsed)。拖拽顺序在挂载配置(virtual-tree.json 的 customOrder)。
    mountTreeRelation: RelationTreeConfig;
}

/** 引用关系树配置(移植自独立插件 siyuan-virtual-tree) */
export interface RelationTreeConfig {
    enabled: boolean;
    sortMethod: "name" | "weight"; // 回退排序:name=名称 | weight=属性权重(拖拽顺序存挂载配置 customOrder)
    weightAttrName: string;   // 权重属性名(文档自定义属性,缺失视为 0)
    caseSensitive: boolean;   // 排序是否区分大小写
    maxDepth: number;         // 最大递归深度(防无限递归)
    maxNodes: number;         // 最大节点数(防失控)
    includePhysicalSubtree: boolean; // 是否并入思源原生层级的物理子文档
    defaultExpandLevel: number;      // 默认展开层级:0=全折叠 -1=全展开 N=展开前 N 层
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
    showMinimap: true,
    formatOnSave: false,
    searchMaxFileSize: 1024 * 1024, // 1MB
    fileTreeRoot: "/data", // 默认思源工作空间 data 目录
    terminalBackend: "auto", // 自动选择(桌面端优先内置)
    terminalShell: "auto", // auto 自动检测,可选 pwsh|powershell|cmd
    terminalServerUrl: "ws://127.0.0.1:9800",
    siyuanWorkspacePath: "", // 留空则自动从思源配置获取
    colorTheme: "", // 自动
    iconTheme: "", // 自动
    marketTopBarIcon: true, // 顶栏默认显示「扩展市场」图标
    markdownDefaultMode: "live", // 实时预览(类 Obsidian Live Preview)
    newTabReplacePlus: true,        // 默认接管顶部「+」
    newTabShowPinned: true,
    newTabShowRecent: true,
    closeUnsavedAction: "ask",      // 关闭未保存页签:默认每次询问
    takeoverSplitOpen: false,       // 接管打开默认在当前页签区打开
    treeBacklinkIcon: true,         // 虚拟文档树行末默认显示「查看引用」图标
    newTabShowFavorites: true,
    importMdSourceAsset: false,      // 默认不插入源文件资源引述块
    showFileTreeDock: false,         // 默认不显示「文件」面板(功能已由虚拟文档树承接)
    // 默认不接管文档内文件打开(保持思源原生行为);开启后按扩展名或全部交给本插件
    docOpenTakeover: "off",
    docOpenTakeoverExts: "md,txt",
    // 默认开启:打开 Markdown 即只读渲染,编辑需手动切换(全局阅读模式)
    globalReadingMode: true,
    // 默认保留最近 10 个修改前版本
    versionKeepCount: 10,
    // 删除默认走插件回收站(可一键恢复)
    deleteMode: "plugin",
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
        collapsed: [],
    },
};
