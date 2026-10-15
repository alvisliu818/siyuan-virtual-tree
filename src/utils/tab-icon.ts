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
