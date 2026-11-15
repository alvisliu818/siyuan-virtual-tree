// 卡片内嵌 CM6 编辑器:Obsidian 同款「CM6 套 CM6」—— 点卡片后正文区挂一个
// 轻量 CM6 EditorView(替代 Monaco, 用户 2026-11-14「代码块编辑不要用
// monaco 了」+「本身就是cm6还要内嵌cm6吗」的最终方案讨论后定稿: 卡片壳/
// 语言标签/盒带/行号补画不变, 正文区换内嵌 CM6, 语法渲染走 language-data
// 语言包 —— 与源码态围栏行同一套语言管道)。
//
// 内嵌编辑器的事件隔离(2026-11-15)行为参考 Logseq OG
// (E:/HOME/Code/logseq/og, src/main/frontend/extensions/code.cljs 的 render!,
// AGPL-3.0),按本插件的 Electron + CM6 环境重新实现。
// 附加编辑器选项注入(2026-11-15)行为参考 Logseq OG 的
// :editor/extra-codemirror-options(AGPL-3.0),按 CM6 facet 白名单重实现;
// 两处均为行为级移植,未引入 Logseq 源码。
//
// 视图值 = codeView(去结构缩进), 写回按栅栏列重新缩进(与 Monaco 版契约
// 一致, 见 cm6-render 的 syncFromMonaco)。Esc / 点击卡片外退出回 colorize。

import {EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter} from "@codemirror/view";
import {EditorState, Compartment, Extension} from "@codemirror/state";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {LanguageDescription, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, indentUnit} from "@codemirror/language";
import {tags as highlightTags, Tag} from "@lezer/highlight";
import {languages} from "@codemirror/language-data";
import {getActiveCodeTheme, TmTokenRule} from "../extensions/theme-loader";
import {getSetting} from "../settings/user-settings";

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

// 参考 Logseq OG 的 :editor/extra-codemirror-options(AGPL-3.0)按本插件的
// CM6 基座重实现:CM6 没有 CM5 那种「一整个 options 对象」入口,选项必须映射成
// facet / 扩展。只放行白名单键 —— 未知键忽略(与 VS Code 未知设置一致),
// JSON 非法一律回落默认,绝不让一段坏配置把整块编辑器挂掉。
// 支持:lineWrapping / lineNumbers / tabSize / indentUnit /
//       highlightActiveLine / highlightActiveLineGutter / readOnly /
//       allowMultipleSelections(布尔型 false = 关掉对应内置扩展)。
interface ExtraCm6Options {
    lineWrapping?: boolean;
    lineNumbers?: boolean;
    tabSize?: number;
    indentUnit?: string;
    highlightActiveLine?: boolean;
    highlightActiveLineGutter?: boolean;
    readOnly?: boolean;
    allowMultipleSelections?: boolean;
}

function readExtraOptions(): ExtraCm6Options {
    const raw = getSetting("markdown.cm6CodeBlockExtraOptions");
    if (typeof raw !== "string" || !raw.trim()) return {};
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const b = (k: string): boolean | undefined =>
        typeof parsed[k] === "boolean" ? parsed[k] : undefined;
    const out: ExtraCm6Options = {
        lineWrapping: b("lineWrapping"),
        lineNumbers: b("lineNumbers"),
        highlightActiveLine: b("highlightActiveLine"),
        highlightActiveLineGutter: b("highlightActiveLineGutter"),
        readOnly: b("readOnly"),
        allowMultipleSelections: b("allowMultipleSelections"),
    };
    if (typeof parsed.tabSize === "number" && Number.isFinite(parsed.tabSize)) {
        out.tabSize = Math.max(1, Math.min(16, Math.round(parsed.tabSize)));
    }
    if (typeof parsed.indentUnit === "string" && parsed.indentUnit.length <= 16) {
        out.indentUnit = parsed.indentUnit;
    }
    return out;
}

/** additive facet;「关掉某内置扩展」的开关在 mount 里直接条件拼装 */
function extraOptionExtensions(o: ExtraCm6Options): Extension[] {
    const out: Extension[] = [];
    if (o.lineWrapping === true) out.push(EditorView.lineWrapping);
    if (typeof o.tabSize === "number") out.push(EditorState.tabSize.of(o.tabSize));
    if (o.indentUnit) out.push(indentUnit.of(o.indentUnit));
    if (o.readOnly === true) {
        out.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }
    if (o.allowMultipleSelections === true) out.push(EditorState.allowMultipleSelections.of(true));
    return out;
}

