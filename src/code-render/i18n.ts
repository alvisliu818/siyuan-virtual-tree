// 插件 UI 文案自包含字典：不依赖 this.i18n 的就绪时机（设置面板在 onload 早期就可能被创建）。
// 根目录 i18n/*.json 供思源集市/插件信息读取，两者内容保持一致。

export const zh_CN = {
    enabled: "启用代码块渲染",
    enabledDesc: "关闭后还原思源原生高亮并收起所有渲染面板;重新打开即恢复",
    settings: "设置",
    groupRules: "渲染规则",
    groupRulesDesc: "按代码块语言标识挂载渲染器，可自由增删",
    groupDataSource: "数据源",
    groupDataSourceDesc: "SQL 执行时使用的数据源",
    groupAppearance: "外观与行为",

    addRule: "新增规则",
    lang: "语言",
    langPlaceholder: "如 mysql",
    renderer: "渲染器",
    mode: "默认模式",
    enabled: "启用",
    autoOpen: "自动展开",
    actions: "操作",
    delete: "删除",
    noRule: "暂无规则，点击「新增规则」添加",

    addDataSource: "新增数据源",
    dsName: "名称",
    dsType: "类型",
    dsUrl: "代理地址",
    dsToken: "令牌",
    dsDefault: "默认",
    siyuanSqlite: "思源内置数据库（SQLite）",
    httpProxy: "HTTP 代理（外部 MySQL）",
    test: "测试",
    noDataSource: "暂无数据源",

    autoRender: "打开文档时自动渲染面板",
    autoRenderDesc: "关闭后需手动点击代码块头部的渲染按钮",
    showToolbarButton: "显示渲染按钮",
    showToolbarButtonDesc: "在代码块头部右侧显示一个渲染入口",
    renderTarget: "渲染位置",
    renderTargetDesc: "就地 = 接管代码块自身的高亮（行号仍由思源绘制）；面板 = 在代码块下方展开结果；两者 = 都要",
    targetInplace: "就地（接管原生高亮）",
    targetPanel: "面板",
    targetBoth: "两者",
    maxRows: "结果最大行数",
    theme: "高亮配色",
    themeAuto: "跟随主题",
    themeLight: "浅色",
    themeDark: "深色",

    // 渲染器 / 模式
    modePretty: "美化",
    modeSchema: "表结构",
    modeRun: "执行",
    rendererMysqlName: "MySQL / SQL",

    // 运行时 UI
    render: "渲染",
    close: "收起",
    copy: "复制",
    copied: "已复制",
    copySql: "复制 SQL",
    format: "格式化",
    formatted: "已格式化",
    run: "运行",
    running: "执行中…",
    stop: "停止",
    exportCsv: "导出 CSV",
    rows: "行",
    cols: "列",
    elapsed: "耗时",
    emptyCode: "代码块内容为空",
    noDataSourceSelected: "请先在插件设置中添加数据源",
    runConfirmTitle: "确认执行",
    runConfirmText: "即将在数据源「{name}」上执行该 SQL，确定继续？",
    runHint: "写操作不会被拦截，请自行确认 SQL 内容",
    readOnlyBlocked: "该数据源已设为只读，仅允许执行 SELECT / SHOW / DESCRIBE / EXPLAIN",
    errTitle: "执行失败",
    unsupported: "当前渲染器不支持此模式",
    schemaEmpty: "未解析到 CREATE TABLE 语句",
    refresh: "重新渲染",
    openInSettings: "打开设置",
    noRenderer: "未找到适用于「{lang}」的渲染规则",
    tables: "张表",
    fields: "字段",
    indexes: "索引",
    primaryKey: "主键",
    nullable: "可空",
    default: "默认值",
    comment: "注释",
    type: "类型",
    field: "字段名",
    notNull: "非空",
    autoInc: "自增",
    foreignKeys: "外键",
    unknown: "未命名表",
    cancel: "取消",
    confirm: "确定",
    selected: "已选",
    totalRows: "共 {n} 行",
    truncated: "结果已截断至 {n} 行",
};

export type I18nKey = keyof typeof zh_CN;

