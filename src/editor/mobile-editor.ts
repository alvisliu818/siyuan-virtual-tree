// 移动端代码 / Markdown 编辑器。
//
// 为什么另起一套而不复用桌面编辑器:桌面的状态层绑死 Monaco ITextModel
// (editor/model-manager.ts),Markdown 页签的富渲染又会在围栏代码块里挂
// 全局 Monaco 实例(editor/cm6-render.ts → monaco-block.ts)。移动端没有
// 页签系统,也不该为看一个文件拉起整个 Monaco。
//
// 这里只用 CodeMirror 6(纯浏览器库,项目已有依赖):按文件名匹配语言、
// 语法高亮、行号、历史、查找、自动换行。Markdown 走源码态 + 围栏代码高亮,
// 不做所见即所得 —— 窄屏上富渲染的点击进编辑交互反而更难用。
import {EditorState, Compartment} from "@codemirror/state";
import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
    drawSelection, rectangularSelection,
} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, undo, redo} from "@codemirror/commands";
import {bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, LanguageDescription} from "@codemirror/language";
import {searchKeymap, highlightSelectionMatches} from "@codemirror/search";
import {closeBrackets, closeBracketsKeymap} from "@codemirror/autocomplete";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {languages} from "@codemirror/language-data";
import {extname} from "../utils/path";

export interface MobileEditorOptions {
    value: string;
    /** 用于匹配语言与判断是否 Markdown */
    path: string;
    readOnly?: boolean;
    onSave(): void;
    onInput(): void;
    /** 点击行号槽:复制该行链接(移动端没有右键菜单,用点击代替) */
    onCopyLine?(line: number): void;
}

export interface MobileEditorHandle {
    getValue(): string;
    setValue(v: string): void;
    focus(): void;
    blur(): void;
    destroy(): void;
    undo(): void;
    redo(): void;
    /** 缩进 / 反缩进(工具栏 Tab、Shift+Tab 按钮) */
    indentMore(): void;
    indentLess(): void;
    /** 跳到指定行(文档内行号链接打开时定位) */
    revealLine(line: number): void;
    getFontSize(): number;
    setFontSize(px: number): void;
    isWrap(): boolean;
    setWrap(on: boolean): void;
}

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

export function isMarkdownPath(path: string): boolean {
    return MARKDOWN_EXTS.has(extname(path).toLowerCase());
}

// 移动端默认字号。CM6 的编辑区是 contenteditable 而非 input/textarea,
// 不会触发 iOS 对小于 16px 表单控件的整页自动放大,所以可以比桌面更紧凑;
// 仍提供字号步进器让用户自己调。
export const MOBILE_FONT_DEFAULT = 14;
export const MOBILE_FONT_MIN = 12;
export const MOBILE_FONT_MAX = 24;

// 全部走思源 CSS 变量,明暗主题自动跟随。
const mobileTheme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "var(--b3-theme-background)",
        color: "var(--b3-theme-on-background)",
    },
    ".cm-scroller": {
        fontFamily: "var(--b3-font-family-code, Consolas, 'Courier New', monospace)",
        lineHeight: "1.6",
        overflow: "auto",
    },
    ".cm-content": {
        caretColor: "var(--b3-theme-primary)",
        // 贴边显示:窄屏上左右 10px 内边距和 12vh 底部留白太奢侈,
        // 去掉左右、只留少量底部空间防止最后一行被键盘压住。
        // 留白仍放在 content 上,行号槽背景才不会中途断开。
        padding: "0 0 4vh",
    },
    // 行号槽默认值(0 3px 0 5px)在 360px 屏上占 30px,收紧把宽度还给正文
    ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 2px 0 3px",
        minWidth: "18px",
        opacity: "var(--syfe-cm-gutter-opacity, 0.4)",
    },
    ".cm-gutters": {
        backgroundColor: "var(--b3-theme-surface)",
        color: "var(--b3-theme-on-surface-light)",
        border: "none",
        fontSize: "11px",
    },
    // 当前行高亮走设置变量(默认不高亮,与桌面 CM6 同一开关)
    ".cm-activeLine": {backgroundColor: "var(--syfe-cm-active-line-bg, transparent)"},
    ".cm-activeLineGutter": {backgroundColor: "var(--syfe-cm-active-line-bg, transparent)"},
    "&.cm-focused": {outline: "none"},
    ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--b3-theme-primary-lightest, rgba(0,0,0,.12))",
    },
    ".cm-panels": {
        backgroundColor: "var(--b3-theme-surface)",
        color: "var(--b3-theme-on-surface)",
    },
});

