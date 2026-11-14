// 选中气泡工具条 —— 选中文本浮出格式按钮(桌面端,Obsidian/SilverBullet 同款)
//
// AGPL-3.0 派生声明:生命周期与定位移植自 SilverBullet
// (https://github.com/silverbulletmd/silverbullet,AGPL-3.0)
// client/codemirror/selection_bubble.ts:
//  - 显示门槛:选区非空 + 编辑器持焦 + 无补全弹层;pointer 按住期间不弹
//  - 消隐:Esc 与键入(input/delete 事务)临时消隐,选区一变即重新允许;
//    选区塌缩 / 失焦 / 补全弹层打开即隐藏
//  - 定位:悬于选区首可视行上方居中,上方无空间则翻到下方,8px 贴边钳制;
//    requestMeasure read/write 两阶段测量,滚动(capture)/resize 跟随
//  - mousedown preventDefault:点击按钮不丢编辑器焦点与选区
// 按钮集合对齐 SilverBullet markupBar.selection 默认配置(加粗/斜体/删除线/
// 行内码/高亮/双链/链接);格式化执行复用 cm6-inline.ts 的 ProseMark 系
// toggle 命令(与 Mod+B/I/E 快捷键同一实现),不引入 SB 的标记文本检查。
// 上下文门槛对应 SB 的 exceptContexts(FencedCode/FrontMatter):选区起点
// 落在围栏代码 / 缩进代码 / HTML 块或文首 YAML frontmatter 内不弹。
//
// 主题:全部走思源 CSS 变量(--b3-*),样式在全局 index.scss(气泡挂在
// document.body,不在 .cm-editor 作用域内)。
import {EditorSelection, EditorState, type Extension} from "@codemirror/state";
import {completionStatus} from "@codemirror/autocomplete";
import {Command, EditorView, ViewPlugin} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import type {SyntaxNode} from "@lezer/common";
import {
    insertLinkCommand,
    insertWikilinkCommand,
    makeToggleInlineCommand,
} from "./cm6-inline";

// ===== 1. 文案(模块自包含,模式同 fake-doc-breadcrumb/i18n) =====

const zh_CN = {
    bold: "加粗",
    italic: "斜体",
    strike: "删除线",
    code: "行内代码",
    highlight: "高亮",
    wikilink: "双链",
    link: "链接",
} as const;
const en_US = {
    bold: "Bold",
    italic: "Italic",
    strike: "Strikethrough",
    code: "Code",
    highlight: "Highlight",
    wikilink: "Wiki link",
    link: "Link",
} as const;
type BubbleLabelKey = keyof typeof zh_CN;

function detectZh(): boolean {
    try {
        const lang = (window as any)?.siyuan?.config?.langs?.currentLang || navigator.language || "";
        return /^zh/i.test(lang);
    } catch {
        return true;
    }
}

// ===== 2. 图标(feather 描边系,16px currentColor —— SB 气泡默认按钮同源) =====

