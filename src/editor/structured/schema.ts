// 结构化内核：ProseMirror schema + NodeView（层级容器模型）。
// list / quote 容器节点；math 块级公式（容器子块）；mathInline 行内公式；image 行内图片。
// 叶子节点名 leaf（避免与 group "block" 同名遮蔽）。KaTeX 异步复用 vditor 资源。
// 移植自隔离原型 tmp/structured-proto/src/schema.js（已四文档保真 + 全量 NodeView 验证）。
import {Schema} from "prosemirror-model";
import {getKatex, lazyRender} from "./katex";
import {CodeBlockView} from "./code-block";

export const schema = new Schema({
    nodes: {
        doc: {content: "block*"},
        leaf: {
            group: "block", content: "inline*",
            attrs: {kind: {}, raw: {default: ""}, prefix: {default: ""}, prefix0: {default: ""}, body0: {default: ""}, heading: {default: 0}},
            toDOM: (n: any) => ["div", {"data-kind": n.attrs.kind, class: "blk blk-" + n.attrs.kind}, 0],
            parseDOM: [{tag: "div[data-kind]", getAttrs: (d: any) => ({kind: d.getAttribute("data-kind"), raw: "", body0: ""})}],
        },
        list: {
            group: "block", content: "block+",
            attrs: {raw: {default: ""}, indent: {default: ""}, pad: {default: 0}},
            toDOM: () => ["div", {class: "lv-list"}, ["div", {class: "lv-items"}, 0]],
            parseDOM: [{tag: "div.lv-list", contentElement: "div.lv-items"}],
        },
        quote: {
            group: "block", content: "block+",
            attrs: {raw: {default: ""}, indent: {default: ""}, slot: {default: false}, pad: {default: 0}},
            toDOM: () => ["blockquote", {class: "lv-quote"}, ["div", {class: "lv-quote-inner"}, 0]],
            parseDOM: [{tag: "blockquote.lv-quote", contentElement: "div.lv-quote-inner"}],
        },
        math: {
            group: "block", atom: true, selectable: true,
            attrs: {tex: {}, tex0: {default: ""}, raw: {default: ""}, prefix: {default: ""},
                delim: {default: "$$"}, display: {default: true}, fence: {default: false},
                open: {default: ""}, close: {default: ""}, innerEol: {default: "\n"}},
            toDOM: (n: any) => ["div", {class: "math-block", "data-math": n.attrs.tex}],
            parseDOM: [{tag: "div.math-block", getAttrs: (d: any) => ({tex: d.getAttribute("data-math") || ""})}],
        },
        mathInline: {
            inline: true, group: "inline", atom: true, selectable: true,
            attrs: {tex: {}, delim: {default: "$"}, display: {default: false}, strong: {default: false}},
            toDOM: (n: any) => ["span", {"data-math": n.attrs.tex}],
            parseDOM: [{tag: "span[data-math]", getAttrs: (d: any) => ({tex: d.getAttribute("data-math"), delim: "$"})}],
        },
        image: {
            inline: true, group: "inline", atom: true, selectable: true,
            attrs: {alt: {default: ""}, src: {default: ""}, strong: {default: false}},
            toDOM: (n: any) => ["span", {"data-image": n.attrs.src, "data-alt": n.attrs.alt}],
            parseDOM: [{tag: "span[data-image]", getAttrs: (d: any) => ({src: d.getAttribute("data-image"), alt: d.getAttribute("data-alt") || ""})}],
        },
        link: {
            inline: true, group: "inline", atom: true, selectable: true,
            attrs: {text: {default: ""}, href: {default: ""}, strong: {default: false}},
            toDOM: (n: any) => ["a", {href: n.attrs.href, class: "syfe-link", rel: "noopener"}, n.attrs.text],
            parseDOM: [{tag: "a.syfe-link", getAttrs: (d: any) => ({href: d.getAttribute("href"), text: d.textContent})}],
        },
        text: {group: "inline"},
    },
    marks: {
        strong: {toDOM: () => ["strong", 0], parseDOM: [{tag: "strong"}]},
        code: {toDOM: () => ["code", 0], parseDOM: [{tag: "code"}]},
    },
} as any);

