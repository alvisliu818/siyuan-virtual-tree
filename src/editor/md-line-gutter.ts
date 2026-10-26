// Markdown 渲染态(实时预览 / 阅读)的行号槽 + 行级定位
//
// 需求:Markdown 文件也要能「跳转到对应行」「在行号上右键复制链接」。
// 源码态(Monaco)天然有行号,行号右键菜单在 editor/monaco.ts 里做;
// 这里解决的是 Vditor 渲染态 —— DOM 里没有行概念,需要自己建「源码行 ↔ 渲染块」的映射。
//
// 映射原理:Vditor 的 ir / wysiwyg DOM 由 Lute 从 Markdown 生成,**一个顶层块元素
// 对应一个顶层 markdown 结构**(标题/段落/列表/引用/表格/代码围栏/分隔线),
// 空行不产生元素。所以按同样的规则把源码行切成块序列,再按顺序与 DOM 块对齐即可:
//   - 槽位上显示的数字 = 该块首行的源码行号(与 ?line= 的语义一致)
//   - ?line=N 跳转 = 找到覆盖第 N 行的块,滚动过去
// 两者共用同一份映射,槽位上复制出去的链接必然能被跳转逻辑还原。
//
// 已知近似:列表/引用/表格按「连续相关行」折叠成一个块,遇到 Lute 特殊折叠时
// 块数可能对不上 —— 此时按序号钳位取数,槽位数字会漂移但不会错位崩溃。
// 需要精确行号的场景(贴链接引用具体一行)建议在源码态复制。

import {Menu} from "siyuan";

export interface MdLineGutterHost {
    /** 内容容器(.syfe-md__content,模块自己在里面找 .vditor-reset) */
    contentEl(): HTMLElement | null;
    /** 当前源码(Markdown 全文) */
    source(): string;
    /** 复制某行的链接(由调用方按文件生成 Markdown 格式) */
    copyLineLink(line: number): void;
}

export interface MdLineGutterHandle {
    /** 重新对齐并渲染(内容/尺寸变化时模块自己也会触发) */
    refresh(): void;
    /** 第 line 行(1-based)所在的渲染块;找不到返回 null */
    lineToBlock(line: number): HTMLElement | null;
    dispose(): void;
}

const GUTTER_CLASS = "syfe-md__linenums";
const GUTTER_ON = "syfe-md__gutter-on";

