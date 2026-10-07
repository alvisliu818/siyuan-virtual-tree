// Markdown 实时预览 / 阅读模式下的「文档内查找」。
//
// 源码模式用 Monaco,自带 Ctrl+F;这里负责**渲染态**(Vditor 输出的 HTML):
// 遍历文本节点把命中片段包成 <span class="syfe-md__find-hit">,再标记当前项并滚动到视野。
//
// 注意:Vditor 的取内容走 `lute.dom2md`(DOM → Markdown),行内多出来的 span 会被展平,
// 文本不丢;但为稳妥,保存/切模式前应调用 `clearFindHighlights()` 清掉高亮。
const HIT_CLASS = "syfe-md__find-hit";
const CUR_CLASS = "syfe-md__find-hit--cur";

// 去掉所有高亮(unwrap,还原为纯文本节点)
export function clearFindHighlights(root: HTMLElement | null | undefined): void {
    if (!root) return;
    const spans = root.querySelectorAll<HTMLElement>(`.${HIT_CLASS}`);
    spans.forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
    });
    if (spans.length > 0) root.normalize();
}

// 在 root 下高亮 query 的全部命中,返回命中的元素列表(按文档顺序)
export function highlightMatches(
    root: HTMLElement | null | undefined,
    query: string,
    caseSensitive = false,
): HTMLElement[] {
    clearFindHighlights(root);
    const q = query.trim();
    if (!root || !q) return [];

    const needle = caseSensitive ? q : q.toLowerCase();
    // 收集候选文本节点:跳过脚本/样式/输入框/已有高亮
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node: Node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "INPUT") {
                return NodeFilter.FILTER_REJECT;
            }
            if (p.closest(`.${HIT_CLASS}`)) return NodeFilter.FILTER_REJECT;
            const text = node.nodeValue || "";
            return text && (caseSensitive ? text : text.toLowerCase()).includes(needle)
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        },
    });
    const texts: Text[] = [];
    let cur: Node | null = walker.nextNode();
    while (cur) {
        texts.push(cur as Text);
        cur = walker.nextNode();
    }

    const hits: HTMLElement[] = [];
    for (const text of texts) {
        const str = text.nodeValue || "";
        const hay = caseSensitive ? str : str.toLowerCase();
        let idx = hay.indexOf(needle);
        if (idx < 0) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        while (idx >= 0) {
            if (idx > last) frag.appendChild(document.createTextNode(str.slice(last, idx)));
            const span = document.createElement("span");
            span.className = HIT_CLASS;
            span.textContent = str.slice(idx, idx + q.length);
            frag.appendChild(span);
            hits.push(span);
            last = idx + q.length;
            idx = hay.indexOf(needle, last);
        }
        if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
        if (text.parentNode) text.parentNode.replaceChild(frag, text);
    }
    return hits;
}

// 把第 index 项标为当前项并滚动到视野;越界时按方向环绕
export function setCurrentFindHit(hits: HTMLElement[], index: number, scroll = true): number {
    if (hits.length === 0) return -1;
    const i = ((index % hits.length) + hits.length) % hits.length;
    hits.forEach((el, idx) => el.classList.toggle(CUR_CLASS, idx === i));
    if (scroll) {
        try {
            hits[i].scrollIntoView({block: "center", inline: "nearest"});
        } catch {
            // 忽略
        }
    }
    return i;
}
