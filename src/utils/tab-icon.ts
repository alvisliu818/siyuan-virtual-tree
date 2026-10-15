// 自定义页签头的类型图标 → 虚拟文件树同款文件图标。
//
// openTab 的 custom.icon 参数只收思源 icon id(svg use),装了图标主题后的
// 扩展图标是 <img src> 进不去;所以页签建好后把头部那个类型图标 svg 直接替换掉。
// 头部 DOM:li.item → [svg 类型图标] [span.item__text] [span.item__close svg] ——
// 用创建时传入的 icon id 精确匹配那条 <use>,避免误伤关闭按钮的图标。
//
// WhenReady 版本:页签头可能比 init 晚就绪(新建/会话恢复/页签条重绘),
// 200ms × 25 次(5s)重试直到找到目标 use;替换后若页签条重绘回退,
// 再次调用会因找不到 iconFile use 而跳过(已被替换) —— 需要恢复时可重调。

import {basename} from "./path";
import {fileIconHTML} from "./icons";

export function applyFileTabHeadIcon(tabLike: any, path: string, iconId: string): boolean {
    try {
        const head: HTMLElement | null | undefined = tabLike?.headElement || tabLike?.parent?.headElement;
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

// 全局补画:给所有已打开的插件页签重刷头图标。
//
// 场景:扩展是异步加载的,会话恢复/早期打开建立的页签在画图标时还没有图标主题,
// 落成了思源内置图标;主题就绪后必须补一次,否则要点开重画才会变。
// 页签内容元素都写了 dataset.syfePath(见各 tabs/*),顺着它回到自己的 panel,
// 再用 panel 的 data-id 反查对应的页签头。
export function refreshAllTabIcons(): number {
    let count = 0;
    try {
        const els = Array.from(document.querySelectorAll<HTMLElement>("[data-syfe-path]"));
        for (const el of els) {
            const path = el.dataset.syfePath;
            if (!path) continue;
            const panel = el.closest("[data-id]");
            const id = panel?.getAttribute("data-id");
            if (!id) continue;
            const head = document.querySelector<HTMLElement>(
                `.layout-tab-bar .item[data-id="${CSS.escape(id)}"]`,
            );
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
    return count;
}

// 重试版:init 时调用(新建页签与**会话恢复的页签**都走 init,统一覆盖)
export function applyFileTabHeadIconWhenReady(tabLike: any, path: string, iconId: string, attempts = 25): void {
    const step = () => {
        if (applyFileTabHeadIcon(tabLike, path, iconId)) return true;
        return false;
    };
    if (step()) return;
    let n = 0;
    const timer = window.setInterval(() => {
        n++;
        if (step() || n >= attempts) window.clearInterval(timer);
    }, 200);
}
