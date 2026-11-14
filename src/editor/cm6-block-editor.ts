// 卡片内嵌 CM6 编辑器:Obsidian 同款「CM6 套 CM6」—— 点卡片后正文区挂一个
// 轻量 CM6 EditorView(替代 Monaco, 用户 2026-11-14「代码块编辑不要用
// monaco 了」+「本身就是cm6还要内嵌cm6吗」的最终方案讨论后定稿: 卡片壳/
// 语言标签/盒带/行号补画不变, 正文区换内嵌 CM6, 语法渲染走 language-data
// 语言包 —— 与源码态围栏行同一套语言管道)。
//
// 视图值 = codeView(去结构缩进), 写回按栅栏列重新缩进(与 Monaco 版契约
// 一致, 见 cm6-render 的 syncFromMonaco)。Esc / 点击卡片外退出回 colorize。

import {EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter} from "@codemirror/view";
import {EditorState, Compartment} from "@codemirror/state";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {LanguageDescription, syntaxHighlighting, defaultHighlightStyle, HighlightStyle} from "@codemirror/language";
import {tags as highlightTags, Tag} from "@lezer/highlight";
import {languages} from "@codemirror/language-data";
import {getActiveCodeTheme, TmTokenRule} from "../extensions/theme-loader";

interface MountOptions {
    container: HTMLElement;
    key: string;
    /** 围栏语言标签原文("powershell"/"python"/"js"/...), 用于匹配语言包 */
    lang: string;
    /** 视图值 = codeView(去结构缩进) */
    value: string;
    onContentChange: (v: string) => void;
    onExit: () => void;
}

const S: {
    view: EditorView | null;
    activeKey: string | null;
    container: HTMLElement | null;
    lang: string;
    outsideListener: ((e: MouseEvent) => void) | null;
    onContentChange: ((v: string) => void) | null;
} = {
    view: null,
    activeKey: null,
    container: null,
    lang: "",
    outsideListener: null,
    onContentChange: null,
};

/** TextMate 顶层 scope → CM6 tag(常见子集; 主题规则按最长前缀探测取色) */
const SCOPE_TAGS: [string, Tag][] = [
    ["comment", highlightTags.comment],
    ["string", highlightTags.string],
    ["keyword", highlightTags.keyword],
    ["number", highlightTags.number],
    ["constant", highlightTags.standard(highlightTags.constant)],
    ["operator", highlightTags.operatorKeyword],
    ["punctuation", highlightTags.punctuation],
    ["variable", highlightTags.variableName],
    ["entity", highlightTags.function(highlightTags.variableName)],
    ["support", highlightTags.function(highlightTags.variableName)],
    ["storage", highlightTags.typeName],
    ["type", highlightTags.typeName],
    ["class", highlightTags.className],
];

/** 主题规则 → CM6 HighlightStyle(与块内 colorize 的 Monaco 主题取色同源) */
function buildTokenHighlight(): HighlightStyle | null {
    const theme = getActiveCodeTheme();
    if (!theme || !theme.rules.length) return null;
    const probe = (scope: string[]): TmTokenRule | null => {
        let best: TmTokenRule | null = null;
        let bestLen = 0;
        for (const r of theme.rules) {
            if (r.segments.length > scope.length) continue;
            if (r.segments.length <= bestLen) continue;
            let ok = true;
            for (let i = 0; i < r.segments.length; i++) {
                if (r.segments[i] !== scope[i]) { ok = false; break; }
            }
            if (ok) { best = r; bestLen = r.segments.length; }
        }
        return best;
    };
    const entries: {tag: Tag; color: string; fontStyle?: string; fontWeight?: string; textDecoration?: string}[] = [];
    for (const [scope, tag] of SCOPE_TAGS) {
        const rule = probe([scope]);
        if (!rule) continue;
        const style: {tag: Tag; color: string; fontStyle?: string; fontWeight?: string; textDecoration?: string} = {tag, color: rule.foreground};
        if (rule.fontStyle === "italic") style.fontStyle = "italic";
        if (rule.fontStyle === "bold") style.fontWeight = "bold";
        if (rule.fontStyle === "underline") style.textDecoration = "underline";
        entries.push(style);
    }
    return entries.length ? HighlightStyle.define(entries) : null;
}

// 行号列样式(复刻 colorize 的 .syfe-cm-cl-n: on-surface 0.45、右对齐)
const gutterTheme = EditorView.theme({
    ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--b3-theme-on-surface)",
        opacity: "0.45",
    },
    ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 0.9em",
        color: "var(--b3-theme-on-surface)",
        opacity: "0.45",
    },
    ".cm-activeLineGutter": {backgroundColor: "transparent"},
});

