// CM6 Markdown 富渲染扩展:在源码态编辑器里做「轻 live」渲染。
//
// 范围(与 cm6-markdown.ts 的语法高亮互补):
//  - 围栏代码块:光标在块外时整块替换为「代码卡片」(头部语言标签/复制按钮 +
//    TextMate 高亮正文,复用 Monaco 代码文件那套 vscode-textmate 语法 + VS Code
//    主题 tokenColors,见 tm-highlight.ts);光标进入块内回源码行底色态,
//    并按 token 打 mark decoration 内联着色(与卡片同一套语法/主题;
//    语法未就绪时先无色,grammarSync 插件就绪后补色)
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
// 代码主题切换(Monaco 扩展主题)经 onCodeThemeChanged → StateEffect 强制重建。
import {EditorState, Extension, Range, StateEffect, StateField} from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import {getCachedTmHighlight, getCachedTmTokens, tmHighlightToHtml, tmThemeSignature, tmTokenize, tmTokenizeSync} from "./tm-highlight";
import {onCodeThemeChanged} from "../extensions/theme-loader";

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

/**
 * 围栏代码块整块渲染卡片(光标在块外时):头部(语言标签 + 复制按钮)+
 * TextMate 高亮正文(tm-highlight.ts,与 Monaco 代码文件同一套语法/主题)。
 * 头部是交互区(复制),点击正文区把光标送回源码块(clickHandler)。
 */
class CodeBlockWidget extends WidgetType {
    private copiedTimer: number | undefined;
    // 构建时快照的主题签名:主题切换 → eq 不等 → 重建 DOM 重取色
    readonly themeSig = tmThemeSignature();

    constructor(readonly lang: string, readonly code: string) {
        super();
    }

    eq(other: CodeBlockWidget): boolean {
        return other.lang === this.lang && other.code === this.code && other.themeSig === this.themeSig;
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

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-codeblock";
        wrap.setAttribute("contenteditable", "false");

        const head = document.createElement("div");
        head.className = "syfe-cm-codeblock-head";
        const lang = document.createElement("span");
        lang.className = "syfe-cm-codeblock-lang";
        lang.textContent = this.lang || "text";
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
            void copyTextCompat(this.code)
                .then(() => this.markCopied(btn))
                .catch(() => undefined);
        };
        head.appendChild(btn);

        const pre = document.createElement("pre");
        pre.className = "syfe-cm-codeblock-body";
        const cached = getCachedTmHighlight(this.lang, this.code);
        if (cached) {
            pre.innerHTML = cached.html;
        } else {
            // 高亮未就绪(语法/wasm 首次加载中):先显示纯文本,就绪后就地替换
            pre.textContent = this.code;
            void tmHighlightToHtml(this.lang, this.code).then(res => {
                if (!res || !pre.isConnected) return;
                pre.innerHTML = res.html;
                view.requestMeasure();
            });
        }

