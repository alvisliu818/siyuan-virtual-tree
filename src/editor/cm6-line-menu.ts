// 行级菜单:左侧 gutter 悬浮 ⋮ 手柄,点开当前行的上下文操作菜单
// (AGPL-3.0 派生:移植自 SilverBullet client/codemirror/line_handle.ts +
// line_menu.ts + line_geometry.ts,按本插件 CM6 栈与思源 Menu 重写)
//
//  - 手柄:单个 overlay 按钮挂在 view.scrollDOM 上,跟随鼠标悬浮的文本行,
//    显示在该行行号槽位置(Logseq 块控件同款:盖住行号);键入时隐藏
//    (除非鼠标正悬在手柄上),被整行替换的行(卡片/属性面板)不显示
//  - 菜单条目按行上下文分派(SB markupBar.line 默认集的可用子集):
//      标题行   → 标题 1/2/3、正文、上移节、下移节、删除节
//      列表项   → 缩进、反缩进、上移、下移、转为任务(非任务时)、删除项
//      任务行   → 设为已完成/未完成 + 列表项操作
//      普通段落 → 标题 1/2/3、列表项、任务、引用、删除段落
//  - 条目只捕获行号,执行时按当前文档重算(SB "Found again when picked"),
//    全部走单事务 dispatch(userEvent input),可撤销;选取执行前若当前选区
//    不在该行上,先把光标钉到行文本起点(SB selectionForPick)
//  - 上下文识别用行文本起点(跳过缩进/列表标记/任务框/引用标记)处的语法树
//    祖先(SB contextsAt 的行级用法);围栏代码/缩进代码/HTML 块/引用不弹
//  - 菜单关闭检测:思源 Menu 无 onClose,开菜单时挂一次性 document
//    click/Escape 捕获监听,任意点击(含选中条目)后延时复位钉住态
//
// 主题:思源 CSS 变量,样式在全局 index.scss(手柄是 scroller 直接子元素,
// 不在 .cm-editor theme 作用域里);菜单用思源原生 Menu(平台惯例)。
import {EditorSelection, EditorState, type Extension, type Line, type TransactionSpec} from "@codemirror/state";
import {BlockType, type Command, EditorView, ViewPlugin} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import type {SyntaxNode} from "@lezer/common";
import {Menu} from "siyuan";
import {beginCodeEdit, fencedCodeInfosOfState} from "./cm6-render";

// ===== 1. 行上下文(SB lineTextStart / lineContexts 行级用法) =====

/** 行文本起点:跳过缩进、列表标记、任务框、引用标记与行首空白 */
function lineTextStart(state: EditorState, line: Line): number {
    let pos = line.from;
    syntaxTree(state).iterate({
        from: line.from,
        to: line.to,
        enter: (node) => {
            if (
                (node.name === "ListMark" ||
                    node.name === "TaskState" ||
                    node.name === "QuoteMark") &&
                node.from >= line.from &&
                node.to <= line.to
            ) {
                pos = Math.max(pos, node.to);
            }
        },
    });
    const rest = state.doc.sliceString(pos, line.to);
    return pos + (rest.length - rest.trimStart().length);
}

interface LineContext {
    /** 语法树祖先名(最内层在前) */
    names: string[];
    /** 行文本起点(选取钉住的锚点) */
    start: number;
    kind: "heading" | "task" | "list" | "paragraph" | "quote" | "code" | "blank" | "other";
    /** 标题级别(1-6,非标题为 0) */
    headingLevel: number;
    /** 列表标记区间(列表/任务行才有;正则先行,树扫描兜底) */
    listMark: {from: number; to: number} | null;
    /** 任务框区间(Task 行才有) */
    taskState: {from: number; to: number} | null;
    /** 列表项是否有子级(有子级时缩进/反缩进整树才安全,v1 先禁) */
    hasChildren: boolean;
}

