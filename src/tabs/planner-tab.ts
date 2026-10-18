// 全屏「习惯与目标」Tab:左侧导航 + 右侧内容。
//
// 与 Dock 的关系:Dock 是日常速览(打卡 / 今日清单 / 计时器),Tab 是完整管理。
// 两边共享同一份数据和同一套视图渲染函数,所以不会出现"这边加了习惯那边看不到"的分裂。
import {openTab} from "siyuan";
import {PLANNER_TAB_TYPE} from "../constants";
import {ViewCtx, ViewId} from "../planner/context";
import {PLANNER_CHANGED_EVENT, IPlannerPlugin} from "../planner/store";
import {TIMER_TICK_EVENT} from "../planner/timer";
import {openPlannerSettingsDialog} from "../planner/dialogs";
import {renderToday} from "../planner/views/today";
import {renderHabits} from "../planner/views/habits";
import {renderGoals} from "../planner/views/goals";
import {renderTasks} from "../planner/views/tasks";
import {renderCountdowns} from "../planner/views/countdowns";
import {renderTimerView, patchTimerView} from "../planner/views/timer";
import {renderStatsView} from "../planner/views/stats";
import {disposeTimer} from "../planner/timer";

export interface IPluginForPlannerTab extends IPlannerPlugin {
    app: any;
    name: string;
    getOpenedTab(): {[key: string]: any[]};
}

interface PlannerTabInstance {
    element: HTMLElement;
    _bodyEl?: HTMLElement;
    _changedHandler?: () => void;
    _tickHandler?: () => void;
    _gotoHandler?: (e: Event) => void;
    _view?: ViewId;
}

const VIEWS: {id: ViewId; label: string; icon: string}[] = [
    {id: "today", label: "今日", icon: "☀️"},
    {id: "habits", label: "习惯", icon: "⭐"},
    {id: "goals", label: "目标", icon: "🎯"},
    {id: "tasks", label: "任务", icon: "🗂️"},
    {id: "todo", label: "待办", icon: "📥"},
    {id: "timer", label: "计时", icon: "⏱️"},
    {id: "countdowns", label: "倒数日", icon: "📅"},
    {id: "stats", label: "统计", icon: "📊"},
];

export function createPlannerTabConfig(plugin: IPluginForPlannerTab) {
    return {
        type: PLANNER_TAB_TYPE,
        init(this: PlannerTabInstance) {
            this.element.classList.add("syfe-planner-tab", "fn__flex", "fn__flex-column");
            const wanted = this.element.dataset.plView as ViewId | undefined;
            this._view = wanted && VIEWS.some(v => v.id === wanted) ? wanted : "today";

            this.element.innerHTML = `
                <div class="syfe-pl">
                    <div class="syfe-pl__nav">
                        <div class="syfe-pl__navhead">
                            <span class="syfe-pl__navtitle">习惯与目标</span>
                            <span class="fn__flex-1"></span>
                            <span class="syfe-pl__navbtn" data-act="settings" title="设置">⚙</span>
                            <span class="syfe-pl__navbtn" data-act="refresh" title="刷新">⟳</span>
                        </div>
                        <div class="syfe-pl__navlist">
                            ${VIEWS.map(v => `
                                <div class="syfe-pl__navitem${v.id === this._view ? " is-active" : ""}" data-view="${v.id}">
                                    <span class="syfe-pl__navicon">${v.icon}</span>
                                    <span class="syfe-pl__navlabel">${v.label}</span>
                                </div>`).join("")}
                        </div>
                    </div>
                    <div class="syfe-pl__body fn__flex-1"></div>
                </div>`;

            const shell = this.element.querySelector(".syfe-pl") as HTMLElement;
            const bodyEl = this.element.querySelector(".syfe-pl__body") as HTMLElement;
            this._bodyEl = bodyEl;

            const go = (view: ViewId) => {
                this._view = view;
                shell.querySelectorAll(".syfe-pl__navitem").forEach(n => {
                    n.classList.toggle("is-active", (n as HTMLElement).dataset.view === view);
                });
                render(plugin, bodyEl, view);
            };

            shell.addEventListener("click", (ev) => {
                const target = ev.target as HTMLElement;
                const act = target.dataset.act;
                if (act === "settings") {
                    openPlannerSettingsDialog(plugin, () => go(this._view!));
                    return;
                }
                if (act === "refresh") {
                    go(this._view!);
                    return;
                }
                const item = target.closest("[data-view]") as HTMLElement | null;
                if (item?.dataset.view) go(item.dataset.view as ViewId);
            });

            // 「今日」里点 ▶ 会派发该事件,直接跳到计时视图
            this._gotoHandler = (ev: Event) => {
                const detail = (ev as CustomEvent).detail;
                const targetView = detail?.view || "timer";
                go(targetView);
            };
            this.element.addEventListener("syfe-pl:goto-timer", this._gotoHandler);

            // 数据变了重绘当前视图。计时 tick 单独处理 —— 它太频繁,
            // 整视图重绘会把输入框的焦点掀掉(「统计」页切换日期跨度时最明显)。
            this._changedHandler = () => {
                // 延迟一拍:等多方面 mutate 连锁走完再画,避免同一次操作画两遍
                requestAnimationFrame(() => {
                    if (this._bodyEl) render(plugin, this._bodyEl, this._view!);
                });
            };
            window.addEventListener(PLANNER_CHANGED_EVENT, this._changedHandler);

            this._tickHandler = () => {
                if (this._view === "timer" && this._bodyEl) patchTimerView(this._bodyEl);
            };
            window.addEventListener(TIMER_TICK_EVENT, this._tickHandler);

            go(this._view);
        },
        resize() {
            // 布局用 flex,无需特殊处理
        },
        destroy(this: PlannerTabInstance) {
            if (this._changedHandler) window.removeEventListener(PLANNER_CHANGED_EVENT, this._changedHandler);
            if (this._tickHandler) window.removeEventListener(TIMER_TICK_EVENT, this._tickHandler);
            this._changedHandler = undefined;
            this._tickHandler = undefined;
            this._bodyEl = undefined;
        },
    };
}

