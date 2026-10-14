// Markdown 标题面包屑
//
// 语义对齐 siyuan-breadcrumb(E:\HOME\Code\siyuan\siyuan-breadcrumb):显示"当前位置的
// 层级路径",点某项**就地滚动定位**到目标,不跳走、不换页签、不进入聚焦。
// 区别在于:那个插件接管的是思源原生 protyle 的面包屑(块级),
// 而我们的 Markdown Tab 是 Vditor / Monaco 渲染的**磁盘 .md 文件**,没有 protyle,
// 所以按"标题"重建同款能力 —— 对纯 markdown 来说标题就是天然的层级路径。
//
// 与渲染引擎无关:数据一律从「内容容器里的 h1~h6 元素 + 当前选区」推导,
// 因此实时预览/阅读(Vditor)与源码(Monaco)两条路都能用,调用方只需给差别的两件事:
// 怎么取光标、怎么滚动。

export interface HeadingCrumb {
    /** 1~6 */
    level: number;
    text: string;
    /** Vditor 模式:标题元素 */
    element?: HTMLElement;
    /** Monaco 模式:行号(1-based) */
    line?: number;
}

/** 标题路径 → HTML。复用编辑器路径面包屑的 seg/sep 样式,不维护第二套 CSS */
export function renderHeadingSegments(crumbs: HeadingCrumb[]): string {
    const out: string[] = [];
    crumbs.forEach((c, i) => {
        if (i > 0) out.push(`<span class="syfe-editor__sep">›</span>`);
        const label = c.text.length > 40 ? c.text.slice(0, 40) + "…" : c.text;
        out.push(
            `<span class="syfe-editor__seg" data-hidx="${i}" title="H${c.level} · 点击定位">${escapeHTML(label)}</span>`,
        );
    });
    return out.join("");
}

/**
 * 从 DOM 推导标题路径。
 *
 * "当前所在标题"优先取光标所在的标题元素;光标不在标题里时,取**文档顺序上
 * 最后一个不晚于光标的标题**(即光标正处于谁的正文里)。随后从文档开头重新
 * 按层级压栈,得到 H1 › H2 › … 的完整祖先链。
 */
export function headingPathFromDom(container: HTMLElement | null, caretNode: Node | null): HeadingCrumb[] {
    if (!container) return [];
    const all = Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
    if (all.length === 0) return [];

    let current: HTMLElement | null = null;
    if (caretNode && caretNode.ownerDocument === container.ownerDocument) {
        const host = caretNode instanceof HTMLElement ? caretNode : caretNode.parentElement;
        if (host) current = host.closest("h1,h2,h3,h4,h5,h6") as HTMLElement | null;
        if (!current) {
            // DOCUMENT_POSITION_PRECEDING: 标题在光标之前 → 光标处于该标题的正文里
            for (const h of all) {
                if (h.compareDocumentPosition(caretNode) & Node.DOCUMENT_POSITION_PRECEDING) current = h;
                else break;
            }
        }
    }
    if (!current) current = all[all.length - 1];

    const stack: HTMLElement[] = [];
    for (const h of all) {
        const lv = levelOf(h);
        while (stack.length && levelOf(stack[stack.length - 1]) >= lv) stack.pop();
        stack.push(h);
        if (h === current) break;
    }
    return stack.map((h) => ({level: levelOf(h), text: textOf(h), element: h}));
}

/**
 * 从文本推导标题路径(Monaco 源码模式)。
 * 跳过 ``` / ~~~ 代码围栏里的 `#` 行,否则代码示例会被误当成标题。
 */