function indentPx(prefix: string): number {
    const lead = /^(\s*)/.exec(prefix || "")?.[1] || "";
    const tabs = (lead.match(/\t/g) || []).length;
    const spaces = lead.replace(/\t/g, "").length;
    return tabs * 18 + spaces * 4;
}

/** 叶子节点视图：只渲染正文 contentDOM；圆点/竖线由父容器 CSS 画 */
/** 活跃叶子视图注册表:供选区驱动「光标所在块显示源码」两态切换 */
export const leafViews = new Set<LeafView>();

export class LeafView {
    node: any; view: any; getPos: any; dom: HTMLElement; contentDOM: HTMLElement;
    private replaceSource?: (pos: number, src: string) => void;
    private revealing = false;
    private active = false;
    private commitFn?: (save: boolean) => void;
    constructor(node: any, view: any, getPos: any, replaceSource?: (pos: number, src: string) => void) {
        this.node = node; this.view = view; this.getPos = getPos; this.replaceSource = replaceSource;
        leafViews.add(this);
        const kind = node.attrs.kind;
        // 标题渲染为真 h1-h6,供锚点定位/标题面包屑的 DOM 推导匹配
        const dom = document.createElement(node.attrs.heading ? "h" + Math.min(node.attrs.heading, 6) : "div");
        dom.className = `blk blk-${kind}` + (node.attrs.heading ? " is-heading" : "");
        const member = kind === "list" || kind === "quote" || kind === "listQuote";
        dom.style.setProperty("--indent", `${member ? 0 : indentPx(node.attrs.prefix)}px`);
        const content = document.createElement("div");
        content.className = "content";
        dom.appendChild(content);
        this.dom = dom; this.contentDOM = content;
        // 点击块边缘(圆点/留白等非正文区)→ 揭示该块 raw 源码编辑(对齐旧 live 手感);
        // 正文内点击仍由 PM 处理(WYSIWYG 就地编辑)
        dom.addEventListener("mousedown", e => {
            if (!this.view.editable) return;
            if (this.contentDOM.contains(e.target as Node)) return;
            e.preventDefault(); e.stopPropagation();
            this.revealSource();
        });
    }
    private revealSource(focus = true): void {
        if (this.revealing || !this.replaceSource) return;
        this.revealing = true;
        const posAtOpen = this.getPos();
        const src = (this.node.attrs.raw || "").replace(/\r?\n$|\r$/, "");
        const ta = document.createElement("textarea");
        ta.className = "sb-source";
        ta.value = src;
        ta.spellcheck = false;
        this.contentDOM.style.display = "none";
        this.dom.appendChild(ta);
        if (focus) ta.focus();
        const commit = (save: boolean): void => {
            if (!this.dom.contains(ta)) return;
            const val = ta.value;
            this.dom.removeChild(ta);
            this.contentDOM.style.display = "";
            this.revealing = false;
            this.commitFn = undefined;
            this.active = false;
            const pos = posAtOpen;
            if (save && val !== src && typeof pos === "number") {
                const rs = this.replaceSource!;
                // 延迟到事件循环外回写,避免 blur 事件内 PM 重入导致事务被吞
                setTimeout(() => rs(pos, val), 0);
            }
        };
        this.commitFn = commit;
        ta.addEventListener("keydown", e => {
            if (e.key === "Escape") { e.preventDefault(); commit(false); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(true); }
            e.stopPropagation();
        });
        ta.addEventListener("blur", () => commit(true));
    }
    /** Obsidian 式两态:光标所在块显示源码(active),移开提交并恢复渲染 */
    setActive(active: boolean): void {
        if (active === this.active) return;
        this.active = active;
        if (active) this.revealSource(false);
        else if (this.commitFn) this.commitFn(true);
    }
    destroy(): void {
        leafViews.delete(this);
    }
    update(node: any): boolean {
        if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
        this.node = node; return true;
    }
    ignoreMutation(m: any): boolean {
        return m.target !== this.contentDOM && !this.contentDOM.contains(m.target);
    }
}

