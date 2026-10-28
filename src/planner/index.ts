// 习惯与目标 —— 并入宿主(siyuan-virtual-tree)后的适配层。
//
// 原独立插件(siYuan-planner)入口只做三件事:加载数据 → 注册界面(Dock/Tab/命令/设置) → 卸载收尾。
// 并入后拆成:
//  - applyPlannerEnabled(host, enabled) = 总开关;启用 = loadPlanner + initPlannerTimer(+首次迁移)
//  - destroyPlanner()                   = 停计时器 + 强制落盘
//  - openPlannerTab / createPlannerDockConfig / createPlannerTabConfig 原样导出,
//    Dock / Tab / 顶栏 / 命令的注册由宿主 onload / onLayoutReady 完成(见宿主 index.ts)。
// 所有业务逻辑都在 store / stats / timer / views 里,与独立插件版本保持一致,便于跟随上游。
import {showMessage} from "siyuan";
import {flushPlanner, loadPlanner} from "./store";
import {disposeTimer, initPlannerTimer} from "./timer";
import {disposeReminders, initReminders} from "./remind";
import {tryImportLegacy} from "./migrate";
import "./styles.scss";

let g_host: any = null;
let g_active = false;

/**
 * 按总开关启用/停用本模块(幂等;宿主 onLayoutReady 与保存设置后调用)。
 * 启用 = 读档 + 启动计时引擎 + 首次空档迁移(从独立插件 siyuan-planner 的旧存档导入)。
 */
export async function applyPlannerEnabled(host: any, enabled: boolean): Promise<void> {
    if (!enabled) {
        destroyPlanner();
        return;
    }
    if (g_active) {
        return;
    }
    g_active = true;
    g_host = host;
    try {
        await loadPlanner(host);
        initPlannerTimer(host);
        initReminders(host);
    } catch (e) {
        console.error("[planner] 加载数据失败:", e);
        return;
    }
    // 从独立插件(siyuan-planner)迁移历史数据 —— 只在本模块还是空存档时跑一次。
    // 插件私有存储按插件名隔离,不迁的话用户之前建的习惯会凭空消失。
    try {
        if (await tryImportLegacy(host)) {
            showMessage("已从「习惯与目标」独立插件导入历史数据", 6000);
        }
    } catch {
        // 迁移失败不影响使用
    }
}

/** 总开关关闭 / 宿主 onunload:停计时器、落盘。数据保留在 planner.json,重新启用即恢复。 */
export function destroyPlanner(): void {
    if (!g_active) {
        return;
    }
    g_active = false;
    try {
        disposeTimer();
        disposeReminders();
        flushPlanner();
    } catch {
        // ignore
    }
}

/** 供宿主判断模块是否已激活(命令回调、设置行保存等用) */
export function isPlannerActive(): boolean {
    return g_active;
}