// 行形态正则(即时确定,不等异步语法树 —— 菜单在编辑后立刻打开,树可能滞后;
// SB 为此专门写了 parse_ahead.ts,这里用正则绕开同一问题):
const RE_TASK = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[xX ]\])(\s|$)/;
const RE_LIST_ITEM_LINE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s|$)/;
const RE_HEADING = /^(\s*)(#{1,6})\s/;
const RE_QUOTE = /^\s*>\s/;

function lineContext(state: EditorState, n: number): LineContext {
    const line = state.doc.line(n);
    const start = lineTextStart(state, line);
    const ctx: LineContext = {
        names: [], start, kind: "other", headingLevel: 0,
        listMark: null, taskState: null, hasChildren: false,
    };
    if (line.text.trim() === "") {
        ctx.kind = "blank";
        return ctx;
    }
    // 正则先行:任务 > 标题 > 列表 > 引用
    const mTask = RE_TASK.exec(line.text);
    const mHead = RE_HEADING.exec(line.text);
    const mList = RE_LIST.exec(line.text);
    if (mTask) {
        ctx.kind = "task";
        ctx.listMark = {from: line.from + mTask[1].length, to: line.from + mTask[1].length + mTask[2].length};
        // 任务框在整段匹配里的偏移(m1 与 m[3] 之间有未捕获的 \s+)
        const bracketStart = line.from + mTask[0].indexOf(mTask[3]);
        ctx.taskState = {from: bracketStart, to: bracketStart + mTask[3].length};
    } else if (mHead) {
        ctx.kind = "heading";
        ctx.headingLevel = mHead[2].length;
    } else if (mList) {
        ctx.kind = "list";
        ctx.listMark = {from: line.from + mList[1].length, to: line.from + mList[1].length + mList[2].length};
    } else if (RE_QUOTE.test(line.text)) {
        ctx.kind = "quote";
    }
    // 语法树兜底:围栏/代码块/段落判定 + 标题级别(正则未命中时) + 列表子级
    const inner: SyntaxNode | null = syntaxTree(state).resolveInner(start, 1);
    let listItem: SyntaxNode | null = null;
    for (let node: SyntaxNode | null = inner; node; node = node.parent) {
        ctx.names.push(node.name);
        if (node.name === "ATXHeading" && ctx.kind !== "heading") {
            const mark = node.getChild("ATXHeadingMark");
            if (mark) {
                ctx.headingLevel = state.sliceDoc(mark.from, mark.to).trim().length;
                ctx.kind = "heading";
            }
        }
    }
    if (!ctx.listMark) {
        // 树扫描兜底(正则未识别的标记形态)
        syntaxTree(state).iterate({
            from: line.from,
            to: line.to,
            enter: (node) => {
                if (node.name === "ListMark" && !ctx.listMark && node.from >= line.from && node.to <= line.to) {
                    ctx.listMark = node;
                }
                if (node.name === "TaskState" && !ctx.taskState && node.from >= line.from && node.to <= line.to) {
                    ctx.taskState = node;
                }
            },
        });
        if (ctx.listMark && ctx.kind === "paragraph") ctx.kind = "list";
        if (ctx.taskState && ctx.kind === "list") ctx.kind = "task";
    }
    const has = (name: string) => ctx.names.includes(name);
    if (has("FencedCode") || has("CodeBlock") || has("HTMLBlock")) ctx.kind = "code";
    else if (ctx.kind === "other" && has("ATXHeading")) ctx.kind = "heading";
    else if (ctx.kind === "other" && has("Task")) ctx.kind = "task";
    else if (ctx.kind === "other" && has("ListItem")) ctx.kind = "list";
    else if (ctx.kind === "other" && has("Blockquote")) ctx.kind = "quote";
    else if (ctx.kind === "other" && has("Paragraph")) ctx.kind = "paragraph";
    if (listItem) {
        ctx.hasChildren = !!(listItem.getChild("BulletList") || listItem.getChild("OrderedList"));
    }
    return ctx;
}

// ===== 2. 图标(feather 描边系,与选中气泡同源) =====

function featherIcon(paths: string, size = 15): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS = {
    h1: featherIcon('<path d="M4 4h7M4 9h5M4 4v16M14 20v-9l-2 2M20 20v-9l-2 2M18 11h2v9"/>'),
    h2: featherIcon('<path d="M4 4h7M4 9h5M4 4v16M15 11h3a2 2 0 0 1 2 2v1c0 .6-.2 1.1-.5 1.6L14 20h6"/>'),
    h3: featherIcon('<path d="M4 4h7M4 9h5M4 4v16M15 11h4l-3 4h2a2 2 0 0 1 0 5h-3"/>'),
    text: featherIcon('<path d="M4 7V5h16v2M12 5v14M8 19h8"/>'),
    list: featherIcon('<circle cx="5" cy="7" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="17" r="1" fill="currentColor"/><path d="M10 7h9M10 12h9M10 17h9"/>'),
    task: featherIcon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    quote: featherIcon('<path d="M6 17h3l2-4V7H5v6h3zM15 17h3l2-4V7h-6v6h3z"/>'),
    indent: featherIcon('<path d="M3 5h18M3 12h7M3 19h18M14 9l4 3-4 3"/>'),
    outdent: featherIcon('<path d="M3 5h18M3 12h7M3 19h18M18 9l-4 3 4 3"/>'),
    up: featherIcon('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    down: featherIcon('<path d="M12 5v14M19 12l-7 7-7-7"/>'),
    check: featherIcon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    square: featherIcon('<rect x="3" y="3" width="18" height="18" rx="3"/>'),
    trash: featherIcon('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
};

// ===== 3. 文档操作(执行时按当前文档重算,单事务可撤销) =====

type DocOp = (view: EditorView, n: number) => void;

/** 标题行设级别;level 0 = 正文(移除标记) */
function setHeading(level: number): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const line = state.doc.line(n);
        const m = /^(\s*)(#{1,6})(\s?)/.exec(line.text);
        if (m) {
            const from = line.from + m[1].length;
            const to = line.from + m[0].length;
            const insert = level === 0 ? "" : "#".repeat(level) + " ";
            if (state.sliceDoc(from, to) === insert) return;
            view.dispatch({changes: {from, to, insert}, userEvent: "input"});
        } else if (level > 0) {
            view.dispatch({
                changes: {from: line.from, to: line.from, insert: "#".repeat(level) + " "},
                userEvent: "input",
            });
        }
    };
}

/** 普通段落行加前缀(标题/列表/任务/引用) */
function prefixLine(prefix: string): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const line = state.doc.line(n);
        view.dispatch({
            changes: {from: line.from, to: line.from, insert: prefix},
            userEvent: "input",
        });
    };
}