/** list 容器视图：圆点由 CSS ::before 画，嵌套缩进由 pad 决定 */
export class ListView {
    node: any; view: any; getPos: any; dom: HTMLElement; contentDOM: HTMLElement;
    constructor(node: any, view: any, getPos: any) {
        this.node = node; this.view = view; this.getPos = getPos;
        const dom = document.createElement("div");
        dom.className = "lv-list";
        if (node.attrs.pad > 22) dom.style.marginLeft = `${node.attrs.pad - 22}px`;
        const items = document.createElement("div");
        items.className = "lv-items";
        dom.appendChild(items);
        this.dom = dom; this.contentDOM = items;
    }
    update(node: any): boolean {
        if (node.type !== this.node.type) return false;
        this.node = node; return true;
    }
    ignoreMutation(m: any): boolean {
        return m.target !== this.contentDOM && !this.contentDOM.contains(m.target);
    }
}

/** quote 容器视图：左竖线；作为 list 的 slot 时由 list CSS 补圆点 */
export class QuoteView {
    node: any; view: any; getPos: any; dom: HTMLElement; contentDOM: HTMLElement;
    constructor(node: any, view: any, getPos: any) {
        this.node = node; this.view = view; this.getPos = getPos;
        const dom = document.createElement("blockquote");
        dom.className = "lv-quote";
        if (!node.attrs.slot && node.attrs.pad) dom.style.marginLeft = `${node.attrs.pad}px`;
        const inner = document.createElement("div");
        inner.className = "lv-quote-inner";
        dom.appendChild(inner);
        this.dom = dom; this.contentDOM = inner;
    }
    update(node: any): boolean {
        if (node.type !== this.node.type) return false;
        this.node = node; return true;
    }
    ignoreMutation(m: any): boolean {
        return m.target !== this.contentDOM && !this.contentDOM.contains(m.target);
    }
}

/** 公式视图：math（块级）与 mathInline（行内）共用。KaTeX 异步渲染即编辑。 */
export class MathView {
    node: any; view: any; getPos: any; dom: HTMLElement; block: boolean;
    private rendered = false; private curTex = ""; private curDisplay = false;
    constructor(node: any, view: any, getPos: any) {
        this.node = node; this.view = view; this.getPos = getPos;
        this.block = node.type.name === "math";
        this.dom = document.createElement(this.block ? "div" : "span");
        this.dom.className = this.block ? "math-block" : ("math" + (node.attrs.display ? " math-display" : ""));
        this.dom.title = "点击编辑公式";
        this.paint(node.attrs.tex, this.block ? true : node.attrs.display);
        this.dom.addEventListener("mousedown", e => {
            e.stopPropagation();
            if (!this.view.editable) return;
            e.preventDefault(); this.edit();
        });
        // 真实点击的 mouseup/click 会冒泡到 PM 触发 NodeSelection、抢走编辑输入框焦点;
        // 一并阻断,保证点击公式块稳定进入编辑(阅读态也不产生选中)
        for (const evt of ["mouseup", "click"]) {
            this.dom.addEventListener(evt, e => { e.stopPropagation(); });
        }
    }
    paint(tex: string, display: boolean): void {
        this.curTex = tex; this.curDisplay = display;
        if (this.rendered) { this.renderNow(); return; }
        // 离屏先放轻量占位,进视口才渲染 KaTeX(虚拟滚动友好)
        this.dom.textContent = tex;
        this.dom.classList.add("math-pending");
        lazyRender(this.dom, () => {
            this.rendered = true;
            this.dom.classList.remove("math-pending");
            this.renderNow();
        });
    }
    private renderNow(): void {
        const tex = this.curTex, display = this.curDisplay;
        getKatex().then(katex => {
            if (!this.dom.isConnected) return;
            if (!katex) { this.dom.textContent = tex; return; }
            try {
                this.dom.innerHTML = katex.renderToString(tex, {throwOnError: false, displayMode: !!display});
            } catch {
                this.dom.textContent = tex;
            }
        });
    }
    edit(): void {
        if (this.dom.querySelector("input")) return;
        const input = document.createElement("input");
        input.className = "math-edit";
        input.value = this.node.attrs.tex;
        this.dom.textContent = "";
        this.dom.appendChild(input);
        input.focus(); input.select();
        const commit = (save: boolean): void => {
            if (!this.dom.contains(input)) return;
            const tex = save ? input.value : this.node.attrs.tex;
            const pos = this.getPos();
            if (typeof pos === "number" && save && tex !== this.node.attrs.tex) {
                this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, {...this.node.attrs, tex}));
            } else {
                this.dom.textContent = "";
                this.paint(tex, this.node.attrs.display);
            }
        };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); commit(true); }
            if (e.key === "Escape") { e.preventDefault(); commit(false); }
            e.stopPropagation();
        });
        input.addEventListener("blur", () => commit(true));
    }
    update(node: any): boolean {
        if (node.type !== this.node.type) return false;
        if (node.attrs.tex !== this.node.attrs.tex || node.attrs.display !== this.node.attrs.display) {
            this.node = node;
            this.paint(node.attrs.tex, node.attrs.display);
        }
        return true;
    }
    ignoreMutation(): boolean { return true; }
}

