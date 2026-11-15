// CM6 Markdown 富渲染扩展:在源码态编辑器里做「轻 live」渲染。
//
// 范围(与 cm6-markdown.ts 的语法高亮互补):
//  - 围栏代码块:唯一一套渲染 —— 代码行永远以「行底色 + TextMate token 着色」呈现。
//    三种形态(buildDecorations):光标在块外 → 卡片(colorize 正文);点卡片 →
//    卡片 + 全局单例 Monaco 编辑器;点语言标签/光标进块(未挂 Monaco)→ 原始围栏
//    源码态(Obsidian 同款「点语言看源码」),光标离开块回卡片。高亮与代码文件
//    同源:Monaco TextMate 分词 + 全局主题(colorize 出静态 HTML,编辑态挂单例)。
//    (交互模型参考 ProseMark codeFenceExtension / PurrMD codeBlock)
//  - 图片:整行就是一张图片语法 ![alt](src) 或 <img src="..."> 时,替换为真实 <img>
//    (光标落在该行时还原源码,方便编辑;地址经宿主 resolveImageSrc → blob URL)
//  - 公式:$$...$$ 块用 KaTeX display 渲染(资源来自 vditor 自带的 katex,懒加载),
//    光标在块内时还原源码;行内 $...$ / $$...$$ 用 inline widget 渲染,
//    **光标所在行保持源码态**(Obsidian 同款编辑模型,见 buildDecorations 步骤 5)。
//    表格单元格内同款公式在 TableWidget 里同步渲染(见 renderCellHtml)
//  - 页面属性:文档开头的 YAML frontmatter(--- ... ---)渲染为 Obsidian 属性面板,
//    光标进入块内时还原源码编辑
//  - 图片:行内 ![...](...) / <img> 逐处替换为 <img>(支持列表项内、一行多图、
//    与文字混排);光标所在行保持源码态。地址经宿主 resolveImageSrc → blob URL
//  - 表格:GFM 表格块替换为真实 <table>,光标进入块内时还原源码编辑;
//    单元格内的公式段/行内码段中的 | 不作为列分隔符(见 splitRow)
//
// 实现要点:一个 StateField 统一计算 Decoration 集(doc/selection 变化全量重建)。
// 必须用 StateField 而非 ViewPlugin —— CM6 不允许 ViewPlugin 提供块级 replace
// 装饰("Block decorations may not be specified via plugins")。
// 块级替换配合 atomicRanges 让光标不落在渲染物中间;
// 光标进入块内即回源码,这是 Obsidian 同款的编辑模型。
// 全局主题切换(Monaco 扩展主题)经 onCodeThemeChanged → StateEffect 强制重建。
import {ChangeDesc, EditorState, Extension, Range, StateEffect, StateField, Text, Transaction} from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import {getBoolSetting, registerSettingsChangedHandler} from "../settings/user-settings";
import {
    colorizeCached,
    getEditingKey,
    getMonacoThemeName,
    onMonacoThemeChanged,
    setEditingKey,
} from "./monaco-block";
import {
    flushActiveBlock,
    getActiveBlockValue,
    getMountedBlockKey,
    getMountedContainer,
    getMountedLanguage,
    mountBlockEditor,
    remountBlockEditor,
    unmountBlockEditor,
} from "./cm6-block-editor";
import {isDiagramLang, renderDiagram} from "./cm6-diagram";
import {isCalcLang, refreshCalcResults, renderCalc} from "./cm6-calc";

export interface Cm6RenderOptions {
    /** 解析图片地址 → 可加载 URL(blob URL / 绝对路径);返回 null 表示不处理 */
    resolveImageSrc?(src: string): Promise<string | null>;
}

// ===== KaTeX 懒加载(vditor 自带,位于插件目录 vditor/dist/js/katex) =====

declare const __SYFE_PLUGIN_NAME__: string;

let katexPromise: Promise<any> | null = null;

function loadKatex(): Promise<any> {
    if (katexPromise) return katexPromise;
    katexPromise = new Promise((resolve) => {
        try {
            const w = window as any;
            if (w.katex) {
                resolve(w.katex);
                return;
            }
            const base = `/plugins/${__SYFE_PLUGIN_NAME__}/vditor/dist/js/katex`;
            if (!document.querySelector(`link[data-syfe-katex]`)) {
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = `${base}/katex.min.css`;
                css.setAttribute("data-syfe-katex", "1");
                document.head.appendChild(css);
            }
            const script = document.createElement("script");
            script.src = `${base}/katex.min.js`;
            script.setAttribute("data-syfe-katex", "1");
            script.onload = () => resolve((window as any).katex || null);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        } catch {
            resolve(null);
        }
    });
    return katexPromise;
}

// ===== Widgets =====

/**
 * 富渲染 widget 的内容常异步变化(图片 blob 加载、KaTeX 懒加载重绘、
 * Monaco 挂载)。块高变了而 CM6 没重新测量 → 行号槽(gutter)与内容行错位。
 * 统一用 ResizeObserver 通知 CM6;MathWidget 等所有 widget 共用同一套记账,
 * destroy 时断开,避免测量克隆的 DOM 泄漏观察者。
 */
const widgetObservers = new WeakMap<HTMLElement, ResizeObserver>();

function observeWidgetResize(wrap: HTMLElement, view: EditorView, extra?: () => void): void {
    if (typeof ResizeObserver === "undefined" || widgetObservers.has(wrap)) return;
    const ro = new ResizeObserver(() => {
        view.requestMeasure();
        extra?.();
    });
    ro.observe(wrap);
    widgetObservers.set(wrap, ro);
}

// 原生滚动条区域的 mousedown 阻断冒泡到 CM6:否则被劫持成进入编辑态/选区,
// 滚动条按不住拖不动。只拦滚动条带,内容区点击行为不变。
function guardScrollbarDrag(wrap: HTMLElement): void {
    wrap.addEventListener("mousedown", (e) => {
        const r = wrap.getBoundingClientRect();
        const onH = e.clientY > r.top + wrap.clientHeight && e.clientY <= r.bottom;
        const onV = e.clientX > r.left + wrap.clientWidth && e.clientX <= r.right;
        if (onH || onV) e.stopPropagation();
    }, true);
}

/**
 * 公式容器统一滚动条策略:内容一行放得下时**完全不出现滚动条**。
 * 默认 CSS 是 overflow:hidden,只有内容明显溢出才加 is-overflow → overflow-x:auto。
 * 阈值留 6px 容差:KaTeX 的 mtable/分数边框常有 1~2px 亚像素舍入
 * (实测 437 vs 435),这种"几乎能放下"的情况出滚动条毫无意义。
 * KaTeX 异步就绪/字体加载会改变宽度,故 RO + rAF + 两次延时重算。
 */
function attachOverflowSync(wrap: HTMLElement, view: EditorView): () => void {
    const sync = () => {
        wrap.classList.toggle("is-overflow", wrap.scrollWidth > wrap.clientWidth + 6);
    };
    guardScrollbarDrag(wrap);
    observeWidgetResize(wrap, view, sync);
    requestAnimationFrame(sync);
    setTimeout(() => { if (wrap.isConnected) sync(); }, 50);
    setTimeout(() => { if (wrap.isConnected) sync(); }, 300);
    return sync;
}

function disconnectWidgetResize(wrap: HTMLElement): void {
    widgetObservers.get(wrap)?.disconnect();
    widgetObservers.delete(wrap);
}

/** 复制代码的兼容实现:Clipboard API 被拒(Electron WebView 常见)时退回 execCommand(PurrMD 同款兜底) */
async function copyTextCompat(text: string): Promise<void> {
    if (window.navigator.clipboard) {
        try {
            await window.navigator.clipboard.writeText(text);
            return;
        } catch {
            // 继续 execCommand 兜底
        }
    }
    const selection = window.getSelection();
    if (!selection) throw new Error("selection unavailable");
    // 本模块已从 @codemirror/state 导入 Range(遮蔽 DOM 同名类型),用 ReturnType 指代 DOM Range
    const prev: Array<ReturnType<Selection["getRangeAt"]>> = [];
    for (let i = 0; i < selection.rangeCount; i++) prev.push(selection.getRangeAt(i).cloneRange());
    const holder = document.createElement("span");
    holder.textContent = text;
    holder.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;white-space:pre;user-select:text;";
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    let copied = false;
    try {
        selection.removeAllRanges();
        selection.addRange(range);
        copied = document.execCommand("copy");
    } finally {
        selection.removeAllRanges();
        holder.remove();
        for (const r of prev) selection.addRange(r);
    }
    if (!copied) throw new Error("copy failed");
}

// 复制按钮图标(新旧 widget 共用)
const COPY_ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

// colorize HTML → 带行号的逐行结构。
// 行号是卡片滚动视图的一部分:每行 = 行号格(sticky left,横向滚动时钉在卡内
// 左缘、始终可见)+ 代码格(pre,跟随横向滚动)。
// ⚠ 行号格不再写内联 width:宽度交给内容 + .syfe-cm-cl-n 的统一规格
// (padding 5/12 + min-width 2ch,与内嵌 CM6/Monaco 的行号格同款)——
// 两态行号列宽、字形位置逐像素一致,进出编辑不抖(用户 2026-11-15)。
function buildNumberedLines(html: string): string {
    // colorize 以 <br> 分行;colorize 失败的兜底是 \n 分行的转义文本,一并支持
    const lines = html.split(/<br\s*\/?>|\n/);
    const rows: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        rows.push(
            '<div class="syfe-cm-cl">' +
            '<span class="syfe-cm-cl-n">' + (i + 1) + '</span>' +
            '<span class="syfe-cm-cl-c">' + (lines[i] || "") + '</span>' +
            '</div>',
        );
    }
    return rows.join("");
}

/**
 * 围栏代码块卡片(整块 replace):头部(语言标签 + 复制按钮)+ 正文。
 * 渲染态正文 = Monaco colorize(与代码文件同一主题服务/分词);
 * 编辑态正文 = 全局单例 Monaco 编辑器 —— 点击卡片后由 editMounter 在真实视图
 * DOM 上挂载(monaco-block.ts),Esc/点击块外退出。toDOM 永远只渲染壳:
 * CM6 重建/测量会克隆销毁 widget DOM,在 toDOM 里挂载会被抽走或克隆出死体。
 */
class CodeBlockWidget extends WidgetType {
    private copiedTimer: number | undefined;
    private readonly themeSig = getMonacoThemeName();
    // 构建时本卡片是否处于编辑态(参与 eq:进入/退出编辑态都要重建换正文)
    private readonly editingFlag = getEditingKey() === this.key;

    constructor(
        readonly lang: string, readonly code: string, readonly key: string,
        readonly indent = 0,
        /** 顶级列表容器盒的附加类(盒带背景 + 首末圆角接管);空串 = 不在盒内 */
        readonly listBox = "",
        /** 列表标记(圆点)的 x 坐标;<0 = 不画。marker-fence 行整行替换后,
         *  行首圆点由卡片自己画出并与卡片顶对齐(用户 2026-11-14:
         *  「代码块渲染应该在列表块顶部开始」) */
        readonly markerLeft = -1,
        /** 被块级替换吞掉的源码行号序列(如 [5,6,7,8])。原生行号槽对 widget
         *  块不画号(gutter 更新循环 Array.isArray(block.type) 只认行块),
         *  卡片自己在槽列上补画这些数字(用户 2026-11-14「行号在代码块
         *  位置没了」) */
        readonly gutterNums: readonly number[] = [],
    ) {
        super();
    }

    eq(other: CodeBlockWidget): boolean {
        // 编辑中内容变化不重建(Monaco 自持最新内容);渲染态主题变了要重建重取色。
        // ⚠ 非编辑态必须比较 code:外部内容变更(setValue/撤销/粘贴)同偏移时
        //   若只比 key/lang,eq 会误判相等 → 卡片滞留旧内容(实测:整卡变成
        //   已被替换的旧代码)。编辑态跳过 code 比较,避免每次击键重建卡片
        //   打断 Monaco 挂载。
        if (other.key !== this.key || other.lang !== this.lang || other.editingFlag !== this.editingFlag
            || other.indent !== this.indent || other.listBox !== this.listBox || other.markerLeft !== this.markerLeft
            || other.gutterNums.join(",") !== this.gutterNums.join(",")) return false;
        if (!this.editingFlag && other.code !== this.code) return false;
        return this.editingFlag || other.themeSig === this.themeSig;
    }

    private markCopied(btn: HTMLButtonElement): void {
        if (!btn.isConnected) return;
        btn.classList.add("is-copied");
        btn.textContent = "已复制";
        if (this.copiedTimer) window.clearTimeout(this.copiedTimer);
        this.copiedTimer = window.setTimeout(() => {
            this.copiedTimer = undefined;
            if (!btn.isConnected) return;
            btn.classList.remove("is-copied");
            btn.innerHTML = COPY_ICON_SVG;
        }, 1600);
    }

