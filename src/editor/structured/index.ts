// 结构化内核引擎适配：把 ProseMirror 编辑器接成 md-tab 的一个引擎句柄。
// 内容主干仍是 Monaco model：getValue() 返回块级原文锚定序列化结果（未编辑块原样 raw），
// 宿主在 live 态保存时 model.setValue(handle.getValue())。reading 态只读、不落盘。
// 移植自隔离原型 tmp/structured-proto/src/main.js（已四文档保真 + P2/P3 验证）。
import {EditorState, TextSelection} from "prosemirror-state";
import {EditorView} from "prosemirror-view";
import {exampleSetup} from "prosemirror-example-setup";
import {keymap} from "prosemirror-keymap";
import {Fragment} from "prosemirror-model";
import {schema, ListView, QuoteView, MathView, ImageView, makeLeafView, leafViews} from "./schema";
import {splitBlocks, walkLeaves, parseInline, serializeInline, inlineToTokens, TreeNode, LeafNode} from "./blocks";
import "./structured.scss";

export interface StructuredOptions {
    value: string;
    readOnly?: boolean;
    resolveImageSrc?: (src: string) => Promise<string | null>;
    onSave?: () => void;
    onInput?: () => void;
    onCursor?: () => void;
}

export interface StructuredHandle {
    getValue(): string;
    dispose(): void;
    revealLine(line: number, focus?: boolean): void;
    focus(): void;
    insertAtCursor(md: string): boolean;
    selectionMarkdown(): string | null;
    replaceBlockSource(pos: number, src: string): void;
    readonly view: EditorView;
}

const SPECIAL = ["codeFence", "tableRow", "frontmatter", "blank", "logseqProp"];
const eolOf = (raw: string): string => (/\r?\n$|\r$/.exec(raw) || [""])[0];

function inlineChildren(body: string): any[] {
    return parseInline(body).flatMap(t => {
        if (t.type === "text") return t.text
            ? [schema.text(t.text, t.strong ? [schema.marks.strong.create()] : [])] : [];
        if (t.type === "strong") return [schema.text(t.text || "", [schema.marks.strong.create()])];
        if (t.type === "code") return [schema.text(t.text || "", [
            schema.marks.code.create(),
            ...(t.strong ? [schema.marks.strong.create()] : []),
        ])];
        if (t.type === "math") return [schema.nodes.mathInline.create({tex: t.tex, delim: t.delim, display: t.display, strong: !!t.strong})];
        if (t.type === "image") return [schema.nodes.image.create({alt: t.alt, src: t.src, strong: !!t.strong})];
        if (t.type === "link") return [schema.nodes.link.create({text: t.text, href: t.href, strong: !!t.strong})];
        return [];
    });
}

function toPM(n: TreeNode): any {
    if (n.type === "list") {
        return schema.nodes.list.create({raw: n.raw, indent: n.indent, pad: n.pad}, n.children.map(toPM));
    }
    if (n.type === "quote") {
        return schema.nodes.quote.create({raw: n.raw, indent: n.indent, slot: !!n.slot, pad: n.pad || 0}, n.children.map(toPM));
    }
    if (n.type === "math") {
        return schema.nodes.math.create({
            tex: n.tex, tex0: n.tex, raw: n.raw, prefix: n.prefix || "", delim: "$$", display: true,
            fence: !!n.fence, open: n.open || "", close: n.close || "", innerEol: n.innerEol || "\n",
        });
    }
    const leaf = n as LeafNode;
    const children = SPECIAL.includes(leaf.kind)
        ? (leaf.body ? [schema.text(leaf.body)] : [])
        : inlineChildren(leaf.body);
    return schema.nodes.leaf.create(
        {kind: leaf.kind, raw: leaf.raw, prefix: leaf.prefix || "", prefix0: leaf.prefix || "", body0: leaf.body, heading: leaf.heading || 0},
        Fragment.fromArray(children),
    );
}

export function buildDoc(text: string): {doc: any; tree: TreeNode[]; leaves: TreeNode[]} {
    const tree = splitBlocks(text);
    const doc = schema.nodes.doc.create(null, tree.map(toPM));
    return {doc, tree, leaves: walkLeaves(tree)};
}

