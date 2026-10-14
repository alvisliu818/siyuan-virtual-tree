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

import {Menu} from "siyuan";

export interface HeadingCrumb {
    /** 1~6 */
    level: number;
    text: string;
    /** Vditor 模式:标题元素 */
    element?: HTMLElement;
    /** Monaco 模式:行号(1-based) */
    line?: number;
    /** 是否还有下级标题(决定要不要渲染展开箭头) */
    hasChildren?: boolean;
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
        // 展开箭头:点它列出该标题的**直接下级标题**,选中即跳转并把面包屑延伸到那一级
        if (c.hasChildren) {
            out.push(
                `<span class="syfe-editor__seg syfe-md__hexp" data-hexp="${i}" title="展开下级标题">▾</span>`,
            );
        }
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
    if (caretNode && container.contains(caretNode)) {
        // 光标在本容器里:优先取所在标题,否则取文档顺序上最后一个不晚于光标的标题
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
    // 光标不在本文档(刚打开还没点进去 / 焦点在别的页签):按文档开头算,
    // 显示第一条标题路径。不能拿别的页签的光标做文档顺序比较 —— 那是任意值。
    if (!current) current = all[0];

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
    // 扫到光标行(含):光标正好停在标题行上时,该标题也要进路径
    const limit = Math.max(0, Math.min(lines.length, caretLine || 1));
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

/**
 * 某个标题的**直接下级**标题(DOM 版)。
 * 从该标题往后扫,收集层级 = 自身+1 的标题;遇到层级 ≤ 自身的就停(那是它的兄弟/长辈)。
 */
export function childHeadingsOfDom(container: HTMLElement | null, crumb: HeadingCrumb): HeadingCrumb[] {
    if (!container || !crumb.element) return [];
    const all = Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
    const start = all.indexOf(crumb.element);
    if (start < 0) return [];
    const out: HeadingCrumb[] = [];
    for (let i = start + 1; i < all.length; i++) {
        const lv = levelOf(all[i]);
        if (lv <= crumb.level) break;
        if (lv === crumb.level + 1) out.push({level: lv, text: textOf(all[i]), element: all[i]});
    }
    return out;
}

/** 某个标题的直接下级标题(文本版,Monaco 源码模式;同样跳过代码围栏) */
export function childHeadingsOfText(text: string, crumb: HeadingCrumb): HeadingCrumb[] {
    if (!text || !crumb.line) return [];
    const lines = text.split("\n");
    const re = /^(#{1,6})\s+(.*)$/;
    let fence: string | null = null;
    const out: HeadingCrumb[] = [];
    for (let i = crumb.line; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = /^\s{0,3}(```|~~~)/.exec(line);
        if (fenceMatch) {
            const mark = fenceMatch[1];
            if (fence === null) fence = mark;
            else if (fence === mark) fence = null;
            continue;
        }
        if (fence !== null) continue;
        // 起始行本身是当前标题,跳过
        if (i + 1 <= crumb.line) continue;
        const m = re.exec(line);
        if (!m) continue;
        const lv = m[1].length;
        if (lv <= crumb.level) break;
        if (lv === crumb.level + 1) out.push({level: lv, text: m[2].trim() || `第 ${i + 1} 行`, line: i + 1});
    }
    return out;
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

    // 某一级的直接下级标题(按当前模式取数)
    const childrenOf = (c: HeadingCrumb): HeadingCrumb[] => host.isSource()
        ? childHeadingsOfText(host.sourceText(), c)
        : childHeadingsOfDom(host.contentEl(), c);

    // 递归构建下级菜单:每个有下级的子项都带 submenu,悬浮即展开下一级。
    // 标题层级最多 6 级,level 单调递增,递归天然收敛,无需额外深度护栏。
    // iconHTML 传空串:思源的 addItem 默认无条件渲染左侧图标位(空 <use xlink:href="#">),
    // 传 iconHTML 走它的另一条分支,菜单项左侧就干净了(见思源 menus/Menu.ts 的 iconHTML 分支)
    const buildChildItems = (crumb: HeadingCrumb): any[] => {
        return childrenOf(crumb).map(k => {
            const sub = buildChildItems(k);
            return {
                iconHTML: "",
                label: `H${k.level} ${k.text}`,
                click: () => host.jump(k),
                submenu: sub.length > 0 ? sub : undefined,
            };
        });
    };

    const refresh = () => {
        const bar = host.bar;
        if (!bar) return;
        const crumbs = crumbsNow();
        if (crumbs.length === 0) {
            bar.innerHTML = "";
            bar.style.display = "none";
            return;
        }
        // 标记每级有没有下级(决定要不要渲染展开箭头);
        // 中间的级必然有(下一级就是它的孩子),只有最后一级需要现查
        for (let i = 0; i < crumbs.length; i++) {
            crumbs[i].hasChildren = i < crumbs.length - 1 || childrenOf(crumbs[i]).length > 0;
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
        const target = e.target as HTMLElement;
        // 展开箭头:列出直接下级标题,选中即跳转(面包屑随之延伸到那一级);
        // 子项上继续悬浮还能展开它的下级 —— 级联子菜单,可一路钻到最深层
        const exp = target.closest("[data-hexp]") as HTMLElement | null;
        if (exp) {
            // 不拦的话,这次 click 会继续冒泡到 document,把刚 open 的菜单又立刻关掉
            e.stopPropagation();
            e.preventDefault();
            const idx = Number(exp.dataset.hexp);
            const crumb = crumbsNow()[idx];
            if (!crumb) return;
            const menu = new Menu();
            const items = buildChildItems(crumb);
            if (items.length === 0) {
                menu.addItem({label: "无下级标题", click: () => {}});
            } else {
                items.forEach(it => menu.addItem(it));
            }
            const rect = exp.getBoundingClientRect();
            menu.open({x: rect.left, y: rect.bottom + 4});
            return;
        }
        // 普通分段:就地滚动定位到该标题
        const seg = target.closest("[data-hidx]") as HTMLElement | null;
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

/** 找最近的可用滚动祖先(overflowY auto/scroll 且确实有溢出) */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
    let p = el.parentElement;
    while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowY;
        if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
        p = p.parentElement;
    }
    return null;
}

/**
 * 把元素滚到滚动容器顶部。
 *
 * 不用 scrollIntoView:Vditor ir 维护着自己的光标状态,程序化改选区后它的滚动同步
 * 会把 scrollIntoView 的 smooth 动画抢回去(实测目标又回到视口外 -202px)。
 * 手动算 scrollTop 赋值则完全可控(实测稳定生效)。
 */
export function scrollToTopOf(el: HTMLElement, offset = 8): void {
    const sc = scrollParentOf(el);
    if (!sc) {
        el.scrollIntoView({block: "start"});
        return;
    }
    const rect = el.getBoundingClientRect();
    const sRect = sc.getBoundingClientRect();
    const top = sc.scrollTop + (rect.top - sRect.top) - offset;
    sc.scrollTop = Math.max(0, Math.round(top));
}

// ===== 内部工具 =====

function levelOf(h: HTMLElement): number {
    return Number(h.tagName.slice(1)) || 6;
}

function textOf(h: HTMLElement): string {
    // Vditor ir 模式的标题 textContent 会带上源码标记(`# 一级标题`),剥掉再显示
    const t = (h.textContent || "").replace(/^#{1,6}\s*/, "").replace(/\s+/g, " ").trim();
    return t || "(空标题)";
}

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
