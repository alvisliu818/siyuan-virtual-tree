// CM6 思源块只读预览卡片。
//
// 设计:文档里的 [标题](siyuan://blocks/<id>) **保持原样** —— 它本身就是外部协议
// 链接,从外部程序打开也能跳到思源对应文档;CM6 只在该行下方附加一块只读预览。
//   · 内容优先 /api/block/getBlockDOMWithEmbed:内核渲染好的 protyle 块 DOM,
//     放进 .protyle > .protyle-wysiwyg 层级后完整吃思源原生样式(列表圆点
//     hover 等规则要求 .protyle 祖先,见 _wysiwyg.scss:994);接口不可用时退回
//     getBlockKramdown + window.Lute.Md2BlockDOM。
//   · 只读化:sanitizeProtyleDOM 去掉块标并关掉内层 contenteditable/spellcheck。
//   · 交互: widget 根 contenteditable=false + ignoreEvent=true,mousedown 全程
//     stopPropagation 防 CM6 抢光标;「在思源中打开」走 openSiyuanDoc(应用内
//     openTab 优先、siyuan:// 协议兜底);外部链接保留原生 <a> 协议跳转;
//     「收起/展开」按块 id 记住会话内状态,可随时关掉/恢复这张预览。
//   · 高度:设置项 files.siyuanBlockPreviewMaxHeight(0 = 不限制);超限卡片内部
//     滚动,避免长块/大表格把编辑器撑开。
//   · 生命周期: toDOM 只建壳,异步填充用 isConnected 守卫 + view.requestMeasure()
//     (块级 widget 动态改高必须通知 CM6 重算纵向布局)。
//   · 块级 widget 不能有竖直 margin(WidgetDecorationSpec.block 文档约束)。
//   · 静态 DOM 的边界:KaTeX 公式块在此补渲染;代码高亮 / mermaid / 属性视图(AV)
//     等仍需 protyle 运行时渲染器,只读预览里保留占位。

import {EditorState, StateField, Range, Extension} from "@codemirror/state";
import {EditorView, Decoration, DecorationSet, WidgetType} from "@codemirror/view";
import {getBlockDOM, getBlockKramdown, sanitizeProtyleDOM} from "../api/block-io";
import {openSiyuanDoc} from "../components/entry-menu";
import {ensureSiyuanLute} from "../utils/lute-guard";

/** 与 utils/backlink.ts:143 的块 id 正则一致 */
const SY_BLOCK_LINK_RE = /\[([^\]]*)\]\(siyuan:\/\/blocks\/([0-9]{14}-[0-9a-z]+)\)|\[\[siyuan:\/\/blocks\/([0-9]{14}-[0-9a-z]+)\|([^\]]*)\]\]/g;
const DEFAULT_MAX_HEIGHT = 320;
const COLLAPSE_KEY = "__syfeBlockPreviewCollapsed";

/** 收起状态挂 window:webpack 分块会求值两份,且 widget 会被 CM6 反复重建 */
function collapsedSet(): Set<string> {
    const w = window as any;
    if (!w[COLLAPSE_KEY]) w[COLLAPSE_KEY] = new Set<string>();
    return w[COLLAPSE_KEY] as Set<string>;
}

export interface Cm6BlockPreviewOptions {
    enabled: boolean;
    /** 卡片内容区最大高度(px);0 = 不限制 */
    maxHeight?: number;
    /** 思源 app 实例,给 openSiyuanDoc 走应用内 openTab(优先于协议跳转) */
    app?: any;
}

interface LinkHit {
    lineTo: number;
    id: string;
    title: string;
}

/** 逐行扫块链接;一行只挂一张卡片(取首个),避免同位置堆叠多个 block widget */
function scanLinks(state: EditorState): LinkHit[] {
    const out: LinkHit[] = [];
    const doc = state.doc;
    for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        SY_BLOCK_LINK_RE.lastIndex = 0;
        const m = SY_BLOCK_LINK_RE.exec(line.text);
        // markdown [标题](siyuan://blocks/id) / 双链 [[siyuan://blocks/id|标题]]
        if (m) out.push({
            lineTo: line.to,
            id: m[2] || m[3],
            title: (m[2] ? m[1] : m[4]) || "思源块",
        });
    }
    return out;
}

