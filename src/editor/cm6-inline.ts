// CM6 Markdown 行内 WYSIWYM 扩展(「编辑器 = CM6」选项的 Obsidian 级体验层)
//
// 定位:与 cm6-render.ts(块级富渲染)互补,补上行内这一半 ——
//  - **粗体** / *斜体* / ~~删除线~~ / ==高亮== / `行内码` 的标记符号在光标
//    离开时隐藏,光标/选区触到节点即还原源码(Obsidian 同款编辑模型)
//  - 标题行首 `# ` 隐藏、引用块 `>` 隐藏 + 左侧竖条、任务清单真实复选框、
//    分隔线渲染成横线、链接只显示文字(Ctrl/Cmd+点击打开)
//  - Ctrl+B/I/E、Ctrl+Shift+X/H、Ctrl+K 快捷切换格式,Enter 延续列表/引用
//
// 实现移植自两个 MIT 开源库的算法(按本插件约定重写,零运行时依赖):
//  - purrmd(https://github.com/luoluoqixi/purrmd):==高亮== 解析器、焦点同步、
//    选区按行判断、任务复选框 widget、toggle 格式化、Enter 列表延续(源自 CM5)
//  - ProseMark(https://github.com/jsimonrichard/ProseMark):font-size:0 隐藏
//    策略(避免 display:none 的布局跳动)、隐藏区点击命中测试、链接 GFM
//    autolink 边界修正、转义符单词级揭示
//
// 主题:全部走思源 CSS 变量(--b3-*),类名 syfe-cm-*;美观样式集中在
// cm6-markdown.ts 的 syfeCmTheme,这里只带功能性的隐藏样式。
import {EditorSelection, EditorState, Extension, Prec, Range, SelectionRange, StateField, Text, Line, Transaction, TransactionSpec, CharCategory, countColumn, findClusterBreak} from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    Direction,
    EditorView,
    WidgetType,
    Command,
    keymap,
} from "@codemirror/view";
import {indentUnit, syntaxTree} from "@codemirror/language";
import {markdownLanguage} from "@codemirror/lang-markdown";
import type {SyntaxNode, SyntaxNodeRef} from "@lezer/common";

export interface Cm6InlineOptions {
    /** Ctrl/Cmd+点击链接时打开;不传则 window.open(宿主可接 shell.openExternal) */
    onOpenLink?(url: string): void;
}

// ===== 1. 解析器扩展(移植自 purrmd getMarkdownSyntaxTags) =====
// lezer-markdown 原生不认 ==高亮==,这里加一对分隔符节点;转义符加 EscapeMark
// 子节点便于隐藏。塞进 markdown({extensions: [...]}) 使用。

const HighlightDelim = {resolve: "Highlight", mark: "HighlightMark"};

const highlightParser = {
    defineNodes: ["Highlight", "HighlightMark"],
    parseInline: [{
        name: "Highlight",
        parse(cx: any, next: number, pos: number): number {
            if (next != 61 /* '=' */ || cx.char(pos + 1) != 61) return -1;
            return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
        },
        after: "Emphasis",
    }],
};

const escapeMarkParser = {
    defineNodes: [{name: "EscapeMark"}],
    parseInline: [{
        name: "EscapeMark",
        parse(cx: any, next: number, pos: number): number {
            if (next !== 92 /* '\\' */) return -1;
            return cx.addElement(cx.elt("Escape", pos, pos + 2, [cx.elt("EscapeMark", pos, pos + 1)]));
        },
        before: "Escape",
    }],
};

/** 传入 markdown() 的 extensions 参数 */
export const mdParserExtensions = [highlightParser, escapeMarkParser];

// ===== 2. 焦点同步(移植自 purrmd state/focus) =====
// 失焦不产生事务,但装饰需要在失焦时重新隐藏 —— 用 userEvent 自派发补一拍。

const inlineFocusState = StateField.define<boolean>({
    create: () => false,
    update: (value, tr) => {
        if (tr.isUserEvent("cm-focus")) return true;
        if (tr.isUserEvent("cm-blur")) return false;
        return value;
    },
});

const focusListener = EditorView.updateListener.of((update) => {
    if (update.focusChanged) {
        requestAnimationFrame(() => {
            update.view.dispatch({
                userEvent: update.view.hasFocus ? "cm-focus" : "cm-blur",
            });
        });
    }
});

const hasFocus = (state: EditorState): boolean => state.field(inlineFocusState, false) === true;

const isFocusEvent = (tr: Transaction): boolean =>
    tr.isUserEvent("cm-focus") || tr.isUserEvent("cm-blur");

// ===== 3. 隐藏策略与命中测试(移植自 ProseMark hide/core) =====
// 用 font-size:0 而非 display:none:文本不 reflow,光标进出时版面不跳。
// 代价是 0 宽字符会让 CM 的 posAtCoords 把点击映射进隐藏区,因此配一套
// 只认正宽字符矩形的命中测试。

const HIDDEN_CLASS = "syfe-cm-hidden";

const hiddenDeco = Decoration.mark({class: HIDDEN_CLASS});

