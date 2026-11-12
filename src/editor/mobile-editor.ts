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
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
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
}

export interface MobileEditorHandle {
    getValue(): string;
    setValue(v: string): void;
    focus(): void;
    destroy(): void;
}

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

export function isMarkdownPath(path: string): boolean {
    return MARKDOWN_EXTS.has(extname(path).toLowerCase());
}

// 全部走思源 CSS 变量,明暗主题自动跟随。
// 字号 16px 是硬要求:iOS Safari 对小于 16px 的输入控件会自动放大整页。
const mobileTheme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "16px",
        backgroundColor: "var(--b3-theme-background)",
        color: "var(--b3-theme-on-background)",
    },
    ".cm-scroller": {
        fontFamily: "var(--b3-font-family-code, Consolas, 'Courier New', monospace)",
        lineHeight: "1.6",
        overflow: "auto",
        // 底部留白:移动端底部工具栏会盖住最后一行
        padding: "0 8px 40vh",
    },
    ".cm-content": {caretColor: "var(--b3-theme-primary)"},
    ".cm-gutters": {
        backgroundColor: "var(--b3-theme-surface)",
        color: "var(--b3-theme-on-surface-light)",
        border: "none",
        fontSize: "12px",
    },
    ".cm-activeLine": {backgroundColor: "var(--b3-theme-hover-background, rgba(0,0,0,.04))"},
    ".cm-activeLineGutter": {backgroundColor: "transparent"},
    "&.cm-focused": {outline: "none"},
    ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--b3-theme-primary-lightest, rgba(0,0,0,.12))",
    },
    ".cm-panels": {
        backgroundColor: "var(--b3-theme-surface)",
        color: "var(--b3-theme-on-surface)",
    },
});

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
    const readOnly = opts.readOnly === true;
    const initial = resolveLanguage(opts.path);

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
                lineNumbers(),
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
                // 窄屏必须自动换行,否则横向滚动在触摸设备上几乎不可用
                EditorView.lineWrapping,
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
        destroy: () => {
            destroyed = true;
            view.destroy();
        },
    };
}