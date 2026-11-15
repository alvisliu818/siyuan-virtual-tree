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

import {Decoration, DecorationSet, EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, highlightActiveLineGutter} from "@codemirror/view";
import {EditorState, Compartment, Extension, StateEffect, StateField} from "@codemirror/state";
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import {LanguageDescription, indentUnit, bracketMatching, indentOnInput} from "@codemirror/language";
import {closeBrackets, closeBracketsKeymap} from "@codemirror/autocomplete";
import {languages} from "@codemirror/language-data";
import {getSetting} from "../settings/user-settings";
import {colorizeCached, getMonacoThemeName} from "./monaco-block";

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
    // 缩进单元默认 4 空格(与宿主 tabSize=4 一致);CM6 原生默认是 2 空格,
    // 不显式给会让 Tab 缩进与源码态围栏行对不上。用户可用 indentUnit 覆盖。
    out.push(indentUnit.of(o.indentUnit ?? "    "));
    if (o.readOnly === true) {
        out.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }
    if (o.allowMultipleSelections === true) out.push(EditorState.allowMultipleSelections.of(true));
    return out;
}

// 2026-11-15 移除:原先这里有一套「TextMate scope → CM6 tag」的 HighlightStyle
// (buildTokenHighlight/SCOPE_TAGS),给内嵌编辑器单独着色。它用的是 Lezer 分词,
// 与阅读态的 Monaco TextMate 分词对同一 token 分类不同(python 的 print:
// TextMate = support.function 蓝,Lezer = keyword 红),造成「进出编辑变色」。
// 更麻烦的是 CM6 的 <span class="ͼxx"> 会嵌在 colorize 装饰 span 里,
// 子级 class 色覆盖父级内联色,无法靠叠加装饰修正。
// 现在 token 颜色只由下方 colorizeField 的 Monaco 同源装饰提供(单一真源),
// 语言包 langSlot 仍保留给缩进/括号匹配/输入重排。

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

// ===== 与阅读态同源的 token 配色(2026-11-15 用户反馈「进出编辑主题不一样」)=====
// 阅读态卡片 = monaco.editor.colorize(TextMate 语法)的 HTML;内嵌 CM6 原来另用
// Lezer + buildTokenHighlight 着色,两套分词器对同一 token 分类不同(python 的
// print:TextMate = support.function → 蓝 #005cc5,Lezer = keyword → 红
// #d73a49),进出编辑会「变色」。这里把阅读态**同一份** colorize HTML 解析成
// 带内联颜色的 mark 装饰喂给内嵌 CM6:内联 style 压过 CM6 的 class 着色,
// 两态最终颜色完全一致(主题切换时按主题名失效 mtk 颜色缓存)。
const setColorizeDeco = StateEffect.define<DecorationSet>();
const colorizeField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const e of tr.effects) if (e.is(setColorizeDeco)) deco = e.value;
        return deco;
    },
    provide: f => EditorView.decorations.from(f),
});

/** Monaco 主题类 mtkN → 颜色(需挂在 .monaco-editor 下才能取到主题 CSS) */
let mtkCacheName = "";
let mtkCache = new Map<string, string>();
function mtkColor(cls: string): string | null {
    const name = getMonacoThemeName();
    if (name !== mtkCacheName) { mtkCacheName = name; mtkCache = new Map(); }
    const hit = mtkCache.get(cls);
    if (hit !== undefined) return hit;
    const probe = document.createElement("div");
    probe.className = "monaco-editor";
    probe.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none";
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = "x";
    probe.appendChild(span);
    document.body.appendChild(probe);
    const color = getComputedStyle(span).color;
    probe.remove();
    mtkCache.set(cls, color);
    return color || null;
}

interface ColorRange { from: number; to: number; color: string; }

/** colorize HTML → 字符区间 + 颜色。<br/> = 换行,纯文本节点继承父级颜色 */
function parseColorizeHtml(html: string, docLen: number): ColorRange[] {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const out: ColorRange[] = [];
    let pos = 0;
    const walk = (node: Node, inherited: string | null): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || "";
            if (inherited && text && pos < docLen) {
                out.push({from: pos, to: Math.min(pos + text.length, docLen), color: inherited});
            }
            pos += text.length;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as HTMLElement;
        if (el.tagName === "BR") { pos += 1; return; }
        let color = inherited;
        const inline = el.style?.color;
        if (inline) color = inline;
        else {
            const m = /\bmtk\d+\b/.exec(el.className || "");
            if (m) color = mtkColor(m[0]) ?? color;
        }
        for (const child of Array.from(el.childNodes)) walk(child, color);
    };
    for (const child of Array.from(holder.childNodes)) walk(child, null);
    return out.filter(r => r.from < r.to);
}