const hideTheme = EditorView.theme({
    [`.${HIDDEN_CLASS}`]: {fontSize: "0px"},
});

interface BaseRange {
    from: number;
    to: number;
}

const rangeTouchesRange = (a: BaseRange, b: BaseRange): boolean =>
    a.from <= b.to && b.from <= a.to;

/** 选区(光标)触到 [from,to] 即还原源码;失焦时一律视为未触到(重新隐藏) */
const selectionTouches = (state: EditorState, from: number, to: number): boolean => {
    if (!hasFocus(state)) return false;
    return state.selection.ranges.some((r) => rangeTouchesRange({from, to}, r));
};

/** 选区是否覆盖 [from,to] 所在的行(引用块 > 标记按行还原用) */
const selectionTouchesLine = (state: EditorState, pos: number): boolean => {
    if (!hasFocus(state)) return false;
    const doc = state.doc;
    const ln = doc.lineAt(pos).number;
    return state.selection.ranges.some((r) => {
        const rf = doc.lineAt(r.from).number;
        const rt = doc.lineAt(r.to).number;
        return ln >= rf && ln <= rt;
    });
};

/** 遍历子树中名字匹配的节点(移植自 purrmd iterSubNodes) */
function iterSubNodes(
    node: SyntaxNode,
    subNodeName: string,
    cb: (node: SyntaxNodeRef) => void,
): void {
    const cursor = node.cursor();
    cursor.iterate((n) => {
        if (n.type.name === subNodeName) cb(n);
    });
}

function isInsideFencedCode(state: EditorState, from: number): boolean {
    let node: SyntaxNode | null = syntaxTree(state).resolve(from);
    while (node) {
        if (node.name === "FencedCode") return true;
        node = node.parent;
    }
    return false;
}

/** pos 所在的"单词"区间(移植自 ProseMark stateWORDAt) */
function stateWORDAt(state: EditorState, pos: number): {from: number; to: number} | null {
    const {text, from, length} = state.doc.lineAt(pos);
    const cat = state.charCategorizer(pos);
    let start = pos - from;
    let end = pos - from;
    while (start > 0) {
        const prev = findClusterBreak(text, start, false);
        if (cat(text.slice(prev, start)) === CharCategory.Space) break;
        start = prev;
    }
    while (end < length) {
        const next = findClusterBreak(text, end);
        if (cat(text.slice(end, next)) === CharCategory.Space) break;
        end = next;
    }
    return start === end ? null : {from: start + from, to: end + from};
}

