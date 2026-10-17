/** 插件核心类型定义：渲染器、模式、规则、数据源、设置。 */

export type RenderOutput =
    | string
    | Node
    | { html?: string; node?: Node; onMount?: (root: HTMLElement) => void };

export interface RenderContext {
    /** 代码块语言标识（已小写、去空白） */
    lang: string;
    /** 代码块纯文本 */
    code: string;
    /** 块 ID */
    blockId: string;
    /** 代码块根元素（div[data-type="NodeCodeBlock"]） */
    blockElement: HTMLElement;
    /** 当前渲染面板容器（已插入 DOM），渲染器可直接往里塞内容 */
    panel: HTMLElement;
    /** 全局设置快照 */
    settings: Settings;
    /** 请求用另一个模式重新渲染（用于模式切换） */
    setMode: (modeId: string) => void;
    /** 请求重新渲染当前模式 */
    refresh: () => void;
    /** 面板即将被卸载时的中止信号（用于取消异步查询） */
    signal: AbortSignal;
}

/** 允许延迟取值：注册时 i18n 可能还没初始化 */
export type LocalizedText = string | (() => string);

export function txt(v: LocalizedText | undefined): string {
    if (typeof v === "function") return v();
    return v || "";
}

export interface InplaceContext {
    lang: string;
}

export interface RenderMode {
    id: string;
    /** 显示名 */
    name: LocalizedText;
    /** 渲染，返回 HTML 字符串 / 节点 / 结构化输出 */
    render: (ctx: RenderContext) => Promise<RenderOutput> | RenderOutput;
    /**
     * 可选：就地渲染——返回直接写入代码块内容区的 HTML，接管思源自带高亮。
     *
     * 硬性契约：**输出的 textContent 必须与传入的 code 逐字一致**（只能加标签，
     * 不能增删任何字符）。思源保存代码块时 Lute 只取纯文本，一旦文本变了就会
     * 写进用户笔记造成污染。引擎在每次写入后会校验，不符则回退为纯文本并停用该块。
     *
     * 返回 null 表示不支持/不适用，走面板模式。
     */
    inplace?: (code: string, ctx: InplaceContext) => string | null | undefined;
}

export interface CodeRenderer {
    id: string;
    name: LocalizedText;
    description?: LocalizedText;
    /** 该渲染器支持的模式，第一个作为默认 */
    modes: RenderMode[];
}

/** 用户配置的一条规则：某语言的代码块 → 用某渲染器的某模式 */
export interface RenderRule {
    id: string;
    /** 代码块语言标识，小写，如 mysql / sql / pgsql */
    lang: string;
    rendererId: string;
    modeId: string;
    enabled: boolean;
    /** 打开文档时是否自动展开渲染面板 */
    autoOpen: boolean;
}

export type DataSourceType = "siyuan-sqlite" | "http";

export interface DataSource {
    id: string;
    name: string;
    type: DataSourceType;
    /** HTTP 代理地址（type=http 时必填） */
    url?: string;
    /** HTTP 代理的可选鉴权令牌 */
    token?: string;
    /** 只读：拦截非查询语句 */
    readOnly: boolean;
}

export interface Settings {
    /** 总开关:关闭后还原思源原生高亮并关闭所有渲染面板 */
    enabled: boolean;
    rules: RenderRule[];
    dataSources: DataSource[];
    defaultDataSourceId: string;
    /**
     * inplace = 只接管代码块自身的高亮，不挂面板
     * panel   = 只在代码块外挂渲染面板，代码块保持思源原生高亮
     * both    = 就地接管 + 面板入口
     */
    renderTarget: "inplace" | "panel" | "both";
    autoRender: boolean;
    showToolbarButton: boolean;
    maxRows: number;
    theme: "auto" | "light" | "dark";
}

/** 查询结果：列 + 行（值为原始 JS 值，便于导出与格式化） */
export interface QueryResult {
    columns: string[];
    rows: unknown[][];
    /** 受影响行数（非查询语句） */
    affectedRows?: number;
    elapsedMs: number;
    truncated: boolean;
}