/** 图片行内 atom：渲染 img（加载失败显示占位），点击编辑 src。
 * resolveImageSrc 由宿主注入（思源资产 → blob URL），缺省直接用原 src。 */
export class ImageView {
    node: any; view: any; getPos: any; dom: HTMLElement; resolveImageSrc?: (src: string) => Promise<string | null>;
    constructor(node: any, view: any, getPos: any, resolveImageSrc?: (src: string) => Promise<string | null>) {
        this.node = node; this.view = view; this.getPos = getPos; this.resolveImageSrc = resolveImageSrc;
        this.dom = document.createElement("span");
        this.dom.className = "image-atom";
        this.dom.title = "点击编辑图片";
        this.paint();
        this.dom.addEventListener("mousedown", e => {
            if (!this.view.editable) return;
            e.preventDefault(); e.stopPropagation(); this.edit();
        });
    }
    paint(): void {
        this.dom.textContent = "";
        const src = this.node.attrs.src || "";
        const img = document.createElement("img");
        img.className = "image-img";
        img.alt = this.node.attrs.alt || "";
        const ph = document.createElement("span");
        ph.className = "image-ph";
        ph.textContent = "[图片] " + (src.split("/").pop() || src);
        ph.style.display = "none";
        img.addEventListener("load", () => { ph.style.display = "none"; });
        img.addEventListener("error", () => { img.style.display = "none"; ph.style.display = ""; });
        this.dom.append(img, ph);
        if (this.resolveImageSrc) {
            this.resolveImageSrc(src).then(resolved => {
                if (resolved && this.dom.isConnected) img.src = resolved;
                else img.src = src;
            }).catch(() => { img.src = src; });
        } else {
            img.src = src;
        }
    }
    edit(): void {
        if (this.dom.querySelector("input")) return;
        const input = document.createElement("input");
        input.className = "math-edit";
        input.value = this.node.attrs.src;
        this.dom.textContent = "";
        this.dom.appendChild(input);
        input.focus(); input.select();
        const commit = (save: boolean): void => {
            if (!this.dom.contains(input)) return;
            const src = save ? input.value : this.node.attrs.src;
            const pos = this.getPos();
            if (typeof pos === "number" && save && src !== this.node.attrs.src) {
                this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, {...this.node.attrs, src}));
            } else {
                this.dom.textContent = ""; this.paint();
            }
        };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); commit(true); }
            if (e.key === "Escape") { e.preventDefault(); commit(false); }
            e.stopPropagation();
        });
        input.addEventListener("blur", () => commit(true));
    }
    update(node: any): boolean {
        if (node.type !== this.node.type) return false;
        if (node.attrs.src !== this.node.attrs.src || node.attrs.alt !== this.node.attrs.alt) {
            this.node = node; this.paint();
        }
        return true;
    }
    ignoreMutation(): boolean { return true; }
}