interface VisibleCharRect {
    from: number;
    to: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** 用正宽字符矩形把坐标映射回文档位置(ProseMark posFromVisibleCharRects) */
function posFromVisibleCharRects(
    coords: {x: number; y: number},
    rects: readonly VisibleCharRect[],
    ltr: boolean,
): number | null {
    if (rects.length === 0) return null;
    let closest: VisibleCharRect | undefined;
    let closestDx = 1e9;
    let above: VisibleCharRect | undefined;
    let below: VisibleCharRect | undefined;
    for (const rect of rects) {
        if (rect.bottom < coords.y) {
            if (!above || above.bottom < rect.bottom) above = rect;
            continue;
        }
        if (rect.top > coords.y) {
            if (!below || below.top > rect.top) below = rect;
            continue;
        }
        const off = rect.left > coords.x
            ? coords.x - rect.left
            : rect.right < coords.x ? coords.x - rect.right : 0;
        const dx = Math.abs(off);
        if (dx < closestDx) {
            closestDx = dx;
            closest = rect;
        }
    }
    if (!closest) {
        const side = above && (!below || coords.y - above.bottom < below.top - coords.y)
            ? above
            : below;
        if (!side) return null;
        return posFromVisibleCharRects({x: coords.x, y: (side.top + side.bottom) / 2}, rects, ltr);
    }
    const after = coords.x > (closest.left + closest.right) / 2 === ltr;
    return after ? closest.to : closest.from;
}

/** 收集一行里的正宽字符簇;存在塌缩簇(隐藏标记)时返回 collapsed=true */
function collectVisibleCharRects(
    view: EditorView,
    lineFrom: number,
    lineTo: number,
): {rects: VisibleCharRect[]; collapsed: boolean} {
    const text = view.state.doc.sliceString(lineFrom, lineTo);
    const rects: VisibleCharRect[] = [];
    let collapsed = false;
    for (let i = 0; i < text.length;) {
        const next = findClusterBreak(text, i);
        const from = lineFrom + i;
        const to = lineFrom + next;
        const rect = view.coordsForChar(from);
        if (rect != null && rect.left < rect.right && rect.top < rect.bottom) {
            rects.push({from, to, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom});
        } else {
            collapsed = true;
        }
        i = next;
    }
    return {rects, collapsed};
}

/** 坐标 → 文档位置,忽略隐藏标记(ProseMark visiblePosAtCoords) */
function visiblePosAtCoords(view: EditorView, coords: {x: number; y: number}): number | null {
    if (view.state.field(inlineFocusState, false) === undefined) {
        return view.posAtCoords(coords);
    }
    const content = view.contentDOM.getBoundingClientRect();
    const yOffset = coords.y - content.top - view.documentPadding.top;
    if (yOffset < 0 || yOffset > view.contentHeight) return view.posAtCoords(coords);
    const block = view.lineBlockAtHeight(yOffset);
    const line = view.state.doc.lineAt(block.from);
    const {rects, collapsed} = collectVisibleCharRects(view, line.from, line.to);
    if (!collapsed) return view.posAtCoords(coords);
    if (rects.length === 0) return null;
    const ltr = view.textDirectionAt(line.from) === Direction.LTR;
    return posFromVisibleCharRects(coords, rects, ltr);
}

function rangeForVisibleClick(view: EditorView, pos: number, clickType: number): SelectionRange {
    if (clickType >= 3) {
        const line = view.state.doc.lineAt(pos);
        return EditorSelection.range(line.from, line.to);
    }
    if (clickType === 2) {
        const word = stateWORDAt(view.state, pos);
        if (word) return EditorSelection.range(word.from, word.to);
        return EditorSelection.cursor(pos);
    }
    return EditorSelection.cursor(pos);
}

/** 鼠标选区改走 visiblePosAtCoords,点击/拖选都不会落进隐藏标记 */
const pointerSelectionExtension = EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0) return null;
    const coords = {x: event.clientX, y: event.clientY};
    const start = visiblePosAtCoords(view, coords);
    if (start == null) return null;

    let startPos = start;
    let startSel = view.state.selection;
    const clickType = event.detail;
    return {
        update(update) {
            if (update.docChanged) {
                startPos = update.changes.mapPos(startPos);
                startSel = startSel.map(update.changes);
            }
        },
        get(curEvent, extend, multiple) {
            const cur = visiblePosAtCoords(view, {x: curEvent.clientX, y: curEvent.clientY}) ?? startPos;
            let range = rangeForVisibleClick(view, cur, clickType);
            if (startPos != cur && !extend) {
                // 与 CM 默认拖选规则一致:从起点区段扩到当前区段
                const startRange = rangeForVisibleClick(view, startPos, clickType);
                const from = Math.min(startRange.from, range.from);
                const to = Math.max(startRange.to, range.to);
                range = from < range.from
                    ? EditorSelection.range(from, to, range.assoc)
                    : EditorSelection.range(to, from, range.assoc);
            }
            if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to));
            if (multiple) return startSel.addRange(range);
            return EditorSelection.create([range]);
        },
    };
});

// ===== 4. Widgets =====

/** 任务清单复选框(移植自 purrmd list.ts,勾选直接改写 [x]/[ ]) */
class TaskCheckboxWidget extends WidgetType {
    constructor(readonly checked: boolean, readonly pos: number) {
        super();
    }

    eq(other: TaskCheckboxWidget): boolean {
        return other.checked === this.checked && other.pos === this.pos;
    }

    toDOM(view: EditorView): HTMLElement {
        const el = document.createElement("input");
        el.type = "checkbox";
        el.className = "syfe-cm-md-checkbox";
        el.checked = this.checked;
        el.tabIndex = -1;
        el.contentEditable = "false";
        el.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        el.onchange = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = (e.target as HTMLInputElement).checked;
            // 勾选状态直接写回文档([x] ↔ [ ]);doc 变更会触发装饰重建
            view.dispatch({
                changes: {from: this.pos + 1, to: this.pos + 2, insert: next ? "x" : " "},
                userEvent: "input",
            });
        };
        return el;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/** 分隔线:--- 渲染成横线(点击落光标即还原源码) */
class HRWidget extends WidgetType {
    eq(): boolean {
        return true;
    }

