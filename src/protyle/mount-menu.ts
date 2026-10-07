// 思源侧(文档树 / 正文块)右键挂载到虚拟文档树。
// 利用思源插件菜单扩展机制,新增项落在原生右键菜单的「插件」子菜单下,不破坏原生行为:
//   open-menu-doctree  → 挂载思源文档(挂载后自动带出其子文档)
//   open-menu-content   → 挂载思源块(挂载后按 parent_id 递归展开子块)
import type {Plugin} from "siyuan";
import {addMountMenuItem} from "../components/mount-menu";
import {blockTitle} from "../utils/blocks";

// 块元素 → 块 id(正文块元素带 data-id)
function blockIdOf(el: HTMLElement | null): string | null {
    if (!el) return null;
    const id = el.getAttribute("data-id") || el.getAttribute("data-node-id");
    return id || null;
}

export function registerMountMenu(plugin: Plugin): void {
    // 文档树:一次可能选中多个,只处理第一个(避免菜单爆炸)。
    // docId 优先取 detail.items[0].id(思源内部权威来源,type="doc" 时一定有),
    // 回退到元素上的 data-node-id。笔记本节点 type="notebook"/"notebooks",没有 items[0].id,自然被排除。
    plugin.eventBus.on("open-menu-doctree", (e: any) => {
        const menu = e?.detail?.menu;
        if (!menu) return;
        const items: any[] = Array.isArray(e?.detail?.items) ? e.detail.items : [];
        const elements: HTMLElement[] = Array.isArray(e?.detail?.elements) ? e.detail.elements : [];
        const el = elements[0];
        const docId = (items[0] && typeof items[0].id === "string" && items[0].id)
            || (el ? el.getAttribute("data-node-id") : null);
        if (!docId) return;
        const name = (el?.textContent || "").trim() || docId;
        addMountMenuItem(menu, plugin, {kind: "doc", name, targetId: docId});
    });

    // 正文块:右键段落/标题/列表等
    plugin.eventBus.on("open-menu-content", (e: any) => {
        const menu = e?.detail?.menu;
        if (!menu) return;
        const blockId = blockIdOf(e?.detail?.element as HTMLElement | null);
        if (!blockId) return;
        const text = ((e?.detail?.element as HTMLElement)?.textContent || "").trim();
        addMountMenuItem(menu, plugin, {
            kind: "block",
            name: blockTitle(text, "p"),
            targetId: blockId,
        });
    });
}
