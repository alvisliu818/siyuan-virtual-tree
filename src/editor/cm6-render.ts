// CM6 Markdown 富渲染扩展:在源码态编辑器里做「轻 live」渲染。
//
// 范围(与 cm6-markdown.ts 的语法高亮互补):
//  - 围栏代码块:整块行底色 + 左侧色条(语言高亮由 lang-markdown 的 codeLanguages 提供)
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
import {EditorState, Extension, Range, StateField} from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";

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

/** 公式块:KaTeX display 渲染;失败回退为等宽样式 */
class MathWidget extends WidgetType {
    constructor(readonly tex: string, readonly katex: any) {
        super();
    }

    eq(other: MathWidget): boolean {
        return other.tex === this.tex;
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-math";
        const tryRender = (katex: any) => {
            try {
                const holder = document.createElement("div");
                katex.render(this.tex, holder, {displayMode: true, throwOnError: false});
                wrap.textContent = "";
                wrap.appendChild(holder);
                wrap.classList.remove("is-error");
                wrap.classList.add("is-rendered");
                return true;
            } catch {
                wrap.textContent = this.tex;
                wrap.classList.add("is-error");
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
const RE_TABLE_SEP = /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** 收集围栏代码块的行区间(借 lang-markdown 的语法树,FencedCode 节点) */
function fencedCodeRanges(state: EditorState): Array<{from: number; to: number}> {
    const out: Array<{from: number; to: number}> = [];
    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name === "FencedCode") {
                out.push({from: node.from, to: node.to});
            }
        },
    });
    return out;
}

// ===== 主插件 =====

const codeLineDeco = Decoration.line({class: "syfe-cm-codeblock-line"});
const tableSrcLineDeco = Decoration.line({class: "syfe-cm-tablesrc-line"});
const mathSrcLineDeco = Decoration.line({class: "syfe-cm-mathsrc-line"});

export function cm6MarkdownRender(opts: Cm6RenderOptions): Extension {
    const renderField = StateField.define<DecorationSet>({
        create: (st) => buildDecorations(st, opts),
        update: (value, tr) => {
            if (!tr.docChanged && !tr.selection) return value;
            return buildDecorations(tr.state, opts);
        },
        provide: (f) => [
            EditorView.decorations.from(f),
            // 块替换区域原子化:光标不会落在渲染物中间(点击进入即回源码)
            EditorView.atomicRanges.from(f),
        ],
    });

    // 点击渲染物(表格/公式)→ 光标送进源码块,视图随即回源码态(编辑模型见文件头)。
    // 事件处理必须放在 ViewPlugin 里(StateField 不接 DOM 事件;block 装饰限制只针对装饰)。
    const clickHandler = ViewPlugin.fromClass(class {
        constructor(readonly view: EditorView) {}
        update() {}
    }, {
        eventHandlers: {
            mousedown(event, view) {
                const target = event.target as HTMLElement;
                const wrap = target.closest(".syfe-cm-table, .syfe-cm-math") as HTMLElement | null;
                if (!wrap) return false;
                const pos = view.posAtDOM(wrap);
                const line = view.state.doc.lineAt(pos);
                view.dispatch({selection: {anchor: Math.min(line.from + 1, line.to)}});
                view.focus();
                return true;
            },
        },
    });

    return [renderField, clickHandler];
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

            // 1) 围栏代码块行底色
            for (const range of fencedCodeRanges(state)) {
                const first = doc.lineAt(range.from).number;
                const last = doc.lineAt(range.to).number;
                for (let ln = first; ln <= last; ln++) {
                    lineDecos.push(codeLineDeco.range(doc.line(ln).from));
                }
                void range;
                usedRanges.push(range);
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