    toDOM(): HTMLElement {
        const el = document.createElement("span");
        el.className = "syfe-cm-md-hr";
        el.contentEditable = "false";
        return el;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

// ===== 5. 主 StateField:一次语法树遍历产出全部行内装饰 =====

const mdLinkDeco = Decoration.mark({class: "syfe-cm-md-link"});
const mdHighlightDeco = Decoration.mark({class: "syfe-cm-md-highlight"});
const mdInlineCodeDeco = Decoration.mark({class: "syfe-cm-md-inline-code"});
const mdQuoteLineDeco = Decoration.line({class: "syfe-cm-md-quote-line"});
const mdBulletMarkDeco = Decoration.mark({class: "syfe-cm-md-listmark-bullet"});
const mdOrderedMarkDeco = Decoration.mark({class: "syfe-cm-md-listmark-ordered"});

// Callout:> [!type] 标题 —— 两库都没有,按 Obsidian 语义自研(类型映射见 CSS)
const RE_CALLOUT = /\[!(\w+)\]([+-]?)/;

/** Obsidian callout 类型 → 语义类名(颜色/图标在 CSS 侧) */
function calloutTypeClass(rawType: string): string | null {
    const t = rawType.toLowerCase();
    const map: Record<string, string> = {
        note: "note", abstract: "abstract", summary: "abstract", tldr: "abstract",
        info: "info", todo: "info",
        tip: "tip", hint: "tip", important: "tip",
        success: "success", check: "success", done: "success",
        question: "question", help: "question", faq: "question",
        warning: "warning", caution: "warning", attention: "warning",
        danger: "danger", error: "danger", bug: "danger",
        example: "example", quote: "quote", cite: "quote",
    };
    return map[t] ? `syfe-cm-callout-${map[t]}` : null;
}

interface InlineDecoSet {
    decorations: DecorationSet;
    atomic: DecorationSet;
}

function buildInlineDecorations(state: EditorState, opts: Cm6InlineOptions): InlineDecoSet {
    const deco: Range<Decoration>[] = [];
    const atomic: Range<Decoration>[] = [];
    const seen = new Set<string>();
    const push = (d: Range<Decoration>, isAtomic: boolean) => {
        const key = `${d.from}:${d.to}:${d.value.spec.class ?? "widget"}`;
        if (seen.has(key)) return;
        seen.add(key);
        deco.push(d);
        if (isAtomic) atomic.push(d);
    };
    const hideRange = (from: number, to: number) => {
        const d = hiddenDeco.range(from, to);
        push(d, true);
    };
    const doc = state.doc;

    syntaxTree(state).iterate({
        enter(node) {
            const name = node.name;

            // --- 加粗 / 斜体 / 删除线 / 高亮:隐藏两侧标记 ---
            if (name === "StrongEmphasis" || name === "Emphasis" ||
                name === "Strikethrough" || name === "Highlight") {
                if (selectionTouches(state, node.from, node.to)) return;
                const markName = name === "Strikethrough"
                    ? "StrikethroughMark"
                    : name === "Highlight" ? "HighlightMark" : "EmphasisMark";
                iterSubNodes(node.node, markName, (m) => hideRange(m.from, m.to));
                if (name === "Highlight") push(mdHighlightDeco.range(node.from, node.to), false);
                return;
            }

            // --- 行内码:底色样式 + 隐藏反引号(围栏代码块内不处理) ---
            if (name === "InlineCode") {
                if (isInsideFencedCode(state, node.from)) return;
                if (!selectionTouches(state, node.from, node.to)) {
                    iterSubNodes(node.node, "CodeMark", (m) => hideRange(m.from, m.to));
                }
                push(mdInlineCodeDeco.range(node.from, node.to), false);
                return;
            }

            // --- ATX 标题:隐藏行首 "# " ---
            if (name.startsWith("ATXHeading")) {
                const header = node.node.firstChild;
                if (!header || header.name !== "HeaderMark") return;
                if (selectionTouches(state, node.from, node.to)) return;
                hideRange(header.from, Math.min(header.to + 1, node.to));
                return;
            }

            // --- Setext 标题:隐藏下划线行(整块替换,避免留空行) ---
            if (name.startsWith("SetextHeading")) {
                if (selectionTouches(state, node.from, node.to)) return;
                iterSubNodes(node.node, "HeaderMark", (m) => {
                    // block replace 必须覆盖整行,扩到行边界(行尾可能有空白)
                    const l = doc.lineAt(m.from);
                    const d = Decoration.replace({block: true}).range(l.from, doc.lineAt(m.to).to);
                    push(d, true);
                });
                return;
            }

            // --- 链接 / 行内图片:只显示文字,隐藏标记与地址 ---
            // ProseMark 的修正:URL 只在 "]" 之后隐藏,否则
            // [http://…](http://…) 这类纯地址链接会被整个吞掉
            if (name === "Link" || name === "Image") {
                const reveal = selectionTouches(state, node.from, node.to);
                let pastLabel = false;
                for (let child = node.node.firstChild; child; child = child.nextSibling) {
                    if (child.name === "LinkMark") {
                        if (doc.sliceString(child.from, child.to) === "]") pastLabel = true;
                        if (!reveal) hideRange(child.from, child.to);
                    } else if (child.name === "URL" && pastLabel) {
                        if (!reveal) hideRange(child.from, child.to);
                    }
                }
                if (!reveal) push(mdLinkDeco.range(node.from, node.to), false);
                return;
            }

            // --- 引用块:整段行样式 + 按行隐藏 ">"(该行有选区则还原) ---
            // Callout(> [!type] 标题)是引用块的超集:行样式换成类型配色,
            // 并隐藏 [!type] 标记、给标题加图标
            if (name === "Blockquote") {
                const fromLine = doc.lineAt(node.from).number;
                const toLine = doc.lineAt(node.to).number;
                const firstLine = doc.lineAt(node.from);
                const cm = RE_CALLOUT.exec(firstLine.text);
                let coClass: string | null = null;
                if (cm && /^[\s>]*$/.test(firstLine.text.slice(0, cm.index))) {
                    coClass = calloutTypeClass(cm[1]);
                }
                for (let ln = fromLine; ln <= toLine; ln++) {
                    if (coClass) {
                        deco.push(Decoration.line({
                            class: `syfe-cm-callout ${coClass}`,
                        }).range(doc.line(ln).from));
                    } else {
                        deco.push(mdQuoteLineDeco.range(doc.line(ln).from));
                    }
                }
                if (coClass && cm) {
                    // 隐藏 [!type]+/- 标记(与普通标记同款:选区触到即还原)
                    const markFrom = firstLine.from + cm.index;
                    const markTo = markFrom + cm[0].length;
                    if (!selectionTouches(state, markFrom, markTo)) {
                        hideRange(markFrom, markTo);
                    }
                    // 标题:标记后的非空文本加粗 + 类型图标(CSS ::before)
                    const titleFrom = markTo;
                    const titleText = firstLine.text.slice(cm.index + cm[0].length);
                    const lead = titleText.length - titleText.trimStart().length;
                    const tFrom = titleFrom + lead;
                    if (titleText.trim() && !selectionTouches(state, tFrom, firstLine.to)) {
                        deco.push(Decoration.mark({
                            class: `syfe-cm-callout-title ${coClass}`,
                        }).range(tFrom, firstLine.to));
                    }
                }
                iterSubNodes(node.node, "QuoteMark", (m) => {
                    if (!selectionTouchesLine(state, m.from)) hideRange(m.from, m.to);
                });
                return;
            }

            // --- 列表标记:无序 → 隐藏原字符显示圆点;有序 → 数字样式化 ---
            // 结构判断借鉴 PurrMD list.ts(ListMark 的父是 ListItem,祖父是
            // BulletList/OrderedList;ListItem 的下一个子是 Task 即任务项,
            // 任务项交给 TaskMarker 分支整体替换,这里跳过)
            if (name === "ListMark") {
                const listItem = node.node.parent;
                const root = listItem && listItem.name === "ListItem" ? listItem.parent : null;
                if (!listItem || !root) return;
                if (selectionTouches(state, node.from, node.to)) return;
                const after = listItem.node.firstChild === node.node ? node.node.nextSibling : null;
                if (after && after.name === "Task") return;   // 任务项:另一分支处理
                if (root.name === "BulletList") {
                    // 原子化:方向键直接跳过原字符,与 Obsidian 一致
                    push(mdBulletMarkDeco.range(node.from, node.to), true);
                } else if (root.name === "OrderedList") {
                    push(mdOrderedMarkDeco.range(node.from, node.to), false);
                }
                return;
            }

            // --- 任务清单:复选框直接替换 "- [ ]"(ListMark+空格+TaskMarker,
            //     复选框本身就是项目符号,PurrMD list.ts 同思路) ---
            if (name === "TaskMarker") {
                const parent = node.node.parent;
                const item = parent && parent.name === "Task" ? parent.parent : null;
                if (!item || item.name !== "ListItem") return;
                const listMark = parent!.prevSibling;
                const from = listMark && listMark.name === "ListMark" ? listMark.from : node.from;
                if (selectionTouches(state, from, node.to)) return;
                const checked = doc.sliceString(node.from + 1, node.to - 1).toLowerCase() === "x";
                const d = Decoration.replace({
                    widget: new TaskCheckboxWidget(checked, node.from),
                }).range(from, node.to);
                push(d, true);
                return;
            }

            // --- 分隔线:渲染成横线 ---
            if (name === "HorizontalRule") {
                if (selectionTouches(state, node.from, node.to)) return;
                const l = doc.lineAt(node.from);
                const d = Decoration.replace({widget: new HRWidget()})
                    .range(l.from, doc.lineAt(node.to).to);   // 覆盖整行(含行尾空白)
                push(d, true);
                return;
            }

            // --- 转义:隐藏反斜杠,除非选区触到它所在的单词 ---
            if (name === "Escape") {
                if (selectionTouches(state, node.from, node.to)) return;
                const word = stateWORDAt(state, node.from);
                const zone = word && word.to > node.from + 1 ? word : {from: doc.lineAt(node.from).from, to: doc.lineAt(node.from).to};
                if (selectionTouches(state, zone.from, zone.to)) return;
                iterSubNodes(node.node, "EscapeMark", (m) => hideRange(m.from, m.to));
                return;
            }
        },
    });

    return {
        decorations: Decoration.set(deco, true),
        atomic: Decoration.set(atomic, true),
    };
}

function inlineField(opts: Cm6InlineOptions): Extension {
    return StateField.define<InlineDecoSet>({
        create: (st) => buildInlineDecorations(st, opts),
        update: (value, tr) => {
            if (
                tr.docChanged || tr.selection || isFocusEvent(tr) ||
                syntaxTree(tr.startState) !== syntaxTree(tr.state)   // 异步语法树建好后补一帧
            ) {
                return buildInlineDecorations(tr.state, opts);
            }
            return {
                decorations: value.decorations.map(tr.changes),
                atomic: value.atomic.map(tr.changes),
            };
        },
        provide: (f) => [
            EditorView.decorations.from(f, (v) => v.decorations),
            // atomicRanges 是「函数值」型 facet,须用 .of(view => ...) 供值
            EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
        ],
    });
}

// ===== 6. 链接点击打开 =====

/** 取 pos 所在链接/图片的 URL(与装饰同款「] 之后的 URL」规则) */
function findLinkUrl(state: EditorState, pos: number): string | null {
    let cur: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    while (cur && cur.name !== "Link" && cur.name !== "Image") cur = cur.parent;
    if (!cur) return null;
    let pastLabel = false;
    for (let child = cur.firstChild; child; child = child.nextSibling) {
        if (child.name === "LinkMark") {
            if (state.sliceDoc(child.from, child.to) === "]") pastLabel = true;
        } else if (child.name === "URL" && pastLabel) {
            return state.sliceDoc(child.from, child.to);
        }
    }
    return null;
}

function linkClickHandler(opts: Cm6InlineOptions): Extension {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const target = event.target as HTMLElement;
            const el = target.closest(".syfe-cm-md-link") as HTMLElement | null;
            if (!el) return false;
            const pos = view.posAtDOM(el);
            const url = findLinkUrl(view.state, pos);
            if (!url) return false;
            event.preventDefault();
            if (opts.onOpenLink) opts.onOpenLink(url);
            else window.open(url, "_blank");
            return true;
        },
    });
}