/** Lute 配置对齐 cm6-render.ts QuoteWidget;缺失方法逐个跳过,兼容不同 Lute 版本 */
function configureLute(lute: any): void {
    const set = (name: string, ...args: any[]): void => {
        const fn = lute?.[name];
        if (typeof fn === "function") fn.apply(lute, args);
    };
    set("SetProtyleWYSIWYG", true);
    set("SetInlineMath", true);
    set("SetGFMStrikethrough", true);
    set("SetMark", true);
    set("SetRenderListStyle", true);
    set("SetSanitize", true);
    set("SetKramdownIAL", true);
    set("SetSuperBlock", true);
    set("SetCallout", true);
    set("SetHeadingID", false);
    set("SetYamlFrontMatter", false);
    set("SetToC", false);
    set("SetFootnotes", false);
    set("SetLinkRef", false);
    set("SetSpellcheck", false);
}

/** protyle DOM 里的公式块只有 data-content,补一轮 KaTeX(同 QuoteWidget 思路) */
function renderMath(body: HTMLElement): void {
    const katex = (window as any).katex;
    if (!katex || typeof katex.render !== "function") return;
    const L = (window as any).Lute;
    body.querySelectorAll('[data-subtype="math"], .language-math').forEach((el) => {
        const raw = el.getAttribute("data-content") || el.textContent || "";
        if (!raw) return;
        try {
            const tex = typeof L?.UnEscapeHTMLStr === "function" ? String(L.UnEscapeHTMLStr(raw)) : raw;
            katex.render(tex, el as HTMLElement, {displayMode: true, throwOnError: false});
        } catch { /* 公式渲染失败保留原文 */ }
    });
}

class BlockPreviewWidget extends WidgetType {
    constructor(
        readonly id: string,
        readonly title: string,
        readonly maxHeight: number,
        readonly app?: any,
    ) {
        super();
    }

    eq(other: BlockPreviewWidget): boolean {
        return other instanceof BlockPreviewWidget && other.id === this.id
            && other.title === this.title && other.maxHeight === this.maxHeight;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "syfe-cm-blockpreview";
        wrap.setAttribute("contenteditable", "false");

        // 补齐思源 CSS 要求的祖先层级(.protyle > .protyle-wysiwyg)。
        // .protyle 自带的 flex/最小高度/裁切在 previewTheme 里重置掉。
        const stage = document.createElement("div");
        stage.className = "syfe-cm-blockpreview__stage protyle";
        const body = document.createElement("div");
        body.className = "syfe-cm-blockpreview__body protyle-wysiwyg";
        if (this.maxHeight > 0) {
            body.style.maxHeight = `${this.maxHeight}px`;
            body.style.overflowY = "auto";
        }
        body.textContent = "正在加载块内容…";
        stage.appendChild(body);

        const head = document.createElement("div");
        head.className = "syfe-cm-blockpreview__head";
        const label = document.createElement("span");
        label.className = "syfe-cm-blockpreview__label";
        label.textContent = this.title;
        head.appendChild(label);
        const idTag = document.createElement("span");
        idTag.className = "syfe-cm-blockpreview__id";
        idTag.textContent = this.id;
        head.appendChild(idTag);

        const openBtn = document.createElement("button");
        openBtn.className = "syfe-cm-blockpreview__open";
        openBtn.type = "button";
        openBtn.textContent = "在思源中打开";
        openBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        openBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void openSiyuanDoc(this.id, this.app);
        };
        head.appendChild(openBtn);

        const ext = document.createElement("a");
        ext.className = "syfe-cm-blockpreview__ext";
        ext.href = `siyuan://blocks/${this.id}`;
        ext.textContent = "外部链接";
        ext.title = ext.href;
        ext.onclick = (e) => e.stopPropagation();   // 不阻止协议跳转默认行为
        head.appendChild(ext);

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "syfe-cm-blockpreview__toggle";
        toggleBtn.type = "button";
        const applyCollapsed = (on: boolean, measure: boolean): void => {
            wrap.classList.toggle("syfe-cm-blockpreview--collapsed", on);
            body.style.display = on ? "none" : "";
            toggleBtn.textContent = on ? "展开" : "收起";
            if (measure) view.requestMeasure();
        };
        toggleBtn.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        toggleBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const set = collapsedSet();
            const next = !set.has(this.id);
            if (next) set.add(this.id);
            else set.delete(this.id);
            applyCollapsed(next, true);
        };
        head.appendChild(toggleBtn);

        wrap.appendChild(head);
        wrap.appendChild(stage);
        applyCollapsed(collapsedSet().has(this.id), false);
        wrap.onmousedown = (e) => {
            e.stopPropagation();
            // 卡片里除 <a> 外一律不吃默认聚焦/选区行为
            if (!(e.target as HTMLElement).closest("a")) e.preventDefault();
        };

        void (async () => {
            let html = await getBlockDOM(this.id);
            if (!html) {
                // 内核 DOM 接口不可用/块不存在:退回 kramdown + Lute 转换
                await ensureSiyuanLute();
                const md = await getBlockKramdown(this.id);
                const L = (window as any).Lute;
                if (md && L?.New) {
                    try {
                        const lute = L.New();
                        configureLute(lute);
                        html = typeof lute.Md2BlockDOM === "function" ? String(lute.Md2BlockDOM(md) || "") : "";
                        html = html.replace(/<div class="protyle-attr"[\s\S]*$/, "");
                    } catch { html = ""; }
                }
                if (!html && md) body.textContent = md;
            }
            if (!wrap.isConnected) return;   // 装饰重建后旧 DOM 已卸载
            if (html) {
                // 内核 DOM 是编辑态的:去块标 + 关掉内层 contenteditable
                body.innerHTML = sanitizeProtyleDOM(html);
                renderMath(body);
            } else if (!body.textContent) {
                body.textContent = "块内容不可用(可能已删除或无权限)";
            }
            view.requestMeasure();
        })();

        return wrap;
    }

    ignoreEvent(): boolean { return true; }
}