/** 任务状态切换(正则定位任务框,确定性) */
function setTaskState(done: boolean): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const line = state.doc.line(n);
        const m = RE_TASK.exec(line.text);
        if (!m) return;
        const bracketStart = line.from + m[0].indexOf(m[3]);
        view.dispatch({
            changes: {from: bracketStart, to: bracketStart + m[3].length, insert: done ? "[x]" : "[ ]"},
            userEvent: "input",
        });
    };
}

/** 非任务列表项转任务:在列表标记与正文之间插 [ ] */
function taskifyItem(): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const line = state.doc.line(n);
        const m = RE_LIST.exec(line.text);
        if (!m) return;
        // "- x" → "- [ ] x"(标记后已有空格,紧跟其后再插);"-x"/"-" → 补空格
        const hasSpace = m[3] === " ";
        const insertAt = line.from + m[1].length + m[2].length + (hasSpace ? 1 : 0);
        view.dispatch({
            changes: {from: insertAt, to: insertAt, insert: hasSpace ? "[ ] " : " [ ] "},
            userEvent: "input",
        });
    };
}

/** 父级列表项的标记列(反缩进目标;层级关系必须走语法树) */
function parentMarkOffset(state: EditorState, line: Line, mark: {from: number; to: number}): number {
    const node: SyntaxNode | null = syntaxTree(state).resolveInner(mark.from, 1);
    for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
        if (cur.name !== "ListItem") continue;
        const list = cur.parent;
        if (list && (list.name === "BulletList" || list.name === "OrderedList")) {
            const parentItem = list.parent;
            if (parentItem && parentItem.name === "ListItem") {
                const pm = parentItem.getChild("ListMark");
                if (pm) {
                    // ⚠ 父级标记在更早的行上,列偏移必须以**父标记自身所在行**为基准;
                    //   曾错误地减子行行首 → 恒为负 → 反缩进删除长度爆炸,吞掉子行到
                    //   父行之间的全部内容(2026-11-15 实测)
                    const pmLine = state.doc.lineAt(pm.from);
                    return pm.from - pmLine.from;
                }
            }
        }
    }
    return 0;
}

/** 列表项缩进(step>0:插等宽空格)/ 反缩进(step<0:删到父级列) */
function indentItem(step: number): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const line = state.doc.line(n);
        if (step > 0) {
            view.dispatch({
                changes: {from: line.from, to: line.from, insert: " ".repeat(step)},
                userEvent: "syfe.indent",
            });
            return;
        }
        const ctx = lineContext(state, n);
        if (!ctx.listMark) return;
        const markOffset = ctx.listMark.from - line.from;
        const remove = markOffset - parentMarkOffset(state, line, ctx.listMark);
        if (remove <= 0) return;
        view.dispatch({
            changes: {from: line.from, to: line.from + remove, insert: ""},
            userEvent: "syfe.indent",
        });
    };
}

/**
 * Tab/Shift+Tab 列表感知缩进(Logseq/Obsidian 同款):选区(光标)落在列表项/
 * 任务行上时整行缩进/反缩进,多光标一次事务完成;非列表行返回 false,
 * 回落通用缩进(indentWithTab)。反缩进无可删层级时同样回落。
 */
export function listIndentCommand(dir: 1 | -1): Command {
    return (view) => {
        const state = view.state;
        const targets: number[] = [];
        for (const range of state.selection.ranges) {
            const n = state.doc.lineAt(range.head).number;
            const ctx = lineContext(state, n);
            if (ctx.kind !== "list" && ctx.kind !== "task") return false;
            targets.push(n);
        }
        if (!targets.length) return false;
        // 单事务逐行收集;反缩进任一行无可删层级则整体回落
        const changes: {from: number; to: number; insert?: string}[] = [];
        for (const n of targets) {
            const line = state.doc.line(n);
            if (dir > 0) {
                const m = RE_LIST.exec(line.text);
                const step = m ? m[2].length + (m[3] === " " ? 1 : 0) : 2;
                changes.push({from: line.from, to: line.from, insert: " ".repeat(step)});
            } else {
                const ctx = lineContext(state, n);
                if (!ctx.listMark) return false;
                const markOffset = ctx.listMark.from - line.from;
                const remove = markOffset - parentMarkOffset(state, line, ctx.listMark);
                if (remove <= 0) return false;
                changes.push({from: line.from, to: line.from + remove, insert: ""});
            }
        }
        // userEvent 不用 "input":lang-markdown 的 indentOnInput 会在 input 事务上
        // 对列表行再缩进一次(实测 Tab 一次 +4、Shift+Tab 被顶回);自定义事件绕开,
        // 撤销组照常记录
        view.dispatch({changes, userEvent: "syfe.indent", scrollIntoView: true} as TransactionSpec);
        return true;
    };
}

/**
 * Alt+↑/↓ 块移动(Logseq 同款键盘行为):光标所在的可移动块(列表项/任务/
 * 段落/标题节)与相邻同级块整块换位。无同级块时吞键不动(不回落光标移动,
 * 避免按了移动键却跳光标的意外);只读态/不可移动行返回 false 回落默认行为。
 */
export function moveBlockCommand(dir: -1 | 1): Command {
    return (view) => {
        const state = view.state;
        if (state.readOnly || state.facet(EditorView.editable) === false) return false;
        const n = state.doc.lineAt(state.selection.main.head).number;
        const ctx = lineContext(state, n);
        if (ctx.kind !== "heading" && ctx.kind !== "list" && ctx.kind !== "task" && ctx.kind !== "paragraph") {
            return false;
        }
        const end = blockEnd(state, n, ctx);
        if (sibling(state, ctx, n, end, dir) == null) return true; // 吞键不动
        moveBlock(dir)(view, n);
        return true;
    };
}

