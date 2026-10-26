// 思源侧(文档树 / 正文块 / 块标)右键挂载到虚拟文档树。
// 利用思源插件菜单扩展机制,新增项落在原生右键菜单的「插件」子菜单下,不破坏原生行为:
//   open-menu-doctree  → 挂载思源文档/笔记本(文档自动带出子文档;笔记本列出顶级文档)
//   open-menu-content  → 挂载思源块(挂载后按 parent_id 递归展开子块)
//   click-blockicon    → 块标(悬浮块图标)点击/右键菜单,与正文右键同款挂块入口
import type {Plugin} from "siyuan";
import {addMountMenuItem} from "../components/mount-menu";
import {blockTitle} from "../utils/blocks";

// 块元素 → 块 id(正文块元素带 data-id)
function blockIdOf(el: HTMLElement | null): string | null {
    if (!el) return null;
    const id = el.getAttribute("data-id") || el.getAttribute("data-node-id");
    return id || null;
}

// 给菜单追加「挂载到虚拟文档树」(块挂载):正文右键与块标菜单共用
function addBlockMountItem(menu: any, plugin: Plugin, el: HTMLElement | null): void {
    const blockId = blockIdOf(el);
    if (!blockId) return;
    const text = (el?.textContent || "").trim();
    addMountMenuItem(menu, plugin, {
        kind: "block",
        name: blockTitle(text, "p"),
        targetId: blockId,
    });
}

export function registerMountMenu(plugin: Plugin): void {
    // 文档树:一次可能选中多个,只处理第一个(避免菜单爆炸)。
    // items[0].id 是思源的权威来源(见 siyuan/app/src/menus/navigation.ts 各 emit 点):
    //   type="doc"/"docs"/"items"          → 文档 id
    //   type="notebook"/"notebooks" → 笔记本 id —— 单选笔记本 emit 的是
    //     items:[{id: notebookId, path: "/", notebookId}],**有 id**,并不是「自然被排除」。
    //     曾误判导致笔记本被按 kind="doc" 挂载:笔记本 ID 不是块 ID,展开时 getDocInfo
    //     查不到 blocks 行,得到「文档不存在」的死条目,与面板「挂载思源笔记本」
    //     (kind="notebook")行为不一致。笔记本必须走 kind="notebook"。
    plugin.eventBus.on("open-menu-doctree", (e: any) => {
        const menu = e?.detail?.menu;
        if (!menu) return;
        const items: any[] = Array.isArray(e?.detail?.items) ? e.detail.items : [];
        const elements: HTMLElement[] = Array.isArray(e?.detail?.elements) ? e.detail.elements : [];
        const el = elements[0];
        const menuType = typeof e?.detail?.type === "string" ? e.detail.type : "";
        const isNotebook = menuType === "notebook" || menuType === "notebooks";
        // 笔记本只信 items[0].id,不用 data-node-id 兑底(元素上没有可靠的笔记本 ID)
        const targetId = isNotebook
            ? (items[0] && typeof items[0].id === "string" && items[0].id) || null
            : (items[0] && typeof items[0].id === "string" && items[0].id)
                || (el ? el.getAttribute("data-node-id") : null);
        if (!targetId) return;
        if (isNotebook) {
            // 显示名优先取笔记本真实名称(window.siyuan.notebooks 与原生菜单同源),
            // 否则退回元素文本,最后才是裸 ID —— 避免出现 name=裸 ID 的条目
            const nb = ((window as any).siyuan?.notebooks || []).find((n: any) => n && n.id === targetId);
            const name = (typeof nb?.name === "string" && nb.name)
                || (el?.textContent || "").trim()
                || targetId;
            addMountMenuItem(menu, plugin, {kind: "notebook", name, targetId});
            return;
        }
        const name = (el?.textContent || "").trim() || targetId;
        addMountMenuItem(menu, plugin, {kind: "doc", name, targetId});
    });

    // 正文块:右键段落/标题/列表等
    plugin.eventBus.on("open-menu-content", (e: any) => {
        const menu = e?.detail?.menu;
        if (!menu) return;
        addBlockMountItem(menu, plugin, e?.detail?.element as HTMLElement | null);
    });

    // 块标(悬浮块图标)点击/右键:blockElements 是选中的块集合,多选时只处理第一个
    plugin.eventBus.on("click-blockicon", (e: any) => {
        const menu = e?.detail?.menu;
        if (!menu) return;
        const els: HTMLElement[] = Array.isArray(e?.detail?.blockElements) ? e.detail.blockElements : [];
        addBlockMountItem(menu, plugin, els[0] || null);
    });
}