function featherIcon(paths: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS: Record<BubbleLabelKey, string> = {
    bold: featherIcon('<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>'),
    italic: featherIcon('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
    strike: featherIcon('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>'),
    code: featherIcon('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    highlight: featherIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
    wikilink: featherIcon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    link: featherIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};

// ===== 3. 按钮定义(SB markupBar.selection 默认集;run 与快捷键同源) =====

// 平台前缀:tooltip 里显示与 Mod+B/I/E 一致的快捷键提示(SB buttonHint 同款)
function modKey(): string {
    try {
        if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) return "⌘";
    } catch { /* 忽略 */ }
    return "Ctrl";
}

interface BubbleButton {
    key: BubbleLabelKey;
    hint?: string;
    run: Command;
}

function bubbleButtons(): BubbleButton[] {
    const mod = modKey();
    return [
        {key: "bold", hint: `${mod}+B`, run: makeToggleInlineCommand("StrongEmphasis", "**", "**")},
        {key: "italic", hint: `${mod}+I`, run: makeToggleInlineCommand("Emphasis", "*", "*")},
        {key: "strike", hint: `${mod}+Shift+X`, run: makeToggleInlineCommand("Strikethrough", "~~", "~~")},
        {key: "code", hint: `${mod}+E`, run: makeToggleInlineCommand("InlineCode", "`", "`")},
        {key: "highlight", hint: `${mod}+Shift+H`, run: makeToggleInlineCommand("Highlight", "==", "==")},
        {key: "wikilink", run: insertWikilinkCommand},
        {key: "link", hint: `${mod}+K`, run: insertLinkCommand},
    ];
}

// ===== 4. 定位(移植 SB bubblePosition / measureSelection) =====

/** 气泡与视口边缘的最小间距 */
const EDGE = 8;

/**
 * 气泡居中的 x:选区首可视行上选中部分的水平中点(右端未知或不居右时取左端)
 */
function selectionCenterX(left: number, right?: number): number {
    return right === undefined || right <= left ? left : (left + right) / 2;
}

/**
 * 气泡位置(视口坐标):以 left 居中,悬于选区首行上方 8px;上方放不下
 * (低于 minTop,即编辑器可见顶沿)则翻到下方;整体钳在视口与 minTop 内
 */
function bubblePosition(
    selTop: {left: number; top: number; bottom: number; minTop?: number},
    size: {width: number; height: number},
    viewport: {width: number; height: number},
): {left: number; top: number; placement: "above" | "below"} {
    const {minTop = 0} = selTop;
    const clamp = (value: number, min: number, max: number) =>
        Math.max(min, Math.min(value, max - EDGE));
    const above = selTop.top - size.height - EDGE;
    const placement = above < minTop ? "below" : "above";
    const top = placement === "above" ? above : selTop.bottom + EDGE;
    return {
        left: clamp(selTop.left - size.width / 2, EDGE, viewport.width - size.width),
        top: clamp(top, Math.max(minTop, EDGE), viewport.height - size.height),
        placement,
    };
}

/** 选区首可视行几何;起点滚出可视区(被滚动遮挡)时返回 null → 气泡暂隐 */
function measureSelection(view: EditorView) {
    const {from, to} = view.state.selection.main;
    const coords = view.coordsAtPos(from, 1);
    const scroller = view.scrollDOM.getBoundingClientRect();
    if (!coords || coords.bottom < scroller.top || coords.top > scroller.bottom) {
        return null;
    }
    // 选区在首可视行上的跨度:到选区终点,或换行/越行时到该行行尾
    const rowEnd = view.moveToLineBoundary(EditorSelection.cursor(from, 1), true, true).head;
    const end = view.coordsAtPos(Math.min(to, rowEnd), -1);
    const onFirstRow = end && end.top < coords.bottom && end.bottom > coords.top;
    return {
        left: selectionCenterX(coords.left, onFirstRow ? end.right : undefined),
        top: coords.top,
        bottom: coords.bottom,
        minTop: scroller.top,
    };
}

// ===== 5. 上下文门槛(SB exceptContexts: FencedCode / FrontMatter) =====

/** 选区起点是否落在代码上下文(围栏/缩进代码块、HTML 块)里 */
function inCodeContext(state: EditorState, pos: number): boolean {
    const node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    for (let n = node; n; n = n.parent) {
        if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "HTMLBlock") {
            return true;
        }
    }
    return false;
}

/** 选区起点是否落在文首闭合的 YAML frontmatter(--- ... ---)里 */
function inFrontmatter(state: EditorState, pos: number): boolean {
    const doc = state.doc;
    if (doc.lines < 2 || pos > doc.line(1).to + 1024) return false;
    if (!/^\s*---\s*$/.test(doc.line(1).text)) return false;
    for (let n = 2; n <= doc.lines; n++) {
        if (/^\s*---\s*$/.test(doc.line(n).text)) return pos <= doc.line(n).to;
    }
    return false;
}

// ===== 6. 插件本体(移植 SB selectionBubblePlugin,Preact 渲染换原生 DOM) =====

export function cm6SelectionBubble(): Extension {
    return ViewPlugin.define((view: EditorView) => {
        const labels = detectZh() ? zh_CN : en_US;
        const bubble = document.createElement("div");
        bubble.className = "syfe-selection-bubble";
        bubble.setAttribute("role", "toolbar");
        bubble.setAttribute("aria-label", "Formatting");
        // 点击按钮不丢编辑器焦点与选区(SB 同款;click 事件照常触发)
        bubble.addEventListener("mousedown", (e) => e.preventDefault());
        for (const button of bubbleButtons()) {
            const el = document.createElement("button");
            el.type = "button";
            el.title = button.hint ? `${labels[button.key]} (${button.hint})` : labels[button.key];
            el.setAttribute("aria-label", labels[button.key]);
            el.innerHTML = ICONS[button.key];
            el.addEventListener("click", () => {
                // 命令不命中(如上下文检查失败)时不产生任何副作用
                bubbleClick = true;
                try {
                    button.run(view);
                } finally {
                    bubbleClick = false;
                }
            });
            bubble.appendChild(el);
        }

        let pointerDown = false;
        // Esc 或键入后临时消隐,直到选区下一次变化(SB dismissed 语义)
        let dismissed = false;
        // 气泡按钮点击中:按钮触发的 toggle 事务带 userEvent "input"(与快捷键
        // 同源),不能触发消隐 —— SB 明确气泡按钮的编辑不消隐,保持气泡可见
        let bubbleClick = false;

        const hide = () => {
            if (!bubble.isConnected) return;
            bubble.remove();
        };

        const place = () =>
            view.requestMeasure({
                key: bubble,
                read: () => measureSelection(view),
                write: (sel) => {
                    if (!bubble.isConnected) return;
                    if (!sel) {
                        bubble.style.visibility = "hidden";
                        return;
                    }
                    const at = bubblePosition(
                        sel,
                        {width: bubble.offsetWidth, height: bubble.offsetHeight},
                        {width: window.innerWidth, height: window.innerHeight},
                    );
                    bubble.style.left = `${at.left}px`;
                    bubble.style.top = `${at.top}px`;
                    bubble.style.visibility = "";
                },
            });

        const refresh = () => {
            const state = view.state;
            const selection = state.selection.main;
            // 廉价门槛先行:本函数在每次编辑器更新时都会跑
            const editable = state.facet(EditorView.editable) && !state.readOnly;
            if (
                selection.empty ||
                dismissed ||
                pointerDown ||
                !view.hasFocus ||
                completionStatus(state) !== null ||
                !editable ||
                inCodeContext(state, selection.from) ||
                inFrontmatter(state, selection.from)
            ) {
                return hide();
            }
            if (!bubble.isConnected) {
                bubble.style.visibility = "hidden";
                document.body.appendChild(bubble);
            }
            place();
        };

        const onPointerDown = () => {
            pointerDown = true;
            refresh();
        };
        const onPointerUp = () => {
            if (!pointerDown) return;
            pointerDown = false;
            refresh();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            dismissed = true;
            refresh();
        };
        const onScroll = () => {
            if (bubble.isConnected) place();
        };

        view.dom.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("pointercancel", onPointerUp, true);
        view.dom.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);

        return {
            update(update) {
                if (!update.state.selection.main.eq(update.startState.selection.main)) {
                    // 新选区(包括重新选中同一段文本)都是全新开始
                    dismissed = false;
                }
                // 在选区检查之后:保持选区的键入(自动配对包裹)会移动选区,
                // 同样要消隐;其他编辑(气泡按钮的、同步、程序 dispatch)不影响
                if (
                    !bubbleClick &&
                    update.transactions.some(
                        (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
                    )
                ) {
                    dismissed = true;
                }
                refresh();
            },
            destroy() {
                hide();
                view.dom.removeEventListener("pointerdown", onPointerDown, true);
                document.removeEventListener("pointerup", onPointerUp, true);
                document.removeEventListener("pointercancel", onPointerUp, true);
                view.dom.removeEventListener("keydown", onKeyDown, true);
                window.removeEventListener("scroll", onScroll, true);
                window.removeEventListener("resize", onScroll);
            },
        };
    });
}