// ===== Markdown 顶层块切分 =====
// 返回每个顶层块的起始行下标(0-based)。规则与 Lute 的块生成对齐:
// 空行不算块;围栏代码/引用/表格/列表各自把连续相关行折叠成一个块。
export function mdBlockStarts(source: string): number[] {
    const lines = String(source || "").split("\n");
    const starts: number[] = [];
    const fenceMark = (s: string) => {
        const m = /^\s{0,3}(```+|~~~+)/.exec(s);
        return m ? m[1].slice(0, 3) : null;
    };
    const isBlank = (s: string) => s.trim() === "";
    let i = 0;
    while (i < lines.length) {
        if (isBlank(lines[i])) {
            i++;
            continue;
        }
        starts.push(i);
        const line = lines[i];
        const mark = fenceMark(line);
        if (mark) {
            // 围栏代码:吃到配对的收尾围栏(容错:没收到就一直吃到尾)
            i++;
            while (i < lines.length && fenceMark(lines[i]) !== mark) i++;
            i++;
            continue;
        }
        if (/^\s{0,3}#{1,6}\s/.test(line)) {
            i++;   // ATX 标题:一行
            continue;
        }
        if (/^\s{0,3}([-*_])[ \t]*\1[ \t]*\1[\s\-*_]*$/.test(line)) {
            i++;   // 分隔线
            continue;
        }
        if (/^\s{0,3}>/.test(line)) {
            // 引用:连续引用行(引用里的空行不断开 —— 与 Lute 的折叠近似)
            i++;
            while (i < lines.length && !isBlank(lines[i]) && /^\s{0,3}>/.test(lines[i])) i++;
            continue;
        }
        if (/^\s{0,3}\|/.test(line)) {
            // 表格:连续竖线行
            i++;
            while (i < lines.length && !isBlank(lines[i]) && /^\s{0,3}\|/.test(lines[i])) i++;
            continue;
        }
        if (/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(line)) {
            // 列表:列表项 + 缩进续行/嵌套项,直到空行或新的顶层结构
            i++;
            while (i < lines.length && !isBlank(lines[i])
                && (/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(lines[i]) || /^\s{1,}/.test(lines[i]))) i++;
            continue;
        }
        if (/^\s{0,3}</.test(line)) {
            // 内联 HTML 块:到空行为止
            i++;
            while (i < lines.length && !isBlank(lines[i])) i++;
            continue;
        }
        // 段落:连续非空、且不以新顶层结构开头的行(Setext 下划线也一并算进段落)
        i++;
        while (i < lines.length && !isBlank(lines[i])
            && !fenceMark(lines[i])
            && !/^\s{0,3}#{1,6}\s/.test(lines[i])
            && !/^\s{0,3}>/.test(lines[i])
            && !/^\s{0,3}\|/.test(lines[i])
            && !/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(lines[i])
            && !/^\s{0,3}([-*_])[ \t]*\1[ \t]*\1[\s\-*_]*$/.test(lines[i])) i++;
    }
    return starts;
}

// ===== 槽位安装 =====
export function installMdLineGutter(host: MdLineGutterHost): MdLineGutterHandle {
    let gutter: HTMLElement | null = null;
    let resetEl: HTMLElement | null = null;
    let disposed = false;
    let refreshTimer: number | undefined;

    // 找真正装着块的 .vditor-reset:同容器常有 pre/div 两个同名元素(见 markdown-tab 的注释),
    // 带块子元素(data-block)的那个才是渲染体
    const findReset = (): HTMLElement | null => {
        const content = host.contentEl();
        if (!content) return null;
        let best: HTMLElement | null = null;
        let bestN = -1;
        for (const r of Array.from(content.querySelectorAll(".vditor-reset")) as HTMLElement[]) {
            const n = r.querySelectorAll(":scope > [data-block]").length;
            if (n > bestN) {
                bestN = n;
                best = r;
            }
        }
        return bestN > 0 ? best : null;
    };

    const blocksOf = (reset: HTMLElement): HTMLElement[] =>
        Array.from(reset.querySelectorAll(":scope > [data-block]")) as HTMLElement[];

    // 块顶部相对滚动容器内容顶部的偏移(槽位行要用同一个坐标系)
    const topOf = (reset: HTMLElement, el: HTMLElement): number => {
        return el.getBoundingClientRect().top - reset.getBoundingClientRect().top
            + reset.scrollTop - reset.clientTop;
    };

    const refresh = () => {
        if (disposed) return;
        const reset = findReset();
        if (!reset) {
            disposeGutter();
            return;
        }
        // 换了滚动容器:摘掉旧观察器与旧槽位
        if (reset !== resetEl) {
            stopObserving();
            disposeGutter();
            resetEl = reset;
        }
        // 无论当前有没有块都先挂观察器:Vditor 的块渲染可能晚于本模块安装,
        // 不挂的话「首次 refresh 时块还没出来」就永远没人补渲染了
        startObserving(reset);
        const blocks = blocksOf(reset);
        const starts = mdBlockStarts(host.source());
        if (blocks.length === 0 || starts.length === 0) {
            // 块还没出来:槽位先不画,等观察器触发下一轮
            disposeGutter();
            return;
        }
        if (!gutter) {
            gutter = document.createElement("div");
            gutter.className = GUTTER_CLASS;
            reset.classList.add(GUTTER_ON);
            reset.appendChild(gutter);
            gutter.addEventListener("contextmenu", onContext);
        }
        // 行号内容整体重画(块数不多,代价可控);重建期间掐掉观察器避免自触发
        stopObserving();
        try {
            gutter.textContent = "";
            const n = Math.min(blocks.length, starts.length);
            for (let i = 0; i < n; i++) {
                const line = starts[i] + 1;
                const row = document.createElement("div");
                row.className = "syfe-md__linenum";
                row.textContent = String(line);
                row.dataset.line = String(line);
                row.style.top = Math.max(0, Math.round(topOf(reset, blocks[i]))) + "px";
                row.title = `第 ${line} 行 · 右键复制链接`;
                gutter.appendChild(row);
            }
            gutter.style.height = Math.max(reset.scrollHeight, reset.clientHeight) + "px";
        } finally {
            startObserving(reset);
        }
    };

    const schedule = () => {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            refresh();
        }, 250);
    };

    let observer: MutationObserver | null = null;
    let resizer: ResizeObserver | null = null;
    const startObserving = (reset: HTMLElement) => {
        if (disposed) return;
        if (!observer) {
            observer = new MutationObserver(schedule);
        }
        try {
            observer.observe(reset, {childList: true, subtree: true});
        } catch {
            // 元素已脱离 DOM 等异常:忽略,下次 refresh 再挂
        }
        if (!resizer && typeof ResizeObserver === "function") {
            resizer = new ResizeObserver(schedule);
        }
        try {
            resizer?.observe(reset);
        } catch {
            // 同上
        }
    };
    const stopObserving = () => {
        try {
            observer?.disconnect();
        } catch {
            // 忽略
        }
        try {
            resizer?.disconnect();
        } catch {
            // 忽略
        }
    };

    const onContext = (e: MouseEvent) => {
        const row = (e.target as HTMLElement).closest(".syfe-md__linenum") as HTMLElement | null;
        if (!row) return;
        const line = Number(row.dataset.line);
        if (!isFinite(line) || line <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem({
            icon: "iconLink",
            label: `复制第 ${line} 行链接`,
            click: () => host.copyLineLink(line),
        });
        menu.open({x: e.clientX, y: e.clientY});
    };

    const disposeGutter = () => {
        if (gutter) {
            try {
                gutter.remove();
            } catch {
                // 忽略
            }
            gutter = null;
        }
        if (resetEl) {
            try {
                resetEl.classList.remove(GUTTER_ON);
            } catch {
                // 忽略
            }
            resetEl = null;
        }
    };

    refresh();
    // 首次 refresh 时 Vditor 的块可能还没渲染完(after 回调不总在渲染后),多试几拍
    let retries = 20;
    const early = window.setInterval(() => {
        if (disposed || gutter || retries-- <= 0) {
            window.clearInterval(early);
            return;
        }
        refresh();
    }, 500);

    return {
        refresh,
        lineToBlock(line: number): HTMLElement | null {
            const reset = resetEl || findReset();
            if (!reset) return null;
            const blocks = blocksOf(reset);
            const starts = mdBlockStarts(host.source());
            if (blocks.length === 0 || starts.length === 0) return null;
            const target = line - 1;   // 0-based
            let hit = -1;
            for (let i = 0; i < starts.length; i++) {
                if (starts[i] <= target) hit = i;
                else break;
            }
            if (hit < 0) return null;
            return blocks[Math.min(hit, blocks.length - 1)] || null;
        },
        dispose() {
            disposed = true;
            if (refreshTimer) window.clearTimeout(refreshTimer);
            stopObserving();
            if (gutter) gutter.removeEventListener("contextmenu", onContext);
            disposeGutter();
        },
    };
}