// ===== 7. 格式化切换命令(算法出自 ProseMark markdownFormattingKeymap,简化重写) =====
// 找到与选区重叠的最外层同名节点:命中则整体解除并选回内文(选区跨节点边界时
// 同样整体解除,避免产出破碎标记);未命中则包裹选区。changeByRange 预计算
// 保证多光标一次事务完成。

function isMarkdownContext(state: EditorState, pos: number): boolean {
    return markdownLanguage.isActiveAt(state, pos, -1) || markdownLanguage.isActiveAt(state, pos, 1);
}

function findOutermostOverlappingNode(
    state: EditorState,
    from: number,
    to: number,
    predicate: (n: SyntaxNode) => boolean,
): SyntaxNode | null {
    const tree = syntaxTree(state);
    let found: SyntaxNode | null = null;
    for (let pos = from; pos <= to; pos++) {
        let node: SyntaxNode | null = tree.resolveInner(pos, 1);
        while (node) {
            if (node.to < from || node.from > to) break;
            if (predicate(node)) {
                if (!found || node.from < found.from || node.to > found.to) found = node;
            }
            node = node.parent;
        }
    }
    return found;
}

interface ToggleSpec {
    range: SelectionRange;
    changes: {from: number; to: number; insert: string};
}

function computeToggle(
    state: EditorState,
    range: {from: number; to: number},
    nodeName: string,
    open: string,
    close: string,
): ToggleSpec | null {
    const {from, to} = range;
    const outer = findOutermostOverlappingNode(state, from, to, (n) => n.name === nodeName);
    if (outer) {
        const innerFrom = outer.from + open.length;
        const innerTo = outer.to - close.length;
        if (innerFrom > innerTo) return null;
        const insert = state.sliceDoc(innerFrom, innerTo);
        return {
            changes: {from: outer.from, to: outer.to, insert},
            range: EditorSelection.range(outer.from, outer.from + insert.length),
        };
    }
    const text = state.sliceDoc(from, to);
    return {
        changes: {from, to, insert: open + text + close},
        range: EditorSelection.range(from + open.length, from + open.length + text.length),
    };
}

