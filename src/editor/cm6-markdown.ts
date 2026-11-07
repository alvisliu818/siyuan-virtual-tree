// CodeMirror 6 版 Markdown 编辑器(md-tab 的「编辑器 = CM6」选项)
//
// 定位:编辑面 = CM6(源码态编辑 + Markdown 语法高亮);渲染面 = Vditor.preview
// 静态渲染(在 markdown-tab.ts 里做)。与 Vditor 的关系:Vditor 是黑盒(内部
// lute / DOM 标记 / 事件分发都得 patch),CM6 的一切皆扩展 —— 复制/粘贴/行号/
// 查找全部走标准机制,没有私有结构要兼容。
//
// 主题:全部用思源 CSS 变量(--b3-*),明暗切换零成本跟随,无需重建实例。
// 范围:源码编辑体验 —— 语法高亮、行号、撤销历史、查找面板、行链接/图片粘贴
// 由宿主(md-tab)接线;块级富渲染(代码块/图片/公式/表格)在 cm6-render.ts,
// 行内 WYSIWYM(标记隐藏/复选框/列表延续/格式化快捷键)在 cm6-inline.ts。

import {EditorState, Prec} from "@codemirror/state";
import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    drawSelection, dropCursor, placeholder,
} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import {indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle} from "@codemirror/language";
import {search, searchKeymap, highlightSelectionMatches, openSearchPanel} from "@codemirror/search";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {languages} from "@codemirror/language-data";
import {tags} from "@lezer/highlight";
import {cm6MarkdownRender, preloadCm6Katex} from "./cm6-render";
import {cm6InlineWysiwyg, mdParserExtensions} from "./cm6-inline";

export interface Cm6MarkdownOptions {
    /** 初始内容(Markdown 全文) */
    value: string;
    /** Ctrl/Cmd+S(宿主统一落盘) */
    onSave(): void;
    /** 文档内容变化(宿主:打脏标记 + 刷新面包屑) */
    onInput(): void;
    /** 光标移动(宿主:刷新标题面包屑) */
    onCursor?(): void;
    /** Ctrl+F 打开内置查找面板(宿主查找按钮转发用) */
    onFind?(): void;
    /** Ctrl/Cmd+点击渲染态链接时打开(宿主可接 shell.openExternal;缺省 window.open) */
    onOpenLink?(url: string): void;
    /**
     * 图片地址解析:相对路径 → blob URL 等;返回 null 表示无法加载(渲染占位失败态)。
     * 不传则图片语法只保留源码高亮。
     */
    resolveImageSrc?(src: string): Promise<string | null>;
    placeholder?: string;
}

export interface Cm6MarkdownHandle {
    getValue(): string;
    setValue(v: string): void;
    focus(): void;
    /** 光标所在行(1-based;标题面包屑用) */
    currentLine(): number;
    /** 插入 Markdown 到光标处(媒体页签时间戳 / 图片粘贴落盘) */
    insertAtCursor(md: string): boolean;
    /** 跳到某行并置中(搜索跳转 / ?line= 链接);focus=false 不抢焦点 */
    revealLine(line: number, focus: boolean): void;
    /** 打开内置查找面板 */
    openSearch(): void;
    destroy(): void;
}