/** TextMate 顶层 scope → CM6 tag(常见子集; 主题规则按最长前缀探测取色) */
const SCOPE_TAGS: [string, Tag][] = [
    ["comment", highlightTags.comment],
    ["string", highlightTags.string],
    ["keyword", highlightTags.keyword],
    ["number", highlightTags.number],
    // ⚠ tags.constant 是修饰符函数(Tag.defineModifier),不是 tag —— 修饰符
    //   只能作用于基础 tag(如 tags.function(tags.variableName)),修饰符套修饰符
    //   会在 lezer Tag.defineModifier 闭包里对无 modified 字段的函数取属性,
    //   打包后模块求值即崩(整插件加载失败,TypeError: reading 'indexOf')。
    //   TextMate "constant" 作用域(语言常量 true/false/null)映射到 tags.atom。
    ["constant", highlightTags.standard(highlightTags.atom)],
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

export function mountBlockEditor(o: MountOptions): void {
    unmountBlockEditor();
    const extra = readExtraOptions();
    const langSlot = new Compartment();
    // 语言匹配:language-data 的 LanguageDescription(与 markdown codeLanguages
    // 同一套 —— 源码态围栏行的语法渲染就是它, 颜色天然一致)
    const desc = LanguageDescription.matchLanguageName(languages as any, o.lang, true);
    const view = new EditorView({
        parent: o.container,
        state: EditorState.create({
            doc: o.value,
            extensions: [
                // 附加选项的「关掉内置扩展」类开关(extra-codemirror-options)
                ...(extra.lineNumbers === false ? [] : [lineNumbers({})]),
                history(),
                drawSelection(),
                ...(extra.highlightActiveLineGutter === false ? [] : [highlightActiveLineGutter()]),
                ...(extra.highlightActiveLine === false ? [] : [highlightActiveLine()]),
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
                        // 内嵌编辑器是宿主 .cm-editor 的后代,宿主的
                        // .syfe-md__content .cm-editor{height:100%} 会串进来
                        height: "auto",
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
                        // ⚠ 宿主 syfeCmTheme 的 .cm-scroller{padding:0 16px 45vh}
                        // 是后代选择器,会串到内嵌编辑器上:一行代码被 45vh
                        // 底部留白撑出整屏空白(839px 视口实测 377px)。这里
                        // 显式重置,保留左右边距、去掉底部滚动留白。
                        padding: "0 16px",
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
                ...extraOptionExtensions(extra),
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
    // 监听挂在 view.dom(wrapper)而非 contentDOM:事件先经 CM6 自己的 keymap,
    // 冒泡到这里才拦,既不影响内嵌编辑器,也覆盖行号槽等非编辑区的按键。
    // ⚠ 只 stopPropagation,不 preventDefault —— 本 Electron 实测在 mousedown
    // 上 preventDefault 会抑制后续 click 派生(Logseq 的 util/stop 含
    // preventDefault,那是 CM5 textarea 场景,不能原样照抄)。
    view.dom.addEventListener("mousedown", (e) => e.stopPropagation());
    view.dom.addEventListener("touchstart", (e) => e.stopPropagation());
    view.dom.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey || e.altKey;
        // Logseq 同款:Cmd/Ctrl + [ / ] 在 Electron 里触发浏览器前进/后退,
        // 内嵌编辑器里必须连默认行为一起拦掉(其余修饰键仍冒泡给宿主)。
        if (mod && (e.code === "BracketLeft" || e.code === "BracketRight")) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (!mod) e.stopPropagation();
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
export function remountBlockEditor(o: MountOptions): void {
    if (!S.view || S.activeKey !== o.key) return;
    if (S.container === o.container) return;
    S.container = o.container;
    o.container.appendChild(S.view.dom);
    // 这里没有局部 view 变量(mountBlockEditor 的 view 是它的局部变量),
    // 之前写成 view.focus() 会在重挂载时抛 ReferenceError。
    S.view.focus();
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