function makeToggleInlineCommand(nodeName: string, open: string, close: string): Command {
    return (view) => {
        const {state} = view;
        const specs: ToggleSpec[] = [];
        for (const range of state.selection.ranges) {
            if (!isMarkdownContext(state, range.from)) return false;
            const spec = computeToggle(state, range, nodeName, open, close);
            if (!spec) return false;
            specs.push(spec);
        }
        let i = 0;
        view.dispatch({
            ...state.changeByRange(() => specs[i++] as {range: SelectionRange; changes: any}),
            scrollIntoView: true,
            userEvent: "input",
        } as TransactionSpec);
        return true;
    };
}

/** 选区包成 [label](),光标落在括号内等输 URL(ProseMark insertLink) */
const insertLinkCommand: Command = (view) => {
    const {state} = view;
    for (const range of state.selection.ranges) {
        if (!isMarkdownContext(state, range.from)) return false;
    }
    view.dispatch({
        ...state.changeByRange((range) => {
            const label = state.sliceDoc(range.from, range.to);
            const insert = range.empty ? "[]()" : `[${label}]()`;
            const head = range.empty ? range.from + 1 : range.from + 1 + label.length + 2;
            return {
                changes: {from: range.from, to: range.to, insert},
                range: EditorSelection.cursor(head),
            };
        }),
        scrollIntoView: true,
        userEvent: "input",
    } as TransactionSpec);
    return true;
};

// ===== 8. Enter 延续列表 / 引用(移植自 purrmd command/newline,血统为 CM5 算法) =====

class ContinueContext {
    constructor(
        readonly node: SyntaxNode,
        readonly from: number,
        readonly to: number,
        readonly spaceBefore: string,
        readonly spaceAfter: string,
        readonly type: string,
        readonly item: SyntaxNode | null,
    ) {}