function render(plugin: IPluginForPlannerTab, host: HTMLElement, view: ViewId): void {
    const ctx: ViewCtx = {plugin: plugin as any, container: host};
    switch (view) {
        case "habits":
            renderHabits(ctx);
            break;
        case "goals":
            renderGoals(ctx);
            break;
        case "tasks":
            renderTasks(ctx, "tasks");
            break;
        case "todo":
            renderTasks(ctx, "todo");
            break;
        case "timer":
            renderTimerView(ctx);
            break;
        case "countdowns":
            renderCountdowns(ctx);
            break;
        case "stats":
            renderStatsView(ctx);
            break;
        default:
            renderToday(ctx);
    }
}

/** 打开/聚焦 Tab;已打开则切到它 */
export function openPlannerTab(plugin: IPluginForPlannerTab, opts?: {view?: ViewId; position?: "right" | "bottom"}): void {
    const opened = plugin.getOpenedTab()[PLANNER_TAB_TYPE] || [];
    const existing = opts?.position ? undefined : opened[0];
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        // 已打开的也要能切换目标分区(例如点击 Dock 的「习惯」进来)
        const el = (existing as any).element as HTMLElement | undefined;
        if (el) {
            if (opts?.view) {
                const navItem = el.querySelector(`[data-view="${opts.view}"]`) as HTMLElement | null;
                if (navItem) {
                    navItem.click();
                    return;
                }
            }
            const navItem = el.querySelector(".syfe-pl__navitem.is-active") as HTMLElement | null;
            if (navItem) {
                (navItem as HTMLElement).click();
                return;
            }
            el.querySelectorAll(".syfe-pl__navitem")[0]?.dispatchEvent(new MouseEvent("click", {bubbles: true}));
        }
        return;
    }
    const id = plugin.name + PLANNER_TAB_TYPE;
    openTab({
        app: plugin.app,
        custom: {
            id,
            icon: "iconList",
            title: "习惯与目标",
            data: {},
        },
        position: opts?.position,
    } as any);
    // Tab 的 init 无法直接接收要跳到哪个分区(思源只透传 data),
    // 这里靠 data 属性 + 一次延迟点击:等页签 init 完成后落到目标分区。
    if (opts?.view && opts.view !== "today") {
        setTimeout(() => {
            const host = document.querySelector(`[data-id="${id}"] .syfe-pl`) as HTMLElement | null;
            const navItem = host?.querySelector(`[data-view="${opts.view}"]`) as HTMLElement | null;
            navItem?.click();
        }, 60);
    }
}

/** 插件卸载时清理(定时器等) */
export function disposePlannerUI(): void {
    disposeTimer();
}
