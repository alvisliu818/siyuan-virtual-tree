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
import {autocompletion, CompletionContext, Completion, CompletionResult} from "@codemirror/autocomplete";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {languages} from "@codemirror/language-data";
import {tags} from "@lezer/highlight";
import {Menu} from "siyuan";
import {cm6MarkdownRender, preloadCm6Katex} from "./cm6-render";
import {cm6InlineWysiwyg, mdParserExtensions} from "./cm6-inline";
import {cm6BlockPreview} from "./cm6-block-preview";
import {BLOCK_FONT_FAMILY, BLOCK_FONT_SIZE, BLOCK_LINE_HEIGHT} from "./monaco-block";
import {getLinkIndex} from "../utils/wikilink";
import {searchBlocksForRef} from "../utils/backlink";

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
    /** 右键行号时复制该行链接(宿主用 buildFileRefMd 生成;与 Vditor 行号槽/Monaco 一致) */
    onCopyLine?(line: number): void;
    /** Ctrl/Cmd+Shift+L 插入双链:宿主弹文件选择器,选中后经 insertAtCursor 写入 */
    onInsertLink?(): void;
    placeholder?: string;
    /** 思源块只读预览:开 = [[ 混合候选(文件 + 思源块)+ siyuan://blocks 链接
     *  在行下渲染只读块卡片;关 = [[ 只补文件、不渲染卡片 */
    siyuanBlockPreview?: boolean;
    /** 思源块预览卡片最大高度(px,0 = 不限制) */
    previewMaxHeight?: number;
    /** 思源块引用插入格式(默认 markdown) */
    blockRefFormat?: "markdown" | "wikilink";
    /** 思源 app 实例:卡片「在思源中打开」优先走应用内 openTab */
    app?: any;
    /** 只读阅读态:保留全部富渲染(代码块/公式/表格/图片/属性面板)与行号,
     *  但禁止点击进入编辑、不挂 Monaco 代码块编辑器,活动行/历史/拖拽/
     *  自动补全等编辑态 UI 一律不挂 */
    readOnly?: boolean;
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

