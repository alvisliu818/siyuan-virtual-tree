// 结构化内核：块级原文锚定解析层（纯函数，零依赖）。
// 层级容器模型：splitBlocks 输出树（list / quote 容器 + leaf / math 叶子）。
// 每个节点保存 raw（原始字节）；未编辑子树保存时直接输出 raw。
// 移植自隔离原型 tmp/structured-proto/src/blocks.js（已四文档逐字节保真验证）。

export interface LeafNode {
    type: "leaf";
    kind: string;
    raw: string;
    prefix: string;
    body: string;
    heading: number;
}

export interface MathNode {
    type: "math";
    raw: string;
    prefix: string;
    tex: string;
    delim: string;
    display: boolean;
    fence: boolean;
    open?: string;
    close?: string;
    innerEol?: string;
    heading?: number;
}

export interface ContainerNode {
    type: "list" | "quote";
    indent: string;
    pad: number;
    slot?: boolean;
    children: TreeNode[];
    raw?: string;
}

export type TreeNode = LeafNode | MathNode | ContainerNode;

export interface Token {
    type: string;
    text?: string;
    tex?: string;
    delim?: string;
    display?: boolean;
    strong?: boolean;
    alt?: string;
    src?: string;
    href?: string;
}

export function splitLines(text: string): string[] {
    const out: string[] = [];
    const re = /[^\r\n]*(?:\r\n|\n|\r)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { out.push(m[0]); last = re.lastIndex; }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const RE_LIST_QUOTE = /^(\s*)([-*+]|\d+[.)])\s*>\s*/;
const RE_QUOTE = /^(\s*)>\s*/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const RE_PURE_MATH = /^\$\$([\s\S]*)\$\$$/;

export function classify(line: string): string {
    const s = line.replace(/\r?\n$|\r$/, "");
    if (/^\s*(```|~~~)/.test(s)) return "codeFence";
    if (/^\s*\$\$\s*$/.test(s)) return "mathFence";
    if (RE_LIST_QUOTE.test(s)) return "listQuote";
    if (RE_QUOTE.test(s)) return "quote";
    if (/^\s*\|.*\|\s*$/.test(s)) return "tableRow";
    if (RE_LIST.test(s)) return "list";
    if (/^\s*#{1,6}\s/.test(s)) return "heading";
    if (/^\s*[\w-]+::\s/.test(s)) return "logseqProp";
    if (/^\s*---\s*$/.test(s)) return "frontmatter";
    if (s.trim() === "") return "blank";
    return "text";
}

const indentOf = (s: string): string => /^(\s*)/.exec(s)![1];
const stripEol = (s: string): string => s.replace(/\r?\n$|\r$/, "");
const eolOf = (s: string): string => (/\r?\n$|\r$/.exec(s) || [""])[0];
function indentPx(w: string): number {
    const tabs = (w.match(/\t/g) || []).length;
    return tabs * 18 + (w.length - tabs) * 4;
}

interface StackNode {
    type: string;
    indent: string | null;
    pad?: number;
    slot?: boolean;
    children: TreeNode[];
    raw?: string;
}

/**
 * 按行切块并收进层级容器，输出树（保留每行原始行尾，不做任何规范化）。
 * - 连续同层列表行 → 一个 list 容器；更深缩进 → 嵌套 list 容器。
 * - `- >` → list 容器内的 quote 容器（slot），真实表达「列表包引用」。
 * - 整行 `$$…$$` / `$$` 围栏 → math 叶子（块级公式），可作为 list/quote 的子块。
 */
export function splitBlocks(text: string): TreeNode[] {
    const lines = splitLines(text);
    const root: StackNode = {type: "root", indent: null, children: []};
    const stack: StackNode[] = [root];
    const top = (): StackNode => stack[stack.length - 1];

    const popTo = (W: string, sameLevelAccept: (t: StackNode) => boolean): void => {
        while (stack.length > 1) {
            const t = top();
            if (!W.startsWith(t.indent as string)) { stack.pop(); continue; }
            if (W.length > (t.indent as string).length) break;
            if (sameLevelAccept(t)) break;
            stack.pop();
        }
    };
    const pushContainer = (type: "list" | "quote", W: string, extra?: {slot?: boolean}): ContainerNode => {
        const parent = top();
        const pad = indentPx(W) - indentPx(parent.indent || "");
        const node: ContainerNode = {type, indent: W, pad, children: [], ...extra};
        parent.children.push(node);
        stack.push(node as unknown as StackNode);
        return node;
    };
    const ensureList = (W: string): ContainerNode => {
        const t = top();
        return (t.type === "list" && t.indent === W) ? t as unknown as ContainerNode : pushContainer("list", W);
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const kind = classify(line);
        let end = i + 1;
        if (kind === "codeFence") {
            const mark = /^\s*(```|~~~)/.exec(line)![1];
            while (end < lines.length && !new RegExp("^\\s*" + mark).test(lines[end])) end++;
            if (end < lines.length) end++;
        } else if (kind === "mathFence") {
            while (end < lines.length && classify(lines[end]) !== "mathFence") end++;
            if (end < lines.length) end++;
        } else if (kind === "tableRow") {
            while (end < lines.length && classify(lines[end]) === "tableRow") end++;
        }
        const raw = lines.slice(i, end).join("");
        const W = indentOf(line);

        if (kind === "list" || kind === "listQuote") {
            popTo(W, t => t.type === "list");
            const list = ensureList(W);
            if (kind === "list") {
                list.children.push(makeLineLeaf(raw, "list", RE_LIST));
            } else {
                const last = list.children[list.children.length - 1];
                let slot: ContainerNode;
                if (last && last.type === "quote" && (last as ContainerNode).slot && (last as ContainerNode).indent === W) {
                    slot = last as ContainerNode;
                } else {
                    slot = {type: "quote", indent: W, slot: true, pad: 0, children: []};
                    list.children.push(slot);
                }
                slot.children.push(makeLineLeaf(raw, "listQuote", RE_LIST_QUOTE));
            }
        } else if (kind === "quote") {
            popTo(W, t => t.type === "quote" && !t.slot);
            const t = top();
            const quote = (t.type === "quote" && !t.slot && t.indent === W)
                ? t as unknown as ContainerNode : pushContainer("quote", W, {slot: false});
            quote.children.push(makeLineLeaf(raw, "quote", RE_QUOTE));
        } else {
            popTo(W, () => false);
            top().children.push(makeOtherLeaf(kind, raw));
        }
        i = end;
    }
    fillRaw(root.children);
    return root.children;
}