export function mountBlockEditor(o: MountBlockOptions): void {
    unmountBlockEditor();
    const langSlot = new Compartment();
    // 语言匹配:language-data 的 LanguageDescription(与 markdown codeLanguages
    // 同一套 —— 源码态围栏行的语法渲染就是它, 颜色天然一致)
    const desc = LanguageDescription.matchLanguageName(languages as any, o.lang, true);
    const view = new EditorView({
        parent: o.container,
        state: EditorState.create({
            doc: o.value,
            extensions: [
                lineNumbers({}),
                history(),
                drawSelection(),
                highlightActiveLineGutter(),
                highlightActiveLine(),
                syntaxHighlighting(buildTokenHighlight() ?? defaultHighlightStyle, {fallback: true}),
                gutterTheme,
                keymap.of([
                    // Esc 退出编辑回 colorize
                    {key: "Escape", run: () => {
                        o.onExit();
                        return true;
                    }},
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                // 卡片观感:透明底(露出盒带), 等宽字体/行高与卡片正文一致
                EditorView.theme({
                    "&": {
                        fontSize: "13px",
                        backgroundColor: "var(--b3-theme-surface)",
                    },
                    ".cm-content": {padding: "0", caretColor: "var(--b3-theme-on-surface)"},
                    ".cm-line": {
                        padding: "0",
                        lineHeight: "21px",
                        fontFamily: 'Consolas, "Courier New", monospace',
                    },
                    ".cm-scroller": {
                        fontFamily: 'Consolas, "Courier New", monospace',
                        lineHeight: "21px",
                    },
                    "&.cm-focused": {outline: "none"},
                    ".cm-selectionBackground, .cm-content ::selection": {
                        backgroundColor: "var(--b3-theme-primary-lightest, rgba(0,0,0,.12))",
                    },
                    ".cm-activeLine": {backgroundColor: "transparent"},
                    ".cm-activeLineGutter": {backgroundColor: "transparent"},
                }),
                EditorView.updateListener.of(u => {
                    if (u.docChanged) o.onContentChange(u.state.doc.toString());
                }),
                langSlot.of(desc?.support ? [desc.support] : []),
            ],
        }),
    });
    // 语言包异步分块:到位后重配置(不重建, 保住光标与历史; mobile-editor 同款)
    if (desc && !desc.support) {
        void desc.load().then(support => {
            if (S.view === view) view.dispatch({effects: langSlot.reconfigure([support])});
        }).catch(() => {
            // 语言包加载失败保持纯文本, 不影响编辑与写回
        });
    }
    // 键隔离:嵌套编辑器的 keydown 阻断冒泡 —— 否则宿主 CM6 的 keymap 会对同
    // 一个按键再处理一遍(Monaco 版的 Enter 被吞就是这条链, 见 d9c29e3)。
    // 修饰组合键(Mod-s 保存等)不拦, 继续冒泡给宿主。
    view.contentDOM.addEventListener("keydown", (e) => {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
    });
    // 点击卡片外 → 退出编辑回 colorize(document 捕获, monaco-block 同款)
    const outsideListener = (e: MouseEvent) => {
        const t = e.target as Node | null;
        const inCard = !!o.container.contains(t) || !!view.dom.contains(t);
        if (!inCard) o.onExit();
    };
    document.addEventListener("mousedown", outsideListener, true);
    S.view = view;
    S.activeKey = o.key;
    S.container = o.container;
    S.lang = o.lang;
    S.outsideListener = outsideListener;
    S.onContentChange = o.onContentChange;
    view.focus();
    setTimeout(() => view.focus(), 0);
}

// 同一块的 CM6 重建后:把编辑器 DOM 搬进新容器(模型/光标/历史保持)。
export function remountBlockEditor(o: MountBlockOptions): void {
    if (!S.view || S.activeKey !== o.key) return;
    if (S.container === o.container) return;
    S.container = o.container;
    o.container.appendChild(S.view.dom);
    view.focus();
}

export function unmountBlockEditor(): void {
    if (!S.view) return;
    const view = S.view;
    S.view = null;
    S.activeKey = null;
    S.container = null;
    S.onContentChange = null;
    if (S.outsideListener) {
        document.removeEventListener("mousedown", S.outsideListener, true);
        S.outsideListener = null;
    }
    view.destroy();
}

// 退出前的兜底写回:嵌套视图的当前内容就是最新值(逐变更已同步, 这里幂等)
export function flushActiveBlock(): void {
    if (!S.view || !S.onContentChange) return;
    S.onContentChange(S.view.state.doc.toString());
}

export function getActiveBlockValue(): string | null {
    return S.view ? S.view.state.doc.toString() : null;
}

export function getMountedBlockKey(): string | null {
    return S.activeKey;
}

export function getMountedContainer(): HTMLElement | null {
    return S.container;
}

export function getMountedLanguage(): string {
    return S.lang;
}