const fontTheme = (px: number) => EditorView.theme({"&": {fontSize: `${px}px`}});

/** 按文件名取语言;Markdown 直接用同步可用的 markdown(),其余异步加载 */
function resolveLanguage(path: string): {sync?: any; promise?: Promise<any>} {
    const name = path.split(/[\\/]/).pop() || path;
    if (isMarkdownPath(path)) {
        return {sync: markdown({base: markdownLanguage, codeLanguages: languages})};
    }
    const desc = LanguageDescription.matchFilename(languages as any, name);
    if (!desc) return {};
    return {promise: desc.load()};
}

export function createMobileEditor(container: HTMLElement, opts: MobileEditorOptions): MobileEditorHandle {
    const langSlot = new Compartment();
    const fontSlot = new Compartment();
    const wrapSlot = new Compartment();
    const readOnly = opts.readOnly === true;
    const initial = resolveLanguage(opts.path);
    let fontSize = MOBILE_FONT_DEFAULT;
    let wrap = true;

    const saveKey = keymap.of([{
        key: "Mod-s",
        preventDefault: true,
        run: () => {
            opts.onSave();
            return true;
        },
    }]);

    const view = new EditorView({
        parent: container,
        state: EditorState.create({
            doc: opts.value,
            extensions: [
                saveKey,
                lineNumbers({
                    // 点行号复制该行链接;返回 true 阻止 CM6 默认的选区行为
                    domEventHandlers: {
                        click: (view, block) => {
                            const n = view.state.doc.lineAt(block.from).number;
                            if (n > 0) opts.onCopyLine?.(n);
                            return true;
                        },
                    },
                }),
                foldGutter(),
                highlightActiveLine(),
                highlightActiveLineGutter(),
                drawSelection(),
                rectangularSelection(),
                history(),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                highlightSelectionMatches(),
                syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
                // 窄屏默认自动换行,否则横向滚动在触摸设备上几乎不可用;可开关
                wrapSlot.of(EditorView.lineWrapping),
                fontSlot.of(fontTheme(fontSize)),
                mobileTheme,
                keymap.of([
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...searchKeymap,
                    ...historyKeymap,
                    ...foldKeymap,
                    indentWithTab,
                ]),
                EditorView.updateListener.of(u => {
                    if (u.docChanged) opts.onInput();
                }),
                langSlot.of(initial.sync ? [initial.sync] : []),
                ...(readOnly ? [
                    EditorState.readOnly.of(true),
                    EditorView.editable.of(false),
                ] : []),
            ],
        }),
    });

    // 语言包是异步分块:到位后重新配置,不重建编辑器(保住光标与历史)
    let destroyed = false;
    if (initial.promise) {
        void initial.promise.then(support => {
            if (!destroyed) view.dispatch({effects: langSlot.reconfigure([support])});
        }).catch(() => {
            // 语言包加载失败就保持纯文本,不影响编辑与保存
        });
    }

    return {
        getValue: () => view.state.doc.toString(),
        setValue: (v: string) => {
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: v}});
        },
        focus: () => view.focus(),
        blur: () => {
            const el = view.contentDOM;
            if (el && (document.activeElement === el || el.contains(document.activeElement))) {
                el.blur();
            }
        },
        destroy: () => {
            destroyed = true;
            view.destroy();
        },
        // 工具栏在编辑区之外:点工具按钮后保持失焦,焦点交给 openEditorDialog
        // 的区域点击规则(点编辑区才进编辑,点其它区域退出)
        undo: () => { undo(view); },
        redo: () => { redo(view); },
        indentMore: () => { indentMore(view); },
        indentLess: () => { indentLess(view); },
        revealLine: (line: number) => {
            const n = Math.max(1, Math.min(line, view.state.doc.lines));
            const pos = view.state.doc.line(n).from;
            view.dispatch({
                selection: {anchor: pos},
                effects: EditorView.scrollIntoView(pos, {y: "center"}),
            });
        },
        getFontSize: () => fontSize,
        setFontSize: (px: number) => {
            fontSize = Math.max(MOBILE_FONT_MIN, Math.min(MOBILE_FONT_MAX, Math.round(px)));
            view.dispatch({effects: fontSlot.reconfigure(fontTheme(fontSize))});
        },
        isWrap: () => wrap,
        setWrap: (on: boolean) => {
            wrap = on;
            view.dispatch({effects: wrapSlot.reconfigure(on ? EditorView.lineWrapping : [])});
        },
    };
}