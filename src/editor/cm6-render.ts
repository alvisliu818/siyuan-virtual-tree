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
//  - 公式:$$...$$ 块用 KaTeX 渲染(资源来自 vditor 自带的 katex,懒加载),
//    光标在块内时还原源码;$...$ 行内公式不做(编辑体验容易翻车)
//  - 表格:GFM 表格块替换为真实 <table>,光标进入块内时还原源码编辑
//
// 实现要点:一个 StateField 统一计算 Decoration 集(doc/selection 变化全量重建)。
// 必须用 StateField 而非 ViewPlugin —— CM6 不允许 ViewPlugin 提供块级 replace
// 装饰("Block decorations may not be specified via plugins")。
// 块级替换配合 atomicRanges 让光标不落在渲染物中间;
// 光标进入块内即回源码,这是 Obsidian 同款的编辑模型。
// 全局主题切换(Monaco 扩展主题)经 onCodeThemeChanged → StateEffect 强制重建。
import {EditorState, Extension, Range, StateEffect, StateField} from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import {resolveFenceLanguageId} from "../extensions/grammar-loader";
import {getBoolSetting, registerSettingsChangedHandler} from "../settings/user-settings";
import {
    colorizeCached,
    flushActiveBlock,
    getActiveBlockValue,
    getEditingKey,
    getMonacoThemeName,
    getMountedBlockKey,
    getMountedContainer,
    getMountedLanguage,
    mountBlockEditor,
    onMonacoThemeChanged,
    remountBlockEditor,
    setEditingKey,
    unmountBlockEditor,
} from "./monaco-block";

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
// 左缘、始终可见)+ 代码格(pre,跟随横向滚动)。宽度按最大行号的位数用 ch
// 定宽,等宽字体下各行的代码起始 x 严格对齐。
function buildNumberedLines(html: string): string {
    // colorize 以 <br> 分行;colorize 失败的兜底是 \n 分行的转义文本,一并支持
    const lines = html.split(/<br\s*\/?>|\n/);
    const widthCh = String(Math.max(lines.length, 1)).length + 1;
    const rows: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        rows.push(
            '<div class="syfe-cm-cl">' +
            '<span class="syfe-cm-cl-n" style="width:' + widthCh + 'ch">' + (i + 1) + '</span>' +
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

    constructor(readonly lang: string, readonly code: string, readonly key: string) {
        super();
    }

    eq(other: CodeBlockWidget): boolean {
        // 编辑中内容变化不重建(Monaco 自持最新内容);渲染态主题变了要重建重取色。
        // ⚠ 非编辑态必须比较 code:外部内容变更(setValue/撤销/粘贴)同偏移时
        //   若只比 key/lang,eq 会误判相等 → 卡片滞留旧内容(实测:整卡变成
        //   已被替换的旧代码)。编辑态跳过 code 比较,避免每次击键重建卡片
        //   打断 Monaco 挂载。
        if (other.key !== this.key || other.lang !== this.lang || other.editingFlag !== this.editingFlag) return false;
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
        lang.title = "点击显示/隐藏围栏";
        lang.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleFenceReveal(view, this.key);
        };
        head.appendChild(lang);
        const btn = document.createElement("button");
        btn.className = "syfe-cm-codeblock-copy";
        btn.title = "复制代码";
        btn.innerHTML = COPY_ICON_SVG;
        // 抢在 CM/点击进源码之前消费头部事件:点复制不动光标、不触发移动端键盘
        btn.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
        };
        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            // 编辑中的卡片复制最新内容(挂载中取 Monaco 实时值,否则取快照)
            void copyTextCompat(getActiveBlockValue() ?? this.code)
                .then(() => this.markCopied(btn))
                .catch(() => undefined);
        };
        head.appendChild(btn);
        return head;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-codeblock";
        wrap.dataset.blockKey = this.key;
        wrap.setAttribute("contenteditable", "false");
        wrap.appendChild(this.buildHead(view));
        const body = document.createElement("div");
        body.className = "syfe-cm-codeblock-body";
        wrap.appendChild(body);
        // 渲染正文:Monaco colorize(异步,先纯文本占位)。编辑态由 CSS 隐藏此层。
        // colorize 结果重建为带行号的逐行结构(行号列 sticky,随卡片横向滚动
        // 保持可见 —— 见 buildNumberedLines)
        const colorizeDiv = document.createElement("div");
        colorizeDiv.className = "syfe-cm-codeblock-colorize";
        body.appendChild(colorizeDiv);
        colorizeDiv.textContent = this.code;
        void colorizeCached(this.lang, this.code).then(html => {
            if (!colorizeDiv.isConnected) return;
            colorizeDiv.innerHTML = buildNumberedLines(html);
            view.requestMeasure();
        });
        // 编辑态宿主:点击卡片后由 editMounter 把全局单例 Monaco 安置进来
        const host = document.createElement("div");
        host.className = "syfe-cm-codeblock-editorhost";
        body.appendChild(host);
        if (this.editingFlag) body.classList.add("is-editing");
        return wrap;
    }

    destroy(): void {
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

    toDOM(): HTMLElement {
        const wrap = document.createElement("span");
        wrap.className = "syfe-cm-img";
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

    ignoreEvent(): boolean {
        return false;
    }
}

/** 公式块:KaTeX display 渲染;失败回退为等宽样式并给出错误提示 */
const mathWidgetObservers = new WeakMap<HTMLElement, ResizeObserver>();

class MathWidget extends WidgetType {
    constructor(readonly tex: string, readonly katex: any) {
        super();
    }

    eq(other: MathWidget): boolean {
        return other.tex === this.tex;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-math";
        // KaTeX 异步渲染完成会改变块高,主动通知 CM 重新测量(ProseMark 同款;
        // 否则长公式首屏可能出现滚动/光标定位偏差)
        let ro: ResizeObserver | undefined;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => view.requestMeasure());
            ro.observe(wrap);
            mathWidgetObservers.set(wrap, ro);
        }
        const requestRelayout = () => view.requestMeasure();
        const tryRender = (katex: any) => {
            try {
                const holder = document.createElement("div");
                katex.render(this.tex, holder, {displayMode: true, throwOnError: false});
                wrap.textContent = "";
                wrap.appendChild(holder);
                wrap.classList.remove("is-error");
                wrap.classList.add("is-rendered");
                requestRelayout();
                return true;
            } catch (err) {
                wrap.textContent = this.tex;
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
            wrap.textContent = this.tex;
            wrap.classList.add("is-error");
            loadKatex().then(k => {
                if (k && wrap.isConnected) tryRender(k);
            });
        }
        return wrap;
    }

    destroy(dom: HTMLElement): void {
        mathWidgetObservers.get(dom)?.disconnect();
        mathWidgetObservers.delete(dom);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** GFM 表格:块级替换为真实 <table>;点击表格把光标送回源码块 */
class TableWidget extends WidgetType {
    constructor(readonly lines: string[]) {
        super();
    }

    eq(other: TableWidget): boolean {
        return other.lines.join("\n") === this.lines.join("\n");
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-table";
        wrap.appendChild(renderGfmTable(this.lines));
        return wrap;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/** 极简行内格式(粗/斜/行内码),先转义再替换,防 XSS */
function formatInlineCell(text: string): string {
    const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return escaped
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
}

function renderGfmTable(lines: string[]): HTMLElement {
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
        th.innerHTML = formatInlineCell(cell);
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
            td.innerHTML = formatInlineCell(cells[i] || "");
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

// ===== 结构识别 =====

const RE_IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)\s*$/;
const RE_IMG_TAG_LINE = /^\s*<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>\s*$/i;
const RE_TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;
const RE_TABLE_SEP = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** 围栏代码块信息(借 lang-markdown 的语法树,FencedCode 节点) */
interface FencedCodeInfo {
    from: number;
    to: number;
    /** CodeInfo 节点文本(``` 后的语言名) */
    lang: string;
    /** 围栏之间的代码内容(复制按钮用) */
    code: string;
}

function fencedCodeInfos(state: EditorState): FencedCodeInfo[] {
    const doc = state.doc;
    const out: FencedCodeInfo[] = [];
    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name !== "FencedCode") return;
            const infoNode = node.node.getChild("CodeInfo");
            const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : "";
            const first = doc.lineAt(node.from);
            const last = doc.lineAt(Math.max(node.from, node.to - 1));
            // 最后一行是闭合围栏(``` / ~~~)时,代码内容 = 首尾围栏行之间
            const lastIsFence = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
            const contentFrom = first.to + 1;
            const contentTo = lastIsFence ? doc.line(last.number - 1).to : last.to;
            const code = contentTo >= contentFrom ? doc.sliceString(contentFrom, contentTo) : "";
            out.push({from: node.from, to: node.to, lang, code});
        },
    });
    return out;
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
let activeSync: {key: string; lastValue: string} | null = null;

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

export function cm6MarkdownRender(opts: Cm6RenderOptions): Extension {
    const renderField = StateField.define<DecorationSet>({
        create: (st) => buildDecorations(st, opts),
        update: (value, tr) => {
            if (tr.effects.some(e => e.is(forceRenderEffect))) {
                return buildDecorations(tr.state, opts);
            }
            // doc/selection 变化重建;语法树异步解析完成(树实例变化)也重建,
            // 否则大文档首次渲染时 FencedCode 装饰会缺失(PurrMD 同款坑)
            if (!tr.docChanged && !tr.selection && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
                return value;
            }
            return buildDecorations(tr.state, opts);
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
                const target = event.target as HTMLElement;
                // 复制按钮是独立交互区
                if (target.closest(".syfe-cm-codeblock-copy")) return false;
                const wrap = target.closest(".syfe-cm-codeblock, .syfe-cm-table, .syfe-cm-math") as HTMLElement | null;
                if (!wrap) return false;
                if (wrap.classList.contains("syfe-cm-codeblock")) {
                    // 代码块:声明进入编辑态,由 editMounter 在重建后的真实视图 DOM 上
                    // 安置单例(不能在此处直接挂载 —— 本 wrap 可能即将被重建/克隆替换)
                    const key = wrap.dataset.blockKey ?? null;
                    if (key !== null && getEditingKey() !== key) {
                        const info = fencedCodeInfos(view.state).find(i => i.from === parseInt(key, 10));
                        if (info) {
                            activeSync = {key, lastValue: info.code};
                            setEditingKey(key);
                            view.dispatch({effects: forceRenderEffect.of(null)});
                        }
                    }
                    return true;   // 已挂载:事件交给 Monaco 自行处理
                }
                const pos = view.posAtDOM(wrap);
                const line = view.state.doc.lineAt(pos);
                view.dispatch({selection: {anchor: Math.min(line.from + 1, line.to)}});
                view.focus();
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
        }
        destroy() {
            activeRenderViews.delete(this.view);
            this.off.dispose();
        }
    });

    // Monaco 内容变更 → 单事务写回 cm6 文档(定位:块首围栏行尾 + 上次同步长度)
    const syncFromMonaco = (view: EditorView) => (v: string) => {
        if (!activeSync) return;
        const nv = v.replace(/\r\n/g, "\n");
        const from = parseInt(activeSync.key, 10);
        if (Number.isNaN(from) || from >= view.state.doc.length) return;
        const firstLine = view.state.doc.lineAt(from);
        const innerFrom = firstLine.to + 1;
        const innerTo = Math.min(innerFrom + activeSync.lastValue.length, view.state.doc.length);
        activeSync.lastValue = nv;
        view.dispatch({changes: {from: innerFrom, to: innerTo, insert: nv}});
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
            if (!getEditingKey()) return;
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
                        language: getMountedLanguage(),
                        value: activeSync?.lastValue ?? "",
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
                language: resolveFenceLanguageId(langLabel),
                value: activeSync?.lastValue ?? "",
                onContentChange: syncFromMonaco(this.view),
                onExit: exitEditing(this.view),
            });
        }
    });

    ensureSettingsFanout();
    return [renderField, clickHandler, themeSync, editMounter];
}