/**
 * 块的结束行(不含):
 *  - 标题:到下一个级别 ≤ 自身的标题(或文档尾)——即整节
 *  - 列表项:后续缩进更深的行为子块;空行只有当其后仍接更深缩进延续行时才属于块
 *  - 段落:连续非空且非其它块类型(列表/标题/围栏/引用)的行为一段
 */
function blockEnd(state: EditorState, n: number, ctx: LineContext): number {
    const total = state.doc.lines;
    if (ctx.kind === "heading") {
        let end = n + 1;
        while (end <= total) {
            const t = state.doc.line(end).text;
            const m = /^\s*(#{1,6})\s/.exec(t);
            if (m && m[1].length <= ctx.headingLevel) break;
            end++;
        }
        return end;
    }
    const indent = ctx.listMark ? ctx.listMark.from - state.doc.line(n).from : 0;
    let end = n + 1;
    while (end <= total) {
        const t = state.doc.line(end).text;
        if (t.trim() === "") {
            const next = end + 1 <= total ? state.doc.line(end + 1).text : "";
            if (ctx.kind !== "paragraph" && next.trim() !== "" &&
                next.length - next.trimStart().length > indent) {
                end++;
                continue;
            }
            break;
        }
        if (ctx.kind === "paragraph") {
            // 连续段落行:直到遇到其它块类型的行
            const inner: SyntaxNode | null = syntaxTree(state).resolveInner(state.doc.line(end).from, 1);
            let alien = false;
            for (let node: SyntaxNode | null = inner; node; node = node.parent) {
                if (node.name === "ListItem" || node.name === "ATXHeading" ||
                    node.name === "FencedCode" || node.name === "CodeBlock" ||
                    node.name === "HTMLBlock" || node.name === "Blockquote") {
                    alien = true;
                    break;
                }
            }
            if (alien) break;
            end++;
            continue;
        }
        const ind = t.length - t.trimStart().length;
        if (ind > indent) {
            end++;
            continue;
        }
        break;
    }
    return end;
}

/** 两个行号区间(均含)的文本 */
function linesText(state: EditorState, a: number, b: number): string[] {
    const out: string[] = [];
    for (let i = a; i <= Math.min(b, state.doc.lines); i++) out.push(state.doc.line(i).text);
    return out;
}

/** 同级前驱/后继块起始行 */
function sibling(state: EditorState, ctx: LineContext, n: number, end: number, dir: -1 | 1): number | null {
    const total = state.doc.lines;
    // 同级判定:缩进/层级**相等**才算兄弟;更浅 = 父级边界(停止,无兄弟);
    // 更深 = 前面某个兄弟的子级(跳过继续找)。旧的 `<=` 判据会把父级当兄弟,
    // 与其子块换位时区间重叠,产出损坏文档(2026-11-15 实测)。
    let c = dir === -1 ? n - 1 : end;
    while (c >= 1 && c <= total) {
        const t = state.doc.line(c).text;
        if (t.trim() === "") {
            c += dir;
            continue;
        }
        if (ctx.kind === "heading") {
            // 只认标题行:同级 = 兄弟;更浅 = 父级边界(无兄弟);更深/非标题 = 继续
            const m = /^\s*(#{1,6})\s/.exec(t);
            if (m) {
                if (m[1].length === ctx.headingLevel) return c;
                if (m[1].length < ctx.headingLevel) return null;
            }
        } else {
            // 只认列表项行:同缩进列表项 = 兄弟;更浅缩进的**列表项** = 父级边界;
            // 非列表行(标题/段落,同缩进也算)= 列表边界(无兄弟) —— 曾把 H1 标题
            // 当兄弟,换位横跨全部章节(2026-11-15 实测)
            if (!RE_LIST_ITEM_LINE.test(t)) return null;
            const ind = t.length - t.trimStart().length;
            const indSelf = ctx.listMark ? ctx.listMark.from - state.doc.line(n).from : 0;
            if (ind === indSelf) return c;
            if (ind < indSelf) return null;
        }
        c += dir;
    }
    return null;
}

/** 块上下移动(dir=-1 上移 / 1 下移):与相邻同级块整块换位,块间空行随行 */
function moveBlock(dir: -1 | 1): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const ctx = lineContext(state, n);
        if (ctx.kind !== "heading" && ctx.kind !== "list" && ctx.kind !== "task" && ctx.kind !== "paragraph") return;
        const end = blockEnd(state, n, ctx);
        const other = sibling(state, ctx, n, end, dir);
        if (other == null) return;
        // ⚠ 兄弟块的边界必须用**它自己的** context 计算 —— 复用 self 的 ctx 时
        //   listMark 跨行相减得负缩进,块边界膨胀到 EOF,换位吞掉整篇(2026-11-15 实测)
        const otherCtx = lineContext(state, other);
        const otherEnd = blockEnd(state, other, otherCtx);
        // 行区间(含):dir=-1 → [other..n-1 空行] + [other 块] 换到 self 后;
        // dir=1 → [self 块] 换到 [end..other-1 空行] + [other 块] 后
        let a: number, b: number, selfLines: string[], otherLines: string[], sepLines: string[];
        if (dir === -1) {
            const otherEndX = otherEnd; // 不含
            a = other;
            b = end - 1;
            otherLines = linesText(state, other, otherEndX - 1);
            sepLines = linesText(state, otherEndX, n - 1);
            selfLines = linesText(state, n, end - 1);
            const insert = [...selfLines, ...sepLines, ...otherLines].join("\n");
            const from = state.doc.line(a).from;
            const to = state.doc.line(b).to;
            view.dispatch({changes: {from, to, insert}, userEvent: "input"});
        } else {
            a = n;
            b = otherEnd - 1;
            selfLines = linesText(state, n, end - 1);
            sepLines = linesText(state, end, other - 1);
            otherLines = linesText(state, other, otherEnd - 1);
            const insert = [...otherLines, ...sepLines, ...selfLines].join("\n");
            const from = state.doc.line(a).from;
            const to = state.doc.line(b).to;
            view.dispatch({changes: {from, to, insert}, userEvent: "input"});
        }
    };
}

