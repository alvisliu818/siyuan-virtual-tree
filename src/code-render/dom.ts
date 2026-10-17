/** 代码块 DOM 读写工具：语言识别、取纯文本、注入渲染按钮。 */

export const RENDER_BTN_FLAG = "data-code-render-btn";
export const PANEL_FLAG = "data-code-render-panel";
export const PROCESSED_FLAG = "data-code-render-processed";

/** 思源代码块选择器（div[data-type="NodeCodeBlock"].code-block） */
export const CODE_BLOCK_SELECTOR = 'div[data-type="NodeCodeBlock"]';

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 代码块元素判定：思源用 div[data-type="NodeCodeBlock"].code-block */
export function isCodeBlock(el: Element | null | undefined): el is HTMLElement {
    return !!el && el.getAttribute?.("data-type") === "NodeCodeBlock";
}

/**
 * 取代码块语言标识。
 * 思源把语言放在 .protyle-action 下的语言标签里；第三方美化插件可能移动它，
 * 因此这里做多候选匹配 + 兜底（取 action 区第一个 span 的文本）。
 */
export function getBlockLang(block: HTMLElement): string {
    const action = block.querySelector(":scope > .protyle-action");
    if (action) {
        const byClass = action.querySelector('[class*="language"]');
        if (byClass?.textContent) {
            const text = byClass.textContent.trim().toLowerCase();
            if (text) return text;
        }
        const first = action.querySelector("span");
        const text = first?.textContent?.trim().toLowerCase() || "";
        // 只有单个词且不是已知图标容器时才采信
        if (text && /^[\w+#.-]{1,20}$/.test(text)) return text;
    }
    return "";
}

/** `.hljs` 外层容器（内含行号槽 + 可编辑代码元素） */
export function getHljsHost(block: HTMLElement): HTMLElement | null {
    return block.querySelector(":scope > .hljs") as HTMLElement | null;
}

/**
 * 取真正承载代码文本的可编辑元素。
 * 与内核 getContenteditableElement 保持一致：`.hljs` 的 lastElementChild。
 * `.hljs` 的 firstElementChild 是行号槽 .protyle-linenumber__rows，不能当代码容器。
 */
export function getCodeEditable(block: HTMLElement): HTMLElement | null {
    const host = getHljsHost(block);
    if (host) {
        const last = host.lastElementChild as HTMLElement | null;
        // 只有一个子节点时该子节点可能就是行号槽，此时退回 host 本身
        if (last && !last.classList.contains("protyle-linenumber__rows")) return last;
        return host;
    }
    return block.querySelector(":scope > [contenteditable]") as HTMLElement | null;
}

/**
 * 取代码块纯文本。
 * 可编辑区里换行可能是 \n 文本节点，也可能是 <br>（只读/导出态），
 * 直接 textContent 会把 <br> 变成空串导致整段粘成一行，故先归一化。
 */
export function getCodeText(block: HTMLElement): string {
    const host = getCodeEditable(block);
    if (!host) return "";
    const clone = host.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("br").forEach((br) => {
        br.replaceWith(document.createTextNode("\n"));
    });
    // 思源在每个块末尾可能插入零宽空格，去掉避免污染 SQL
    return (clone.textContent || "").replace(/\u200b/g, "");
}

export function findCodeBlocks(root: ParentNode): HTMLElement[] {
    const nodes = root.querySelectorAll(CODE_BLOCK_SELECTOR);
    const out: HTMLElement[] = [];
    nodes.forEach((n) => out.push(n as HTMLElement));
    return out;
}

const BTN_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';

/** 在代码块头部注入渲染按钮；已注入过则直接返回既有按钮。 */
export function ensureRenderButton(block: HTMLElement, label: string): HTMLElement {
    const action = block.querySelector(":scope > .protyle-action") as HTMLElement | null;
    const scope: HTMLElement = action || block;
    const exist = scope.querySelector(`[${RENDER_BTN_FLAG}]`) as HTMLElement | null;
    if (exist) return exist;

    const btn = document.createElement("span");
    btn.setAttribute(RENDER_BTN_FLAG, "1");
    btn.className = "protyle-icon protyle-icon--last code-render-btn";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("data-position", "4north");
    btn.contentEditable = "false";
    btn.innerHTML = BTN_SVG;
    scope.appendChild(btn);
    return btn;
}

export function removeRenderButton(block: HTMLElement): void {
    block.querySelectorAll(`[${RENDER_BTN_FLAG}]`).forEach((n) => n.remove());
}