    blank(maxWidth: number | null, trailing = true): string {
        let result = this.spaceBefore + (this.node.name === "Blockquote" ? ">" : "");
        if (maxWidth != null) {
            while (result.length < maxWidth) result += " ";
            return result;
        }
        for (let i = this.to - this.from - result.length - this.spaceAfter.length; i > 0; i--) {
            result += " ";
        }
        return result + (trailing ? this.spaceAfter : "");
    }

    marker(doc: Text, add: number): string {
        const number = this.node.name === "OrderedList"
            ? String(Number(itemNumber(this.item!, doc)[2]) + add)
            : "";
        let type = this.type;
        if (type.includes("[") && this.node.name === "OrderedList") {
            type = type.replace(/([.)])(\s*\[[ xX]\]\s*)/, (_: string, p1: string) => `${p1} [ ] `);
            return this.spaceBefore + number + type;
        }
        return this.spaceBefore + number + this.type + this.spaceAfter;
    }
}


function getContext(node: SyntaxNode, doc: Text): ContinueContext[] {
    const nodes: SyntaxNode[] = [];
    const context: ContinueContext[] = [];
    for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
        if (cur.name === "FencedCode") return context;
        if (cur.name === "ListItem" || cur.name === "Blockquote") nodes.push(cur);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        let match: RegExpExecArray | null;
        const line = doc.lineAt(n.from);
        const startPos = n.from - line.from;
        if (n.name === "Blockquote" && (match = /^ *>( ?)/.exec(line.text.slice(startPos)))) {
            context.push(new ContinueContext(n, startPos, startPos + match[0].length, "", match[1], ">", null));
        } else if (
            n.name === "ListItem" && n.parent && n.parent.name === "OrderedList" &&
            (match = /^( *)(\d+)([.)])( {1,4}\[[ xX]\])?(\s*)/.exec(line.text.slice(startPos)))
        ) {
            let after = match[5] || " ";
            const len = match[0].length;
            let type = match[3];
            if (match[4]) {
                type += " [ ] ";
                after = after.slice(0, 1);
            }
            context.push(new ContinueContext(n.parent!, startPos, startPos + len, match[1], after, type, n));
        } else if (
            n.name === "ListItem" && n.parent && n.parent.name === "BulletList" &&
            (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(line.text.slice(startPos)))
        ) {
            let after = match[4];
            let len = match[0].length;
            if (after.length > 4) {
                after = after.slice(0, after.length - 4);
                len -= 4;
            }
            let type = match[2];
            if (match[3]) type += match[3].replace(/[xX]/, " ");
            context.push(new ContinueContext(n.parent!, startPos, startPos + len, match[1], after, type, n));
        }
    }
    return context;
}

function itemNumber(item: SyntaxNode, doc: Text): RegExpExecArray {
    return /^(\s*)(\d+)(?=[.)])/.exec(doc.sliceString(item.from, item.from + 10))!;
}

function renumberList(after: SyntaxNode, doc: Text, changes: Array<{from: number; to?: number; insert?: string}>, offset = 0): void {
    for (let prev = -1, node: SyntaxNode | null = after; node;) {
        if (node.name === "ListItem") {
            const m = itemNumber(node, doc);
            const number = Number(m[2]);
            if (prev >= 0) {
                if (number !== prev + 1) return;
                changes.push({
                    from: node.from + m[1].length,
                    to: node.from + m[0].length,
                    insert: String(prev + 2 + offset),
                });
            }
            prev = number;
        }
        const next: SyntaxNode | null = node.nextSibling;
        if (!next) break;
        node = next;
    }
}

function normalizeIndent(content: string, state: EditorState): string {
    const blank = /^[ \t]*/.exec(content)![0].length;
    if (!blank || state.facet(indentUnit) !== "\t") return content;
    const col = countColumn(content, 4, blank);
    let space = "";
    for (let i = col; i > 0;) {
        if (i >= 4) {
            space += "\t";
            i -= 4;
        } else {
            space += " ";
            i--;
        }
    }
    return space + content.slice(blank);
}

function nonTightList(node: SyntaxNode, doc: Text): boolean {
    if (node.name !== "OrderedList" && node.name !== "BulletList") return false;
    const first = node.firstChild;
    const second = node.getChild("ListItem", "ListItem");
    if (!first || !second) return false;
    const line1 = doc.lineAt(first.to);
    const line2 = doc.lineAt(second.from);
    const empty = /^[\s>]*$/.test(line1.text);
    return line1.number + (empty ? 0 : 1) < line2.number;
}

function blankLine(context: ContinueContext[], state: EditorState, line: Line): string {
    let insert = "";
    for (let i = 0, e = context.length - 2; i <= e; i++) {
        let blank = context[i].blank(
            i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null,
            i < e,
        );
        if (context[i].type.includes("[")) {
            blank = blank.replace(/(\d+[.)])(\s*)(\[[ xX]\])?(\s*)/, "$1 [ ] ");
        }
        insert += blank;
    }
    return normalizeIndent(insert, state);
}