/** 删除块(段落=连续段;列表项=含子级;标题=整节),吞掉一侧空行避免留双空行 */
function deleteBlock(): DocOp {
    return (view, n) => {
        const state = view.state;
        if (n > state.doc.lines) return;
        const ctx = lineContext(state, n);
        const end = blockEnd(state, n, ctx);
        let a = n;
        let b = end - 1;
        // 两侧都有空行 → 连后面的空行一起删;只有前面有空行 → 删块后空行顶上即可
        if (n > 1 && state.doc.line(n - 1).text.trim() === "" &&
            end <= state.doc.lines && state.doc.line(end).text.trim() === "") {
            b = end;
        }
        // 整个文档只有这一块 → 清空
        if (n === 1 && b >= state.doc.lines) {
            view.dispatch({changes: {from: 0, to: state.doc.length, insert: ""}, userEvent: "input"});
            return;
        }
        const from = state.doc.line(a).from;
        const to = state.doc.line(b).to;
        view.dispatch({changes: {from, to, insert: ""}, userEvent: "input"});
    };
}

// ===== 4. 菜单条目(按上下文分派;只捕获行号,执行时重算) =====

interface LineMenuEntry {
    label: string;
    icon: string;
    run: DocOp;
    /** 当前态勾选(如标题级别/任务状态),label 前缀 ✓ */
    current?: boolean;
}

function lineMenuEntries(state: EditorState, n: number): LineMenuEntry[] {
    const ctx = lineContext(state, n);
    const out: LineMenuEntry[] = [];
    switch (ctx.kind) {
        case "heading": {
            for (const level of [1, 2, 3] as const) {
                out.push({label: `标题 ${level}`, icon: ICONS[`h${level}`], run: setHeading(level), current: ctx.headingLevel === level});
            }
            out.push({label: "正文", icon: ICONS.text, run: setHeading(0), current: ctx.headingLevel === 0});
            out.push({label: "上移节", icon: ICONS.up, run: moveBlock(-1)});
            out.push({label: "下移节", icon: ICONS.down, run: moveBlock(1)});
            out.push({label: "删除节", icon: ICONS.trash, run: deleteBlock()});
            break;
        }
        case "task": {
            const done = ctx.taskState
                ? state.sliceDoc(ctx.taskState.from, ctx.taskState.to).toLowerCase().includes("x")
                : false;
            out.push({label: "已完成", icon: ICONS.check, run: setTaskState(true), current: done});
            out.push({label: "未完成", icon: ICONS.square, run: setTaskState(false), current: !done});
            out.push(...listEntries(ctx, state, n, true));
            break;
        }
        case "list": {
            out.push(...listEntries(ctx, state, n, false));
            break;
        }
        case "paragraph": {
            out.push({label: "标题 1", icon: ICONS.h1, run: setHeading(1)});
            out.push({label: "标题 2", icon: ICONS.h2, run: setHeading(2)});
            out.push({label: "标题 3", icon: ICONS.h3, run: setHeading(3)});
            out.push({label: "列表项", icon: ICONS.list, run: prefixLine("- ")});
            out.push({label: "任务", icon: ICONS.task, run: prefixLine("- [ ] ")});
            out.push({label: "引用", icon: ICONS.quote, run: prefixLine("> ")});
            out.push({label: "删除段落", icon: ICONS.trash, run: deleteBlock()});
            break;
        }
        default:
            break;
    }
    return out;
}

function listEntries(ctx: LineContext, state: EditorState, n: number, isTask: boolean): LineMenuEntry[] {
    const out: LineMenuEntry[] = [];
    if (ctx.listMark) {
        const line = state.doc.line(n);
        const markOffset = ctx.listMark.from - line.from;
        const parentOffset = parentMarkOffset(state, line, ctx.listMark);
        // 缩进:插「标记+后随空格」宽(- → 2 格;1. → 3 格),有子级时禁(半树移动会破坏嵌套)
        if (!ctx.hasChildren) {
            const lm = RE_LIST.exec(line.text);
            const step = lm ? lm[2].length + (lm[3] === " " ? 1 : 0) : 2;
            out.push({label: "缩进", icon: ICONS.indent, run: indentItem(step)});
        }
        // 反缩进:删到父级列(顶层项 markOffset=parentOffset=0,不显示)
        if (markOffset > parentOffset) {
            out.push({label: "反缩进", icon: ICONS.outdent, run: indentItem(-1)});
        }
    }
    out.push({label: "上移", icon: ICONS.up, run: moveBlock(-1)});
    out.push({label: "下移", icon: ICONS.down, run: moveBlock(1)});
    if (!isTask) {
        out.push({label: "转为任务", icon: ICONS.task, run: taskifyItem()});
    }
    out.push({label: "删除项", icon: ICONS.trash, run: deleteBlock()});
    return out;
}