// ===== 主题(全部思源 CSS 变量,明暗自适应) =====
const syfeCmTheme = EditorView.theme({
    "&": {
        height: "100%",
        // 顶部留白放在编辑器根上(content 与 gutter 一起下移,相对位置不变);
        // 放 scroller 会破坏 CM6 的行号槽对齐
        paddingTop: "10px",
        boxSizing: "border-box",
        fontSize: "14px",
        backgroundColor: "var(--b3-theme-background)",
        color: "var(--b3-theme-on-background)",
    },
    ".cm-scroller": {
        fontFamily: "var(--b3-font-family, var(--b3-font-family-code))",
        lineHeight: "1.65",
        // ⚠ 行号槽对齐:CM6 的 measure() 只按 contentDOM 的 padding 计算
        // gutter spacer。给 scroller 加 10px padding-top 会让行号整体比内容
        // 行低约 10px(实测 19 行仅 1 行对齐);把 padding 挪到 content 又会
        // 让 CM6 初始化时把默认行高算成 14px 而非 25px,行号按 14px 间距
        // 排布、逐行累积错位。结论:垂直方向完全不碰 scroller/content 的
        // padding(用 CM6 默认 4px),只保留底部滚动留白与左右边距。
        padding: "0 16px 45vh",
        overflow: "auto",
    },
    ".cm-content": {
        caretColor: "var(--b3-theme-primary)",
        // 断开 min-content 传播:cm-content 是 cm-scroller 的 flex item,
        // min-width:auto = 内容的 min-content —— 宽代码块卡片(不换行的 pre
        // 行)会把整个编辑器撑出横向滚动(行号栏一起滚走/挡内容)。归零后
        // cm-content 收敛到视口宽,卡片宽度受约束,横向滚动发生在卡片内部
        // (body overflowX scroll + 行号列 sticky),行号成为卡片滚动视图的一部分
        minWidth: 0,
    },
    ".cm-gutters": {
        backgroundColor: "var(--b3-theme-background)",
        color: "var(--b3-theme-on-surface)",
        border: "none",
        userSelect: "none",
        // ⚠ 不要在这里加 marginTop 补偿:.cm-editor 的 padding 对 gutter 与
        // content 两列同时生效,列起点本就重合;再加负 margin 会让整列行号
        // 比内容行高一个固定值(实测 -26px 里含这 10px)。行号与行的对齐
        // 完全交给 CM6 高度图,块级 widget 的 margin 要圈进可测量范围
        // (见 .syfe-cm-properties-host / codeblock padding)。
    },
    // 属性面板宿主:flow-root 收住子元素的 margin,让 CM6 高度图量到完整占高
    ".syfe-cm-properties-host": {
        display: "flow-root",
    },
    ".cm-activeLine": {backgroundColor: "var(--b3-list-hover, rgba(0,0,0,.03))"},
    ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--b3-theme-primary)",
    },
    "&.cm-focused": {outline: "none"},
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--b3-theme-primary-lightest, rgba(53,118,144,.2)) !important",
    },
    ".cm-selectionMatch": {backgroundColor: "var(--b3-theme-primary-lightest, rgba(53,118,144,.15))"},
    // 内置查找面板配色尽量贴思源
    ".cm-panels": {
        backgroundColor: "var(--b3-theme-surface)",
        color: "var(--b3-theme-on-surface)",
        borderBottom: "1px solid var(--b3-border-color)",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        color: "var(--b3-theme-on-surface)",
    },
    ".cm-searchMatch": {backgroundColor: "var(--b3-theme-primary-lightest, rgba(53,118,144,.25))"},
    ".cm-searchMatch-selected": {backgroundColor: "var(--b3-theme-primary-lighter, rgba(53,118,144,.45))"},

    // ===== 富渲染(cm6-render.ts 的装饰与 widget) =====
    // ===== 代码块卡片:样式对齐 my-logseq .lgp-code-block(2026-11-02) =====
    // 结构同款:顶部工具栏(1px 边框、无下边、上圆角)+ 正文(无边框、下圆角、
    // surface 底)—— 工具栏框住上沿,正文以底色为界,卡片本身不画框。
    // 正文不折行(Logseq parity)+ 常驻 10px 横向条带;编辑态 Monaco 横条同为
    // 10px(monaco-block.ts),两态任何情况下等高。
    ".syfe-cm-codeblock": {
        // 用 padding 不用 margin:CM6 高度图只量 widget 的 border-box,
        // 块级 margin 会逃出测量,行号槽 spacer 按少 8px 的块高排布,
        // 之后的行号整体上浮。根元素无背景,padding 与 margin 视觉等价。
        padding: "4px 0",
    },
    ".syfe-cm-codeblock-head": {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "2px",
        boxSizing: "border-box",
        height: "22px",
        padding: "0 6px",
        fontSize: "12px",
        color: "var(--b3-theme-on-surface-light, var(--b3-theme-on-surface))",
        background: "var(--b3-theme-surface)",
        border: "1px solid var(--b3-border-color)",
        borderBottom: "none",
        borderRadius: "var(--b3-border-radius, 6px) var(--b3-border-radius, 6px) 0 0",
        userSelect: "none",
    },
    ".syfe-cm-codeblock-lang": {
        marginRight: "auto",        // 语言居左、按钮组贴右;只留这一个 auto
        textTransform: "lowercase",
        cursor: "pointer",          // 可点:亮/收围栏(cm6-render toggleFenceReveal)
    },
    ".syfe-cm-codeblock-lang.is-empty": {
        opacity: ".55",             // 无语言围栏:读作「未设置」而非叫 text 的语言
        fontStyle: "italic",
    },
    ".syfe-cm-codeblock-copy": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        padding: "2px",
        borderRadius: "4px",
        cursor: "pointer",
        backgroundColor: "transparent",
        color: "inherit",
        opacity: ".65",
        fontSize: "12px",
    },
    ".syfe-cm-codeblock-copy:hover": {
        opacity: "1",
        backgroundColor: "var(--b3-list-hover, rgba(127,127,127,.15))",
    },
    ".syfe-cm-codeblock-copy.is-copied": {
        color: "var(--b3-theme-primary)",
        fontWeight: "600",
        opacity: "1",
    },
    ".syfe-cm-codeblock-body": {
        margin: "0",
        // 左内边距归零:行号列(逐行重建,sticky)从 x=0 起,数字自带缩进;
        // 右侧 0.9em 给滚动条留白。固定 px:与编辑态(padding 8×2 + 横条 10)逐像素等高
        padding: "8px 0.9em 8px 0",
        overflowX: "scroll",        // scroll 非 auto:条带常驻,短块也留 10px 底带
        overflowY: "hidden",
        whiteSpace: "pre",          // 不折行(Logseq parity),长行横向滚
        backgroundColor: "var(--b3-theme-surface)",
        borderRadius: "0 0 var(--b3-border-radius, 6px) var(--b3-border-radius, 6px)",
        fontFamily: "var(--b3-font-family-code, monospace)",
        fontSize: "13px",
        lineHeight: "21px",         // 与编辑态 monaco lineHeight 21 严格一致
        fontVariantLigatures: "none",
        tabSize: 4,
    },
    // 编辑态:body 不再当滚动容器(条带由 Monaco 横条提供),内边距清零 ——
    // 水平 0.9em 挂在 editorhost 上(左与阅读态对齐;右 0,滚动条贴右缘,
    // 与工具条右缘对齐 —— 右内边距会把滚动条右侧挤出一条空白,lgp 同款论证)
    ".syfe-cm-codeblock-body.is-editing": {
        padding: "0",
        overflow: "hidden",
    },
    ".syfe-cm-codeblock-body.is-editing .syfe-cm-codeblock-colorize": {display: "none"},
    ".syfe-cm-codeblock-body.is-editing .syfe-cm-codeblock-editorhost": {
        display: "block",
        padding: "0 0 0 0.9em",
        minHeight: "21px",
    },
    ".syfe-cm-codeblock-editorhost": {display: "none"},
    ".syfe-cm-tablesrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-mathsrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-propsrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-img": {
        display: "inline-block",
        padding: "2px 0",
        minWidth: "40px",
        minHeight: "22px",
    },
    ".syfe-cm-img__pic": {
        display: "block",
        maxWidth: "100%",
        maxHeight: "360px",
        borderRadius: "4px",
        border: "1px solid var(--b3-border-color)",
    },
    ".syfe-cm-img.is-broken .syfe-cm-img__pic": {
        display: "none",
    },
    ".syfe-cm-img.is-broken::before": {
        content: "'🖼 (图片加载失败)'",
        color: "var(--b3-theme-on-surface)",
        fontSize: "12px",
        opacity: ".7",
    },
    ".syfe-cm-img__alt": {
        fontSize: "11px",
        color: "var(--b3-theme-on-surface)",
        opacity: ".7",
        textAlign: "center",
    },
    ".syfe-cm-math": {
        padding: "6px 10px",
        margin: "2px 0",
        overflowX: "auto",
        maxWidth: "100%",
    },
    ".syfe-cm-math.is-error": {
        fontFamily: "var(--b3-font-family-code, monospace)",
        color: "var(--b3-theme-on-surface)",
        whiteSpace: "pre-wrap",
    },
    // 公式块里被思源导出误塞进来的正文/标题:按普通文本保留,不再喂给 KaTeX
    ".syfe-cm-math-note": {
        fontSize: "12px",
        lineHeight: "1.6",
        padding: "2px 0",
        color: "var(--b3-theme-on-surface)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
    },
    ".syfe-cm-table": {
        padding: "4px 0",
        overflowX: "auto",
        maxWidth: "100%",
    },
    ".syfe-cm-md-table": {
        borderCollapse: "collapse",
        fontSize: "13px",
        margin: "4px 0",
    },
    ".syfe-cm-md-table th, .syfe-cm-md-table td": {
        border: "1px solid var(--b3-border-color)",
        padding: "4px 10px",
    },
    ".syfe-cm-md-table th": {
        backgroundColor: "var(--b3-theme-surface)",
        fontWeight: "600",
    },
    // 单元格内行内公式(KaTeX):允许长公式在单元格内横向滚动,不撑破表格
    ".syfe-cm-math-inline": {
        display: "inline-block",
        maxWidth: "100%",
        overflowX: "auto",
        overflowY: "hidden",
        verticalAlign: "middle",
    },
    // KaTeX 未就绪/渲染失败:显示原始 $...$ 源码,不伪装成渲染成功
    ".syfe-cm-math-inline.is-pending, .syfe-cm-math-inline.is-error": {
        fontFamily: "var(--b3-font-family-code, monospace)",
        fontSize: ".92em",
        color: "var(--b3-theme-on-surface)",
    },
    // 行内公式 widget(表格外的普通行):与单元格内公式同款收敛,长公式格内横向滚动
    ".syfe-cm-inline-math": {
        display: "inline-block",
        maxWidth: "100%",
        overflowX: "auto",
        overflowY: "hidden",
        verticalAlign: "middle",
        cursor: "text",
    },
    ".syfe-cm-inline-math.is-pending": {
        fontFamily: "var(--b3-font-family-code, monospace)",
        fontSize: ".92em",
        color: "var(--b3-theme-on-surface)",
    },

    // 注:属性面板(.syfe-cm-properties*)要同时用于阅读态 Vditor.preview 的
    // frontmatter,故样式放在全局 index.scss,不能放 EditorView.theme(作用域是 .cm-editor)。

    // ===== 行内 WYSIWYM(cm6-inline.ts 的装饰,配色全走思源变量) =====
    // 渲染态链接:主色 + 可点击提示(plain 点击落光标还原源码,Ctrl/Cmd+点击打开)
    ".syfe-cm-md-link": {
        color: "var(--b3-theme-primary)",
        cursor: "pointer",
        textDecoration: "none",
    },
    // 行内码:代码字体 + 底色圆角
    ".syfe-cm-md-inline-code": {
        fontFamily: "var(--b3-font-family-code, monospace)",
        fontSize: ".9em",
        backgroundColor: "var(--b3-theme-surface)",
        borderRadius: "3px",
        padding: "1px 4px",
    },
    // ==高亮==:淡主色底
    ".syfe-cm-md-highlight": {
        backgroundColor: "var(--b3-theme-primary-lightest, rgba(255, 213, 0, .35))",
        borderRadius: "2px",
    },
    // 引用块:行级左侧竖条 + 缩进
    ".syfe-cm-md-quote-line": {
        boxShadow: "inset 3px 0 0 var(--b3-border-color)",
        opacity: ".88",
    },
    // 任务清单复选框
    ".syfe-cm-md-checkbox": {
        accentColor: "var(--b3-theme-primary)",
        verticalAlign: "middle",
        margin: "0 4px 0 0",
        cursor: "pointer",
    },
    // 分隔线 --- 渲染成横线
    ".syfe-cm-md-hr": {
        display: "inline-block",
        width: "100%",
        height: "1px",
        verticalAlign: "middle",
        backgroundColor: "var(--b3-border-color)",
        margin: "8px 0",
    },

    // ===== 列表层(块内 WYSIWYM) =====
    // 无序标记:原字符隐藏(font-size:0),用 ::before 显示圆点
    ".syfe-cm-md-listmark-bullet": {
        fontSize: "0",
    },
    ".syfe-cm-md-listmark-bullet::before": {
        content: "'•'",
        fontSize: "15px",
        color: "var(--b3-theme-on-surface)",
    },
    // 有序标记:数字保留,样式化
    ".syfe-cm-md-listmark-ordered": {
        color: "var(--b3-theme-on-surface)",
        fontVariantNumeric: "tabular-nums",
    },

    // ===== Callout(> [!type] 标题,Obsidian 同款语义) =====
    // 行级:左侧类型色条 + 轻底色;类型色经 --syfe-co 注入
    ".syfe-cm-callout": {
        boxShadow: "inset 3px 0 0 var(--syfe-co, var(--b3-border-color))",
        backgroundColor: "rgba(127, 127, 127, .06)",
    },
    // 标题:类型色加粗 + 前置图标
    ".syfe-cm-callout-title": {
        fontWeight: "600",
        color: "var(--syfe-co, var(--b3-theme-primary))",
    },
    ".syfe-cm-callout-title::before": {
        marginRight: "4px",
    },
    // 类型配色 + 图标(色值取自 Obsidian 默认调色板)
    ".syfe-cm-callout-info": {"--syfe-co": "#086ddd"},
    ".syfe-cm-callout-note": {"--syfe-co": "#086ddd"},
    ".syfe-cm-callout-abstract": {"--syfe-co": "#00bfbc"},
    ".syfe-cm-callout-tip": {"--syfe-co": "#00bfa5"},
    ".syfe-cm-callout-success": {"--syfe-co": "#08b94e"},
    ".syfe-cm-callout-question": {"--syfe-co": "#ec7500"},
    ".syfe-cm-callout-warning": {"--syfe-co": "#e0ac00"},
    ".syfe-cm-callout-danger": {"--syfe-co": "#e93147"},
    ".syfe-cm-callout-example": {"--syfe-co": "#7852ee"},
    ".syfe-cm-callout-quote": {"--syfe-co": "var(--b3-theme-on-surface)"},
    ".syfe-cm-callout-title.syfe-cm-callout-note::before": {content: "'✏️ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-abstract::before": {content: "'📃 '"},
    ".syfe-cm-callout-title.syfe-cm-callout-info::before": {content: "'ℹ️ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-tip::before": {content: "'🔥 '"},
    ".syfe-cm-callout-title.syfe-cm-callout-success::before": {content: "'✅ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-question::before": {content: "'❓ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-warning::before": {content: "'⚠️ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-danger::before": {content: "'⚡ '"},
    ".syfe-cm-callout-title.syfe-cm-callout-example::before": {content: "'📋 '"},
    ".syfe-cm-callout-title.syfe-cm-callout-quote::before": {content: "'❝ '"},
});

// ===== 语法高亮(Markdown 结构,色值走思源变量) =====
const syfeMdHighlight = HighlightStyle.define([
    {tag: tags.heading1, fontWeight: "600", fontSize: "1.5em"},
    {tag: tags.heading2, fontWeight: "600", fontSize: "1.3em"},
    {tag: tags.heading3, fontWeight: "600", fontSize: "1.15em"},
    {tag: tags.heading4, fontWeight: "600"},
    {tag: tags.heading5, fontWeight: "600"},
    {tag: tags.heading6, fontWeight: "600", color: "var(--b3-theme-on-surface)"},
    {tag: tags.strong, fontWeight: "600"},
    {tag: tags.emphasis, fontStyle: "italic"},
    {tag: tags.strikethrough, textDecoration: "line-through"},
    {tag: tags.link, color: "var(--b3-theme-primary)"},
    {tag: tags.url, color: "var(--b3-theme-secondary)"},
    {tag: tags.monospace, fontFamily: "var(--b3-font-family-code, monospace)", color: "var(--b3-theme-on-surface)"},
    {tag: tags.quote, color: "var(--b3-theme-on-surface)"},
    {tag: tags.contentSeparator, color: "var(--b3-theme-on-surface)"},
    {tag: tags.processingInstruction, color: "var(--b3-theme-on-surface)"},   // #、** 等源码标记,弱化
    {tag: tags.keyword, color: "var(--b3-theme-on-surface)"},                  // 列表标记等
]);

export function createCm6MarkdownEditor(
    container: HTMLElement,
    opts: Cm6MarkdownOptions,
): Cm6MarkdownHandle {
    // KaTeX 预热(本地资源,百毫秒级;首个公式渲染时基本已就绪)
    preloadCm6Katex();
    const state = EditorState.create({
        doc: opts.value,
        extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            bracketMatching(),
            syntaxHighlighting(syfeMdHighlight, {fallback: true}),
            search({top: true}),
            highlightSelectionMatches(),
            markdown({base: markdownLanguage, codeLanguages: languages, extensions: mdParserExtensions}),
            cm6MarkdownRender({resolveImageSrc: opts.resolveImageSrc}),
            cm6InlineWysiwyg({onOpenLink: opts.onOpenLink}),
            EditorView.lineWrapping,
            syfeCmTheme,
            // Ctrl/Cmd+S:默认键位不含保存,最高优先级拦给宿主
            Prec.highest(keymap.of([{
                key: "Mod-s",
                run: () => {
                    opts.onSave();
                    return true;
                },
            }])),
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
            placeholder(opts.placeholder ?? ""),
            EditorView.updateListener.of((u) => {
                if (u.docChanged) opts.onInput();
                if ((u.docChanged || u.selectionSet) && opts.onCursor) opts.onCursor();
            }),
        ],
    });

    const view = new EditorView({state, parent: container});

    // CM6 的初始 measure 走 rAF;窗口失焦/页签在后台时可能迟迟不跑,行号槽会
    // 一直按 defaultLineHeight(=font-size 14px) 排布而不是真实行高 25px。
    // 显式补一次测量 + 字体/KaTeX/图片就绪后的延时兜底(富渲染 widget 另由
    // ResizeObserver 通知,见 cm6-render.ts 的 observeWidgetResize)。
    view.requestMeasure();
    window.setTimeout(() => view.requestMeasure(), 250);

    return {
        getValue: () => view.state.doc.toString(),
        setValue(v: string) {
            view.dispatch({
                changes: {from: 0, to: view.state.doc.length, insert: v},
            });
        },
        focus: () => view.focus(),
        currentLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
        insertAtCursor(md: string): boolean {
            try {
                const pos = view.state.selection.main.head;
                view.dispatch({
                    changes: {from: pos, insert: md},
                    selection: {anchor: pos + md.length},
                    scrollIntoView: true,
                });
                view.focus();
                return true;
            } catch {
                return false;
            }
        },
        revealLine(line: number, focus: boolean) {
            try {
                const l = view.state.doc.line(
                    Math.max(1, Math.min(line, view.state.doc.lines)),
                );
                view.dispatch({
                    selection: {anchor: l.from},
                    effects: EditorView.scrollIntoView(l.from, {y: "center"}),
                });
                if (focus) view.focus();
            } catch {
                // 忽略:行号越界等不影响主流程
            }
        },
        openSearch: () => {
            openSearchPanel(view);
            view.focus();
        },
        destroy: () => view.destroy(),
    };
}