export const insertNewlineContinueMarkup: Command = ({state, dispatch}) => {
    const tree = syntaxTree(state);
    const {doc} = state;
    let dont: {range: SelectionRange} | null = null;
    const changes = state.changeByRange((range) => {
        if (
            !range.empty ||
            (!markdownLanguage.isActiveAt(state, range.from, -1) &&
             !markdownLanguage.isActiveAt(state, range.from, 1))
        ) {
            dont = {range};
            return dont;
        }
        const pos = range.from;
        const line = doc.lineAt(pos);
        const context = getContext(tree.resolveInner(pos, -1), doc);
        while (context.length && context[context.length - 1].from > pos - line.from) context.pop();
        if (!context.length) {
            dont = {range};
            return dont;
        }
        const inner = context[context.length - 1];
        if (inner.to - inner.spaceAfter.length > pos - line.from) {
            dont = {range};
            return dont;
        }

        const emptyLine = pos >= inner.to - inner.spaceAfter.length && !/\S/.test(line.text.slice(inner.to));
        // 空行在列表里:再按一次 Enter 逐级退出
        if (inner.item && emptyLine) {
            const first = inner.node.firstChild;
            const second = inner.node.getChild("ListItem", "ListItem");
            if (
                (first && first.to >= pos) ||
                (second && second.to < pos) ||
                (line.from > 0 && !/[^\s>]/.test(doc.lineAt(line.from - 1).text))
            ) {
                const next = context.length > 1 ? context[context.length - 2] : null;
                let delTo: number;
                let insert = "";
                if (next && next.item) {
                    delTo = line.from + next.from;
                    insert = next.marker(doc, 1);
                } else {
                    delTo = line.from + (next ? next.to : 0);
                }
                const changes: Array<{from: number; to?: number; insert?: string}> = [{from: delTo, to: pos, insert}];
                if (inner.node.name === "OrderedList") renumberList(inner.item, doc, changes, -2);
                if (next && next.item && next.node.name === "OrderedList") renumberList(next.item, doc, changes);
                return {range: EditorSelection.cursor(delTo + insert.length), changes};
            }
            const insert = blankLine(context, state, line);
            return {
                range: EditorSelection.cursor(pos + insert.length + 1),
                changes: {from: line.from, insert: insert + state.lineBreak},
            };
        }

        if (inner.node.name === "Blockquote" && emptyLine && line.from) {
            const prevLine = doc.lineAt(line.from - 1);
            const quoted = />\s*$/.exec(prevLine.text);
            if (quoted && quoted.index === inner.from) {
                const changes = state.changes([
                    {from: prevLine.from + quoted.index, to: prevLine.to},
                    {from: line.from + inner.from, to: line.to},
                ]);
                return {range: range.map(changes), changes};
            }
        }

        const changes: Array<{from: number; to?: number; insert?: string}> = [];
        if (inner.node.name === "OrderedList") renumberList(inner.item!, doc, changes);
        const continued = !!(inner.item && inner.item.from < line.from);
        let insert = "";
        if (!continued || /^[\s\d.)\-+*>]*/.exec(line.text)![0].length >= inner.to) {
            for (let i = 0, e = context.length - 1; i <= e; i++) {
                insert += i === e && !continued
                    ? context[i].marker(doc, 1)
                    : context[i].blank(i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null);
            }
        }
        let from = pos;
        while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1))) from--;
        insert = normalizeIndent(insert, state);
        if (nonTightList(inner.node, doc)) {
            insert = blankLine(context, state, line) + state.lineBreak + insert;
        }
        changes.push({from, to: pos, insert: state.lineBreak + insert});
        return {range: EditorSelection.cursor(from + insert.length + 1), changes};
    });
    if (dont) return false;
    dispatch(state.update(changes as any, {scrollIntoView: true, userEvent: "input"}));
    return true;
};

// ===== 9. 快捷键(Obsidian 习惯:Mod+B/I/K;Mod+E 行内码) =====

const syfeMdInlineKeymap = Prec.high(keymap.of([
    {key: "Mod-b", run: makeToggleInlineCommand("StrongEmphasis", "**", "**")},
    {key: "Mod-i", run: makeToggleInlineCommand("Emphasis", "*", "*")},
    {key: "Mod-e", run: makeToggleInlineCommand("InlineCode", "`", "`")},
    {key: "Mod-Shift-x", run: makeToggleInlineCommand("Strikethrough", "~~", "~~")},
    {key: "Mod-Shift-h", run: makeToggleInlineCommand("Highlight", "==", "==")},
    {key: "Mod-k", run: insertLinkCommand},
    {key: "Enter", run: insertNewlineContinueMarkup},
]));

// ===== 10. 组装 =====

export function cm6InlineWysiwyg(opts: Cm6InlineOptions = {}): Extension {
    return [
        inlineFocusState,
        focusListener,
        inlineField(opts),
        hideTheme,
        pointerSelectionExtension,
        linkClickHandler(opts),
        syfeMdInlineKeymap,
    ];
}