function serializeNode(node: any): string {
    const t = node.type.name;
    if (t === "list" || t === "quote") {
        let out = "", clean = true;
        node.forEach((c: any) => {
            const s = serializeNode(c);
            out += s;
            if (s !== c.attrs.raw) clean = false;
        });
        return clean ? node.attrs.raw : out;
    }
    if (t === "math") {
        const a = node.attrs;
        if (a.tex === a.tex0) return a.raw;
        if (a.fence) return a.open + a.tex + a.innerEol + a.close;
        return a.prefix + "$$" + a.tex + "$$" + eolOf(a.raw);
    }
    const body = serializeInline(inlineToTokens(node));
    if (body === node.attrs.body0 && node.attrs.prefix === node.attrs.prefix0) return node.attrs.raw;
    return node.attrs.prefix + body + eolOf(node.attrs.raw);
}

/** 源码揭示回写:把编辑后的单块源码重解析为 PM 节点并替换(保留块级锚定) */
/** Obsidian 式两态:光标所在叶子块显示源码,移开提交并恢复渲染 */
function updateActiveLeaf(view: any): void {
    if (!view.editable) return;
    const {from} = view.state.selection;
    for (const lv of leafViews) {
        const pos = lv.getPos();
        if (typeof pos !== "number") { lv.setActive(false); continue; }
        const node = view.state.doc.nodeAt(pos);
        const contains = !!node && from >= pos && from <= pos + node.nodeSize;
        lv.setActive(contains);
    }
}

/** 源码揭示回写:把编辑后的单块源码替换进全文(按 raw 精确定位),整 doc 重建。
 *  与 load 同源的 buildDoc+updateState 路径,必然生效;其余块逐字节保留。 */
export function replaceBlockSource(view: any, pos: number, source: string): void {
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const raw = node.attrs.raw || "";
    if (!raw) return;
    const full = serializeDoc(view.state);
    const idx = full.indexOf(raw);
    if (idx < 0) return;
    const eol = (raw.match(/\r?\n$/) || ["\n"])[0];
    const newText = full.slice(0, idx) + source + eol + full.slice(idx + raw.length);
    const built = buildDoc(newText);
    view.updateState(EditorState.create({doc: built.doc, plugins: view.state.plugins}));
}

export function serializeDoc(state: any): string {
    let out = "";
    state.doc.forEach((n: any) => { out += serializeNode(n); });
    return out;
}

/** 选区片段 → Markdown(剪贴板复制用):块节点走 serializeNode,行内节点累积成 tokens */
function serializeFragment(frag: any): string {
    let out = "";
    const inlineBuf: any[] = [];
    const flushInline = (): void => { if (inlineBuf.length) { out += serializeInline(inlineBuf); inlineBuf.length = 0; } };
    frag.forEach((node: any) => {
        if (node.isBlock) { flushInline(); out += serializeNode(node); return; }
        if (node.isText) {
            const strong = node.marks.some((m: any) => m.type.name === "strong");
            const code = node.marks.some((m: any) => m.type.name === "code");
            inlineBuf.push({type: code ? "code" : "text", text: node.text, strong});
        } else if (node.type.name === "mathInline") {
            inlineBuf.push({type: "math", tex: node.attrs.tex, delim: node.attrs.delim, display: node.attrs.display, strong: node.attrs.strong});
        } else if (node.type.name === "image") {
            inlineBuf.push({type: "image", alt: node.attrs.alt, src: node.attrs.src});
        } else if (node.type.name === "link") {
            inlineBuf.push({type: "link", text: node.attrs.text, href: node.attrs.href});
        }
    });
    flushInline();
    return out;
}

function findLeafDepth($pos: any): number {
    let d = $pos.depth;
    while (d > 0 && $pos.node(d).type.name !== "leaf") d--;
    return d;
}

function sinkItem(state: any, dispatch?: (tr: any) => void): boolean {
    const {$from} = state.selection;
    const d = findLeafDepth($from);
    if (d === 0) return false;
    const leaf = $from.node(d);
    if (leaf.attrs.kind !== "list") return false;
    const list = $from.node(d - 1);
    if (!list || list.type.name !== "list") return false;
    const leafPos = $from.before(d);
    const newLeaf = leaf.type.create({...leaf.attrs, prefix: "\t" + leaf.attrs.prefix}, leaf.content);
    const newList = schema.nodes.list.create({indent: list.attrs.indent + "\t", pad: 18, raw: ""}, [newLeaf]);
    if (dispatch) {
        const tr = state.tr.replaceWith(leafPos, leafPos + leaf.nodeSize, newList);
        tr.setSelection(TextSelection.create(tr.doc, leafPos + 2));
        dispatch(tr.scrollIntoView());
    }
    return true;
}