        wrap.appendChild(head);
        wrap.appendChild(pre);
        return wrap;
    }

    destroy(): void {
        if (this.copiedTimer) window.clearTimeout(this.copiedTimer);
        this.copiedTimer = undefined;
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

// ===== 主插件 =====

// 编辑态 TextMate 着色的字符上限:巨型块同步分词会卡键击,超限回退纯文本
const EDIT_MARK_MAX_CHARS = 20000;

// 围栏代码块编辑态(光标在块内)的 token 着色装饰:
// 围栏行之间的整行内容 → Decoration.mark 内联 color(与卡片正文同一套语法/主题)。
// 只吃同步通道(缓存命中或语法已就绪);无色返回空数组,由 grammarSync 异步补。
function editStateTokenMarks(
    info: FencedCodeInfo,
    doc: EditorState["doc"],
    first: number,
    last: number,
): Array<Range<Decoration>> {
    const out: Array<Range<Decoration>> = [];
    if (!info.code || info.code.length > EDIT_MARK_MAX_CHARS) return out;
    const cached = getCachedTmTokens(info.lang, info.code);
    const toks = cached !== undefined ? cached : tmTokenizeSync(info.lang, info.code);
    if (!toks) return out;
    const innerLast = /^\s*(`{3,}|~{3,})\s*$/.test(doc.line(last).text) ? last - 1 : last;
    for (let li = 0; li < toks.lines.length; li++) {
        const ln = first + 1 + li;
        if (ln > innerLast) break;
        const line = doc.line(ln);
        for (const span of toks.lines[li]) {
            if (!span.css || span.end <= span.start) continue;
            const from = Math.min(line.from + span.start, line.to);
            const to = Math.min(line.from + span.end, line.to);
            if (to > from) out.push(Decoration.mark({attributes: {style: span.css}}).range(from, to));
        }
    }
    return out;
}

const codeLineDeco = Decoration.line({class: "syfe-cm-codeblock-line"});
const codeLineFirstDeco = Decoration.line({class: "syfe-cm-codeblock-line syfe-cm-codeblock-first"});
const codeLineLastDeco = Decoration.line({class: "syfe-cm-codeblock-line syfe-cm-codeblock-last"});
const codeLineOnlyDeco = Decoration.line({
    class: "syfe-cm-codeblock-line syfe-cm-codeblock-first syfe-cm-codeblock-last",
});
const tableSrcLineDeco = Decoration.line({class: "syfe-cm-tablesrc-line"});
const mathSrcLineDeco = Decoration.line({class: "syfe-cm-mathsrc-line"});

export function cm6MarkdownRender(opts: Cm6RenderOptions): Extension {
    // 代码主题切换等外部事件 → 强制重建装饰(widget eq 带主题签名,重建才会重渲)
    const forceRenderEffect = StateEffect.define<null>();
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
                // 代码卡片头部是复制按钮交互区,不进入源码
                if (target.closest(".syfe-cm-codeblock-head")) return false;
                const wrap = target.closest(".syfe-cm-codeblock, .syfe-cm-table, .syfe-cm-math") as HTMLElement | null;
                if (!wrap) return false;
                const pos = view.posAtDOM(wrap);
                const line = view.state.doc.lineAt(pos);
                view.dispatch({selection: {anchor: Math.min(line.from + 1, line.to)}});
                view.focus();
                return true;
            },
        },
    });

    // 代码主题切换(Monaco 扩展主题 applyTheme)→ 通知本编辑器重建代码块高亮
    const themeSync = ViewPlugin.fromClass(class {
        private off: () => void = () => undefined;
        constructor(readonly view: EditorView) {
            this.off = onCodeThemeChanged(() => {
                view.dispatch({effects: forceRenderEffect.of(null)});
            });
        }
        destroy() {
            this.off();
        }
    });

    // 编辑态 TextMate 着色的语法异步就绪回调:光标所在块缓存未命中且语法未就绪时
    // 先无色,这里触发加载并在就绪后强制重建一次补上着色
    // (卡片态由 widget 自己异步补,不走这里;null = 不支持,不重试不重建)
    const grammarSync = ViewPlugin.fromClass(class {
        private inflight = new Set<string>();
        constructor(readonly view: EditorView) {}
        update(u: ViewUpdate) {
            if (!u.docChanged && !u.selectionSet) return;
            const cursor = u.state.selection.main.head;
            for (const info of fencedCodeInfos(u.state)) {
                if (!(cursor >= info.from && cursor <= info.to)) continue;
                if (getCachedTmTokens(info.lang, info.code) !== undefined) continue;
                const key = `${info.lang}\u0000${info.code}`;
                if (this.inflight.has(key)) continue;
                this.inflight.add(key);
                void tmTokenize(info.lang, info.code).then(res => {
                    this.inflight.delete(key);
                    if (res) this.view.dispatch({effects: forceRenderEffect.of(null)});
                }).catch(() => this.inflight.delete(key));
            }
        }
    });

    return [renderField, clickHandler, themeSync, grammarSync];
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

            // 1) 围栏代码块:光标在块内 → 行底色源码态(首尾圆角);
            //    光标在块外 → 整块 replace 成代码卡片(围栏隐藏,头部语言/复制 + 高亮正文)
            for (const info of fencedCodeInfos(state)) {
                const first = doc.lineAt(info.from).number;
                const last = doc.lineAt(Math.max(info.from, info.to - 1)).number;
                usedRanges.push({from: info.from, to: info.to});
                if (cursorInRange(info.from, info.to)) {
                    for (let ln = first; ln <= last; ln++) {
                        const deco =
                            ln === first
                                ? (ln === last ? codeLineOnlyDeco : codeLineFirstDeco)
                                : (ln === last ? codeLineLastDeco : codeLineDeco);
                        lineDecos.push(deco.range(doc.line(ln).from));
                    }
                    // 编辑态 TextMate 着色:mark decoration 按 token 上色
                    // (语法未就绪时先无色,grammarSync 在加载完成后 dispatch 补色)
                    for (const m of editStateTokenMarks(info, doc, first, last)) {
                        ranges.push(m);
                    }
                } else {
                    const widget = new CodeBlockWidget(info.lang, info.code);
                    const replace = Decoration.replace({widget, block: true});
                    ranges.push(replace.range(info.from, info.to));
                    atomicRanges.push(replace.range(info.from, info.to));
                }
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
