// 思源正文 file:// 链接右键菜单增强:
// 监听 SiYuan 的 open-menu-link 事件,对 file:// 链接追加
// 「在文件夹树中定位」(展开插件文件树并高亮该文件)。
// 利用思源插件菜单扩展机制,新增项落在链接右键菜单的「插件」子菜单下,不破坏原生行为。
import type {Plugin} from "siyuan";
import {fileUrlToPath} from "../utils/system-path";
import {revealInFileTree} from "../components/file-tree";

// 从链接节点取出 file:// 地址(思源链接节点可能用 data-href / data-url / href)
function getLinkUrl(element: HTMLElement): string | null {
    const candidates = [
        element.getAttribute("data-href"),
        element.getAttribute("href"),
        element.getAttribute("data-url"),
    ];
    for (const c of candidates) {
        if (c && /^file:\/\//i.test(c)) return c;
    }
    return null;
}

// 注册:思源笔记正文里右键 file:// 链接时,提供"在文件夹树中定位"
export function registerLinkReveal(plugin: Plugin): void {
    plugin.eventBus.on("open-menu-link", (e: any) => {
        const element: HTMLElement | null = e?.detail?.element;
        if (!element) return;
        const url = getLinkUrl(element);
        if (!url) return; // 仅处理 file:// 链接(http/assets/siyuan 等交给思源原生菜单)
        const path = fileUrlToPath(url);
        if (!path) return;
        const menu = e.detail.menu;
        menu.addItem({
            icon: "iconFolder",
            label: "在文件夹树中定位",
            click: () => {
                void revealInFileTree(path);
            },
        });
    });
}