// 行号不透明度 / 当前行高亮走 CSS 变量:设置保存后即时生效,无需重建编辑器。
// 在 onLayoutReady 与保存设置处调用(index.ts)。
export function syncCm6StyleVars(cfg: {cm6GutterOpacity?: number; cm6HighlightActiveLine?: boolean}): void {
    const root = document.documentElement;
    const op = Math.min(1, Math.max(0, cfg.cm6GutterOpacity ?? 0.4));
    root.style.setProperty("--syfe-cm-gutter-opacity", String(op));
    const on = cfg.cm6HighlightActiveLine === true;
    root.style.setProperty("--syfe-cm-active-line-bg", on ? "var(--b3-list-hover, rgba(0,0,0,.03))" : "transparent");
    root.style.setProperty("--syfe-cm-active-gutter-color", on ? "var(--b3-theme-primary)" : "inherit");
}

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
        // 行号弱化:用次级文本色,避免与正文同色抢眼
        color: "var(--b3-theme-on-surface-light)",
        border: "none",
        userSelect: "none",
        // ⚠ 不要在这里加 marginTop 补偿:.cm-editor 的 padding 对 gutter 与
        // content 两列同时生效,列起点本就重合;再加负 margin 会让整列行号
        // 比内容行高一个固定值(实测 -26px 里含这 10px)。行号与行的对齐
        // 完全交给 CM6 高度图,块级 widget 的 margin 要圈进可测量范围
        // (见 .syfe-cm-properties-host / codeblock padding)。
    },
    // 行号与正文拉开距离(CM6 默认右 3px 太贴);不透明度走设置变量
    ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 12px 0 5px",
        opacity: "var(--syfe-cm-gutter-opacity, 0.4)",
    },
    // 属性面板宿主:flow-root 收住子元素的 margin,让 CM6 高度图量到完整占高
    ".syfe-cm-properties-host": {
        display: "flow-root",
    },
    // 当前行/行号高亮走设置变量,默认不高亮
    ".cm-activeLine": {backgroundColor: "var(--syfe-cm-active-line-bg, transparent)"},
    ".cm-activeLineGutter": {
        backgroundColor: "var(--syfe-cm-active-line-bg, transparent)",
        color: "var(--syfe-cm-active-gutter-color, inherit)",
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
        // 字体三件套与块内编辑态 Monaco 严格同源(monaco-block 的 BLOCK_FONT_*)。
        // 用户 2026-11-09 决策「卡片用 Monaco 字体」:两态统一 Consolas 栈,
        // 不再用 var(--b3-font-family-code)——此前编辑态(JetBrains/monaco)与
        // 卡片字形不一致,进出编辑整块跳动
        fontFamily: BLOCK_FONT_FAMILY,
        fontSize: `${BLOCK_FONT_SIZE}px`,
        lineHeight: `${BLOCK_LINE_HEIGHT}px`,
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
    // 容器块化:最外层列表整段加底色,首末行圆角(与引述盒同模型)。
    // 用 color-mix 取背景与表面的中间色:列表盒比引述盒淡,行上叠有
    // 引述/标注/表格源等更具体的盒色时仍可分辨。⚠ 本规则必须排在
    // tablesrc/quotesrc/callout 等盒色之前 —— 同特异性靠源顺序决胜,
    // 后定义者覆盖列表盒。
    ".syfe-cm-list-box": {
        backgroundColor: "color-mix(in srgb, var(--b3-theme-surface) 45%, var(--b3-theme-background))",
    },
    ".syfe-cm-list-box.is-first": {
        "border-top-left-radius": "8px",
        "border-top-right-radius": "8px",
    },
    ".syfe-cm-list-box.is-last": {
        "border-bottom-left-radius": "8px",
        "border-bottom-right-radius": "8px",
    },
    // 标题容器块化:标题行加底色(ATX 单行四角圆角;Setext 两行首末圆角)。
    // 取列表盒与引述盒的中间色:标题略重于列表、轻于引述。⚠ 排在 tablesrc/
    // quotesrc/callout 等盒色之前(同特异性靠源顺序决胜,后定义者覆盖)
    ".syfe-cm-heading-box": {
        backgroundColor: "color-mix(in srgb, var(--b3-theme-surface) 65%, var(--b3-theme-background))",
    },
    ".syfe-cm-heading-box.is-first": {
        "border-top-left-radius": "8px",
        "border-top-right-radius": "8px",
    },
    ".syfe-cm-heading-box.is-last": {
        "border-bottom-left-radius": "8px",
        "border-bottom-right-radius": "8px",
    },
    ".syfe-cm-tablesrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-mathsrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-propsrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    ".syfe-cm-quotesrc-line": {backgroundColor: "var(--b3-theme-surface)"},
    // 引述块统一渲染:编辑 / 退出编辑 / 只读阅读态都是同一条 .cm-line(不再切换 widget)。
    // 盒左边界(--syfe-quote-bar)build 期按缩进估算,quoteBoxMeasure 渲染后实测钉到
    // 列表圆点右缘+1;竖线贴盒内左边界,盒底色也从边界起画(边界之外无引述底色)。
    ".syfe-cm-quote-line": {
        // padding-left 把内容(含折行续行)约束在盒右;quoteBoxMeasure 会实测覆写为
        // 正文起点并用负 text-indent 悬挂补偿冻结首行(续行与正文对齐)。
        // .syfe-cm-math 负 margin 补偿把公式块拉回盒内全宽,attachOverflowSync
        // 不再误判溢出(拉过量由 --syfe-quote-math-pull 实测给出)。
        "padding-left": "calc(var(--syfe-quote-bar, 30px) + 7px)",
        backgroundImage:
            "linear-gradient(to right, transparent var(--syfe-quote-bar, 30px), " +
            "var(--b3-border-color, rgba(128,128,128,.45)) var(--syfe-quote-bar, 30px), " +
            "var(--b3-border-color, rgba(128,128,128,.45)) calc(var(--syfe-quote-bar, 30px) + 2px), " +
            "var(--b3-theme-surface, var(--b3-theme-background)) calc(var(--syfe-quote-bar, 30px) + 2px))",
    },
    ".syfe-cm-quote-line .syfe-cm-math": {
        "margin-left": "calc(-1 * var(--syfe-quote-math-pull, 7px))",
    },
    // ⚠ 列表行内公式不做拉回补偿:曾按 --syfe-list-math-pull 左拉所有行内公式,
    // 小个 $...$ 连同行内文字一起压到圆点列上,整篇错位(用户 2026-11-14 反馈
    // 「里乱了」)。宽 $$ 块溢出走 attachOverflowSync 的横向滚动,即预期行为。
    // ⚠ 悬挂缩进的负 text-indent 会继承进行内公式 widget 内部,KaTeX 内容首行
    // 被拉出裁切(P( 显示成 "爪印|猫)"、后验丢 "后")—— 公式容器全局重置,
    // 不按行类限定(列表行/引述行/任何悬挂行的公式一律不受缩进影响)
    ".syfe-cm-math, .syfe-cm-inline-math, .syfe-cm-math-inline, .syfe-cm-quote-math, .katex": {
        "text-indent": "0",
    },
    // 容器块化:引述段整体容器盒(底色已并入 .syfe-cm-quote-line 的 gradient,
    // 从盒左边界起画),此类只负责首末行圆角 —— 圆角裁的是元素盒,gradient
    // 随之被裁;盒左边界在列表内时左角为直角(边界即竖线,视觉上贴边)
    ".syfe-cm-quote-box": {},
    ".syfe-cm-quote-box.is-first": {
        "border-top-left-radius": "8px",
        "border-top-right-radius": "8px",
    },
    ".syfe-cm-quote-box.is-last": {
        "border-bottom-left-radius": "8px",
        "border-bottom-right-radius": "8px",
    },
    // cm6-inline 自带的行级竖线画在行盒左缘 + opacity .88,统一渲染下关掉
    ".syfe-cm-quote-line.syfe-cm-md-quote-line": {boxShadow: "none", opacity: "1"},
    // 引述块编辑态与渲染态对齐:文字不变淡(.syfe-cm-md-quote-line 自带 .88),
    // 列表圆点用与 Lute <li>::marker 同款灰色,竖线/粗体/公式都由行内装饰保留
    ".syfe-cm-quotesrc-line.syfe-cm-md-quote-line": {opacity: "1"},
    ".syfe-cm-quotesrc-line .syfe-cm-md-listmark-bullet::before": {opacity: ".45"},
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
        padding: "6px 2px",
        margin: "2px 0",
        // 一行能放下时不出现任何滚动条;真正溢出才切 auto(可拖动,见 attachOverflowSync)。
        // overflowY 必须显式 hidden:CSS 规定 overflowX 非 visible 时,visible 的 Y 会被
        // 计算成 auto —— 这正是「没溢出却冒出竖向滚动条」的根因。
        overflowX: "hidden",
        overflowY: "hidden",
        maxWidth: "100%",
    },
    ".syfe-cm-math.is-overflow": {overflowX: "auto", overflowY: "hidden"},
    ".syfe-cm-math .katex-display": {overflowX: "visible", overflowY: "visible", margin: "0", textAlign: "left"},
    // 引述块:编辑/退出编辑同一渲染(block widget);原生 protyle 左竖条 + 紧凑边距。
    // ⚠ CM6 的 .cm-content 是 white-space:pre-wrap,而 Lute 输出标签之间带换行/缩进 ——
    // 这些格式化空白会被当成真实换行,每层(ul/li/blockquote)凭空多一行高,
    // 2 行文字被撑到 220px、圆点与正文分离。这里恢复普通空白折叠。
    ".syfe-cm-quote": {margin: "0", maxWidth: "100%", whiteSpace: "normal"},
    ".syfe-cm-quote ul, .syfe-cm-quote ol": {margin: "0", paddingLeft: "1.4em"},
    ".syfe-cm-quote li": {margin: "0"},
    ".syfe-cm-quote ul > li::marker": {color: "var(--b3-theme-on-surface)", opacity: ".45"},
    ".syfe-cm-quote blockquote, .syfe-cm-quote .bq": {
        borderLeft: "3px solid var(--b3-border-color, rgba(128,128,128,.45))",
        padding: "2px 10px",
        margin: "2px 0",
    },
    ".syfe-cm-quote p": {margin: "2px 0"},
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
    // 跨行 \(...\) 块的段前/段后正文(块 replace 只能整行覆盖,同行文字进 widget):
    // 正文字号(区别于 note 的 12px 辅注),支持粗/斜/行内码
    ".syfe-cm-math-plain": {
        fontSize: "14px",
        lineHeight: "1.6",
        padding: "2px 0",
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
    // 行内公式 widget(表格外的普通行/列表项内 $$…$$):默认不滚动,
    // 只有内容明显溢出时才由 attachOverflowSync 加 is-overflow 允许横向拖动
    ".syfe-cm-inline-math": {
        display: "inline-block",
        maxWidth: "100%",
        overflowX: "hidden",
        overflowY: "hidden",
        verticalAlign: "middle",
        cursor: "text",
    },
    ".syfe-cm-inline-math.is-overflow": {overflowX: "auto", overflowY: "hidden"},
    // 列表项内 $$…$$ 用 display 模式但收敛边距/左对齐,保留列表圆点不撑破行
    ".syfe-cm-inline-math .katex-display": {
        overflowX: "visible", overflowY: "visible", margin: "0", textAlign: "left",
    },
    // 引述块内回填的行内公式:沿用 KaTeX 自带排版,不引入第二层滚动容器
    ".syfe-cm-quote-math": {
        display: "inline-block",
        maxWidth: "100%",
        verticalAlign: "baseline",
    },
    ".syfe-cm-quote-math .katex-display": {margin: "0", textAlign: "left"},
    ".syfe-cm-quote-math.is-pending, .syfe-cm-quote-math.is-error": {
        fontFamily: "var(--b3-font-family-code, monospace)",
        color: "var(--b3-theme-on-surface)",
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

    // ===== [[ 混合补全:文件 / 思源块用小图标区分(label 不写来源文字) =====
    // CM6 对未知 type 没有内置图标,这里用纯 CSS 画:空心方块 = 文件,实心圆点 = 思源块
    ".cm-tooltip-autocomplete .cm-completionIcon": {
        backgroundImage: "none",
        backgroundColor: "transparent",
    },
    ".cm-tooltip-autocomplete .cm-completionIcon-file::after": {
        content: "''",
        display: "inline-block",
        width: "8px", height: "10px",
        border: "1.5px solid var(--b3-theme-on-surface-light)",
        borderRadius: "2px",
        boxSizing: "border-box",
    },
    ".cm-tooltip-autocomplete .cm-completionIcon-block::after": {
        content: "''",
        display: "inline-block",
        width: "8px", height: "8px",
        borderRadius: "50%",
        backgroundColor: "var(--b3-theme-primary)",
    },
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

// ===== [[ 双链补全 =====
// 输入 [[ 触发:列出文件名索引(全部挂载根、所有类型文件,见 utils/wikilink.ts),
// [[ 混合补全:文件候选(TTL 索引)+ 思源块候选(SQL blocks 表)。
// 与纯文件版的两处差异(都是为了让「选中块」能整体替换掉 [[ 触发符):
//   ① from 移到 [[ 处,文件候选的 apply 改为自带 "[[" 的完整 [[名]];
//   ② filter:false + 不带 validFor —— 含 "[[" 的 pattern 会被 CM6 内置模糊
//      过滤全灭(md-editor 实测教训),改为每键入一字符重发 source 自行筛选。
// 思源块候选插入 [标题](siyuan://blocks/<id>):它是外部协议链接,从外部打开
// 也能跳到思源对应文档;CM6 会为该行附加只读块预览卡片(见 cm6-block-preview)。
const WIKILINK_COMPLETE_LIMIT = 64;
const WIKILINK_BLOCK_LIMIT = 16;

type BlockRefFormat = "markdown" | "wikilink";

/** 块引用插入文本:两种形式都能点击跳思源块、都能被卡片扫描器识别 */
function blockRefText(format: BlockRefFormat, label: string, id: string): string {
    const url = `siyuan://blocks/${id}`;
    return format === "wikilink" ? `[[${url}|${label}]]` : `[${label}](${url})`;
}

function wikilinkCompletionSource(withBlocks: boolean, format: BlockRefFormat) {
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const before = context.matchBefore(/\[\[([^\[\]]*)$/);
        if (!before) return null;
        const queryFrom = before.from + 2; // 越过 [[:筛选只针对触发符后的输入
        const rawQuery = context.state.sliceDoc(queryFrom, before.to).trim();
        const query = rawQuery.toLowerCase();
        const index = await getLinkIndex();
        const options: Completion[] = [];
        const seen = new Set<string>(); // 同一文件在 byName/byStem 都出现,按路径去重
        const collect = (map: Map<string, string[]>) => {
            for (const [key, paths] of map) {
                if (query && !key.includes(query)) continue;
                for (const p of paths) {
                    if (options.length >= WIKILINK_COMPLETE_LIMIT) return;
                    if (seen.has(p)) continue;
                    seen.add(p);
                    const name = p.split("/").pop() || key;
                    options.push({
                        label: name,
                        detail: p.slice(0, p.lastIndexOf("/")),
                        // from 含 [[,补全过程要把触发符一起写回
                        apply: `[[${name}]]`,
                        type: "file",
                        boost: key === query ? 99 : 0,
                    });
                }
                if (options.length >= WIKILINK_COMPLETE_LIMIT) return;
            }
        };
        collect(index.byName);
        if (options.length < WIKILINK_COMPLETE_LIMIT) collect(index.byStem);

        if (withBlocks && rawQuery) {
            const briefs = await searchBlocksForRef(rawQuery, WIKILINK_BLOCK_LIMIT);
            // blocks 表里同内容块常有多个(文档块/标题块/段落块),按展示文案去重
            const seenBlocks = new Set<string>();
            for (const b of briefs) {
                // label 里的 []() 会破坏 markdown 链接结构,插入前清掉
                const text = b.title.replace(/[\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || b.id;
                const dedupKey = text + "|" + (b.hpath || "");
                if (seenBlocks.has(dedupKey)) continue;
                seenBlocks.add(dedupKey);
                options.push({
                    // 来源靠补全浮层里的小图标区分,不往 label 里塞「思源块」文字
                    label: text,
                    detail: b.hpath || b.id,
                    apply: blockRefText(format, text, b.id),
                    type: "block",
                });
            }
        }
        if (options.length === 0) return null;
        // 选中后整体替换 [[query;内置过滤对含 [[ 的 pattern 必然全灭 → filter:false
        return {from: before.from, options, filter: false};
    };
}

// ===== (( 块引用补全(思源外部引用格式)=====
// 与思源文档里 (( 同语义:内容搜索块,选中插入 [内容](siyuan://blocks/<id>)。
// from 同样必须在触发符 (( 之后(见上方 wikilink 补全的教训注释)。
const BLOCKREF_COMPLETE_LIMIT = 24;

function blockRefCompletionSource(format: BlockRefFormat) {
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const before = context.matchBefore(/\(\(([^()]*)$/);
        if (!before) return null;
        const query = context.state.sliceDoc(before.from + 2, before.to).trim();
        const briefs = await searchBlocksForRef(query, BLOCKREF_COMPLETE_LIMIT);
        const options: Completion[] = briefs.map(b => {
            // label 里的 []() 会破坏链接结构,插入前清掉
            const label = b.title.replace(/[\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || b.id;
            return {
                label,
                detail: b.hpath || "思源块",
                apply: blockRefText(format, label, b.id),
                type: "block",
            };
        });
        if (options.length === 0) return null;
        // from 在触发符 (( 处:选中后整体替换掉 ((query(与思源一致,触发符不残留)。
        // 内置过滤对含 (( 的 pattern 必然全灭(md-editor 教训),SQL 已筛过 → filter:false。
        // 不带 validFor:每键入一字符重新搜索(与思源 (( 行为一致)。
        return {from: before.from, options, filter: false};
    };
}

export function createCm6MarkdownEditor(
    container: HTMLElement,
    opts: Cm6MarkdownOptions,
): Cm6MarkdownHandle {
    // KaTeX 预热(本地资源,百毫秒级;首个公式渲染时基本已就绪)
    preloadCm6Katex();
    const readOnly = opts.readOnly === true;
    const state = EditorState.create({
        doc: opts.value,
        extensions: [
            // 行号槽:live 编辑态与 CM6 只读阅读态共用(阅读态同样显示源码行号,
            // 与 Vditor 阅读态行号槽 / live 编辑态保持一致)。富渲染把多行源码
            // 整块 replace 时,CM6 只在块首行画行号、块身用 spacer 撑高 ——
            // 对齐修复见 syfeCmTheme 与 cm6-render.ts 的 observeWidgetResize。
            lineNumbers({
                // 右键行号 → 思源菜单「复制第 N 行链接」,与 Vditor 渲染态行号槽
                // (md-line-gutter)和 Monaco 源码态(monaco.ts)同一套交互。
                // CM6 回调签名 (view, line: BlockInfo, event),行号取
                // lineAt(line.from).number —— 对被 replace 吞掉的块(widget 行)
                // 得到的是块首行号,与显示的数字一致。
                domEventHandlers: {
                    contextmenu: (view, line, event) => {
                        if (!opts.onCopyLine) return false;
                        const me = event as MouseEvent;
                        // 行号取值:优先用被右键的 gutter 元素上显示的数字(与所见
                        // 一致,且对被 replace 吞掉的块天然取块首行号)。CM6 自带的
                        // lineBlockAtHeight(元素中心) 反查在编辑器刚创建、heightmap
                        // 与 DOM 短暂失步时会解析到错误的行(实测弹出"第 1 行"),
                        // 只作文本取不到时的兜底。
                        const el = me.target as HTMLElement | null;
                        const shown = el ? parseInt(el.textContent || "", 10) : NaN;
                        const num = isFinite(shown) && shown > 0
                            ? shown
                            : view.state.doc.lineAt(line.from).number;
                        me.preventDefault();
                        me.stopPropagation();
                        const menu = new Menu();
                        menu.addItem({
                            icon: "iconLink",
                            label: `复制第 ${num} 行链接`,
                            click: () => opts.onCopyLine?.(num),
                        });
                        menu.open({x: me.clientX, y: me.clientY});
                        return true;
                    },
                },
            }),
            // 只读阅读态 = **完全相同的 CM6 编辑器**(所有扩展两态一致),只额外
            // 加 3 个 facet 禁止编辑。「禁止点击进入编辑」由富渲染层按
            // state.readOnly 早退实现(cm6-render / cm6-inline),不再另起一套精简
            // 配置 —— 否则两态的行号/活动行/选区/查找/补全/键位会不一致
            // (用户 2026-11-10:两个应该是一样的,阅读态只是加了禁止点击进入编辑)。
            ...(readOnly ? [
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                // 双保险:任何 docChanged 事务(快捷键/命令/程序 dispatch)一律丢弃,
                // 阅读态绝不会被改出脏标记。selection/effect 事务照常(查找/定位可用)
                EditorState.transactionFilter.of(tr => (tr.docChanged ? [] : tr)),
            ] : []),
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
            // [[ 混合补全(文件 + 思源块)+ (( 思源块引用补全(override = 本编辑器仅有的
            // 补全源;TTL 缓存索引/SQL 搜索,键入不重扫)——两态同挂,只读态无键入自然不触发
            autocompletion({override: [
                // 块检索始终可用;预览开关只管卡片渲染(关闭后仍只显示链接)
                wikilinkCompletionSource(true, opts.blockRefFormat ?? "markdown"),
                blockRefCompletionSource(opts.blockRefFormat ?? "markdown"),
            ]}),
            // 思源块只读预览:siyuan://blocks/<id> 链接所在行下方附加只读块 DOM
            ...cm6BlockPreview({
                enabled: opts.siyuanBlockPreview !== false,
                maxHeight: opts.previewMaxHeight,
                app: opts.app,
            }),
            EditorView.lineWrapping,
            syfeCmTheme,
            // Ctrl/Cmd+S 保存 / Ctrl/Cmd+Shift+L 插入双链 —— 两态同挂
            // (阅读态宿主传入的 onSave/onInsertLink 本身就是 no-op)
            Prec.highest(keymap.of([{
                key: "Mod-s",
                run: () => {
                    opts.onSave();
                    return true;
                },
            }, {
                key: "Mod-Shift-l",
                run: () => {
                    if (!opts.onInsertLink) return false;
                    opts.onInsertLink();
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
    // 同步测量兜底:requestMeasure 只是把 measure 排进 rAF,窗口失焦/页签在后台
    // 时 rAF 会被暂停 —— 实测新开的 CM6 只读阅读页签 3s 后行号仍全部按
    // defaultLineHeight(14px) 排布,13 个可见行只有 2 个与内容行对齐。
    // CM6 的 measure() 在事务后本就同步跑一次(且会取消上面排的 rAF),视图
    // 构造完直接调一次即可把高度图拉齐;富渲染 widget 后续尺寸变化仍由
    // ResizeObserver → requestMeasure 通知。私有方法按运行时形态收窄调用,
    // 版本差异时静默退回原 rAF 路径。
    try {
        (view as unknown as {measure?: () => void}).measure?.();
    } catch {
        // ignore:不影响编辑/阅读功能,后续 requestMeasure 仍会重试
    }
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
            if (readOnly) return false;
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