function buildPreviewDecorations(state: EditorState, opts: Cm6BlockPreviewOptions, maxHeight: number): DecorationSet {
    const ranges: Array<Range<Decoration>> = [];
    for (const hit of scanLinks(state)) {
        ranges.push(Decoration.widget({
            widget: new BlockPreviewWidget(hit.id, hit.title, maxHeight, opts.app),
            side: 1,
            block: true,
        }).range(hit.lineTo));
    }
    return Decoration.set(ranges, true);
}

const previewTheme = EditorView.theme({
    ".syfe-cm-blockpreview": {
        border: "1px solid var(--b3-border-color)",
        borderRadius: "6px",
        backgroundColor: "var(--b3-theme-surface-lighter, var(--b3-theme-surface))",
        padding: "0 10px 10px",
        cursor: "default",
        userSelect: "none",
    },
    ".syfe-cm-blockpreview__head": {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "6px 0", fontSize: "12px",
        color: "var(--b3-theme-on-surface-light)",
        borderBottom: "1px solid var(--b3-border-color)",
    },
    ".syfe-cm-blockpreview__label": {
        fontWeight: "500", color: "var(--b3-theme-on-surface)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    },
    ".syfe-cm-blockpreview__id": {
        opacity: "0.6", fontSize: "11px", whiteSpace: "nowrap",
        fontFamily: "var(--b3-font-family-code, monospace)",
    },
    ".syfe-cm-blockpreview__open": {
        marginLeft: "auto", border: "none", background: "transparent",
        color: "var(--b3-theme-primary)", cursor: "pointer", fontSize: "12px",
    },
    ".syfe-cm-blockpreview__ext": {
        color: "var(--b3-theme-primary)", textDecoration: "none",
        fontSize: "12px", whiteSpace: "nowrap",
    },
    ".syfe-cm-blockpreview__toggle": {
        border: "none", background: "transparent",
        color: "var(--b3-theme-on-surface-light)", cursor: "pointer",
        fontSize: "12px", whiteSpace: "nowrap",
    },
    ".syfe-cm-blockpreview--collapsed": {paddingBottom: "0"},
    ".syfe-cm-blockpreview--collapsed .syfe-cm-blockpreview__head": {borderBottom: "none"},
    // 抵消 _content.scss:1-8 的 .protyle 容器布局,否则卡片被撑高/裁切
    ".syfe-cm-blockpreview__stage.protyle": {
        display: "block", position: "static", minHeight: "0", maxHeight: "none",
        overflowX: "visible", backgroundColor: "transparent",
    },
    ".syfe-cm-blockpreview__body": {
        paddingTop: "6px", fontSize: "14px",
        color: "var(--b3-theme-on-surface)",
        userSelect: "text", overflowX: "auto",
    },
});

/** 开关关闭时返回空扩展 —— 两态(live / reading)装配位置完全一致 */
export function cm6BlockPreview(opts: Cm6BlockPreviewOptions): Extension[] {
    if (!opts.enabled) return [];
    const maxHeight = Math.max(0, Math.min(2000, Number(opts.maxHeight ?? DEFAULT_MAX_HEIGHT) || 0));
    const previewField = StateField.define<DecorationSet>({
        create: (state) => buildPreviewDecorations(state, opts, maxHeight),
        update: (value, tr) => tr.docChanged
            ? buildPreviewDecorations(tr.state, opts, maxHeight)
            : value.map(tr.changes),
        // 直接提供(非 compute 函数)才允许影响纵向布局 —— 块级 widget 的硬约束
        provide: (f) => EditorView.decorations.from(f),
    });
    return [previewField, previewTheme];
}