export function headingPathFromText(text: string, caretLine: number): HeadingCrumb[] {
    if (!text) return [];
    const lines = text.split("\n");
    const re = /^(#{1,6})\s+(.*)$/;
    let fence: string | null = null;
    const stack: Array<{level: number; text: string; line: number}> = [];
    // 只扫到光标行为止(i < caretLine-1):光标所在行之后的不算
    const limit = Math.max(0, Math.min(lines.length, (caretLine || 1) - 1));
    for (let i = 0; i < limit; i++) {
        const line = lines[i];
        const fenceMatch = /^\s{0,3}(```|~~~)/.exec(line);
        if (fenceMatch) {
            const mark = fenceMatch[1];
            if (fence === null) fence = mark;
            else if (fence === mark) fence = null;
            continue;
        }
        if (fence !== null) continue;
        const m = re.exec(line);
        if (!m) continue;
        const lv = m[1].length;
        while (stack.length && stack[stack.length - 1].level >= lv) stack.pop();
        stack.push({level: lv, text: m[2].trim() || `第 ${i + 1} 行`, line: i + 1});
    }
    return stack.map((s) => ({level: s.level, text: s.text, line: s.line}));
}

export interface HeadingCrumbsHost {
    /** 面包屑行容器 */
    bar: HTMLElement;
    /** 当前内容容器(Vditor 渲染区 / Monaco 容器) */
    contentEl: () => HTMLElement | null;
    /** 当前光标节点(Vditor 模式);Monaco 模式返回 null */
    caretNode: () => Node | null;
    /** 是否源码(Monaco)模式 */
    isSource: () => boolean;
    /** 源码文本 */
    sourceText: () => string;
    /** 源码光标行(1-based) */
    sourceLine: () => number;
    /** 点击后的滚动定位 */
    jump: (crumb: HeadingCrumb) => void;
}

export interface HeadingCrumbsHandle {
    /** 重新计算并渲染 */
    refresh(): void;
    dispose(): void;
}

/** 一键接线:内部管 selectionchange(防抖)+ 点击委托,返回 refresh/dispose */
export function enableHeadingCrumbs(host: HeadingCrumbsHost): HeadingCrumbsHandle {
    let debounce: number | undefined;

    const crumbsNow = (): HeadingCrumb[] => host.isSource()
        ? headingPathFromText(host.sourceText(), host.sourceLine())
        : headingPathFromDom(host.contentEl(), host.caretNode());

    const refresh = () => {
        const bar = host.bar;
        if (!bar) return;
        const crumbs = crumbsNow();
        if (crumbs.length === 0) {
            bar.innerHTML = "";
            bar.style.display = "none";
            return;
        }
        bar.innerHTML = renderHeadingSegments(crumbs);
        bar.style.display = "";
        // 滚动到最右,保证最后一级(当前所在标题)可见
        requestAnimationFrame(() => { bar.scrollLeft = bar.scrollWidth; });
    };

    const onSelection = () => {
        // selectionchange 在输入时会密集触发,防抖;且只关心落在内容区里的选区
        if (debounce) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
            debounce = undefined;
            const content = host.contentEl();
            const sel = window.getSelection();
            if (content && sel && sel.anchorNode && !content.contains(sel.anchorNode)) return;
            refresh();
        }, 120);
    };

    const onClick = (e: MouseEvent) => {
        const seg = (e.target as HTMLElement).closest("[data-hidx]") as HTMLElement | null;
        if (!seg) return;
        const idx = Number(seg.dataset.hidx);
        if (!Number.isFinite(idx)) return;
        const crumb = crumbsNow()[idx];
        if (!crumb) return;
        host.jump(crumb);
    };

    host.bar.addEventListener("click", onClick);
    document.addEventListener("selectionchange", onSelection);
    refresh();

    return {
        refresh,
        dispose() {
            if (debounce) window.clearTimeout(debounce);
            host.bar.removeEventListener("click", onClick);
            document.removeEventListener("selectionchange", onSelection);
        },
    };
}

/** 定位后给标题一次短暂高亮(复用文件树定位的闪烁动画) */
export function flashHeading(el: HTMLElement): void {
    if (!el) return;
    el.classList.add("syfe-md__h--reveal");
    window.setTimeout(() => el.classList.remove("syfe-md__h--reveal"), 1700);
}

// ===== 内部工具 =====

function levelOf(h: HTMLElement): number {
    return Number(h.tagName.slice(1)) || 6;
}

function textOf(h: HTMLElement): string {
    return (h.textContent || "").replace(/\s+/g, " ").trim() || "(空标题)";
}

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