// ===== 6. 卡片菜单(SB block_menu/widget_menu 移植) =====
// 渲染卡片(代码卡片/表格/公式/属性面板)旁的 ⋮ 打开卡片级菜单:编辑源码 /
// 复制 Markdown / 删除块。SB 同款语义:卡片菜单只读态也保留(仅剩只读条目);
// 手柄与行级菜单共用,悬浮目标在「文本行」与「卡片」间自动切换。

/** 自绘卡片根元素的统一选择器(与 cm6-render 的卡片类名一致) */
const WIDGET_SELECTOR = ".syfe-cm-codeblock, .syfe-cm-table, .syfe-cm-math, .syfe-cm-properties, .syfe-cm-quote";

const RE_TABLE_ROW_MENU = /^\s{0,3}\|.*\|\s*$/;
const RE_MATH_DELIM = /^\s*\$\$\s*$/;

/** 覆盖第 n 行的渲染块区间(卡片菜单的编辑/复制/删除都作用于它) */
function blockSpanAt(state: EditorState, n: number): {from: number; to: number; kind: "code" | "table" | "math" | "props"} | null {
    const doc = state.doc;
    const line = doc.line(n);
    // 属性面板 = 文首闭合 frontmatter
    if (doc.lines >= 2 && /^\s*---\s*$/.test(doc.line(1).text)) {
        let end = 2;
        while (end <= doc.lines && !/^\s*---\s*$/.test(doc.line(end).text)) end++;
        if (end <= doc.lines && n <= end) {
            return {from: doc.line(1).from, to: doc.line(end).to, kind: "props"};
        }
    }
    // 围栏代码块
    for (const info of fencedCodeInfosOfState(state)) {
        const fromLine = doc.lineAt(info.from).number;
        const toLine = doc.lineAt(Math.max(info.from, info.to - 1)).number;
        if (n >= fromLine && n <= toLine) {
            return {from: info.from, to: info.to, kind: "code"};
        }
    }
    // 表格
    if (RE_TABLE_ROW_MENU.test(line.text)) {
        let head = n;
        while (head > 1 && RE_TABLE_ROW_MENU.test(doc.line(head - 1).text)) head--;
        let tail = n;
        while (tail + 1 <= doc.lines && RE_TABLE_ROW_MENU.test(doc.line(tail + 1).text)) tail++;
        return {from: doc.line(head).from, to: doc.line(tail).to, kind: "table"};
    }
    // 公式 $$ 对(含内容行)
    const isDelim = (k: number) => k >= 1 && k <= doc.lines && RE_MATH_DELIM.test(doc.line(k).text);
    let head = -1;
    let tail = -1;
    if (isDelim(n)) {
        let j = n + 1;
        while (j <= doc.lines && !isDelim(j)) j++;
        if (j <= doc.lines) {
            head = n;
            tail = j;
        } else {
            let i = n - 1;
            while (i >= 1 && !isDelim(i)) i--;
            if (i >= 1) {
                head = i;
                tail = n;
            }
        }
    } else {
        let i = n;
        while (i >= 1 && !isDelim(i)) i--;
        if (i >= 1) {
            let j = i + 1;
            while (j <= doc.lines && !isDelim(j)) j++;
            if (j <= doc.lines && n >= i && n <= j) {
                head = i;
                tail = j;
            }
        }
    }
    if (head > 0) {
        return {from: doc.line(head).from, to: doc.line(tail).to, kind: "math"};
    }
    return null;
}

/** 卡片菜单条目;只读态只剩 复制 Markdown(SB:widget 菜单只读态也保留只读条目) */
function cardMenuEntries(state: EditorState, span: {from: number; to: number; kind: string}): LineMenuEntry[] {
    const writable = !state.readOnly && state.facet(EditorView.editable) !== false;
    const out: LineMenuEntry[] = [];
    if (writable) {
        out.push({
            label: "编辑源码",
            icon: featherIcon('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>'),
            run: (view) => {
                if (span.kind === "code") {
                    // 代码卡片:与点击卡片同一编辑流(editingKey + 内嵌 CM6)
                    beginCodeEdit(view, span.from);
                    return;
                }
                // 表格/公式/属性:光标进块,渲染层翻回源码态
                view.dispatch({selection: EditorSelection.cursor(span.from + 1), scrollIntoView: true});
            },
        });
    }
    out.push({
        label: "复制 Markdown",
        icon: featherIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
        run: (view) => {
            const text = view.state.sliceDoc(span.from, span.to);
            void navigator.clipboard.writeText(text).catch(() => {});
        },
    });
    if (writable) {
        out.push({
            label: "删除块",
            icon: ICONS.trash,
            run: (view) => {
                const doc = view.state.doc;
                const fromLine = doc.lineAt(span.from).number;
                const toLine = doc.lineAt(span.to).number;
                let end = toLine;
                // 尾随空行一并删,不留双空行
                if (end + 1 <= doc.lines && doc.line(end + 1).text.trim() === "" &&
                    fromLine > 1 && doc.line(fromLine - 1).text.trim() === "") {
                    end++;
                }
                const from = doc.line(fromLine).from;
                const to = doc.line(end).to;
                // 整文档仅此块 → 清空
                if (fromLine === 1 && end >= doc.lines) {
                    view.dispatch({changes: {from: 0, to: doc.length, insert: ""}, userEvent: "syfe.indent"});
                    return;
                }
                view.dispatch({changes: {from, to, insert: ""}, userEvent: "input"});
            },
        });
    }
    return out;
}