function liftItem(state: any, dispatch?: (tr: any) => void): boolean {
    const {$from} = state.selection;
    const d = findLeafDepth($from);
    if (d === 0) return false;
    const leaf = $from.node(d);
    if (leaf.attrs.kind !== "list") return false;
    const list = $from.node(d - 1);
    if (!list || list.type.name !== "list") return false;
    const parent = d >= 2 ? $from.node(d - 2) : null;
    if (!parent || parent.type.name !== "list") return false;
    const newLeaf = leaf.type.create({...leaf.attrs, prefix: leaf.attrs.prefix.replace(/^\t/, "")}, leaf.content);
    const leafPos = $from.before(d);
    const listPos = $from.before(d - 1);
    if (dispatch) {
        let tr: any, selPos: number;
        if (list.childCount === 1) {
            tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, newLeaf);
            selPos = listPos + 1;
        } else {
            tr = state.tr.delete(leafPos, leafPos + leaf.nodeSize);
            selPos = tr.mapping.map(listPos + list.nodeSize);
            tr.insert(selPos, newLeaf);
            selPos = selPos + 1;
        }
        tr.setSelection(TextSelection.create(tr.doc, selPos));
        dispatch(tr.scrollIntoView());
    }
    return true;
}

/** 创建结构化内核编辑器句柄。readOnly=true 时禁止编辑（阅读态）。 */
export function createStructuredEditor(contentEl: HTMLElement, opts: StructuredOptions): StructuredHandle {
    const built = buildDoc(opts.value ?? "");
    const readOnly = !!opts.readOnly;
    const plugins = readOnly
        ? []
        : [keymap({"Mod-s": () => { opts.onSave?.(); return true; }, Tab: sinkItem, "Shift-Tab": liftItem}), ...exampleSetup({schema, menuBar: false})];
    const state = EditorState.create({doc: built.doc, plugins});
    const view = new EditorView(contentEl, {
        state,
        editable: () => !readOnly,
        nodeViews: {
            leaf: (node, v, getPos) => makeLeafView(node, v, getPos, (pos, src) => replaceBlockSource(v, pos, src)),
            list: (node, v, getPos) => new ListView(node, v, getPos),
            quote: (node, v, getPos) => new QuoteView(node, v, getPos),
            math: (node, v, getPos) => new MathView(node, v, getPos),
            mathInline: (node, v, getPos) => new MathView(node, v, getPos),
            image: (node, v, getPos) => new ImageView(node, v, getPos, opts.resolveImageSrc),
        },
        dispatchTransaction(tr) {
            if (readOnly && tr.docChanged) return;
            const next = view.state.apply(tr);
            view.updateState(next);
            if (tr.docChanged) opts.onInput?.();
            if (tr.selectionSet) opts.onCursor?.();
            if (!readOnly) setTimeout(() => updateActiveLeaf(view), 0);
        },
    });
    return {
        view,
        getValue: () => serializeDoc(view.state),
        focus: () => view.focus(),
        insertAtCursor: (md: string) => {
            const {state} = view;
            view.dispatch(state.tr.insertText(md, state.selection.from));
            view.focus();
            return true;
        },
        selectionMarkdown: () => {
            const {from, to, empty} = view.state.selection;
            if (empty) return null;
            return serializeFragment(view.state.doc.slice(from, to).content);
        },
        replaceBlockSource: (pos: number, src: string) => replaceBlockSource(view, pos, src),
        dispose: () => view.destroy(),
        revealLine: (line: number) => {
            let lineAcc = 0, targetPos = -1;
            view.state.doc.descendants((node: any, pos: number) => {
                if (targetPos >= 0) return false;
                if (node.type.name === "leaf" || node.type.name === "math") {
                    const raw = node.attrs.raw || "";
                    const nlines = Math.max((raw.match(/\n/g) || []).length, 1);
                    if (line <= lineAcc + nlines) { targetPos = pos; return false; }
                    lineAcc += nlines;
                }
                return true;
            });
            if (targetPos >= 0) {
                const dom = view.nodeDOM(targetPos) as HTMLElement | null;
                if (dom && dom.scrollIntoView) dom.scrollIntoView({block: "center"});
            }
        },
    };
}