function buildDecorations(state: EditorState, opts: Cm6RenderOptions): DecorationSet {
    {
            const view = {state} as EditorView;
            // 全部装饰先收集再 Decoration.set(自动按位置排序,避免 RangeSetBuilder 的乱序抛错)
            const ranges: Array<Range<Decoration>> = [];
            const atomicRanges: Array<Range<Decoration>> = [];
            const cursor = view.state.selection.main.head;
            const doc = view.state.doc;
            const lineDecos: Array<Range<Decoration>> = [];
            const usedRanges: Array<{from: number; to: number}> = [];

            const overlapsUsed = (from: number, to: number) => usedRanges.some(r => from < r.to && to > r.from);
            const cursorInRange = (from: number, to: number) => cursor >= from && cursor <= to;

            // 1) 围栏代码块:三种形态 ——
            //    a. 光标在块外            → 卡片(colorize 正文)
            //    b. editingKey 命中(点卡片) → 卡片 + 全局单例 Monaco(monaco-block.ts)
            //    c. 光标在块内未挂 Monaco   → 原始围栏(源码态;点语言标签/方向键进块,
            //       Obsidian 同款「点语言看源码」),不加替换装饰、不占 usedRanges
            //    开关 markdown.cm6CodeBlockMonaco 关闭 → 整体回落源码行(无卡片),
            //    数学/表格/图片等非 Monaco 渲染不受影响
            for (const info of fencedCodeInfos(state)) {
                if (!isCodeBlockMonacoEnabled()) continue;
                const editing = getEditingKey() === String(info.from);
                if (!editing && cursorInRange(info.from, info.to)) continue;
                usedRanges.push({from: info.from, to: info.to});
                const widget = new CodeBlockWidget(info.lang, info.code, String(info.from));
                const replace = Decoration.replace({widget, block: true});
                ranges.push(replace.range(info.from, info.to));
                atomicRanges.push(replace.range(info.from, info.to));
            }

            // 2) 数学块 $$...$$(光标在块内时只加底色,便于编辑)
            {
                const lines = doc.lines;
                let i = 1;
                while (i <= lines) {
                    const line = doc.line(i);
                    if (!/^\s*\$\$\s*$/.test(line.text)) { i++; continue; }
                    let j = i + 1;
                    while (j <= lines && !/^\s*\$\$\s*$/.test(doc.line(j).text)) j++;
                    if (j > lines) { i++; continue; }
                    const from = line.from;
                    const to = doc.line(j).to;
                    if (overlapsUsed(from, to)) { i = j + 1; continue; }
                    usedRanges.push({from, to});
                    if (cursorInRange(from, to)) {
                        for (let ln = i; ln <= j; ln++) {
                            lineDecos.push(mathSrcLineDeco.range(doc.line(ln).from));
                        }
                    } else {
                        const texInner = j - 1 > i ? doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to).trim() : "";
                        const widget = new MathWidget(texInner, (window as any).__syfeKatex || null);
                        const replace = Decoration.replace({widget, block: true});
                        ranges.push(replace.range(from, to));
                        atomicRanges.push(replace.range(from, to));
                    }
                    i = j + 1;
                }
            }

            // 3) 独立图片行
            for (let ln = 1; ln <= doc.lines; ln++) {
                const line = doc.line(ln);
                if (overlapsUsed(line.from, line.to)) continue;
                let src = "";
                let alt = "";
                const m = line.text.match(RE_IMAGE_LINE);
                if (m) {
                    alt = m[1];
                    src = m[2].replace(/^<|>$/g, "");
                } else {
                    const tag = line.text.match(RE_IMG_TAG_LINE);
                    if (tag) {
                        src = tag[2] || tag[3] || "";
                        alt = "";
                    }
                }
                if (!src) continue;
                if (cursorInRange(line.from, line.to)) continue;
                usedRanges.push({from: line.from, to: line.to});
                ranges.push(Decoration.replace({
                    widget: new ImageWidget(src, alt, opts),
                }).range(line.from, line.to));
            }

            // 4) GFM 表格(≥2 行:表头 + 分隔行;光标在块内时只加底色)
            for (let ln = 1; ln <= doc.lines; ln++) {
                const line = doc.line(ln);
                if (overlapsUsed(line.from, line.to)) continue;
                if (!RE_TABLE_ROW.test(line.text)) continue;
                // 分隔行必须是下一行
                const next = doc.line(Math.min(ln + 1, doc.lines));
                if (!RE_TABLE_SEP.test(next.text)) continue;
                // 向上收表头以上(表格只有表头+分隔+数据;表头就是当前行)
                let end = ln + 1;
                while (end + 1 <= doc.lines && RE_TABLE_ROW.test(doc.line(end + 1).text)) end++;
                const from = line.from;
                const to = doc.line(end).to;
                if (overlapsUsed(from, to)) continue;
                usedRanges.push({from, to});
                const tableLines: string[] = [];
                for (let k = ln; k <= end; k++) tableLines.push(doc.line(k).text);
                if (cursorInRange(from, to)) {
                    for (let k = ln; k <= end; k++) {
                        lineDecos.push(tableSrcLineDeco.range(doc.line(k).from));
                    }
                } else {
                    const decoReplace = Decoration.replace({widget: new TableWidget(tableLines), block: true});
                    ranges.push(decoReplace.range(from, to));
                    atomicRanges.push(decoReplace.range(from, to));
                }
                ln = end;
            }

            return Decoration.set([...ranges, ...lineDecos], true);
    }
}

/** 预加载 KaTeX(公式首次渲染前调用;结果挂 window.__syfeKatex 供 widget 同步取用) */
export function preloadCm6Katex(): void {
    void loadKatex().then(k => {
        (window as any).__syfeKatex = k;
    });
}
