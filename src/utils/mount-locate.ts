// 虚拟文档树定位事件的可靠派发。
//
// 坑:dock 面板是懒创建的 —— 虚拟文档树面板从未打开过时,DOM 里没有 .syfe-mtree-dock,
// 面板 init 里的 window 事件监听(syfe:mount-tree-locate / -folder / -doc)也就没注册,
// 此时派发事件等于石沉大海(表现:点固定的文件夹/文档毫无反应)。
// 这里先确保面板已创建(点一次 dock 图标),再派发事件。

const DOCK_ITEM_SEL = '.dock__item[data-type$="siyuan-file-editor-mount-tree-dock"]';

// opts.revealPanel=false:只是"顺带闪烁定位",面板没打开时**不要**替用户打开它
// (从新标签页/最近使用点一篇思源文档就弹出虚拟文档树面板,属于打扰)。
export function dispatchMountTreeEvent(
    type: string,
    detail: Record<string, unknown>,
    opts?: {revealPanel?: boolean},
): void {
    const revealPanel = opts?.revealPanel !== false;
    const fire = () => {
        try {
            window.dispatchEvent(new CustomEvent(type, {detail: {...detail, revealPanel}}));
        } catch {
            // 派发失败静默(调用方的主动作不受影响)
        }
    };
    // 面板已存在(无论显示与否):init 已跑过,监听已注册,直接发
    if (document.querySelector(".syfe-mtree-dock")) {
        fire();
        return;
    }
    // 不主动展开:面板从未创建 → 事件没人接,直接跳过(创建即显示,会打扰用户)
    if (!revealPanel) return;
    // 面板从未创建:点一次 dock 图标触发创建并显示,等它出现后再发
    const dockItem = document.querySelector<HTMLElement>(DOCK_ITEM_SEL);
    if (!dockItem) {
        fire(); // 理论不可能(插件加载即挂 dock);照发,失败静默
        return;
    }
    dockItem.click();
    const deadline = Date.now() + 2500;
    const timer = window.setInterval(() => {
        if (document.querySelector(".syfe-mtree-dock") || Date.now() > deadline) {
            window.clearInterval(timer);
            fire();
        }
    }, 120);
}