export const en_US: Record<I18nKey, string> = {
    enabled: "Enable code block rendering",
    enabledDesc: "Turn off to restore SiYuan native highlighting and collapse all render panels",
    settings: "Settings",
    groupRules: "Render rules",
    groupRulesDesc: "Attach renderers by code block language; add or remove freely",
    groupDataSource: "Data sources",
    groupDataSourceDesc: "Data sources used when running SQL",
    groupAppearance: "Appearance & behavior",

    addRule: "Add rule",
    lang: "Language",
    langPlaceholder: "e.g. mysql",
    renderer: "Renderer",
    mode: "Default mode",
    enabled: "Enabled",
    autoOpen: "Auto expand",
    actions: "Actions",
    delete: "Delete",
    noRule: "No rules yet",

    addDataSource: "Add data source",
    dsName: "Name",
    dsType: "Type",
    dsUrl: "Proxy URL",
    dsToken: "Token",
    dsDefault: "Default",
    siyuanSqlite: "SiYuan built-in (SQLite)",
    httpProxy: "HTTP proxy (external MySQL)",
    test: "Test",
    noDataSource: "No data source",

    autoRender: "Auto render panel on open",
    autoRenderDesc: "When off, click the render button in the code block header",
    showToolbarButton: "Show render button",
    showToolbarButtonDesc: "Show a render entry at the right of the code block header",
    renderTarget: "Render target",
    renderTargetDesc: "Inplace takes over the block's own highlighting (line numbers stay native); panel expands below it",
    targetInplace: "Inplace",
    targetPanel: "Panel",
    targetBoth: "Both",
    maxRows: "Max result rows",
    theme: "Highlight theme",
    themeAuto: "Follow app theme",
    themeLight: "Light",
    themeDark: "Dark",

    modePretty: "Pretty",
    modeSchema: "Schema",
    modeRun: "Run",
    rendererMysqlName: "MySQL / SQL",

    render: "Render",
    close: "Collapse",
    copy: "Copy",
    copied: "Copied",
    copySql: "Copy SQL",
    format: "Format",
    formatted: "Formatted",
    run: "Run",
    running: "Running…",
    stop: "Stop",
    exportCsv: "Export CSV",
    rows: "rows",
    cols: "cols",
    elapsed: "elapsed",
    emptyCode: "Code block is empty",
    noDataSourceSelected: "Add a data source in plugin settings first",
    runConfirmTitle: "Confirm execution",
    runConfirmText: "About to run this SQL on \"{name}\". Continue?",
    runHint: "Write operations are not blocked; review the SQL yourself",
    readOnlyBlocked: "This data source is read-only: only SELECT / SHOW / DESCRIBE / EXPLAIN allowed",
    errTitle: "Execution failed",
    unsupported: "This renderer does not support that mode",
    schemaEmpty: "No CREATE TABLE statement found",
    refresh: "Re-render",
    openInSettings: "Open settings",
    noRenderer: "No rule matches \"{lang}\"",
    tables: "tables",
    fields: "Fields",
    indexes: "Indexes",
    primaryKey: "Primary key",
    nullable: "Nullable",
    default: "Default",
    comment: "Comment",
    type: "Type",
    field: "Field",
    notNull: "Not null",
    autoInc: "Auto increment",
    foreignKeys: "Foreign keys",
    unknown: "Untitled table",
    cancel: "Cancel",
    confirm: "OK",
    selected: "selected",
    totalRows: "{n} rows",
    truncated: "Result truncated to {n} rows",
};

let dict: Record<I18nKey, string> = zh_CN;

/** 依据思源当前语言初始化字典；插件加载时调用一次。 */
export function initI18n(): void {
    try {
        const lang = (window as any)?.siyuan?.config?.langs?.currentLang || navigator.language || "";
        dict = /^zh/i.test(lang) ? zh_CN : en_US;
    } catch {
        dict = zh_CN;
    }
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
    let s = dict[key] ?? zh_CN[key] ?? String(key);
    if (vars) {
        for (const k of Object.keys(vars)) {
            s = s.replace(new RegExp("\\{" + k + "\\}", "g"), String(vars[k]));
        }
    }
    return s;
}
