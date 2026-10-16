// 自定义页签头的类型图标 → 虚拟文件树同款文件图标。
//
// openTab 的 custom.icon 参数只收思源 icon id(svg use),装了图标主题后的
// 扩展图标是 <img src> 进不去;所以页签建好后要把头部那个类型图标 svg 换掉。
// 头部 DOM:li.item → [svg 类型图标] [span.item__text] [span.item__close svg]。
//
// 为什么是"事件驱动"而不是定时轮询:思源会重绘页签条(把通用 svg 又画回去),
// 老实现用 200ms 轮询去追,正好形成"通用图标 ⇄ 树图标"肉眼可见的来回变。
// 现在改成:注册表记下每个页签要画的图标,页签头一出现/被重绘就在微任务里
// (MutationObserver 回调,早于绘制)替换掉 —— 用户看到的就是"一直是树里的图标"。

import {basename} from "./path";
import {fileIconHTML} from "./icons";

// 页签 id → 要画的图标(路径 + 创建时传的通用 icon id 用于精确定位)
interface TabIconRec {
    path: string;
    iconId: string;
    misses: number; // 连续找不到页签头的次数(页签已关闭则注销)
}
const registry = new Map<string, TabIconRec>();
let observer: MutationObserver | null = null;
let scheduled = false;

// 从自定义页签实例取 tab id(与页签头 .item[data-id] / 面板 data-id 一致)
function tabIdOf(tabLike: any): string {
    try {
        const t = tabLike?.tab?.id || tabLike?.id;
        if (t) return String(t);
        const el = tabLike?.element as HTMLElement | undefined;
        const fromEl = el?.dataset?.id || el?.getAttribute?.("data-id");
        return fromEl ? String(fromEl) : "";
    } catch {
        return "";
    }
}

// 页签头当前的图标节点(header 里排在 .item__text 之前的那个 svg/img)
function currentHeadIcon(head: HTMLElement): Element | null {
    for (const child of Array.from(head.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "svg" || tag === "img") return child;
    }
    return null;
}

// 图标节点的"身份":同身份说明画的和要画的是同一个,不必重建(避免无谓重排)
// img 比 src;svg 比 use 的 href(没有 use 时比 class)
function iconIdentity(node: Element | null): string {
    if (!node) return "";
    if (node.tagName.toLowerCase() === "img") {
        return `img:${(node as HTMLImageElement).getAttribute("src") || ""}`;
    }
    const use = node.querySelector("use");
    const href = use?.getAttribute("href") || use?.getAttribute("xlink:href") || "";
    return `svg:${href}:${node.getAttribute("class") || ""}`;
}

function identityOfHTML(html: string): string {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    return iconIdentity(wrap.firstElementChild);
}

// 把某个页签头的图标换成「虚拟文件树同款」;返回是否真的动了
export function replaceHeadIcon(head: HTMLElement, path: string): boolean {
    const cur = currentHeadIcon(head);
    if (!cur) return false;
    const nextHTML = fileIconHTML(basename(path));
    if (iconIdentity(cur) === identityOfHTML(nextHTML)) return false; // 已经是同一个
    const wrap = document.createElement("div");
    wrap.innerHTML = nextHTML;
    const iconEl = wrap.firstElementChild;
    if (!iconEl) return false;
    cur.replaceWith(iconEl);
    return true;
}

export function applyFileTabHeadIcon(tabLike: any, path: string, iconId: string): boolean {
    try {
        const head: HTMLElement | null | undefined = tabLike?.headElement || tabLike?.parent?.headElement
            || tabLike?.tab?.headElement;
        if (!head) return false;
        const uses = Array.from(head.querySelectorAll("use"));
        const target = uses.find(u => (u.getAttribute("href") || u.getAttribute("xlink:href")) === `#${iconId}`);
        const svg = target?.ownerSVGElement;
        if (!svg) return false;
        const wrap = document.createElement("span");
        wrap.innerHTML = fileIconHTML(basename(path));
        const iconEl = wrap.firstElementChild as HTMLElement | null;
        if (!iconEl) return false;
        svg.replaceWith(iconEl);
        return true;
    } catch {
        return false;
    }
}

// === 事件驱动补画 ===

// 一次替换动作:把注册表里所有页签的头图标对齐到"树图标"
function fixAll(): void {
    scheduled = false;
    for (const [id, rec] of Array.from(registry)) {
        let head: HTMLElement | null = null;
        try {
            head = document.querySelector<HTMLElement>(`.layout-tab-bar .item[data-id="${CSS.escape(id)}"]`);
        } catch {
            head = null;
        }
        if (!head) {
            rec.misses++;
            if (rec.misses > 5) registry.delete(id); // 页签已关闭
            continue;
        }
        rec.misses = 0;
        try {
            replaceHeadIcon(head, rec.path);
        } catch {
            // 单个页签失败不影响其它页签
        }
    }
    if (registry.size === 0 && observer) {
        observer.disconnect();
        observer = null;
    }
}

function scheduleFix(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(fixAll); // 同一帧内、早于绘制完成替换
}

function ensureObserver(): void {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver((records) => {
        // 只关心页签条里的变动:正文输入会产生大量 mutation,直接跳过
        for (const r of records) {
            const t: any = r.target;
            const el: HTMLElement | null = t && t.nodeType === 1 ? t : (t?.parentElement || null);
            if (!el) continue;
            if (el.closest?.(".layout-tab-bar") || r.addedNodes?.length) {
                // 进一步确认:新增节点里有页签头/图标,或目标就在页签条里
                if (el.closest?.(".layout-tab-bar")) { scheduleFix(); return; }
                for (const n of Array.from(r.addedNodes || [])) {
                    const ne = n as HTMLElement;
                    if (ne.nodeType === 1 && (ne.matches?.(".item") || ne.querySelector?.(".item"))) {
                        scheduleFix();
                        return;
                    }
                }
            }
        }
    });
    observer.observe(document.body, {childList: true, subtree: true});
}

// 注册:页签 init / 打开时调用。之后页签头的每次出现与重绘都会自动对齐图标
export function applyFileTabHeadIconWhenReady(tabLike: any, path: string, iconId: string): void {
    const id = tabIdOf(tabLike);
    if (id) {
        registry.set(id, {path, iconId, misses: 0});
        ensureObserver();
    }
    // 同步先试一次:页签头往往已就绪,这样连一次中间态都不会出现
    applyFileTabHeadIcon(tabLike, path, iconId);
    scheduleFix();
}

// 图标主题就绪/切换后:注册表里的页签 + 会话恢复的页签(按 data-syfe-path 扫)统一重刷
export function refreshAllTabIcons(): number {
    let count = 0;
    try {
        const els = Array.from(document.querySelectorAll<HTMLElement>("[data-syfe-path]"));
        for (const el of els) {
            const path = el.dataset.syfePath;
            if (!path) continue;
            const panel = el.closest("[data-id]");
            const id = panel?.getAttribute("data-id");
            if (id && !registry.has(id)) {
                // 恢复的页签没进注册表(没走 init 注册),补登记
                registry.set(id, {path, iconId: "", misses: 0});
            }
            const head = id ? document.querySelector<HTMLElement>(`.layout-tab-bar .item[data-id="${CSS.escape(id)}"]`) : null;
            if (!head) continue;
            try {
                if (replaceHeadIcon(head, path)) count++;
            } catch {
                // 单个页签失败不影响其它页签
            }
        }
    } catch {
        return 0;
    }
    if (registry.size > 0) ensureObserver();
    return count;
}