/** 刷新内嵌编辑器配色;异步结果按 doc 版本与单例身份丢弃,避免错位 */
function refreshColorize(view: EditorView, lang: string): void {
    const doc = view.state.doc;
    void colorizeCached(lang, doc.toString()).then(html => {
        if (S.view !== view || view.state.doc !== doc) return;
        const decos = parseColorizeHtml(html, doc.length).map(r =>
            Decoration.mark({attributes: {style: `color:${r.color}`}}).range(r.from, r.to));
        view.dispatch({effects: setColorizeDeco.of(Decoration.set(decos, true))});
    }).catch(() => undefined);
}

export function mountBlockEditor(o: MountOptions): void {
    unmountBlockEditor();
    // 宿主编辑态的 editorhost 默认有 0.9em 左内边距(Monaco 版遗留),内嵌 CM6
    // 要归零才能与阅读态的行号列对齐;用 class 精确限定,不影响 Monaco 路径。
    o.container.classList.add("has-cm6-editor");
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
                // token 颜色只由阅读态同源的 colorize 装饰提供(不挂 CM6 自己的
                // syntaxHighlighting,否则子级 class 色会盖掉内联色)
                colorizeField,
                gutterTheme,
                // 代码块编辑手感(2026-11-15):Tab/Shift-Tab 多行缩进、括号/
                // 引号自动闭合 + 配对高亮、换行自动缩进。此前只有默认键位,
                // Tab 会走浏览器默认行为把焦点踢出内嵌编辑器。
                closeBrackets(),
                bracketMatching(),
                indentOnInput(),
                keymap.of([
                    // Esc 退出编辑回 colorize
                    {key: "Escape", run: () => {
                        o.onExit();
                        return true;
                    }},
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...historyKeymap,
                    indentWithTab,
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
                        // 显式重置,去掉底部滚动留白。内边距全归零让内嵌行号槽
                        // 与阅读态 .syfe-cm-cl-n 同一起点(否则进编辑整个行号 +
                        // 代码右移 27px,观感像「换了主题」);右侧由 body 的
                        // 0.9em 统一提供。挂载后还会写一次内联样式兜底。
                        padding: "0",
                    },
                    "&.cm-focused": {outline: "none"},
                    ".cm-selectionBackground, .cm-content ::selection": {
                        backgroundColor: "var(--b3-theme-primary-lightest, rgba(0,0,0,.12))",
                    },
                    ".cm-activeLine": {backgroundColor: "transparent"},
                    ".cm-activeLineGutter": {backgroundColor: "transparent"},
                }),
                EditorView.updateListener.of(u => {
                    if (!u.docChanged) return;
                    o.onContentChange(u.state.doc.toString());
                    // 逐键重取与阅读态同源的配色(装饰按 changes 映射即时过渡,
                    // 新结果到位后整体替换,不会有空白期)
                    refreshColorize(u.view, o.lang);
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
        // calc 结果列属于同一张卡:点它选结果不该退出编辑(Logseq 同款隔离)
        const inResults = !!(t as Element | null)?.closest?.(".syfe-cm-calc-out");
        const inCard = inResults || !!o.container.contains(t) || !!view.dom.contains(t);
        if (!inCard) o.onExit();
    };
    document.addEventListener("mousedown", outsideListener, true);
    S.view = view;
    S.activeKey = o.key;
    S.container = o.container;
    S.lang = o.lang;
    S.outsideListener = outsideListener;
    S.onContentChange = o.onContentChange;
    // 宿主 syfeCmTheme 的 ".cm-scroller{padding:0 16px 45vh}" 是后代选择器,
    // 会串到内嵌编辑器;theme 里同名规则与它特异性打平、实测被宿主盖过(左
    // 内边距仍 16px)。直接写内联样式定死:左 0 让行号槽与阅读态对齐,
    // 底部 0 去掉 45vh 留白。右也归零 —— 右内边距由 body 与阅读态同款
    // 0.9em 提供,避免两态代码可用宽度不同。
    const scroller = view.dom.querySelector(".cm-scroller") as HTMLElement | null;
    if (scroller) scroller.style.padding = "0";
    refreshColorize(view, o.lang);
    view.focus();
    setTimeout(() => view.focus(), 0);
}

// 同一块的 CM6 重建后:把编辑器 DOM 搬进新容器(模型/光标/历史保持)。
export function remountBlockEditor(o: MountOptions): void {
    if (!S.view || S.activeKey !== o.key) return;
    if (S.container === o.container) return;
    S.container?.classList.remove("has-cm6-editor");
    o.container.classList.add("has-cm6-editor");
    S.container = o.container;
    o.container.appendChild(S.view.dom);
    // 这里没有局部 view 变量(mountBlockEditor 的 view 是它的局部变量),
    // 之前写成 view.focus() 会在重挂载时抛 ReferenceError。
    S.view.focus();
    // 卡片重建(含主题切换)后重取配色:mtk 颜色缓存按主题名失效
    refreshColorize(S.view, o.lang);
}

export function unmountBlockEditor(): void {
    if (!S.view) return;
    const view = S.view;
    S.container?.classList.remove("has-cm6-editor");
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