// ===== 5. 手柄插件(SB line_handle.ts 移植) =====

// Feather "more-vertical"
const HANDLE_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>';

/** 渲染出的 .cm-line 元素(视口内),SB line_geometry.lineElement */
function lineElement(view: EditorView, line: Line): HTMLElement | undefined {
    for (const child of view.contentDOM.children) {
        if (!child.classList.contains("cm-line")) continue;
        try {
            if (view.posAtDOM(child, 0) === line.from) return child as HTMLElement;
        } catch { /* 位置失步时跳过 */ }
    }
}

/** 行是否被整行替换(卡片/属性面板):不显示手柄(SB lineIsReplaced 简化版) */
function lineIsReplaced(view: EditorView, line: Line, el: HTMLElement | undefined): boolean {
    try {
        if (view.lineBlockAt(line.from).type === BlockType.WidgetRange) return true;
    } catch { /* 高度图失步时按可见处理 */ }
    if (!el || el.getClientRects().length === 0) return true;
    return false;
}

export function cm6LineMenu(): Extension {
    return ViewPlugin.define((view: EditorView) => {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "syfe-line-handle";
        handle.innerHTML = HANDLE_ICON;
        handle.title = "行操作";
        handle.setAttribute("aria-label", "行操作");
        handle.hidden = true;
        handle.tabIndex = -1;
        // 鼠标悬停期间键入不隐藏(SB handleHovered)
        let handleHovered = false;
        // 悬浮目标:文本行 / 渲染卡片(SB Target);菜单钉住态同构
        let hovered: {line: number; card: HTMLElement | null} | undefined;
        let pinned: {line: number; card: HTMLElement | null} | undefined;
        let menuOpen = false;

        // 行级菜单需要可写;卡片菜单只读态也保留只读条目(SB 同款)
        const writable = () =>
            !view.state.readOnly && view.state.facet(EditorView.editable) !== false;

        const show = () =>
            view.requestMeasure({
                key: handle,
                read: () => {
                    const t = pinned ?? hovered;
                    if (!t || t.line > view.state.doc.lines) return null;
                    // 行级目标需要可写;卡片目标只读态保留(只读条目)
                    if (!t.card && !writable()) return null;
                    const line = view.state.doc.line(t.line);
                    if (line.text.trim() === "") return null;
                    // 卡片目标跳过「整行被替换」检查(被替换正是卡片的前提)
                    if (!t.card) {
                        const el = lineElement(view, line);
                        if (lineIsReplaced(view, line, el)) return null;
                        if (!lineMenuEntries(view.state, t.line).length) return null;
                    }
                    // 位置:行文本左缘左侧 2px,盖住行号槽(Logseq 块控件同款)
                    const coords = view.coordsAtPos(line.from, 1);
                    if (!coords) return null;
                    const scroller = view.scrollDOM.getBoundingClientRect();
                    const width = handle.offsetWidth || 20;
                    const left = coords.left - width - 2;
                    if (left < scroller.left) return null;
                    return {
                        left: left - scroller.left + view.scrollDOM.scrollLeft,
                        top: coords.top - scroller.top + view.scrollDOM.scrollTop,
                        height: coords.bottom - coords.top,
                    };
                },
                write: (at) => {
                    if (!at) {
                        handle.classList.remove("syfe-line-handle--shown");
                        delete handle.dataset.line;
                        if (!writable()) handle.hidden = true;
                        return;
                    }
                    handle.style.left = `${at.left}px`;
                    handle.style.top = `${at.top}px`;
                    handle.style.height = `${at.height}px`;
                    handle.hidden = false;
                    handle.classList.add("syfe-line-handle--shown");
                },
            });

        // 鼠标移动 → 悬浮目标(SB onMove:卡片优先,其次文本行)
        const onMove = (e: PointerEvent) => {
            if (e.pointerType !== "mouse") return;
            if (e.target instanceof Node && handle.contains(e.target)) return;
            let next: {line: number; card: HTMLElement | null} | undefined;
            // 1) 悬浮在渲染卡片上(SB cardUnder)
            const cardEl = e.target instanceof Element
                ? (e.target.closest(WIDGET_SELECTOR) as HTMLElement | null)
                : null;
            if (cardEl && cardEl.isConnected) {
                try {
                    const block = view.elementAtHeight(e.clientY - view.documentTop);
                    const n = view.state.doc.lineAt(block.from).number;
                    next = {line: n, card: cardEl};
                } catch {
                    next = undefined;
                }
                if (hovered && hovered.card === cardEl) return;
                hovered = next;
                show();
                return;
            }
            // 2) 文本行(elementAtHeight 只认文本行)
            const top = view.scrollDOM.getBoundingClientRect().top;
            let docBottom: number;
            try {
                docBottom = view.documentTop + view.lineBlockAt(view.state.doc.length).bottom;
            } catch {
                docBottom = Infinity;
            }
            if (e.clientY >= top && e.clientY <= docBottom) {
                const block = view.elementAtHeight(e.clientY - view.documentTop);
                if (block.type === BlockType.Text) {
                    next = {line: view.state.doc.lineAt(block.from).number, card: null};
                }
            }
            const same = hovered && next && hovered.line === next.line && !hovered.card && !next.card;
            if (same) return;
            hovered = next;
            show();
        };
        const unhover = () => {
            if (hovered === undefined) return;
            hovered = undefined;
            show();
        };
        // 键入隐藏(手柄被悬停时例外,SB onType)
        const onType = () => {
            if (!handleHovered) unhover();
        };

        // 选取执行:选区不触该行时把光标钉到行文本起点(SB selectionForPick)
        const onRun = (n: number, run: DocOp) => {
            if (n > view.state.doc.lines) return;
            const target = view.state.doc.line(n);
            const {from, to} = view.state.selection.main;
            if (!(from <= target.to && to >= target.from)) {
                view.dispatch({selection: EditorSelection.single(lineTextStart(view.state, target))});
            }
            view.focus();
            run(view, n);
        };

        // 关闭复位:任意 document 点击(含选中条目)/Escape 后复位钉住态。
        // 思源 Menu 无 onClose;once 捕获 + 微延时保证条目 click 先跑完。
        const armClose = () => {
            const reset = () => {
                setTimeout(() => {
                    menuOpen = false;
                    pinned = undefined;
                    show();
                }, 60);
            };
            document.addEventListener("click", reset, {capture: true, once: true});
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape") reset();
            }, {capture: true, once: true});
        };

        const openMenu = () => {
            // 旗标自愈:菜单可能经非 click 路径关闭(Esc 兜底/异常路径),单例实际
            // 已关而旗标未复位时,清旗标继续开
            if (menuOpen) {
                const el = (window as any).siyuan?.menus?.menu?.element;
                if (!el || el.classList.contains("fn__none") || el.getBoundingClientRect().width === 0) {
                    menuOpen = false;
                    pinned = undefined;
                } else {
                    return;
                }
            }
            const t = pinned ?? hovered;
            if (!t || t.line > view.state.doc.lines) return;
            // 卡片目标 → 卡片菜单(编辑/复制/删除,作用于覆盖该行的渲染块)
            const entries = t.card
                ? (() => {
                    const span = blockSpanAt(view.state, t.line);
                    return span ? cardMenuEntries(view.state, span) : [];
                })()
                : lineMenuEntries(view.state, t.line);
            if (!entries.length) return;
            pinned = t;
            menuOpen = true;
            armClose();
            const menu = new Menu();
            for (const entry of entries) {
                menu.addItem({
                    // 思源 MenuItem 的 icon 参数是 <use xlink:href="#id"> 的图标 ID,
                    // 自带 SVG 走 iconHTML;勾选态用原生 checked
                    iconHTML: entry.icon,
                    label: entry.label,
                    checked: entry.current,
                    click: () => onRun(t.line, entry.run),
                });
            }
            const r = handle.getBoundingClientRect();
            menu.open({x: r.right + 4, y: r.top});
        };

        view.scrollDOM.addEventListener("pointermove", onMove);
        view.scrollDOM.addEventListener("pointerover", onMove);
        view.scrollDOM.addEventListener("pointerleave", unhover);
        view.contentDOM.addEventListener("keydown", onType);
        handle.addEventListener("pointerenter", () => {
            handleHovered = true;
        });
        handle.addEventListener("pointerleave", () => {
            handleHovered = false;
        });
        // 不把事件漏给编辑器(SB:保焦点保选区)。⚠ mousedown preventDefault 会
        // 抑制后续 click 事件(本 Electron 实测)——所以菜单直接在 mousedown 开,
        // 不依赖 click;menuOpen 门槛挡住 mouseup 后可能补发的 click 重复开启。
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu();
        });
        handle.addEventListener("click", (e) => {
            e.stopPropagation();
            openMenu();
        });
        view.scrollDOM.appendChild(handle);
        show();

        return {
            update(update) {
                if (update.docChanged) {
                    const mapLine = (line: number) =>
                        update.state.doc.lineAt(
                            update.changes.mapPos(
                                update.startState.doc.line(
                                    Math.min(line, update.startState.doc.lines),
                                ).from,
                            ),
                        ).number;
                    if (hovered) hovered = {line: mapLine(hovered.line), card: hovered.card};
                    if (pinned) pinned = {line: mapLine(pinned.line), card: pinned.card};
                    if (
                        update.transactions.some(
                            (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
                        )
                    ) {
                        onType();
                    }
                }
                if (
                    update.docChanged ||
                    update.geometryChanged ||
                    update.viewportChanged ||
                    update.selectionSet ||
                    update.focusChanged
                ) {
                    show();
                }
            },
            destroy() {
                view.scrollDOM.removeEventListener("pointermove", onMove);
                view.scrollDOM.removeEventListener("pointerover", onMove);
                view.scrollDOM.removeEventListener("pointerleave", unhover);
                view.contentDOM.removeEventListener("keydown", onType);
                handle.remove();
            },
        };
    });
}