function makeLineLeaf(raw: string, kind: string, re: RegExp): TreeNode {
    const first = stripEol(raw);
    const m = re.exec(first);
    let prefix = m ? m[0] : "";
    let body = m ? first.slice(m[0].length) : first;
    let heading = 0;
    if (kind === "list") {
        const hm = /^(#{1,6})\s+/.exec(body);
        if (hm) { heading = hm[1].length; prefix += hm[0]; body = body.slice(hm[0].length); }
    }
    const pm = RE_PURE_MATH.exec(body);
    if (pm && pm[1].trim() && !pm[1].includes("$$")) {
        return {type: "math", raw, prefix, tex: pm[1], delim: "$$", display: true, fence: false, heading};
    }
    return {type: "leaf", kind, raw, prefix, body, heading};
}

function makeOtherLeaf(kind: string, raw: string): TreeNode {
    if (kind === "mathFence") {
        const ls = splitLines(raw);
        const open = ls[0];
        const hasClose = ls.length > 1 && classify(ls[ls.length - 1]) === "mathFence";
        const close = hasClose ? ls[ls.length - 1] : "";
        const inner = ls.slice(1, hasClose ? ls.length - 1 : ls.length);
        const tex = inner.map(stripEol).join("\n");
        const innerEol = inner.length ? (eolOf(inner[0]) || "\n") : (eolOf(open) || "\n");
        return {type: "math", raw, prefix: "", tex, delim: "$$", display: true, fence: true, open, close, innerEol};
    }
    if (kind === "codeFence" || kind === "tableRow") {
        return {type: "leaf", kind, raw, prefix: "", body: stripEol(raw), heading: 0};
    }
    const body = stripEol(raw);
    if (kind === "heading") {
        const m = /^(\s*#{1,6}\s+)/.exec(body);
        const prefix = m ? m[1] : "";
        return {type: "leaf", kind, raw, prefix, body: body.slice(prefix.length), heading: m ? (m[1].match(/#/g) || []).length : 0};
    }
    const pm = RE_PURE_MATH.exec(body);
    if (kind === "text" && pm && pm[1].trim() && !pm[1].includes("$$")) {
        return {type: "math", raw, prefix: "", tex: pm[1], delim: "$$", display: true, fence: false};
    }
    return {type: "leaf", kind, raw, prefix: "", body, heading: 0};
}

function fillRaw(nodes: TreeNode[]): void {
    for (const n of nodes) {
        if (n.type === "list" || n.type === "quote") {
            fillRaw(n.children);
            n.raw = n.children.map(c => c.raw).join("");
        }
    }
}

/** 深度优先收集叶子（文档顺序），用于保真探针与统计 */
export function walkLeaves(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
    for (const n of nodes) {
        if (n.type === "list" || n.type === "quote") walkLeaves(n.children, out);
        else out.push(n);
    }
    return out;
}

/**
 * 行内解析：粗体 / 行内码 / 公式（$…$、$$…$$、\(…\)）/ 图片（![alt](src)）。
 * 真实文档里公式内常含 | 与中文，故按定界符切段，不走 markdown 通用解析器。
 */
export function parseInline(text: string): Token[] {
    const tokens: Token[] = [];
    let i = 0, plain = "";
    const flush = (): void => {
        if (plain) { tokens.push({type: "text", text: plain}); plain = ""; }
    };
    while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
            if (text.startsWith("\\(", i)) {
                const end = text.indexOf("\\)", i + 2);
                if (end > i) {
                    const tex = text.slice(i + 2, end);
                    if (tex.trim()) {
                        flush();
                        tokens.push({type: "math", tex, delim: "\\(", display: false});
                        i = end + 2;
                        continue;
                    }
                }
            }
            plain += text.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (text[i] === "$") {
            const delim = text[i + 1] === "$" ? "$$" : "$";
            let close = text.indexOf(delim, i + delim.length);
            while (close > i && /[\w]/.test(text[close + delim.length] || "")) {
                close = text.indexOf(delim, close + delim.length);
            }
            if (close > i) {
                const tex = text.slice(i + delim.length, close);
                if (tex.trim()) {
                    flush();
                    tokens.push({type: "math", tex, delim, display: delim === "$$"});
                    i = close + delim.length;
                    continue;
                }
            }
        }
        if (text[i] === "!" && text[i + 1] === "[") {
            const cb = text.indexOf("]", i + 2);
            if (cb > i && text[cb + 1] === "(") {
                const cp = text.indexOf(")", cb + 2);
                if (cp > cb) {
                    flush();
                    tokens.push({type: "image", alt: text.slice(i + 2, cb), src: text.slice(cb + 2, cp)});
                    i = cp + 1;
                    continue;
                }
            }
        }
        if (text[i] === "[") {
            const cb = text.indexOf("]", i + 1);
            if (cb > i && text[cb + 1] === "(") {
                const cp = text.indexOf(")", cb + 2);
                if (cp > cb) {
                    flush();
                    tokens.push({type: "link", text: text.slice(i + 1, cb), href: text.slice(cb + 2, cp)});
                    i = cp + 1;
                    continue;
                }
            }
        }
        if (text.startsWith("**", i)) {
            const end = text.indexOf("**", i + 2);
            if (end > i) {
                flush();
                for (const t of parseInline(text.slice(i + 2, end))) {
                    tokens.push({...t, strong: true});
                }
                i = end + 2;
                continue;
            }
        }
        if (text[i] === "`") {
            const end = text.indexOf("`", i + 1);
            if (end > i) {
                flush();
                tokens.push({type: "code", text: text.slice(i + 1, end)});
                i = end + 1;
                continue;
            }
        }
        plain += text[i];
        i++;
    }
    flush();
    return tokens;
}

/** tokens → markdown 正文（只在块被编辑时使用） */
export function serializeInline(tokens: Token[]): string {
    let out = "", inStrong = false;
    const plain = (t: Token): string => {
        switch (t.type) {
            case "text": return t.text || "";
            case "strong": return `**${t.text || ""}**`;
            case "code": return `\`${t.text || ""}\``;
            case "image": return `![${t.alt || ""}](${t.src || ""})`;
            case "link": return `[${t.text || ""}](${t.href || ""})`;
            case "math":
                if (t.delim === "\\(") return `\\(${t.tex}\\)`;
                return `${t.delim}${t.tex}${t.delim}`;
            default: return "";
        }
    };
    for (const t of tokens) {
        if (t.strong && !inStrong) { out += "**"; inStrong = true; }
        else if (!t.strong && inStrong) { out += "**"; inStrong = false; }
        out += plain(t);
    }
    if (inStrong) out += "**";
    return out;
}

/** 从 PM 的 inline 内容还原 tokens（保存时与初始 body 比较，判断是否 dirty） */
export function inlineToTokens(node: any): Token[] {
    const out: Token[] = [];
    node.forEach((child: any) => {
        if (child.isText) {
            const names = child.marks.map((m: any) => m.type.name);
            const strong = names.includes("strong");
            if (names.includes("code")) out.push({type: "code", text: child.text, strong});
            else out.push({type: "text", text: child.text, strong});
        } else if (child.type.name === "mathInline") {
            out.push({type: "math", tex: child.attrs.tex, delim: child.attrs.delim, display: child.attrs.display, strong: child.attrs.strong});
        } else if (child.type.name === "image") {
            out.push({type: "image", alt: child.attrs.alt, src: child.attrs.src, strong: child.attrs.strong});
        } else if (child.type.name === "link") {
            out.push({type: "link", text: child.attrs.text, href: child.attrs.href, strong: child.attrs.strong});
        }
    });
    return out;
}