/** 源码块视图（代码/表格/属性）：默认预览，点击切 textarea 源码编辑，提交写回 leaf text。 */
export class SourceBlockView {
    node: any; view: any; getPos: any; render: (n: any) => HTMLElement;
    dom: HTMLElement; preview: HTMLElement; editing = false;
    constructor(node: any, view: any, getPos: any, render: (n: any) => HTMLElement) {
        this.node = node; this.view = view; this.getPos = getPos; this.render = render;
        this.dom = document.createElement("div");
        this.dom.className = "blk blk-" + node.attrs.kind + " sb";
        this.preview = document.createElement("div");
        this.preview.className = "sb-preview";
        this.preview.contentEditable = "false";
        this.dom.appendChild(this.preview);
        this.paint();
        this.preview.addEventListener("mousedown", e => {
            if (!this.view.editable) return;
            e.preventDefault(); e.stopPropagation(); this.edit();
        });
    }
    paint(): void {
        this.preview.textContent = "";
        this.preview.appendChild(this.render(this.node));
    }
    edit(): void {
        if (this.editing) return;
        this.editing = true;
        const ta = document.createElement("textarea");
        ta.className = "sb-source";
        ta.value = this.node.textContent;
        ta.spellcheck = false;
        this.preview.style.display = "none";
        this.dom.appendChild(ta);
        ta.focus();
        const commit = (save: boolean): void => {
            if (!this.dom.contains(ta)) return;
            const val = save ? ta.value : this.node.textContent;
            this.dom.removeChild(ta);
            this.preview.style.display = "";
            this.editing = false;
            const pos = this.getPos();
            if (save && val !== this.node.textContent && typeof pos === "number") {
                const from = pos + 1, to = pos + 1 + this.node.content.size;
                const tr = this.view.state.tr;
                if (val) tr.replaceWith(from, to, schema.text(val));
                else tr.delete(from, to);
                this.view.dispatch(tr);
            } else {
                this.paint();
            }
        };
        ta.addEventListener("keydown", e => {
            if (e.key === "Escape") { e.preventDefault(); commit(false); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(true); }
            e.stopPropagation();
        });
        ta.addEventListener("blur", () => commit(true));
    }
    update(node: any): boolean {
        if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
        this.node = node;
        if (!this.editing) this.paint();
        return true;
    }
    ignoreMutation(): boolean { return true; }
}

/** GFM 表格预览（单元格纯文本；行内标记保留在源码） */
export function renderTable(node: any): HTMLElement {
    const lines = node.textContent.split("\n").filter((l: string) => l.trim() !== "");
    const parseRow = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    const isSep = (l: string): boolean => l.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "md-table";
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    let headerDone = false;
    for (const l of lines) {
        if (isSep(l)) { headerDone = true; continue; }
        const tr = document.createElement("tr");
        for (const c of parseRow(l)) {
            const cell = document.createElement(headerDone ? "td" : "th");
            cell.textContent = c;
            tr.appendChild(cell);
        }
        (headerDone ? tbody : thead).appendChild(tr);
    }
    if (thead.children.length) table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
}

/** 代码块预览：语言标签 + 等宽代码（去首尾围栏） */
export function renderCode(node: any): HTMLElement {
    const lines = node.textContent.split("\n");
    const open = lines[0] || "";
    const lang = (/^\s*(```|~~~)\s*([^\s`]*)/.exec(open) || [])[2] || "";
    let end = lines.length;
    if (end > 1 && /^\s*(```|~~~)\s*$/.test(lines[end - 1])) end--;
    const code = lines.slice(1, end).join("\n");
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const label = document.createElement("div");
    label.className = "code-lang";
    label.textContent = lang || "text";
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    wrap.append(label, pre);
    return wrap;
}

/** Logseq 属性预览：key:: value 面板 */
export function renderProp(node: any): HTMLElement {
    const m = /^([\w-]+)::\s?(.*)$/.exec(node.textContent);
    const wrap = document.createElement("div");
    wrap.className = "prop-wrap";
    const k = document.createElement("span");
    k.className = "prop-key";
    k.textContent = m ? m[1] : node.textContent;
    const sep = document.createElement("span");
    sep.className = "prop-sep";
    sep.textContent = "::";
    const v = document.createElement("span");
    v.className = "prop-val";
    v.textContent = m ? m[2] : "";
    wrap.append(k, sep, v);
    return wrap;
}

/** leaf 节点视图工厂：按 kind 分派源码块视图或普通叶子视图 */
export function makeLeafView(node: any, view: any, getPos: any, replaceSource?: (pos: number, src: string) => void): any {
    const k = node.attrs.kind;
    if (k === "tableRow") return new SourceBlockView(node, view, getPos, renderTable);
    if (k === "codeFence") return new CodeBlockView(node, view, getPos);
    if (k === "logseqProp") return new SourceBlockView(node, view, getPos, renderProp);
    return new LeafView(node, view, getPos, replaceSource);
}