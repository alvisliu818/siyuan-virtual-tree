// 思源块 ↔ 习惯与目标:块菜单入口 + 生命周期。
//
// 绑定写在块属性 custom-planner 上;菜单提供「绑定项目(可搜索)」与「清除绑定」,
// 块旁徽标与状态同步由 ui.ts 负责。
import {showMessage} from "siyuan";
import {
    bindingsOf, destroyBlockPlannerUI, initBlockPlannerUI, openBindPicker, refreshBindings,
    setLocalBindings,
} from "./ui";
import {describe, loadBindings, saveBindings} from "./store";

let g_plugin: any = null;
let g_registered = false;
const timers: number[] = [];

/** open-menu-content 给 element,click-blockicon 给 blockElements[0]。 */
function blockIdOf(e: any): string {
    const raw = (e?.detail?.element || e?.detail?.blockElements?.[0]) as HTMLElement | null;
    if (!raw) return "";
    const el = (raw.matches?.("[data-node-id], [data-id]") ? raw
        : (raw.closest?.("[data-node-id], [data-id]") || raw)) as HTMLElement;
    return el.getAttribute("data-node-id") || el.getAttribute("data-id") || "";
}

const onMenu = (e: any) => {
    const menu = e?.detail?.menu;
    const blockId = blockIdOf(e);
    if (!menu || !blockId) return;
    const bound = bindingsOf(blockId);
    menu.addItem({
        icon: "iconLink",
        label: bound.length ? `绑定习惯与目标项目 (${bound.length})` : "绑定习惯与目标项目",
        click: () => {
            openBindPicker(async (b) => {
                try {
                    const list = await loadBindings(blockId);
                    if (!list.some(x => x.type === b.type && x.id === b.id)) list.push(b);
                    await saveBindings(blockId, list);
                    setLocalBindings(blockId, list);
                    void refreshBindings();
                    const info = describe([b])[0];
                    showMessage(`已绑定「${info?.name || b.id}」到该块`, 3000, "info");
                } catch (err) {
                    showMessage(`绑定失败:${String(err)}`, 4000, "error");
                }
            });
        },
    });
    if (bound.length) {
        menu.addItem({
            icon: "iconTrashcan",
            label: `清除本块绑定 (${bound.length})`,
            click: () => {
                void (async () => {
                    await saveBindings(blockId, []);
                    setLocalBindings(blockId, []);
                    void refreshBindings();
                    showMessage("已清除该块的习惯与目标绑定", 3000, "info");
                })();
            },
        });
    }
};

const onLoaded = () => {
    void refreshBindings();
};

export function registerBlockPlanner(plugin: any): void {
    if (g_registered) return;
    g_registered = true;
    g_plugin = plugin;
    plugin.eventBus.on("open-menu-content", onMenu);
    plugin.eventBus.on("click-blockicon", onMenu);
    plugin.eventBus.on("loaded-protyle-static", onLoaded);
    plugin.eventBus.on("loaded-protyle-dynamic", onLoaded);
    plugin.eventBus.on("switch-protyle", onLoaded);
    initBlockPlannerUI(plugin);
    // 布局恢复 / 存档加载晚于 onload:双补扫把已绑定的块补上徽标
    timers.push(window.setTimeout(onLoaded, 600));
    timers.push(window.setTimeout(onLoaded, 2000));
}

export function destroyBlockPlanner(): void {
    if (!g_registered) return;
    g_registered = false;
    if (g_plugin?.eventBus?.off) {
        g_plugin.eventBus.off("open-menu-content", onMenu);
        g_plugin.eventBus.off("click-blockicon", onMenu);
        g_plugin.eventBus.off("loaded-protyle-static", onLoaded);
        g_plugin.eventBus.off("loaded-protyle-dynamic", onLoaded);
        g_plugin.eventBus.off("switch-protyle", onLoaded);
    }
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
    destroyBlockPlannerUI();
    g_plugin = null;
}
