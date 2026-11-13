// 虚拟文档树页签:与侧边栏 dock 双形态共存。
// 面板本体(mountTreePanelInit/Destroy)在 dock 与页签两种宿主上各自实例化,
// 状态独立(展开/缓存),mount-tree-changed 等事件广播会同时驱动两者重绘。
// 页签形态的优势:可与编辑器分栏并排、Ctrl+Tab 切换、随布局持久化恢复。
import {openTab, showMessage} from "siyuan";
import {isMobileFrontend} from "../utils/platform";
import {MOUNT_TREE_TAB_TYPE} from "../constants";
import {IPluginForMountTree, MountTreeDockInstance, mountTreePanelInit, mountTreePanelDestroy} from "../dock/mount-tree-dock";

export interface IPluginForMountTreeTab {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

// 打开虚拟文档树页签(已有则聚焦;移动端无页签系统,提示用侧边栏面板)
export function openMountTreeTab(plugin: IPluginForMountTreeTab): void {
    if (isMobileFrontend()) {
        showMessage("移动端不支持页签,请使用侧边栏的虚拟文档树面板", 3000, "info");
        return;
    }
    const opened = plugin.getOpenedTab()[MOUNT_TREE_TAB_TYPE] || [];
    if (opened.length) {
        const tab = (opened[0] as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + MOUNT_TREE_TAB_TYPE,
            icon: "iconList",
            title: "虚拟文档树",
            data: {tab: true},
        },
    } as any);
}

// 页签实例上附加的字段
interface MountTreeTabInstance {
    element: HTMLElement;
    data?: { tab?: boolean };
    _panelSelf?: MountTreeDockInstance;
}

// 创建虚拟文档树页签配置(index.ts addTab 注册)
export function createMountTreeTabConfig(plugin: IPluginForMountTree) {
    return {
        type: MOUNT_TREE_TAB_TYPE,
        init(this: MountTreeTabInstance) {
            this.element.classList.add("syfe-mtree-tab", "fn__flex-column");
            this.element.innerHTML = `<div class="syfe-mtree-tab__host"></div>`;
            const host = this.element.querySelector(".syfe-mtree-tab__host") as HTMLElement;
            const panelSelf: MountTreeDockInstance = {element: host};
            this._panelSelf = panelSelf;
            mountTreePanelInit(panelSelf, plugin);
        },
        destroy(this: MountTreeTabInstance) {
            if (this._panelSelf) {
                mountTreePanelDestroy(this._panelSelf);
            }
            this._panelSelf = undefined;
        },
    } as any;
}