    private buildHead(view: EditorView): HTMLElement {
        const head = document.createElement("div");
        head.className = "syfe-cm-codeblock-head";
        const lang = document.createElement("span");
        lang.className = "syfe-cm-codeblock-lang" + (this.lang ? "" : " is-empty");
        lang.textContent = this.lang || "text";
        // 点语言 → 亮/收围栏(Obsidian 同款)。mousedown 即响应 + stopPropagation:
        // 阻断 CM6 的光标放置(否则光标被放到块边界又触发一次态翻转)。
        lang.title = view.state.readOnly ? "阅读模式" : "点击显示/隐藏围栏";
        lang.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            // 只读阅读态:点语言标签不显围栏(那是进入编辑的入口)
            if (view.state.readOnly) return;
            toggleFenceReveal(view, this.key);
        };
        head.appendChild(lang);
        const btn = document.createElement("button");
        btn.className = "syfe-cm-codeblock-copy";
        btn.title = "复制代码";
        btn.innerHTML = COPY_ICON_SVG;
        // ⚠ 本 Electron 实测:mousedown 上 preventDefault 会抑制后续 click
        // 派生(SB 行级菜单同款坑)。只把复制挂在 onclick 的话,真实鼠标点击
        // 根本不会复制;改为 mousedown 直接执行,onclick 仅兜底程序化 click,
        // 用旗标保证一次点击只复制一次。
        let copyHandled = false;
        const runCopy = () => {
            if (copyHandled) return;
            copyHandled = true;
            void copyTextCompat(getActiveBlockValue() ?? this.code)
                .then(() => this.markCopied(btn))
                .catch(() => undefined);
        };
        btn.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            copyHandled = false;
            runCopy();
        };
        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            runCopy();
        };
        head.appendChild(btn);
        return head;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-codeblock";
        // 列表内的卡片:块 widget 是 .cm-line 的兄弟节点,行 padding 管不到它。
        // 缩进用自身 padding-left(不用 margin:padding 让盒带背景盖住卡片左侧
        // 条带,margin 会留白洞);0 = 顶层块不缩进
        if (this.indent > 0) wrap.style.paddingLeft = `${this.indent.toFixed(1)}px`;
        // 顶级列表容器盒的盒带背景/圆角接管(见 topListBoxSpan)
        if (this.listBox) wrap.classList.add(...this.listBox.split(" "));
        // marker-fence 行的圆点:卡片顶部自画,与卡片顶对齐
        if (this.markerLeft >= 0) {
            wrap.style.position = "relative";
            const dot = document.createElement("span");
            dot.className = "syfe-cm-md-listmark-bullet";
            dot.style.position = "absolute";
            dot.style.left = `${this.markerLeft.toFixed(1)}px`;
            dot.style.top = "7.5px";
            wrap.prepend(dot);
        }
        // 被吞行的行号:原生行号槽对 widget 块不画号,卡片把数字列绝对定位
        // 覆盖到槽列上(负偏移 = 卡片左缘到槽列左缘),高度随卡片内部行分布
        if (this.gutterNums.length) {
            // ⚠ 不要用 view.defaultLineHeight 算列高/卡片 minHeight:它在首帧
            // 还是默认 14px、量完才变 23.09px,而 widget eq 相等不会重建 →
            // 阅读态拿到 42px、编辑态拿到 69px,卡片高度两态不一致(用户反馈
            // 「进编辑会收缩/抖动」)。改为列高 100% 跟随卡片 + 行 min-height:0
            // 可压缩,既不会溢出压到宿主行号,也不依赖测量时机。
            wrap.style.position = "relative";
            // toDOM 可能跑在宿主 .cm-gutters 进 DOM 之前(首帧测量),此时拿不到
            // 槽列几何就只能放弃补画,而 widget eq 相等又不会重建 → 阅读态常见
            // 「3~6 行号整段消失」。改成拿到几何后重挂,最多重试 5 帧。
            const attach = (): boolean => {
                if (wrap.querySelector(".syfe-cm-codeblock-gutternums")) return true;
                const gutters = view.dom.querySelector(".cm-gutters");
                const contentEl = view.dom.querySelector(".cm-content");
                if (!gutters || !contentEl) return false;
                const gRect = gutters.getBoundingClientRect();
                // 偏移用 content/gutters 的稳定几何算(toDOM 时 wrap 尚未入 DOM,
                // 自己的 rect 是零)。wrap 与 content 同宽同左缘
                const offset = contentEl.getBoundingClientRect().left - gRect.left;
                const col = document.createElement("div");
                col.className = "cm-lineNumbers syfe-cm-codeblock-gutternums";
                // z-index 高过 .cm-gutters(sticky, z=200):槽列有不透明背景,
                // 不抬层数字被盖住不可见
                col.style.zIndex = "300";
                col.style.overflow = "hidden";
                col.style.left = `${(-Math.max(0, offset)).toFixed(1)}px`;
                col.style.width = `${gRect.width.toFixed(1)}px`;
                for (const n of this.gutterNums) {
                    const el = document.createElement("div");
                    el.className = "cm-gutterElement";
                    el.textContent = String(n);
                    // 右键单行号 → 「复制第 N 行链接」菜单(回调按编辑器实例登记)
                    const fn = copyLineByEditor.get(view.dom);
                    if (fn) {
                        el.oncontextmenu = (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            fn(n, e.clientX, e.clientY);
                        };
                    }
                    col.appendChild(el);
                }
                wrap.prepend(col);
                return true;
            };
            if (!attach() && typeof requestAnimationFrame !== "undefined") {
                let tries = 5;
                const retry = () => {
                    if (!wrap.isConnected || tries-- <= 0 || attach()) return;
                    requestAnimationFrame(retry);
                };
                requestAnimationFrame(retry);
            }
        }
        // colorize / Monaco 挂载会改变卡片高度 → 通知 CM6 重新测量行号槽
        observeWidgetResize(wrap, view);
        wrap.dataset.blockKey = this.key;
        wrap.setAttribute("contenteditable", "false");
        wrap.appendChild(this.buildHead(view));
        const body = document.createElement("div");
        body.className = "syfe-cm-codeblock-body";
        wrap.appendChild(body);
        // calc 计算块(Logseq 同款):源码 + 右对齐逐行结果双列。main 把「阅读态
        // 源码 / 编辑态内嵌 CM6」两层包成一列,结果列与它同起点(行高均 21px),
        // 所以编辑态结果仍逐行对齐、常驻可见。
        const calc = isCalcLang(this.lang);
        if (calc) body.classList.add("is-calc");
        const main = calc ? document.createElement("div") : null;
        if (main) {
            main.className = "syfe-cm-calc-main";
            body.appendChild(main);
        }
        const slot: HTMLElement = main ?? body;
        // 渲染正文:Monaco colorize(异步,先纯文本占位)。编辑态由 CSS 隐藏此层。
        // colorize 结果重建为带行号的逐行结构(行号列 sticky,随卡片横向滚动
        // 保持可见 —— 见 buildNumberedLines)
        const colorizeDiv = document.createElement("div");
        colorizeDiv.className = "syfe-cm-codeblock-colorize";
        slot.appendChild(colorizeDiv);
        if (calc) {
            const resultEl = document.createElement("div");
            resultEl.className = "syfe-cm-calc-out";
            // 结果可选中复制:阻断冒泡,别让卡片点击处理器把光标送进源码
            resultEl.onmousedown = e => e.stopPropagation();
            body.appendChild(resultEl);
            renderCalc(colorizeDiv, resultEl, this.code);
        } else {
            // 图表类语言(mermaid/flowchart/graphviz/echarts/markmap/plantuml/abc/
            // wavedrom/mindmap/smiles)走 Vditor 本地图表资源渲染成图;其余仍走
            // Monaco colorize 源码卡片。两者都异步完成 → 重测卡片高度。
            const isDiagram = isDiagramLang(this.lang) &&
                renderDiagram(colorizeDiv, this.lang, this.code, () => view.requestMeasure());
            if (!isDiagram) {
                colorizeDiv.textContent = this.code;
                void colorizeCached(this.lang, this.code).then(html => {
                    if (!colorizeDiv.isConnected) return;
                    colorizeDiv.innerHTML = buildNumberedLines(html);
                    view.requestMeasure();
                });
            }
        }
        // 编辑态宿主:点击卡片后由 editMounter 把全局单例 Monaco 安置进来
        const host = document.createElement("div");
        host.className = "syfe-cm-codeblock-editorhost";
        slot.appendChild(host);
        if (this.editingFlag) body.classList.add("is-editing");
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
        if (this.copiedTimer) window.clearTimeout(this.copiedTimer);
        this.copiedTimer = undefined;
        // 不在此处卸载单例:同 key 的继任 widget 可能在本实例销毁后才挂载,
        // 顺序不定。退出由 onExit 显式卸载;页签关闭由 markdown-tab destroy 兜底。
    }

    ignoreEvent(): boolean {
        return false;
    }
}


/** 行内图片:整行图片语法 → <img>(async 解析 blob URL) */
class ImageWidget extends WidgetType {
    constructor(readonly src: string, readonly alt: string, readonly opts: Cm6RenderOptions) {
        super();
    }

