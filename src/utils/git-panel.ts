// 打开 Git 面板并定位到指定路径。
//
// 与 mount-locate 同款坑:dock 面板懒创建,从未打开过时 DOM 里没有 .syfe-git-dock,
// init 里的事件监听也就没注册,直接派发等于石沉大海。先点一次 dock 图标确保创建。
const DOCK_ITEM_SEL = '.dock__item[data-type$="siyuan-file-editor-git-dock"]';

export const GIT_OPEN_EVENT = "syfe:git-open";

export function openGitPanel(path: string): void {
    const fire = () => {
        try {
            window.dispatchEvent(new CustomEvent(GIT_OPEN_EVENT, {detail: {path}}));
        } catch {
            // 派发失败静默:调用方的主动作不受影响
        }
    };
    if (document.querySelector(".syfe-git-dock")) {
        fire();
        return;
    }
    const dockItem = document.querySelector<HTMLElement>(DOCK_ITEM_SEL);
    if (!dockItem) {
        fire();
        return;
    }
    dockItem.click();
    const deadline = Date.now() + 2500;
    const timer = window.setInterval(() => {
        if (document.querySelector(".syfe-git-dock") || Date.now() > deadline) {
            window.clearInterval(timer);
            fire();
        }
    }, 120);
}