    eq(other: ImageWidget): boolean {
        return other.src === this.src && other.alt === this.alt;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("span");
        wrap.className = "syfe-cm-img";
        // blob 图片异步加载会改变行高 → 通知 CM6 重新测量,否则行号槽错位
        observeWidgetResize(wrap, view);
        const img = document.createElement("img");
        img.alt = this.alt;
        img.className = "syfe-cm-img__pic";
        if (this.opts.resolveImageSrc) {
            this.opts.resolveImageSrc(this.src).then(url => {
                if (url && img.isConnected) {
                    img.src = url;
                    wrap.classList.add("is-loaded");
                } else {
                    wrap.classList.add("is-broken");
                    wrap.title = this.src;
                }
            });
        } else {
            img.src = this.src;
            wrap.classList.add("is-loaded");
        }
        wrap.appendChild(img);
        if (this.alt) {
            const cap = document.createElement("div");
            cap.className = "syfe-cm-img__alt";
            cap.textContent = this.alt;
            wrap.appendChild(cap);
        }
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/**
 * 公式块内容分段。思源导出的 md 常见「$$ 块里夹进列表标记甚至整段正文」:
 * 原来的整块 KaTeX 会把这些内容一起吞掉(大段文字消失/变红字)。
 * 这里按行判定:LaTeX 行合并进 tex;明显是正文/标题/图片/表格的行保留为 notes,
 * 以普通文本按原顺序显示在公式下方 —— 内容不丢,也不污染公式。
 */
interface MathBlockBody {
    tex: string;
    notes: string[];
}

function splitMathBlockBody(lines: string[]): MathBlockBody {
    const tex: string[] = [];
    const notes: string[] = [];
    for (const raw of lines) {
        const s = raw.replace(/^\s*-\s+/, "").trim();
        if (!s) continue;
        const looksLikeMarkdown = /!\[[^\]]*\]\(/.test(s) || /^\s*\|/.test(s) ||
            /^<img\b/i.test(s) || /^\[\[.*\]\]/.test(s);
        const looksLikeTex = /\\[a-zA-Z]|\^|_|\{|\}|=|<|>/.test(s);
        if (looksLikeTex && !looksLikeMarkdown) tex.push(s);
        else notes.push(s);
    }
    return {tex: tex.join("\n"), notes};
}

/** 公式块:KaTeX display 渲染;失败回退为等宽样式并给出错误提示 */
class MathWidget extends WidgetType {
    constructor(readonly tex: string, readonly notes: string[], readonly katex: any,
                readonly plainBefore = "", readonly plainAfter = "") {
        super();
    }

    eq(other: MathWidget): boolean {
        return other.tex === this.tex && other.notes.join("\n") === this.notes.join("\n")
            && other.plainBefore === this.plainBefore && other.plainAfter === this.plainAfter;
    }

    /** 把公式 + 保留正文写进容器(KaTeX 就绪/失败两条路径共用) */
    private paint(wrap: HTMLElement, texHtml: string | null): void {
        wrap.textContent = "";
        // 段前/段后正文(跨行 \(...\) 块的同行文字,如「\)...其中」的其中):
        // 按普通文本保留,进块级 widget 一并显示(块 replace 只能整行覆盖)
        if (this.plainBefore) {
            const div = document.createElement("div");
            div.className = "syfe-cm-math-plain";
            div.innerHTML = formatInlineCell(this.plainBefore);
            wrap.appendChild(div);
        }
        if (this.tex) {
            const holder = document.createElement("div");
            if (texHtml !== null) holder.innerHTML = texHtml;
            else holder.textContent = this.tex;
            wrap.appendChild(holder);
        }
        if (this.plainAfter) {
            const div = document.createElement("div");
            div.className = "syfe-cm-math-plain";
            div.innerHTML = formatInlineCell(this.plainAfter);
            wrap.appendChild(div);
        }
        for (const note of this.notes) {
            const div = document.createElement("div");
            div.className = "syfe-cm-math-note";
            div.textContent = note;
            wrap.appendChild(div);
        }
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-math";
        // 一行能放下时不出现任何滚动条;真溢出才允许横向拖动
        const syncOverflow = attachOverflowSync(wrap, view);
        // KaTeX 异步渲染完成会改变块高 → attachOverflowSync 已挂 RO 通知 CM6 重新测量
        const requestRelayout = () => {
            view.requestMeasure();
            syncOverflow();
        };
        const tryRender = (katex: any) => {
            try {
                let html: string | null = null;
                if (this.tex) {
                    const holder = document.createElement("div");
                    katex.render(this.tex, holder, {displayMode: true, throwOnError: false});
                    html = holder.innerHTML;
                }
                this.paint(wrap, html);
                wrap.classList.remove("is-error");
                wrap.classList.add("is-rendered");
                requestRelayout();
                return true;
            } catch (err) {
                this.paint(wrap, null);
                wrap.classList.add("is-error");
                wrap.setAttribute("title", err instanceof Error ? err.message : String(err));
                requestRelayout();
                return false;
            }
        };
        const ready = (window as any).__syfeKatex;
        if (ready) {
            tryRender(ready);
        } else {
            // KaTeX 尚未加载完:先回退显示源码,加载完成后就地重渲(不依赖编辑器重建)
            this.paint(wrap, null);
            wrap.classList.add("is-error");
            loadKatex().then(k => {
                if (k && wrap.isConnected) tryRender(k);
            });
        }
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

interface QuoteMathSlot {
    tex: string;
    raw: string;
    display: boolean;
}

/**
 * 引述块里的行内公式先抽成占位符再交给 Lute。
 * Lute 的 SetInlineMath 对同一行多个 $...$ 会跨段错配 —— 实测
 * "$0.48:0.08 = 6:1$；…$(0.857:0.143=6:1)$" 被解析成
 * "；归一化之后依然" 这一段中文的怪公式,两段真公式反而留作带 $ 的纯文本。
 * 这里用项目统一的 splitCellMath/findMathClose 逐段切分,Lute 只看到纯文本,
 * 渲染完再把占位符回填成 KaTeX —— 与阅读态一致。
 */
function maskQuoteMath(md: string): {masked: string; slots: QuoteMathSlot[]} {
    const slots: QuoteMathSlot[] = [];
    let masked = "";
    for (const part of splitCellMath(md)) {
        if (part.math === undefined) {
            masked += part.text;
            continue;
        }
        const idx = slots.length;
        slots.push({tex: part.math, raw: part.text, display: part.text.startsWith("$$")});
        masked += `SYFEMATH${idx}ZSYFE`;
    }
    return {masked, slots};
}

/** 把 Lute 产物文本节点里的占位符换成 KaTeX 公式 span(未就绪时显示源码,就绪后 paint 重绘) */
function fillQuoteMath(root: HTMLElement, slots: QuoteMathSlot[], katex: any): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // 本文件从 @codemirror/state 导入了 Text,会遮蔽 DOM 的 Text 类型;
    // 这里要的是文本节点,用其基类 CharacterData(带 nodeValue / parentNode)。
    const texts: CharacterData[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as CharacterData);
    const re = /SYFEMATH(\d+)ZSYFE/g;
    for (const node of texts) {
        const text = node.nodeValue || "";
        if (!/SYFEMATH\d+ZSYFE/.test(text)) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const slot = slots[Number(m[1])];
            const span = document.createElement("span");
            // 不加 language-math 类:下面 Lute 自带公式的填充选择器会把它当源码二次覆盖
            span.className = "syfe-cm-quote-math";
            if (slot && katex) {
                try {
                    span.innerHTML = inlineMathHtml(katex, slot.tex, slot.display);
                    span.setAttribute("data-render", "true");
                } catch {
                    span.textContent = slot.raw;
                    span.classList.add("is-error");
                }
            } else {
                span.textContent = slot ? slot.raw : m[0];
                span.classList.add("is-pending");
            }
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode?.replaceChild(frag, node);
    }
}

/** 引述块:与思源原生文档编辑器(protyle)同一渲染 —— window.Lute 出 protyle DOM,
 *  外层挂 protyle-wysiwyg 类直接吃思源应用级 CSS(左竖条/段距/行内样式与文档一致),
 *  公式按 SiYuan mathRender 同款 data-subtype="math" + data-content 填 KaTeX。
 *  光标入块回源码态编辑。 */
class QuoteWidget extends WidgetType {
    constructor(readonly lines: string[]) {
        super();
    }

    eq(other: QuoteWidget): boolean {
        return other.lines.join("\n") === this.lines.join("\n");
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        // 不挂 protyle-wysiwyg 容器类:它给每个 widget 加整篇级内边距(16/24px)造成大空白;
        // 原生是整篇一次内边距。这里用 Lute(protyle 引擎)出 DOM + 自有紧凑样式,编辑/退出同一渲染
        wrap.className = "syfe-cm-quote";
        observeWidgetResize(wrap, view);
        const md = this.lines.join("\n");
        // 行内公式先抽走:Lute 遇到同一行多段 $...$ 会跨段错配(见 maskQuoteMath)
        const {masked, slots} = maskQuoteMath(md);
        const paint = (katex: any) => {
            const LuteCtor = (window as any).Lute;
            if (LuteCtor) {
                try {
                    const lute = LuteCtor.New();
                    // protyle 渲染开关(对齐思源 setLute/getAgentLute 的关键项)
                    lute.SetProtyleWYSIWYG(true);
                    lute.SetInlineMath(true);
                    lute.SetInlineAsterisk(true);
                    lute.SetInlineUnderscore(true);
                    lute.SetGFMStrikethrough(true);
                    lute.SetMark(true);
                    lute.SetSup(true);
                    lute.SetSub(true);
                    lute.SetTag(true);
                    lute.SetRenderListStyle(true);
                    lute.SetSanitize(true);
                    lute.SetKramdownIAL(true);
                    lute.SetSuperBlock(true);
                    lute.SetCallout(true);
                    lute.SetHeadingID(false);
                    lute.SetYamlFrontMatter(false);
                    lute.SetToC(false);
                    lute.SetFootnotes(false);
                    lute.SetLinkRef(false);
                    lute.SetSpellcheck(false);
                    wrap.innerHTML = lute.Md2HTML(masked);
                    // 占位符回填 KaTeX(与 buildDecorations 的行内公式同一套规则/缓存)
                    fillQuoteMath(wrap, slots, katex);
                    // 公式填充(同 SiYuan mathRender:data-content 反解 → KaTeX;
                    // Lute 默认行内公式输出 .language-math,一并处理)
                    wrap.querySelectorAll('[data-subtype="math"], .language-math').forEach(el => {
                        const tex = el.hasAttribute("data-content")
                            ? LuteCtor.UnEscapeHTMLStr(el.getAttribute("data-content") || "")
                            : (el.textContent || "");
                        const isBlock = el.tagName === "DIV";
                        try {
                            const html = katex.renderToString(tex, {
                                displayMode: isBlock,
                                output: "html",
                                throwOnError: false,
                                strict: "ignore",
                            });
                            if (isBlock) {
                                el.innerHTML = `<div contenteditable="false">${html}</div>`;
                            } else {
                                el.innerHTML = html;
                            }
                            el.setAttribute("data-render", "true");
                        } catch {
                            el.textContent = tex;
                        }
                    });
                    view.requestMeasure();
                    return;
                } catch {
                    // Lute 异常回落纯文本
                }
            }
            wrap.innerHTML = `<div class="bq">${escapeHtml(masked).replace(/\n/g, "<br>")}</div>`;
            // Lute 不可用时至少保证公式/粗体之外的内容不丢,公式仍按占位符回填
            fillQuoteMath(wrap, slots, katex);
            view.requestMeasure();
        };
        const ready = (window as any).katex;
        if (ready) {
            paint(ready);
        } else {
            paint(null);
            loadKatex().then(k => {
                if (k && wrap.isConnected) paint(k);
            });
        }
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/**
 * Obsidian 页面属性面板 DOM。CM6 live 的 PropertiesWidget 与阅读态
 * (Vditor.preview 的 frontmatter pre)共用同一份渲染,保证两态一致。
 * 值一律用 textContent 输出(防注入);只认「顶格 key: value」的简单属性,
 * 多行数组/嵌套值保留在源码态查看。
 */
export function createPropertiesElement(lines: string[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "syfe-cm-properties";
    const head = document.createElement("div");
    head.className = "syfe-cm-properties__head";
    head.textContent = "属性";
    wrap.appendChild(head);
    const list = document.createElement("div");
    list.className = "syfe-cm-properties__list";
    for (const line of lines) {
        const m = /^([^:#\s][^:]*):\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        const row = document.createElement("div");
        row.className = "syfe-cm-properties__row";
        const key = document.createElement("span");
        key.className = "syfe-cm-properties__key";
        key.textContent = m[1].trim();
        const val = document.createElement("span");
        val.className = "syfe-cm-properties__value";
        val.textContent = m[2].trim();
        row.appendChild(key);
        row.appendChild(val);
        list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
}

class PropertiesWidget extends WidgetType {
    constructor(readonly lines: string[]) {
        super();
    }

    eq(other: PropertiesWidget): boolean {
        return other.lines.join("\n") === this.lines.join("\n");
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = createPropertiesElement(this.lines);
        // CM6 高度图只量 widget 根元素的 border-box,.syfe-cm-properties 的
        // margin(6px 0 10px)会逃出测量 → 行号槽 spacer 少 16px,其后的行号
        // 整体上浮(实测全列 -26px 中含这 16px)。用 flow-root 宿主把 margin
        // 圈进可测量范围,视觉零变化;阅读态共用渲染不受影响(仅 CM6 路径包壳)。
        const host = document.createElement("div");
        host.className = "syfe-cm-properties-host";
        host.appendChild(wrap);
        // 属性面板与 4 行源码高度差很大;尺寸变化必须让 CM6 重新测量行号槽
        observeWidgetResize(host, view);
        return host;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** 行内公式 HTML 缓存:大文档(数百个公式)按键重建装饰时,只有可见 widget 会取用 */
const inlineMathCache = new Map<string, string>();

function inlineMathHtml(katex: any, tex: string, displayMode = false): string {
    const cacheKey = (displayMode ? "D:" : "I:") + tex;
    const cached = inlineMathCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let html: string;
    try {
        html = katex.renderToString(tex, {
            displayMode,
            throwOnError: false,
            strict: "ignore",
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        html = `<span class="syfe-cm-math-inline is-error" title="${escapeHtml(msg)}">${escapeHtml(tex)}</span>`;
    }
    if (inlineMathCache.size >= 512) inlineMathCache.clear();
    inlineMathCache.set(cacheKey, html);
    return html;
}

/**
 * 行内公式 widget。光标所在行由 buildDecorations 跳过(保持源码态),
 * 点击 widget 由 clickHandler 把光标送回该行 → 装饰消失即可编辑。
 */
class InlineMathWidget extends WidgetType {
    readonly katexReady: boolean;

    constructor(readonly tex: string, readonly raw: string) {
        super();
        this.katexReady = !!(window as any).__syfeKatex;
    }

    eq(other: InlineMathWidget): boolean {
        return other.tex === this.tex && other.katexReady === this.katexReady;
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.className = "syfe-cm-inline-math";
        span.setAttribute("contenteditable", "false");
        // $$…$$ 用 display 模式(分数堆叠),列表项内保留圆点;一行能放下时不出滚动条
        const display = this.raw.startsWith("$$");
        const sync = attachOverflowSync(span, view);
        const katex = (window as any).__syfeKatex;
        if (katex) {
            span.innerHTML = inlineMathHtml(katex, this.tex, display);
        } else {
            span.textContent = this.raw;
            span.classList.add("is-pending");
            loadKatex().then(k => {
                if (!k || !span.isConnected) return;
                span.classList.remove("is-pending");
                span.innerHTML = inlineMathHtml(k, this.tex, display);
                view.requestMeasure();
                sync();
            });
        }
        return span;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** GFM 表格:块级替换为真实 <table>;点击表格把光标送回源码块 */
class TableWidget extends WidgetType {
    /** KaTeX 是否已就绪 —— 参与 eq,保证首屏之后加载完成时表格 DOM 真的重建 */
    readonly katexReady: boolean;

    constructor(readonly lines: string[], readonly indent = 0, readonly listBox = "", readonly gutterNums: readonly number[] = []) {
        super();
        this.katexReady = !!(window as any).__syfeKatex;
    }

    eq(other: TableWidget): boolean {
        return other.lines.join("\n") === this.lines.join("\n") && other.katexReady === this.katexReady
            && other.indent === this.indent && other.listBox === this.listBox && other.gutterNums.join(",") === this.gutterNums.join(",");
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-table";
        // 列表内的表格:同代码卡片,缩进用自身 padding-left + 盒带背景接管
        if (this.indent > 0) wrap.style.paddingLeft = `${this.indent.toFixed(1)}px`;
        if (this.listBox) wrap.classList.add(...this.listBox.split(" "));
        // 被吞行的行号:同代码卡片
        if (this.gutterNums.length) {
            const gutters = view.dom.querySelector(".cm-gutters");
            const contentEl = view.dom.querySelector(".cm-content");
            if (gutters && contentEl) {
                const gRect = gutters.getBoundingClientRect();
                // 偏移用 content/gutters 的稳定几何算(toDOM 时 wrap 尚未入 DOM,
                // 自己的 rect 是零)。wrap 与 content 同宽同左缘
                const offset = contentEl.getBoundingClientRect().left - gRect.left;
                wrap.style.position = "relative";
                const col = document.createElement("div");
                col.className = "cm-lineNumbers syfe-cm-table-gutternums";
                // z-index 高过 .cm-gutters(sticky, z=200):槽列有不透明背景,
                // 不抬层数字被盖住不可见
                col.style.zIndex = "300";
                col.style.left = `${(-Math.max(0, offset)).toFixed(1)}px`;
                col.style.width = `${gRect.width.toFixed(1)}px`;
                for (const n of this.gutterNums) {
                    const el = document.createElement("div");
                    el.className = "cm-gutterElement";
                    el.textContent = String(n);
                    // 右键单行号 → 「复制第 N 行链接」菜单(回调按编辑器实例登记)
                    const fn = copyLineByEditor.get(view.dom);
                    if (fn) {
                        el.oncontextmenu = (e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            fn(n, e.clientX, e.clientY);
                        };
                    }
                    col.appendChild(el);
                }
                wrap.prepend(col);
            }
        }
        guardScrollbarDrag(wrap);
        // 表格内公式重绘/字体加载会改变块高 → 通知 CM6 重新测量行号槽
        observeWidgetResize(wrap, view);
        const initial = renderGfmTable(this.lines, (window as any).__syfeKatex || null);
        wrap.appendChild(initial);
        if (!this.katexReady) {
            // 首屏早于 KaTeX 就绪:加载完成后就地重绘(不依赖编辑器重建)。
            // preloadCm6Katex 完成时还会派发 forceRenderEffect,eq 的 katexReady
            // 翻转使真实 widget DOM 重建,测量克隆里的一次重绘不影响结果。
            loadKatex().then(k => {
                if (!k || !wrap.isConnected) return;
                const next = renderGfmTable(this.lines, k);
                if (initial.parentNode === wrap) wrap.replaceChild(next, initial);
                view.requestMeasure();
            });
        }
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        disconnectWidgetResize(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** HTML 转义(formatInlineCell / 公式回退态共用) */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** 极简行内格式(粗/斜/行内码),先转义再替换,防 XSS */
function formatInlineCell(text: string): string {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        // 思源导出的表格单元格常用 <br> 换行;只放行 br,其余标签仍以转义文本显示
        .replace(/&lt;br\s*\/?&gt;/gi, "<br>");
}

interface CellPart {
    /** 原始片段(公式段含定界符,回退时直接显示) */
    text: string;
    /** 非 undefined 表示该段是公式,值为去掉定界符后的 TeX */
    math?: string;
    /** 在原始文本中的偏移(行内公式装饰据此换算 doc 位置) */
    from?: number;
    to?: number;
}

/**
 * 找公式闭合符。为避开货币符号($100 | $200 之类)误判,要求:
 * 闭合符后不能紧跟字母数字(行尾/空白/标点皆可)、内容非空。
 * ⚠ 闭合符**前**允许空白:思源导出大量写成 "$$ ( C )' = 0 $$",且单元格里
 * "$$公式A$$<br>$$公式B$$" 靠 <br> 分隔;若要求前非空白,第一个闭合会被跳过,
 * 于是 A 与 B 的起始定界符错配成一个跨 <br> 的怪公式。
 */
function findMathClose(text: string, from: number, close: string): {end: number; tex: string} | null {
    let at = from;
    while ((at = text.indexOf(close, at)) >= 0) {
        const tex = text.slice(from, at).trim();
        const after = text[at + close.length] ?? "";
        if (tex && !/[\w]/.test(after)) {
            return {end: at + close.length, tex};
        }
        at += close.length;
    }
    return null;
}

/** 把单元格文本切成「普通文本段 / 行内公式段」;公式段不再走 markdown 格式化 */
function splitCellMath(text: string): CellPart[] {
    const parts: CellPart[] = [];
    let i = 0;
    let plainFrom = 0;
    while (i < text.length) {
        // \(...\) 行内公式(LaTeX 括号定界,思源/Obsidian 导出常见);跨行段在
        // 单行文本里找不到闭合,自然落空,由块级 step 整段处理。
        // 前一字符是反斜杠 → 是转义反斜杠后跟括号(\\(),不是公式开头
        if (text.startsWith("\\(", i) && text[i - 1] !== "\\") {
            const found = findMathClose(text, i + 2, "\\)");
            if (found) {
                if (i > plainFrom) parts.push({text: text.slice(plainFrom, i), from: plainFrom, to: i});
                parts.push({text: text.slice(i, found.end), math: found.tex, from: i, to: found.end});
                i = found.end;
                plainFrom = i;
                continue;
            }
        }
        // 转义符连同伴字符整体跳过(\$100 不是公式,\| 不是列分隔)
        if (text[i] === "\\" && i + 1 < text.length) { i += 2; continue; }
        if (text[i] !== "$") { i++; continue; }
        const close = text[i + 1] === "$" ? "$$" : "$";
        const found = findMathClose(text, i + close.length, close);
        if (!found) { i += close.length; continue; }
        if (i > plainFrom) parts.push({text: text.slice(plainFrom, i), from: plainFrom, to: i});
        parts.push({text: text.slice(i, found.end), math: found.tex, from: i, to: found.end});
        i = found.end;
        plainFrom = i;
    }
    if (plainFrom < text.length) parts.push({text: text.slice(plainFrom), from: plainFrom, to: text.length});
    return parts.length ? parts : [{text, from: 0, to: text.length}];
}

/** 单元格 HTML:普通段走 formatInlineCell,公式段按 inline 交给 KaTeX;未就绪时回退源码 */
function renderCellHtml(cell: string, katex: any): string {
    return splitCellMath(cell).map(part => {
        if (part.math === undefined) return formatInlineCell(part.text);
        if (!katex) return `<span class="syfe-cm-math-inline is-pending">${escapeHtml(part.text)}</span>`;
        try {
            return `<span class="syfe-cm-math-inline">${katex.renderToString(part.math, {
                displayMode: false,
                throwOnError: false,
                strict: "ignore",
            })}</span>`;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `<span class="syfe-cm-math-inline is-error" title="${escapeHtml(msg)}">${escapeHtml(part.text)}</span>`;
        }
    }).join("");
}

// 占位符而非转义:公式/行内码里的 | 不当列分隔符,切完再还原(含 LaTeX 的 \|)
const PIPE_PLACEHOLDER = "\u0000";

function maskInlinePipes(text: string): string {
    let out = "";
    for (const part of splitCellMath(text)) {
        if (part.math !== undefined) {
            out += part.text.replace(/\|/g, PIPE_PLACEHOLDER);
        } else {
            // 行内码里的竖线同样不当分隔符
            out += part.text.replace(/`[^`]+`/g, m => m.replace(/\|/g, PIPE_PLACEHOLDER));
        }
    }
    return out;
}

function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return maskInlinePipes(s)
        .split(/(?<!\\)\|/)
        .map(c => c.trim().replace(/\u0000/g, "|").replace(/\\\|/g, "|"));
}

function renderGfmTable(lines: string[], katex: any): HTMLElement {
    const table = document.createElement("table");
    table.className = "syfe-cm-md-table";
    if (lines.length < 2) {
        const pre = document.createElement("pre");
        pre.textContent = lines.join("\n");
        table.appendChild(pre);
        return table;
    }
    const header = splitRow(lines[0]);
    const alignRow = splitRow(lines[1]);
    const aligns = header.map((_, i) => {
        const a = alignRow[i] || "";
        if (a.startsWith(":") && a.endsWith(":")) return "center";
        if (a.endsWith(":")) return "right";
        return "left";
    });
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    header.forEach((cell, i) => {
        const th = document.createElement("th");
        th.style.textAlign = aligns[i] as any;
        th.innerHTML = renderCellHtml(cell, katex);
        hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const line of lines.slice(2)) {
        if (!line.trim()) continue;
        const cells = splitRow(line);
        const tr = document.createElement("tr");
        header.forEach((_, i) => {
            const td = document.createElement("td");
            td.style.textAlign = aligns[i] as any;
            td.innerHTML = renderCellHtml(cells[i] || "", katex);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

// ===== 结构识别 =====

// 行内图片:逐处匹配(不要求独占整行),支持 "- ![](a.png) ![](b.png)" 这类导出形态
const RE_IMAGE_INLINE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const RE_IMG_TAG_INLINE = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
const RE_TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
// 行形态正则(buildDecorations 的各段落级扫描共用;摘要一次算好,见 LineDigest)
const RE_QUOTE_CALLOUT_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*>\s*\[!\w+\][+-]?/;
const RE_LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const RE_GUIDE_SKIP_ROW = /^\s*(?:\||\$|>)/;
const RE_HANG_BOX_LINE = /^\s*(?:>|\||```|~~~|\$\$)/;
const RE_HANG_LIST = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const RE_MATH_DELIM = /^\s*\$\$\s*$/;
const RE_TASK_LINE = /^(\s*)(?:[-*+]|\d+[.)])(\s+)\[[ xX]\](\s|$)/;

/** 行首空白折算宽(4px/空格、16px/tab;行形态摘要与悬挂几何共用) */
const indentWidth = (text: string): number => {
    const m = /^(\s*)/.exec(text);
    if (!m) return 0;
    return (m[1].match(/\t/g) || []).length * 16 + m[1].replace(/\t/g, "").length * 4;
};

/** 围栏代码块信息(借 lang-markdown 的语法树,FencedCode 节点) */
interface FencedCodeInfo {
    from: number;
    to: number;
    /** 代码内容在文档中的真实跨度(不含开/闭围栏行,含内容行之间的换行)。
     *  编辑写回直接用它定位,别再用 firstLine.to + code.length 反推 —— 多行
     *  编辑后反推会把位置算到文档外(实测 Enter 触发 RangeError)。 */
    contentFrom: number;
    contentTo: number;
    /** CodeInfo 节点文本(``` 后的语言名) */
    lang: string;
    /** 围栏之间的代码内容原文(编辑写回跨度按其长度定位,绝不能变形) */
    code: string;
    /** 渲染/复制用视图:内容行剥到围栏标记列为止 —— 与开栅栏对齐的空白
     *  不显示,多出的缩进保留(用户 2026-11-14:与前围栏对齐就不要空格,
     *  有空格距离就显示空格;CommonMark 内容缩进规则)。**与 code 不等长**,
     *  禁止用于编辑同步。 */
    codeView: string;
}

// fencedCodeInfos 按文档版本记忆化:Text 实例不可变,新版本 = 新实例。
// buildDecorations 一次重建里要取 3 次(引导线跳过集/卡片 widget/行内段),
// 全量扫描(含未闭围栏的最坏 O(n) 内层)按版本算一次即可。
const fencedCodeInfoCache = new WeakMap<Text, FencedCodeInfo[]>();

function fencedCodeInfosOf(state: EditorState): FencedCodeInfo[] {
    const doc = state.doc;
    let out = fencedCodeInfoCache.get(doc);
    if (out) return out;
    out = fencedCodeInfos(state);
    fencedCodeInfoCache.set(doc, out);
    return out;
}

function fencedCodeInfos(state: EditorState): FencedCodeInfo[] {
    const doc = state.doc;
    const out: FencedCodeInfo[] = [];
    // 文本扫描(替代 lezer FencedCode):围栏是**一个块** —— 闭```与开```
    // **对齐缩进**(同列)即配对, 内容行缩进任意变化不断块(用户 2026-11-14
    // 「下```也要和上```对齐缩进, 代码块是块」)。lezer 按列表内容列断块:
    // 内容行删缩进会把块打碎成「未闭围栏」, 卡片吞到文档尾(「编辑出错」)。
    // 开栅栏行 = 空白(+可选列表标记)+ 栅栏串(+语言); 闭栅栏 = 同字符、
    // 长度不短于开、栅栏列与开栅栏相同、行尾无其他文本。
    for (let ln = 1; ln <= doc.lines; ln++) {
        const line = doc.line(ln);
        const open = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(`{3,}|~{3,})(.*)$/.exec(line.text);
        if (!open) continue;
        const run = open[2];
        const fenceCol = open[1].length;
        const hasMarker = /(?:[-*+]|\d+[.)])\s+$/.test(open[1]);
        const lang = open[3].trim();
        // 找闭栅栏:同字符、长度 ≥ 开栅栏、栅栏列相同
        let closeLine = -1;
        for (let j = ln + 1; j <= doc.lines; j++) {
            const t = doc.line(j).text;
            const cm = /^(\s*)(`{3,}|~{3,})\s*$/.exec(t);
            if (cm && cm[2][0] === run[0] && cm[2].length >= run.length && cm[1].length === fenceCol) {
                closeLine = j;
                break;
            }
        }
        // 未闭合围栏:CommonMark 里它延伸到文档尾,但编辑器里**不能**把整段
        // 替换成卡片 widget —— 块级 replace 会让 CM6 的光标映射错乱
        // (实测输入围栏再回车后继续键入,字符会落到围栏之前的行里、搅乱原文)。
        // 保持源码可编辑,等用户输入闭合围栏后再渲染卡片。
        if (closeLine < 0) { ln = doc.lines; continue; }
        const first = doc.line(ln);
        const last = doc.line(closeLine);
        const contentFrom = first.to + 1;
        const contentTo = doc.line(closeLine - 1).to;
        const code = contentTo >= contentFrom ? doc.sliceString(contentFrom, contentTo) : "";
        // 视图文本:每行剥到栅栏列为止 —— 与```对齐的空白(markdown 结构)
        // 不显示, 多出的缩进是代码自身的内容, 保留(用户 2026-11-14 最终确认
        // 「渲染态要有空白」: echo 比 robocopy 深 4 格, 卡片里也要深 4 格;
        // 全剥规则作废)。编辑态(Monaco)与文档原文不受影响, 只影响卡片
        // 渲染与复制
        const codeView = code.split("\n").map(l => {
            let n = 0;
            while (n < fenceCol && n < l.length && (l[n] === " " || l[n] === "\t")) n++;
            return l.slice(n);
        }).join("\n");
        out.push({from: line.from + fenceCol, to: last.to, lang, code, codeView, contentFrom, contentTo});
        ln = closeLine;
    }
    return out;
}

/**
 * 列表内块级 widget(代码卡片/表格)的左缩进(px)= **上```的开头位置**
 * (用户 2026-11-14「代码块左边界就是上\`\`\`的开头位置」—— 与源码态一致)。
 * 块 widget 是 .cm-line 的兄弟节点,行盒的 padding-left 管不到它 —— 列表里的
 * 卡片/表格会顶到内容区最左(用户 2026-11-14 反馈),缩进必须写进 widget 自身
 * padding。
 * 取值:widget 首行自带列表标记("- ```fence")→ ``` 渲染在标记之后的正文列,
 * 用本行的悬挂 pad;纯缩进围栏("  \`\`\`python")→ ``` 渲染在自己的缩进列,
 * 用本行行首空白宽(4px/空格、16px/tab,与源码行渲染同源);顶层块(无前缀)
 * → 0 不缩进。
 */
function listBlockIndent(
    doc: {line(n: number): {text: string}},
    lineNum: number,
    ownIsMarkerLine: boolean,
    hangPadOf: (ln: number) => number,
    indentWidthFn: (t: string) => number,
): number {
    if (ownIsMarkerLine) return hangPadOf(lineNum);
    return indentWidthFn(doc.line(lineNum).text);
}

/**
 * pos 所在的顶级列表容器盒的行号跨度(与 cm6-inline 的 BulletList/OrderedList
 * 盒同一判定:最外层列表祖先,自身不再嵌套在别的列表里)。列表内的块级 widget
 * (代码卡片/表格)要用它接盒色/圆角 —— 盒色是逐行行盒画的,widget 是 .cm-line
 * 的兄弟节点,天然拿不到,盒带会在 widget 处断出白洞(用户 2026-11-14 反馈
 * 「列表块背景显示不对」)。不在任何列表里返回 null。
 */
function topListBoxSpan(state: EditorState, pos: number): {fromLine: number; toLine: number} | null {
    const doc = state.doc;
    let outerList: any = null;
    for (let p: any = syntaxTree(state).resolveInner(pos, -1); p; p = p.parent) {
        if (p.name === "BulletList" || p.name === "OrderedList") outerList = p;
    }
    if (!outerList) return null;
    for (let p = outerList.parent; p; p = p.parent) {
        if (p.name === "BulletList" || p.name === "OrderedList") return null;
    }
    // toLine 取**末字符所在行**:列表以换行结尾时 node.to 指向下一行行首,
    // lineAt(node.to) 会多算一行,盒带涂到列表外的空行上(用户 2026-11-14
    // 「列表背景渲染这么多」)
    return {fromLine: doc.lineAt(outerList.from).number, toLine: doc.lineAt(Math.max(outerList.from, outerList.to - 1)).number};
}

// ===== 被吞行行号的右键菜单 =====
// 编辑器实例 → 「复制第 N 行链接」菜单回调(cm6-markdown 创建编辑器时登记,
// 菜单构建在登记侧以复用其 Menu 与 onCopyLine)。行号补画列的每个数字右键用
// 它弹出菜单;按编辑器 DOM 分键,多页签互不串扰。
const copyLineByEditor = new WeakMap<HTMLElement, (n: number, x: number, y: number) => void>();

export function registerCopyLineHandler(editorDom: HTMLElement, fn: ((n: number, x: number, y: number) => void) | null): void {
    if (fn) copyLineByEditor.set(editorDom, fn);
    else copyLineByEditor.delete(editorDom);
}

// 语言标签点击:亮/收围栏(Obsidian 同款「点语言进源码」)。
//   - 卡片态 → 光标放到开头围栏行尾(紧贴语言名,可直接改语言),渲染层对
//     「光标在块内且未挂 Monaco」的块显示原始围栏(见 buildDecorations);
//   - 围栏态(光标已在块内)→ 光标移到块后,卡片回来;
//   - Monaco 编辑态 → 先退出(落盘 + 卸载单例)再亮围栏。
// 全部通过 dispatch selection 完成,装饰重建走 StateField 正常管线。
function toggleFenceReveal(view: EditorView, key: string): void {
    const from = parseInt(key, 10);
    if (Number.isNaN(from) || from >= view.state.doc.length) return;
    const info = fencedCodeInfos(view.state).find(i => i.from === from);
    if (!info) return;
    const editing = getEditingKey() === key;
    if (editing) {
        flushActiveBlock();
        unmountBlockEditor();
        setEditingKey(null);
        activeSync = null;
    }
    const inside = !editing && view.state.selection.main.head >= info.from
        && view.state.selection.main.head <= info.to;
    if (inside) {
        // 已在围栏态 → 收起:光标移到块后(下一行行首;块后无行则取文档尾)
        const nextLine = Math.min(view.state.doc.lineAt(info.to).number + 1, view.state.doc.lines);
        view.dispatch({selection: {anchor: view.state.doc.line(nextLine).from}});
    } else {
        // 亮围栏:光标放到开头围栏行尾
        view.dispatch({selection: {anchor: view.state.doc.lineAt(info.from).to}});
    }
    view.focus();
}

// ===== 主插件 =====

// 外部事件(主题切换/进入编辑态)→ 强制重建装饰。模块级:编辑态退出等 widget 回调也
// 需要派发,而 widget 实例拿不到闭包内的 effect。
const forceRenderEffect = StateEffect.define<null>();
// 编辑态同步状态:块 key + 最近一次同步进文档的内容(monaco ↔ cm6 回写定位用)
let activeSync: {key: string; viewValue: string} | null = null;
// 写回宿主会触发装饰重建,防重入(否则一次 Enter 可能被同步两次)
let syncingFromBlock = false;

/** 围栏代码块信息(按文档版本记忆化;行级菜单的卡片菜单也用) */
export function fencedCodeInfosOfState(state: EditorState): FencedCodeInfo[] {
    return fencedCodeInfosOf(state);
}

/**
 * 卡片菜单「编辑源码」入口:与点击代码卡片同一编辑流(设置 editingKey +
 * 同步快照 + 强制重建,正文区换内嵌 CM6)。菜单侧(cm6-line-menu)拿不到
 * 模块内的 editingKey 机制,经此入口进入。
 */
export function beginCodeEdit(view: EditorView, from: number): boolean {
    const info = fencedCodeInfosOf(view.state).find(i => i.from === from);
    if (!info) return false;
    const key = String(from);
    activeSync = {key, viewValue: info.codeView};
    setEditingKey(key);
    view.dispatch({effects: forceRenderEffect.of(null)});
    return true;
}

// 开关:CM6 代码块 Monaco 渲染(markdown.cm6CodeBlockMonaco,默认开)。
// 关闭后围栏代码块回落编辑器原生源码行(不渲染卡片、不可 Monaco 编辑),
// 与点语言标签的围栏态同观感;数学/表格/图片等非 Monaco 渲染不受影响。
function isCodeBlockMonacoEnabled(): boolean {
    return getBoolSetting("markdown.cm6CodeBlockMonaco", true);
}

// 开关关且正处 Monaco 编辑态 → 退出(落盘 + 卸载单例),否则单例滞留 detached DOM
function exitBlockEditingIfAny(): void {
    if (!getEditingKey()) return;
    flushActiveBlock();
    unmountBlockEditor();
    setEditingKey(null);
    activeSync = null;
}

// 活跃 CM6 视图集合:设置变更统一扇出重建。registerSettingsChangedHandler 无退订,
// 模块级单订阅 + 集合随视图销毁自清,避免每页签一个闭包的泄漏。
const activeRenderViews = new Set<EditorView>();
let settingsFanoutInstalled = false;
function ensureSettingsFanout(): void {
    if (settingsFanoutInstalled) return;
    settingsFanoutInstalled = true;
    registerSettingsChangedHandler(() => {
        if (!isCodeBlockMonacoEnabled()) {
            exitBlockEditingIfAny();
        }
        for (const view of [...activeRenderViews]) {
            if (!view.dom.isConnected) {
                activeRenderViews.delete(view);
                continue;
            }
            view.dispatch({effects: forceRenderEffect.of(null)});
        }
    });
}

/**
 * CM6 代码块渲染配置变更(markdown.cm6CodeBlockMonaco 开关)→ 全部活跃视图
 * 重建装饰。设置面板(settings.json 编辑器保存)与旧版设置对话框两条入口都调它;
 * 开关关时顺带退出编辑态。
 */
export function notifyCm6RenderConfigChanged(): void {
    if (!isCodeBlockMonacoEnabled()) {
        exitBlockEditingIfAny();
    }
    for (const view of [...activeRenderViews]) {
        if (!view.dom.isConnected) {
            activeRenderViews.delete(view);
            continue;
        }
        view.dispatch({effects: forceRenderEffect.of(null)});
    }
}

const tableSrcLineDeco = Decoration.line({class: "syfe-cm-tablesrc-line"});
const mathSrcLineDeco = Decoration.line({class: "syfe-cm-mathsrc-line"});
const propSrcLineDeco = Decoration.line({class: "syfe-cm-propsrc-line"});
const quoteSrcLineDeco = Decoration.line({class: "syfe-cm-quotesrc-line syfe-cm-md-quote-line"});

export function cm6MarkdownRender(opts: Cm6RenderOptions): Extension {
    const renderField = StateField.define<DecorationSet>({
        create: (st) => buildDecorations(st, opts),
        update: (value, tr) => {
            if (tr.effects.some(e => e.is(forceRenderEffect))) {
                // 强制重建(主题/KaTeX 就绪/进编辑态/尺寸变化):块缓存按旧 doc 记忆,
                // 不传 tr 即全量重建并刷新新 doc 的缓存
                return buildDecorations(tr.state, opts);
            }
            // doc/selection 变化重建;语法树异步解析完成(树实例变化)也重建,
            // 否则大文档首次渲染时 FencedCode 装饰会缺失(PurrMD 同款坑)。
            // 块级增量:未变块按位移映射复用,仅变块重建(见 buildDecorations)。
            if (!tr.docChanged && !tr.selection && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
                return value;
            }
            // 增量重建读的是旧 doc 的块缓存,文档被外部写回缩短时个别位置可能
            // 越界:退回不带 tr 的全量重建(重算缓存),再不行给空集保命 ——
            // 装饰 StateField 抛异常会让整笔事务失效(编辑器卡死)。
            try {
                return buildDecorations(tr.state, opts, tr);
            } catch {
                try {
                    return buildDecorations(tr.state, opts);
                } catch {
                    return Decoration.none;
                }
            }
        },
        provide: (f) => [
            EditorView.decorations.from(f),
            // 块替换区域原子化:光标不会落在渲染物中间(点击进入即回源码)
            // atomicRanges 是「函数值」型 facet,须用 .of(view => ...) 供值
            EditorView.atomicRanges.of((view) => view.state.field(f)),
        ],
    });

    // 点击渲染物(代码卡片/表格/公式)→ 光标送进源码块,视图随即回源码态(编辑模型见文件头)。
    // 事件处理必须放在 ViewPlugin 里(StateField 不接 DOM 事件;block 装饰限制只针对装饰)。
    const clickHandler = ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {}
        update() {}
    }, {
        eventHandlers: {
            mousedown(event, view) {
                // 只读阅读态:点渲染物不再把光标送回源码(禁止点击进入编辑)。
                // 复制按钮自带 onmousedown 且 stopPropagation,仍可正常复制
                if (view.state.readOnly) return false;
                const target = event.target as HTMLElement;
                // 复制按钮 / calc 结果列是独立交互区(结果可选中复制)
                if (target.closest(".syfe-cm-codeblock-copy, .syfe-cm-calc-out")) return false;
                const wrap = target.closest(
                    ".syfe-cm-codeblock, .syfe-cm-table, .syfe-cm-math, .syfe-cm-inline-math, " +
                    ".syfe-cm-img, .syfe-cm-properties, .syfe-cm-quote",
                ) as HTMLElement | null;
                if (!wrap) return false;
                const pos = view.posAtDOM(wrap);
                // 点击处在屏幕上的位置:渲染物被源码替换后块高会变(属性面板
                // ↔ 4 行 YAML、公式 widget ↔ 源码文本),必须把该点锚住才不跳页
                const anchorTop = wrap.getBoundingClientRect().top;
                const line = view.state.doc.lineAt(pos);
                // 行内渲染物(公式/图片)直接落在自身位置,块级渲染物落到行首;
                // 光标一进该行,该行的行内装饰即撤销 → 回到可编辑源码态
                const inline = wrap.classList.contains("syfe-cm-inline-math") ||
                    wrap.classList.contains("syfe-cm-img");
                let anchor: number;
                if (wrap.classList.contains("syfe-cm-codeblock")) {
                    // 代码块:声明进入编辑态 —— 挂载层为**卡片内嵌 CM6 编辑器**
                    //(用户 2026-11-14 定稿: 不用 Monaco, 宿主 CM6 也不变源码,
                    // 卡片壳/行号/盒带保留, 正文区换内嵌 CM6, 语法渲染走
                    // language-data 语言包)。由 editMounter 在重建后的真实视图
                    // DOM 上安置(不能在此处直接挂载 —— 本 wrap 可能即将被重建)。
                    const key = wrap.dataset.blockKey ?? null;
                    if (key !== null && getEditingKey() !== key) {
                        const info = fencedCodeInfos(view.state).find(i => i.from === parseInt(key, 10));
                        if (info) {
                            activeSync = {key, viewValue: info.codeView};
                            setEditingKey(key);
                            view.dispatch({effects: forceRenderEffect.of(null)});
                        }
                    }
                    return true;   // 已挂载:事件交给内嵌 CM6 自行处理
                }
                if (wrap.classList.contains("syfe-cm-quote")) {
                    // 引述块:光标直接落到正文起点(跳过缩进 + 列表标记 + `>`)。
                    // 若落在行首,cm6-inline 的 ListMark/QuoteMark 会把 "- >"
                    // 还原成可见源码(真实焦点下),编辑态与渲染态就不一致了。
                    const pm = /^\s*(?:[-*+]|\d+[.)])?\s*>\s*/.exec(line.text);
                    anchor = Math.min(line.from + (pm ? pm[0].length : 1), line.to);
                } else if (inline) {
                    anchor = Math.min(Math.max(pos, line.from), line.to);
                } else {
                    anchor = Math.min(line.from + 1, line.to);
                }
                view.dispatch({selection: {anchor}});
                view.focus();
                // CM6 的 dispatch 同步完成 DOM 更新,此时 coordsAtPos 已是新布局;
                // 把光标处的屏幕 Y 拉回点击时的位置(scrollTop 差值补偿)。
                try {
                    const now = view.coordsAtPos(anchor);
                    if (now) view.scrollDOM.scrollTop += now.top - anchorTop;
                } catch {
                    // 位置已失效(块被替换/折叠)时忽略
                }
                return true;
            },
        },
    });

    // 主题切换(monaco 全局事件:扩展主题/思源配色/明暗切换全覆盖)→
    // 强制重建代码块卡片(colorize 缓存按主题名失效,重取即新色)。
    // 兼职:登记/清理活跃视图集合(设置变更扇出用,见 ensureSettingsFanout)。
    const themeSync = ViewPlugin.fromClass(class {
        private off: {dispose(): void} = {dispose: () => undefined};
        constructor(readonly view: EditorView) {
            activeRenderViews.add(view);
            this.off = onMonacoThemeChanged(() => {
                view.dispatch({effects: forceRenderEffect.of(null)});
            });
            // 挂载后布局就绪再重建一次,让引述竖线用最终坐标测量(coordsAtPos 在首帧
            // 布局未稳时会返回估算值,导致竖线比正文偏左几十像素)
            if (typeof requestAnimationFrame !== "undefined") {
                requestAnimationFrame(() => {
                    if (view.dom.isConnected) view.dispatch({effects: forceRenderEffect.of(null)});
                });
            }
        }
        destroy() {
            activeRenderViews.delete(this.view);
            this.off.dispose();
        }
    });

    // Monaco 内容变更 → 单事务写回 cm6 文档(定位:块首围栏行尾 + 当前原文跨度)
    // Monaco 是**去结构缩进的视图**(codeView):写回时按开栅栏行前缀重新缩进,
    // 文件里的结构缩进保持不变(用户 2026-11-14「代码块编辑态有空格」—— 编辑态
    // 与渲染态看同一份去缩进视图)。空行不加前缀。
    const syncFromMonaco = (view: EditorView) => (v: string) => {
        if (!activeSync || syncingFromBlock) return;
        const nv = v.replace(/\r\n/g, "\n");
        const from = parseInt(activeSync.key, 10);
        const docLen = view.state.doc.length;
        if (Number.isNaN(from) || from >= docLen) return;
        const info = fencedCodeInfos(view.state).find(i => i.from === from);
        if (!info) return;
        const firstLine = view.state.doc.lineAt(Math.min(from, docLen));
        // 直接用文本扫描算出的内容跨度,不再用 firstLine.to + info.code.length
        // 反推:多行编辑(Enter/删除整行)后反推位置会超出文档长度,CM6 抛
        // "Invalid position N in document of length M",写回整笔丢失(实测)。
        const innerFrom = Math.min(info.contentFrom, docLen);
        const innerTo = Math.max(innerFrom, Math.min(info.contentTo, docLen));
        const reindent = view.state.doc.sliceString(firstLine.from, from).replace(/\S/g, " ");
        const raw = nv.split("\n").map(l => (l.trim() ? reindent + l : l)).join("\n");
        activeSync.viewValue = nv;
        syncingFromBlock = true;
        try {
            view.dispatch({changes: {from: innerFrom, to: innerTo, insert: raw}});
        } finally {
            syncingFromBlock = false;
        }
        // calc 块:编辑态 eq 刻意不比较 code(widget 不重建,避免打断内嵌编辑器),
        // 所以逐键主动刷新右侧结果列 —— 等价 Logseq CM5 的 change → eval-lines。
        const resultEl = view.dom.querySelector(
            `.syfe-cm-codeblock[data-block-key="${activeSync.key}"] .syfe-cm-calc-out`,
        ) as HTMLElement | null;
        if (resultEl) refreshCalcResults(resultEl, nv);
    };
    // 退出编辑态:flush 最终内容 → 卸载单例 → 重建回渲染卡片
    const exitEditing = (view: EditorView) => () => {
        flushActiveBlock();
        unmountBlockEditor();
        setEditingKey(null);
        activeSync = null;
        view.dispatch({effects: forceRenderEffect.of(null)});
        view.focus();
    };

    // 编辑态挂载器:CM6 重建会销毁/克隆 widget DOM,编辑器绝不在 toDOM 里挂载。
    // 每次更新后把单例编辑器安置进「当前编辑块」的真实宿主(过滤测量克隆):
    //   - 未挂载 → 全量挂载(点击卡片后的第一次重建)
    //   - 已挂载同块但容器变了(重建换了 widget DOM)→ 搬 DOM + 重绑监听
    // ⚠ update 里只做调度:ViewPlugin.update 跑在 DocView DOM 同步**之前**
    //   (CM6 update 流:updatePlugins → docView.update),同事务直接挂载会挂进
    //   即将被替换的旧 widget DOM —— 编辑态首挂时 editingFlag 翻转必触发 widget
    //   重建,刚挂进去的宿主连人带编辑器一起 detach;而 flags-only 的 measure
    //   不重跑 plugins(ViewUpdate.empty 短路),没有后续 update 就永不自愈
    //   (实测坐实:宿主空、单例滞留 detached DOM)。挪到微任务执行时本轮
    //   DOM 同步已完结,拿到的必是最终宿主。
    const editMounter = ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {}
        update() {
            // 只读阅读态绝不挂载 Monaco 代码块编辑器(全局 editingKey 可能被
            // 其它可编辑页签设置,这里必须按本视图的 readOnly 早退)
            if (this.view.state.readOnly || !getEditingKey()) return;
            queueMicrotask(() => this.sync());
        }
        sync() {
            const key = getEditingKey();
            if (!key) return;
            const hosts: HTMLElement[] = [];
            this.view.dom.querySelectorAll(`.syfe-cm-codeblock[data-block-key="${key}"] .syfe-cm-codeblock-editorhost`)
                .forEach(h => {
                    if (!(h as HTMLElement).closest(".cm-measurement")) hosts.push(h as HTMLElement);
                });
            if (!hosts.length) return;
            const host = hosts[0];
            if (getMountedBlockKey() === key) {
                if (getMountedContainer() !== host) {
                    remountBlockEditor({
                        container: host,
                        key,
                        lang: getMountedLanguage(),
                        value: activeSync?.viewValue ?? "",
                        onContentChange: syncFromMonaco(this.view),
                        onExit: exitEditing(this.view),
                    });
                }
                return;
            }
            const wrap = host.closest(".syfe-cm-codeblock") as HTMLElement | null;
            const langLabel = wrap ? (wrap.querySelector(".syfe-cm-codeblock-lang")?.textContent ?? "text") : "text";
            mountBlockEditor({
                container: host,
                key,
                lang: langLabel,
                value: activeSync?.viewValue ?? "",
                onContentChange: syncFromMonaco(this.view),
                onExit: exitEditing(this.view),
            });
        }
    });

    // 列表引导线重算(参考 guideLayout.ts 的 watchGuideLayout):字体/缩放/折行/
    // 窗口变化引起 contentDOM 尺寸变化时全量重建装饰。只观察一个容器节点,
    // 覆盖所有渲染路径;装饰只改 background,不改变布局,不会自激循环。
    const guideResize = ViewPlugin.fromClass(class {
        private ro: ResizeObserver | null = null;
        private lastW = 0;
        private lastH = 0;
        constructor(private readonly view: EditorView) {
            if (typeof ResizeObserver === "undefined") return;
            this.ro = new ResizeObserver((entries) => {
                // 只认真实尺寸变化:装饰重建引起的同名回调不重复派发,避免自激
                const r = entries[0]?.contentRect;
                if (r && Math.abs(r.width - this.lastW) < 1 && Math.abs(r.height - this.lastH) < 1) return;
                this.lastW = r?.width ?? 0;
                this.lastH = r?.height ?? 0;
                if (this.view.dom.isConnected) {
                    this.view.dispatch({effects: forceRenderEffect.of(null)});
                }
            });
            this.ro.observe(this.view.contentDOM);
        }
        update() {}
        destroy() {
            this.ro?.disconnect();
        }
    });
    ensureSettingsFanout();
    return [renderField, clickHandler, themeSync, editMounter, guideResize];
}

// ===== 块分解与按块增量(decoration_regions 移植;文本级,按 doc 版本记忆化) =====
//
// 原 buildDecorations 每次击键对全文档跑全部段落扫描(实测 2400 行 27ms/键)。
// 改造:文档分解为顶层块(列表项含子树/段落/标题/围栏/表格/公式对/引述/属性
// 面板),每块的装饰由**块内容 + 光标是否在块内**唯一决定 —— 都不变 → 旧装饰
// 按位移映射后原样复用(纯重发射,零正则零 widget 重建);变了 → 只重建该块。

interface LineDigest {
    from: number;
    to: number;
    indentW: number;
    isList: boolean;
    isTask: boolean;
    isBlank: boolean;
    isQuote: boolean;
    quoteIndent: string;
    isBoxLine: boolean;
    isTableRow: boolean;
    inFence: boolean;
}

function buildLineDigests(doc: Text, fences: FencedCodeInfo[]): LineDigest[] {
    const out: LineDigest[] = new Array(doc.lines + 1);
    const fenceLineSpans: Array<[number, number]> = fences.map(info => [
        doc.lineAt(info.from).number,
        doc.lineAt(Math.max(info.from, info.to - 1)).number,
    ]);
    let fi = 0;
    for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        const text = line.text;
        const isList = RE_LIST_ITEM.test(text);
        while (fi < fenceLineSpans.length && fenceLineSpans[fi][1] < n) fi++;
        const inFence = fi < fenceLineSpans.length && n >= fenceLineSpans[fi][0];
        const qm = /^((?:\s*)(?:[-*+]|\d{1,9}[.)])?\s*)>/.exec(text);
        out[n] = {
            from: line.from,
            to: line.to,
            indentW: indentWidth(text),
            isList,
            isTask: RE_TASK_LINE.test(text),
            isBlank: text.trim() === "",
            isQuote: !!qm,
            quoteIndent: qm ? qm[1] : "",
            isBoxLine: RE_HANG_BOX_LINE.test(text),
            isTableRow: RE_TABLE_ROW.test(text),
            inFence,
        };
    }
    return out;
}

const lineDigestCache = new WeakMap<Text, LineDigest[]>();
function lineDigestsOf(state: EditorState): LineDigest[] {
    const doc = state.doc;
    let d = lineDigestCache.get(doc);
    if (!d) {
        d = buildLineDigests(doc, fencedCodeInfosOf(state));
        lineDigestCache.set(doc, d);
    }
    return d;
}

interface RenderBlock {
    fromLine: number;
    toLine: number;
    kind: "props" | "fence" | "table" | "math" | "quote" | "list" | "para" | "heading";
    from: number;
    to: number;
    /** list 块内部的围栏信息(顶层围栏块就是自己) */
    fences: FencedCodeInfo[];
}

const renderBlockCache = new WeakMap<Text, RenderBlock[]>();

function docBlocksOf(state: EditorState): RenderBlock[] {
    const doc = state.doc;
    const cached = renderBlockCache.get(doc);
    if (cached) return cached;
    const fences = fencedCodeInfosOf(state);
    const fenceCovered = new Uint8Array(doc.lines + 1);
    const fenceInfoByFirstLine = new Map<number, FencedCodeInfo>();
    for (const info of fences) {
        const f = doc.lineAt(info.from).number;
        const t = doc.lineAt(Math.max(info.from, info.to - 1)).number;
        for (let k = f; k <= t; k++) fenceCovered[k] = 1;
        fenceInfoByFirstLine.set(f, info);
    }
    const mathSpans: Array<[number, number]> = [];
    {
        let k = 1;
        while (k <= doc.lines) {
            if (!RE_MATH_DELIM.test(doc.line(k).text)) { k++; continue; }
            let j = k + 1;
            while (j <= doc.lines && !RE_MATH_DELIM.test(doc.line(j).text)) j++;
            if (j <= doc.lines) { mathSpans.push([k, j]); k = j + 1; } else k++;
        }
    }
    const inMathSpan = new Uint8Array(doc.lines + 1);
    for (const [a, b] of mathSpans) for (let k = a; k <= b; k++) inMathSpan[k] = 1;

    const blocks: RenderBlock[] = [];
    const mk = (fromLine: number, toLine: number, kind: RenderBlock["kind"], inner: FencedCodeInfo[] = []): RenderBlock => ({
        fromLine, toLine, kind,
        from: doc.line(fromLine).from,
        to: doc.line(toLine).to,
        fences: inner,
    });

    let n = 1;
    while (n <= doc.lines) {
        // 属性面板(文首闭合 frontmatter)
        if (n === 1 && doc.lines >= 2 && /^\s*---\s*$/.test(doc.line(1).text)) {
            let end = 2;
            while (end <= doc.lines && !/^\s*---\s*$/.test(doc.line(end).text)) end++;
            if (end <= doc.lines) {
                blocks.push(mk(1, end, "props"));
                n = end + 1;
                continue;
            }
        }
        // 顶层围栏块(不在任何列表子树内的围栏)
        if (fenceCovered[n]) {
            let f = n;
            while (f > 1 && fenceCovered[f - 1]) f--;
            let t = n;
            while (t + 1 <= doc.lines && fenceCovered[t + 1]) t++;
            blocks.push(mk(f, t, "fence", [fenceInfoByFirstLine.get(f)!]));
            n = t + 1;
            continue;
        }
        // 顶层 $$ 公式对
        if (inMathSpan[n]) {
            const span = mathSpans.find(([a, b]) => n >= a && n <= b)!;
            blocks.push(mk(span[0], span[1], "math"));
            n = span[1] + 1;
            continue;
        }
        const line = doc.line(n);
        const text = line.text;
        const ind = indentWidth(text);
        if (text.trim() === "") { n++; continue; }
        if (/^\s*#{1,6}\s/.test(text)) {
            blocks.push(mk(n, n, "heading"));
            n++;
            continue;
        }
        if (RE_TABLE_ROW.test(text) && ind === 0) {
            let tail = n;
            while (tail + 1 <= doc.lines && RE_TABLE_ROW.test(doc.line(tail + 1).text)) tail++;
            blocks.push(mk(n, tail, "table"));
            n = tail + 1;
            continue;
        }
        const qm = /^((?:\s*)(?:[-*+]|\d{1,9}[.)])?\s*)>/.exec(text);
        if (qm) {
            let end = n;
            while (end + 1 <= doc.lines) {
                const nm = /^((?:\s*)(?:[-*+]|\d{1,9}[.)])?\s*)>/.exec(doc.line(end + 1).text);
                if (!nm || nm[1] !== qm[1]) break;
                end++;
            }
            blocks.push(mk(n, end, "quote"));
            n = end + 1;
            continue;
        }
        // 列表项:项 + 更深缩进子树(内部围栏/表格/公式随块);子树止于缩进 ≤
        // 首项的行(与行级菜单 blockEnd 同一规则)。围栏行原子并入。
        if (RE_LIST_ITEM.test(text)) {
            const base = ind;
            let end = n;
            const inner: FencedCodeInfo[] = [];
            while (end + 1 <= doc.lines) {
                const j = end + 1;
                const tj = doc.line(j).text;
                if (fenceCovered[j]) {
                    let f = j;
                    while (f > n && fenceCovered[f - 1]) f--;
                    let t = j;
                    while (t + 1 <= doc.lines && fenceCovered[t + 1]) t++;
                    const info = fenceInfoByFirstLine.get(f);
                    if (info) inner.push(info);
                    end = t;
                    continue;
                }
                if (tj.trim() === "") {
                    const nx = end + 2 <= doc.lines ? doc.line(end + 2).text : "";
                    if (nx.trim() !== "" && indentWidth(nx) > base) { end = j; continue; }
                    break;
                }
                if (indentWidth(tj) > base) { end = j; continue; }
                break;
            }
            for (const info of fences) {
                const f = doc.lineAt(info.from).number;
                if (f >= n && f <= end && !inner.includes(info)) inner.push(info);
            }
            blocks.push(mk(n, end, "list", inner));
            n = end + 1;
            continue;
        }
        // 段落
        let end = n;
        while (end + 1 <= doc.lines) {
            const tj = doc.line(end + 1).text;
            if (tj.trim() === "") break;
            if (fenceCovered[end + 1] || inMathSpan[end + 1]) break;
            if (RE_LIST_ITEM.test(tj) || RE_TABLE_ROW.test(tj) ||
                /^\s*(?:[-*+]|\d{1,9}[.)])?\s*>/.test(tj) || /^\s*#{1,6}\s/.test(tj)) break;
            end++;
        }
        blocks.push(mk(n, end, "para"));
        n = end + 1;
    }
    renderBlockCache.set(doc, blocks);
    return blocks;
}

// ===== 单块装饰构建(各段落扫描的块局域版) =====

interface BlockDecorations {
    fromLine: number;
    content: string;
    /** 构建时光标是否在本块范围内(缓存复用条件之一) */
    near: boolean;
    ranges: Range<Decoration>[];
    lineDecos: Range<Decoration>[];
}

function buildBlockDeco(
    state: EditorState,
    block: RenderBlock,
    digests: LineDigest[],
    cursor: number,
    opts: Cm6RenderOptions,
): Pick<BlockDecorations, "ranges" | "lineDecos"> {
    const view = {state} as EditorView;
    const ranges: Array<Range<Decoration>> = [];
    const lineDecos: Array<Range<Decoration>> = [];
    const usedRanges: Array<{from: number; to: number}> = [];
    const overlapsUsed = (from: number, to: number) => usedRanges.some(r => from < r.to && to > r.from);
    // 与原实现同一语义:块级开右区间(光标停在块尾算「在块之后」)
    const cursorInBlock = (from: number, to: number) => cursor >= from && cursor < to;
    const cursorOnLine = (from: number, to: number) => cursor >= from && cursor <= to;
    const doc = state.doc;
    const readOnly = state.readOnly;
    const HANG_STEP = 16;
    const HANG_MARK_W = 9.3;
    const HANG_QUOTE_W = 13.3;
    const GUIDE_GAP = 9;
    const GUIDE_WIDTH = 2;
    const GUIDE_COLOR = "var(--syfe-cm-guide-color, color-mix(in srgb, var(--b3-theme-on-background, #888) 32%, transparent))";
    const fromLine = block.fromLine;
    const toLine = block.toLine;

    const guideStops = new Map<number, Array<{x: number; first: boolean; last: boolean}>>();
    const quoteBarByLine = new Map<number, number>();
    const quoteLines = new Set<number>();
    const quoteCalloutLines = new Set<number>();
    const hangByLine = new Map<number, {pad: number; indent: number}>();

    // 悬挂几何(列表/引述块)
    if (block.kind === "list" || block.kind === "quote") {
        for (let ln = fromLine; ln <= toLine; ln++) {
            const d = digests[ln];
            if (!d.isList && !d.isQuote) continue;
            const prefix = d.isQuote ? HANG_QUOTE_W : HANG_MARK_W;
            const depth = Math.round(d.indentW / HANG_STEP);
            hangByLine.set(ln, {pad: 6 + depth * HANG_STEP + prefix, indent: -prefix});
        }
        {
            let owner: {pad: number; base: number} | null = null;
            for (let ln = fromLine; ln <= toLine; ln++) {
                const d = digests[ln];
                if (d.isList) {
                    const h = hangByLine.get(ln);
                    if (h) owner = {pad: h.pad, base: d.indentW};
                    continue;
                }
                if (!owner || d.isBlank) continue;
                if (d.indentW <= owner.base) { owner = null; continue; }
                if (d.isBoxLine) continue;
                hangByLine.set(ln, {pad: owner.pad, indent: 0});
            }
        }
    }

    // 引导线(列表块)
    if (block.kind === "list") {
        const guideSkipLines = new Set<number>();
        for (const info of block.fences) {
            const f = doc.lineAt(info.from).number;
            const t = doc.lineAt(Math.max(info.from, info.to - 1)).number;
            for (let k = f; k <= t; k++) guideSkipLines.add(k);
        }
        for (let ln = fromLine; ln <= toLine; ln++) {
            if (!digests[ln].isList) continue;
            const w = digests[ln].indentW;
            let end = ln;
            for (let j = ln + 1; j <= toLine; j++) {
                const d = digests[j];
                if (d.isBlank || d.indentW > w) { end = j; continue; }
                break;
            }
            if (end <= ln) continue;
            const depth = Math.round(w / HANG_STEP);
            const isTask = digests[ln].isTask;
            const x = 6 + depth * HANG_STEP + (isTask ? 5.5 : 1.65);
            let adjacentToChild = false;
            for (let k = ln + 1; k <= end; k++) {
                if (!digests[k].isList) continue;
                const childLeft = 6 + Math.round(digests[k].indentW / HANG_STEP) * HANG_STEP;
                if (childLeft - x < 4) { adjacentToChild = true; break; }
            }
            if (adjacentToChild) continue;
            let firstDrawn = -1;
            let lastDrawn = -1;
            for (let k = ln + 1; k <= end; k++) {
                if (digests[k].isBlank) continue;
                if (guideSkipLines.has(k) || digests[k].isQuote || /^\s*(?:\||\$)/.test(doc.line(k).text)) continue;
                if (firstDrawn < 0) firstDrawn = k;
                lastDrawn = k;
            }
            if (firstDrawn < 0 || firstDrawn === lastDrawn) continue;
            for (let k = ln + 1; k <= end; k++) {
                if (digests[k].isBlank) continue;
                if (guideSkipLines.has(k) || digests[k].isQuote || /^\s*(?:\||\$)/.test(doc.line(k).text)) continue;
                const arr = guideStops.get(k) || [];
                arr.push({x, first: k === firstDrawn, last: k === lastDrawn});
                guideStops.set(k, arr);
            }
        }
    }

    // 引述竖线(引述块)
    if (block.kind === "quote") {
        for (let ln = fromLine; ln <= toLine; ln++) {
            const d0 = digests[ln];
            if (!d0.isQuote) continue;
            if (overlapsUsed(d0.from, d0.to)) continue;
            let end = ln;
            while (end + 1 <= toLine) {
                const dn = digests[end + 1];
                if (!dn.isQuote || dn.quoteIndent !== d0.quoteIndent) break;
                end++;
            }
            const qDepth = Math.round(d0.indentW / HANG_STEP);
            const bar = 6 + qDepth * HANG_STEP + 6.3;
            const callout = RE_QUOTE_CALLOUT_LINE.test(doc.line(ln).text);
            for (let k = ln; k <= end; k++) {
                quoteLines.add(k);
                quoteBarByLine.set(k, bar);
                if (callout) quoteCalloutLines.add(k);
            }
            ln = end;
        }
    }

    // 0) 属性面板(光标在 from 之后、to 之前 → 源码态;块首光标仍渲染)
    if (block.kind === "props") {
        if (cursor > block.from && cursor <= block.to) {
            for (let k = 1; k <= toLine; k++) lineDecos.push(propSrcLineDeco.range(doc.line(k).from));
        } else {
            const propLines: string[] = [];
            for (let k = 2; k < toLine; k++) propLines.push(doc.line(k).text);
            const deco = Decoration.replace({widget: new PropertiesWidget(propLines), block: true});
            ranges.push(deco.range(block.from, block.to));
        }
    }

    // 1) 围栏代码卡片(围栏块 / 列表块内部围栏)
    if (block.kind === "fence" || block.kind === "list") {
        for (const info of block.fences) {
            if (!isCodeBlockMonacoEnabled()) continue;
            const editing = !readOnly && getEditingKey() === String(info.from);
            if (!editing && cursorInBlock(info.from, info.to)) continue;
            const fenceLine = doc.lineAt(info.from);
            const prefix = fenceLine.text.slice(0, info.from - fenceLine.from);
            const hasMarker = /^\s*(?:[-*+]|\d+[.)])\s*$/.test(prefix);
            const swallowLine = /^\s*(?:[-*+]|\d+[.)])?\s*$/.test(prefix);
            const indent = listBlockIndent(doc, fenceLine.number, hasMarker, (ln) => hangByLine.get(ln)?.pad ?? 0, indentWidth);
            const span = topListBoxSpan(state, info.from);
            let listBoxCls = "";
            if (span) {
                const f1 = fenceLine.number;
                const f2 = doc.lineAt(Math.max(info.from, info.to - 1)).number;
                if (f1 <= span.toLine && f2 >= span.fromLine) {
                    listBoxCls = "syfe-cm-list-box-extend";
                    if (f1 <= span.fromLine) listBoxCls += " is-box-first";
                    if (f2 >= span.toLine) listBoxCls += " is-box-last";
                }
            }
            const from = swallowLine ? fenceLine.from : info.from;
            const markerLeft = hasMarker ? indent - 9.3 : -1;
            const gutterNums: number[] = [];
            if (swallowLine) {
                const f2 = doc.lineAt(Math.max(info.from, info.to - 1)).number;
                for (let k = fenceLine.number; k <= f2; k++) gutterNums.push(k);
            }
            usedRanges.push({from, to: info.to});
            const widget = new CodeBlockWidget(info.lang, info.codeView, String(info.from), indent, listBoxCls, markerLeft, gutterNums);
            const replace = Decoration.replace({widget, block: true});
            ranges.push(replace.range(from, info.to));
        }
    }

    // 2) $$ 公式对(顶层公式块)
    if (block.kind === "math") {
        const i = block.fromLine;
        const j = block.toLine;
        const from = doc.line(i).from;
        const to = doc.line(j).to;
        usedRanges.push({from, to});
        if (cursorInBlock(from, to)) {
            for (let ln = i; ln <= j; ln++) lineDecos.push(mathSrcLineDeco.range(doc.line(ln).from));
        } else {
            const bodyLines: string[] = [];
            for (let k = i + 1; k < j; k++) bodyLines.push(doc.line(k).text);
            const body = splitMathBlockBody(bodyLines);
            const widget = new MathWidget(body.tex, body.notes, (window as any).__syfeKatex || null);
            const replace = Decoration.replace({widget});
            ranges.push(replace.range(from, to));
        }
    }

    // 3) 表格(顶层表格块)
    if (block.kind === "table") {
        const from = block.from;
        const to = block.to;
        const tableLines: string[] = [];
        for (let k = fromLine; k <= toLine; k++) tableLines.push(doc.line(k).text);
        const indent = listBlockIndent(doc, fromLine, false, (l) => hangByLine.get(l)?.pad ?? 0, indentWidth);
        const span = topListBoxSpan(state, from);
        let listBoxCls = "";
        if (span) {
            const endLn = toLine;
            if (fromLine <= span.toLine && endLn >= span.fromLine) {
                listBoxCls = "syfe-cm-list-box-extend";
                if (fromLine <= span.fromLine) listBoxCls += " is-box-first";
                if (endLn >= span.toLine) listBoxCls += " is-box-last";
            }
        }
        const gutterNums: number[] = [];
        for (let k = fromLine; k <= toLine; k++) gutterNums.push(k);
        const decoReplace = Decoration.replace({widget: new TableWidget(tableLines, indent, listBoxCls, gutterNums), block: true});
        ranges.push(decoReplace.range(from, to));
    }

    // 2.6/2.7) 单行显示公式与 \( \[ 块(段落/标题/列表/引述块内的行)
    if (block.kind === "para" || block.kind === "heading" || block.kind === "list" || block.kind === "quote") {
        for (let ln = fromLine; ln <= toLine; ln++) {
            const line = doc.line(ln);
            if (overlapsUsed(line.from, line.to)) continue;
            const sm = /^\s*\$\$(.+)\$\$\s*$/.exec(line.text);
            if (sm) {
                const from = line.from;
                const to = line.to;
                usedRanges.push({from, to});
                if (cursorInBlock(from, to)) {
                    lineDecos.push(mathSrcLineDeco.range(from));
                } else {
                    const widget = new MathWidget(sm[1].trim(), [], (window as any).__syfeKatex || null);
                    ranges.push(Decoration.replace({widget}).range(from, to));
                }
                continue;
            }
            if (digests[ln].isList || digests[ln].isQuote) continue;
            const t = line.text;
            let openPos = -1;
            let kind = "";
            for (const [open, closerOf, display] of [["\\(", "\\)", false], ["\\[", "\\]", true]] as const) {
                let at = 0;
                while ((at = t.indexOf(open, at)) >= 0) {
                    if (t[at - 1] !== "\\") break;
                    at += open.length;
                }
                if (at < 0) continue;
                if (!display && findMathClose(t, at + open.length, closerOf)) continue;
                if (openPos < 0 || at < openPos) { openPos = at; kind = open; }
            }
            if (openPos < 0) continue;
            const closer = kind === "\\(" ? "\\)" : "\\]";
            let endLine = -1;
            let closeEnd = -1;
            for (let j = ln; j <= toLine; j++) {
                const tj = doc.line(j).text;
                let at = j === ln ? openPos + kind.length : 0;
                while ((at = tj.indexOf(closer, at)) >= 0) {
                    if (tj[at - 1] !== "\\") break;
                    at += closer.length;
                }
                if (at >= 0) { endLine = j; closeEnd = at + closer.length; break; }
            }
            if (endLine < 0) continue;
            const firstText = doc.line(ln).text;
            const lastText = doc.line(endLine).text;
            const segs: string[] = [];
            if (endLine === ln) {
                segs.push(firstText.slice(openPos + kind.length, closeEnd - closer.length));
            } else {
                segs.push(firstText.slice(openPos + kind.length));
                for (let k = ln + 1; k < endLine; k++) segs.push(doc.line(k).text);
                segs.push(lastText.slice(0, closeEnd - closer.length));
            }
            const tex = segs.join("\n").trim();
            if (!tex) continue;
            const from = line.from;
            const to = doc.line(endLine).to;
            usedRanges.push({from, to});
            if (cursorInBlock(from, to)) {
                for (let k = ln; k <= endLine; k++) lineDecos.push(mathSrcLineDeco.range(doc.line(k).from));
            } else {
                const widget = new MathWidget(tex, [], (window as any).__syfeKatex || null,
                    firstText.slice(0, openPos).trim(), lastText.slice(closeEnd).trim());
                ranges.push(Decoration.replace({widget}).range(from, to));
            }
            ln = endLine;
        }
    }

    // 4) 行内图片 + 5) 行内公式(块内非替换行;光标在该行时保持源码)
    for (let ln = fromLine; ln <= toLine; ln++) {
        const line = doc.line(ln);
        if (overlapsUsed(line.from, line.to)) continue;
        if (cursorOnLine(line.from, line.to)) continue;
        const text = line.text;
        const hits: Array<{from: number; to: number; src: string; alt: string}> = [];
        if (!digests[ln].inFence) {
            for (const m of text.matchAll(RE_IMAGE_INLINE)) {
                hits.push({from: m.index, to: m.index + m[0].length, src: m[2].replace(/^<|>$/g, ""), alt: m[1]});
            }
            for (const m of text.matchAll(RE_IMG_TAG_INLINE)) {
                hits.push({from: m.index, to: m.index + m[0].length, src: m[2] || m[3] || "", alt: ""});
            }
        }
        hits.sort((a, b) => a.from - b.from);
        for (const hit of hits) {
            if (!hit.src) continue;
            const from = line.from + hit.from;
            const to = line.from + hit.to;
            if (overlapsUsed(from, to)) continue;
            ranges.push(Decoration.replace({
                widget: new ImageWidget(hit.src, hit.alt, opts),
            }).range(from, to));
        }
        if (text.indexOf("$") < 0 && text.indexOf("\\(") < 0) continue;
        for (const part of splitCellMath(text)) {
            if (part.math === undefined || part.from === undefined || part.to === undefined) continue;
            const from = line.from + part.from;
            const to = line.from + part.to;
            if (overlapsUsed(from, to)) continue;
            if (cursorInBlock(from, to)) continue;
            ranges.push(Decoration.replace({
                widget: new InlineMathWidget(part.math, part.text),
            }).range(from, to));
        }
    }

    // ===== 行级样式唯一出口 =====
    const QUOTE_GRADIENT =
        "linear-gradient(to right, transparent var(--syfe-quote-bar), " +
        "var(--b3-border-color, rgba(128,128,128,.45)) var(--syfe-quote-bar), " +
        "var(--b3-border-color, rgba(128,128,128,.45)) calc(var(--syfe-quote-bar) + 3px), " +
        "transparent calc(var(--syfe-quote-bar) + 3px))";
    const QUOTE_BOX_GRADIENT =
        "linear-gradient(to right, transparent var(--syfe-quote-bar), " +
        "var(--b3-border-color, rgba(128,128,128,.45)) var(--syfe-quote-bar), " +
        "var(--b3-border-color, rgba(128,128,128,.45)) calc(var(--syfe-quote-bar) + 2px), " +
        "var(--b3-theme-surface, var(--b3-theme-background)) calc(var(--syfe-quote-bar) + 2px))";
    const lineStyleFor = (k: number): string => {
        const decls: string[] = [];
        const images: string[] = [];
        const sizes: string[] = [];
        const positions: string[] = [];
        const hang = hangByLine.get(k);
        if (hang) {
            decls.push(`padding-left:${hang.pad.toFixed(1)}px`);
            decls.push(`text-indent:${hang.indent.toFixed(1)}px`);
        }
        const bar = quoteBarByLine.get(k);
        if (bar !== undefined) {
            decls.push(`--syfe-quote-bar:${bar}px`);
            decls.push(`padding-left:calc(var(--syfe-quote-bar) + 7px)`);
            decls.push(`--syfe-quote-math-pull:7px`);
            images.push(quoteCalloutLines.has(k) ? QUOTE_GRADIENT : QUOTE_BOX_GRADIENT);
            sizes.push("100% 100%");
            positions.push("0 0");
        }
        for (const g of guideStops.get(k) || []) {
            const top = g.first ? GUIDE_GAP : 0;
            const bottom = g.last ? GUIDE_GAP : 0;
            images.push(`linear-gradient(${GUIDE_COLOR}, ${GUIDE_COLOR})`);
            sizes.push(`${GUIDE_WIDTH}px calc(100% - ${top + bottom}px)`);
            positions.push(`${g.x}px ${top}px`);
        }
        if (images.length > 0) {
            decls.push(`background-image:${images.join(",")}`);
            decls.push(`background-size:${sizes.join(",")}`);
            decls.push(`background-position:${positions.join(",")}`);
            decls.push("background-repeat:no-repeat");
        }
        return decls.join(";");
    };
    for (const k of quoteLines) {
        lineDecos.push(Decoration.line({
            class: "syfe-cm-quote-line",
            attributes: {style: lineStyleFor(k)},
        }).range(doc.line(k).from));
    }
    for (const k of guideStops.keys()) {
        if (quoteLines.has(k)) continue;
        lineDecos.push(Decoration.line({
            class: "syfe-cm-listguide",
            attributes: {style: lineStyleFor(k)},
        }).range(doc.line(k).from));
    }
    for (let ln = fromLine; ln <= toLine; ln++) {
        if (quoteLines.has(ln) || guideStops.has(ln)) continue;
        if (!hangByLine.has(ln)) continue;
        lineDecos.push(Decoration.line({
            attributes: {style: lineStyleFor(ln)},
        }).range(doc.line(ln).from));
    }

    return {ranges, lineDecos};
}

const blockDecoCache = new WeakMap<Text, Map<number, BlockDecorations>>();

/** 单个装饰 range 的位移映射(@codemirror/state 6.7 的 Range 没有 .map,
 *  用 Decoration 自带的 startSide/endSide 作 assoc 走 changes.mapPos,
 *  与 RangeSet.map 内部逐 range 的映射一致) */
function mapDecoRange(r: Range<Decoration>, changes: ChangeDesc): Range<Decoration> {
    const d = r.value as Decoration;
    // mapPos 的第三参数是 MapMode(枚举),不是布尔值;只需传 assoc 即可
    return d.range(changes.mapPos(r.from, d.startSide), changes.mapPos(r.to, d.endSide));
}

function buildDecorations(state: EditorState, opts: Cm6RenderOptions, tr?: Transaction): DecorationSet {
    const doc = state.doc;
    // 选区位置必须钳到当前文档:内嵌编辑器写回会让宿主文档一次性缩短,
    // 此时若直接 lineAt(selection.head) 会抛 "Invalid position N in document
    // of length M",整笔写回连同装饰重建一起被 CM6 吞掉(实测代码块内 Enter)。
    const cursor = state.readOnly ? 0 : Math.max(0, Math.min(state.selection.main.head, doc.length));
    const cursorLine = cursor > 0 ? doc.lineAt(cursor).number : 0;
    const blocks = docBlocksOf(state);
    const digests = lineDigestsOf(state);
    const oldMap = tr ? blockDecoCache.get(tr.startState.doc) : undefined;
    const newMap = new Map<number, BlockDecorations>();
    const allRanges: Range<Decoration>[] = [];
    const allLineDecos: Range<Decoration>[] = [];
    const docChanged = tr ? tr.docChanged : false;
    const consumedOld = new Set<number>();
    for (const block of blocks) {
        const content = state.sliceDoc(block.from, block.to);
        // 光标是否在本块行范围内(缓存复用条件:光标进出会翻转渲染态)
        const near = cursor >= block.from && cursor <= block.to;
        let entry: BlockDecorations | undefined;
        if (oldMap) {
            const oldPos = docChanged ? tr!.changes.mapPos(block.from, -1) : block.from;
            const oldLine = tr!.startState.doc.lineAt(oldPos).number;
            if (!consumedOld.has(oldLine)) {
                const cand = oldMap.get(oldLine);
                if (cand && cand.content === content && cand.near === near) {
                    consumedOld.add(oldLine);
                    entry = docChanged
                        ? {
                            fromLine: block.fromLine,
                            content: cand.content,
                            near: cand.near,
                            ranges: cand.ranges.map(r => mapDecoRange(r, tr!.changes)),
                            lineDecos: cand.lineDecos.map(r => mapDecoRange(r, tr!.changes)),
                        }
                        : cand;
                }
            }
        }
        if (!entry) {
            const built = buildBlockDeco(state, block, digests, cursor, opts);
            entry = {fromLine: block.fromLine, content, near, ranges: built.ranges, lineDecos: built.lineDecos};
        }
        newMap.set(block.fromLine, entry);
        allRanges.push(...entry.ranges);
        allLineDecos.push(...entry.lineDecos);
    }
    blockDecoCache.set(doc, newMap);
    return Decoration.set([...allRanges, ...allLineDecos], true);
}

/** 预加载 KaTeX(公式首次渲染前调用;结果挂 window.__syfeKatex 供 widget 同步取用) */
export function preloadCm6Katex(): void {
    void loadKatex().then(k => {
        (window as any).__syfeKatex = k || null;
        // 就绪后统一重建装饰:TableWidget.eq 带 katexReady,首屏显示过源码占位
        // 的表格会真的换 DOM,单元格公式随即同步渲染(公式块 MathWidget 自带兜底)。
        for (const view of [...activeRenderViews]) {
            if (!view.dom.isConnected) {
                activeRenderViews.delete(view);
                continue;
            }
            view.dispatch({effects: forceRenderEffect.of(null)});
        }
    });
}
