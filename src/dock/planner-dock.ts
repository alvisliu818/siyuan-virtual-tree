// 侧边栏「习惯与目标」面板。
//
// 定位是**速览 + 快速操作**:今天要打卡的、今天要做的、正在跑的计时器、最近的倒数日。
// 完整管理交给全屏 Tab(见 tabs/planner-tab.ts),这里刻意不做增删改,免得 240px 的宽度
// 里塞进一堆表单控件谁也打不着。
//
// 刷新策略:数据变更事件 → 重绘列表区;timer tick(500ms)→ 只改时间文本,不碰列表 DOM,
// 否则每半秒重绘一次会让正在拖选/聚焦的输入框被掀掉。
import {Menu} from "siyuan";
import {PLANNER_DOCK_TYPE} from "../constants";
import {PLANNER_CHANGED_EVENT, addTask, getHabits, getData, getTask, INBOX_LIST_ID, completeTask, toggleCheckin} from "../planner/store";import {TIMER_TICK_EVENT, pauseTimer, startTimer, timerSnapshot, TimerSnapshot} from "../planner/timer";
import {habitDay, habitStreak, isHabitScheduled, sortedCountdownInfos, todaySummary} from "../planner/stats";
import {openPlannerSettingsDialog, openTaskDialog} from "../planner/dialogs";
import {openPlannerTab, IPluginForPlannerTab} from "../tabs/planner-tab";
import {formatDuration, todayKey} from "../planner/dates";
import {escapeHTML, ringHTML} from "../planner/ui-common";

export interface IPluginForPlannerDock extends IPluginForPlannerTab {
    app: any;
    name: string;
}
interface PlannerDockInstance {
    element: HTMLElement;
    _listEl?: HTMLElement;
    _timerEl?: HTMLElement;
    _changed?: () => void;
    _tick?: () => void;
    _timerClick?: (e: MouseEvent) => void;
}

export function createPlannerDockConfig(plugin: IPluginForPlannerDock) {
    return {
        type: PLANNER_DOCK_TYPE,
        config: {
            position: "LeftTop" as const,
            size: {width: 280, height: 0},
            icon: "iconList",
            title: "习惯与目标",
            hotkey: "",
            show: true,
            // 显式 index:多个 dock 同 1000 时栏一重建顺序就变(图标乱跳),见 recent-dock.ts 注释
            index: 2,
        },
        data: {},
        init(this: PlannerDockInstance) {
            this.element.classList.add("syfe-pl-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-pl__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconList"></use></svg>
                        <span class="block__logotext">习惯与目标</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-act="open" aria-label="打开完整面板" data-position="north">
                        <svg><use xlink:href="#iconExpand"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-act="settings" aria-label="设置" data-position="north">
                        <svg><use xlink:href="#iconEdit"></use></svg>
                    </span>
                </div>
                <div class="syfe-pl__overview"></div>
                <div class="fn__flex-1 syfe-pl__scroll">
                    <div class="syfe-pl__lists"></div>
                </div>
                <div class="syfe-pl__timerbar"></div>`;

            const overviewEl = this.element.querySelector(".syfe-pl__overview") as HTMLElement;
            const listEl = this.element.querySelector(".syfe-pl__lists") as HTMLElement;
            const timerEl = this.element.querySelector(".syfe-pl__timerbar") as HTMLElement;
            this._listEl = listEl;
            this._timerEl = timerEl;

            const renderOverview = () => {
                const s = todaySummary();
                const ratio = s.habitsTotal ? s.habitsRatio : (s.tasksDue + s.tasksOverdue > 0 ? 0 : 1);
                overviewEl.innerHTML = `
                    <div class="syfe-pl__overviewrow">
                        ${ringHTML({ratio, size: 46, stroke: 5, color: "var(--b3-theme-primary, #4285f4)", label: `${Math.round(ratio * 100)}%`})}
                        <div class="syfe-pl__overviewtext">
                            <div class="syfe-pl__ovmain">${s.habitsDone}/${s.habitsTotal} 已打卡</div>
                            <div class="syfe-pl__ovsub">
                                今日 ${s.tasksDue} 项${s.tasksOverdue ? ` · <b class="syfe-pl__danger">逾期 ${s.tasksOverdue}</b>` : ""}
                            </div>
                        </div>
                    </div>`;
            };

            const renderLists = () => {
                const today = todayKey();
                const habits = getHabits(false).filter(h => isHabitScheduled(h, today));
                const tasks = getData().tasks.filter(t => t.status !== "done")
                    .filter(t => !t.due || t.due <= today)
                    .sort((a, b) => (a.due || "").localeCompare(b.due || ""))
                    .slice(0, 20);
                const cds = sortedCountdownInfos().slice(0, 2);

                listEl.innerHTML = `
                    ${habits.length ? `<div class="syfe-pl__docksec">
                        <div class="syfe-pl__docksechead">今日打卡</div>
                        ${habits.map(h => {
        const d = habitDay(h.id, today);
        return `<div class="syfe-pl__habrow${d.done ? " is-done" : ""}" data-habit="${escapeHTML(h.id)}" data-kind="habit">
                            <span class="syfe-pl__habdot" style="--pl-color:${escapeHTML(h.color)}" data-act="check">${d.done ? "✓" : d.count || ""}</span>
                            <span class="syfe-pl__habname">${escapeHTML(h.icon)} ${escapeHTML(h.name)}</span>
                            <span class="fn__flex-1"></span>
                            <span class="syfe-pl__habnum">${d.count}/${d.target}</span>
                        </div>`;
    }).join("")}
                    </div>` : ""}

                    <div class="syfe-pl__docksec">
                        <div class="syfe-pl__docksechead">今日待办</div>
                        <input class="b3-text-field fn__block syfe-pl__dockinput" data-role="quick" placeholder="+ 添加待办,回车">
                        <div class="syfe-pl__tasklist">
                            ${tasks.map(t => {
        const overdue = !!t.due && t.due < today;
        return `<div class="syfe-pl__taskrow" data-id="${escapeHTML(t.id)}" data-kind="task">
                                <span class="syfe-pl__taskcheck" data-act="check"></span>
                                <span class="syfe-pl__tasktitle" data-act="open">${escapeHTML(t.title)}</span>
                                ${overdue ? `<span class="syfe-pl__tone syfe-pl__tone--overdue">逾期</span>` : ""}
                            </div>`;
    }).join("") || `<div class="syfe-pl__hintline syfe-pl__hintline--tiny">今天没有安排</div>`}
                        </div>
                    </div>

                    ${cds.length ? `<div class="syfe-pl__docksec">
                        <div class="syfe-pl__docksechead">倒数日</div>
                        ${cds.map(i => {
        const days = Math.abs(i.days);
        const text = i.cd.kind === "until"
            ? (i.passed ? `已过 ${days} 天` : days === 0 ? "就是今天" : `还剩 ${days} 天`)
            : (i.passed ? `已经 ${days} 天` : `还要 ${days} 天`);
        return `<div class="syfe-pl__cdrow" data-cd="${escapeHTML(i.cd.id)}" style="--pl-color:${escapeHTML(i.cd.color)}">
                            <span class="syfe-pl__cdrowicon">${escapeHTML(i.cd.icon)}</span>
                            <span class="syfe-pl__cdrowtitle">${escapeHTML(i.cd.title)}</span>
                            <span class="fn__flex-1"></span>
                            <span class="syfe-pl__cdrowdays">${escapeHTML(text)}</span>
                        </div>`;
    }).join("")}
                    </div>` : ""}`;
            };

            const renderTimer = (snap?: TimerSnapshot) => {
                const s = snap || timerSnapshot();
                if (!s.running && s.elapsed === 0) {
                    timerEl.innerHTML = `<div class="syfe-pl__timeridle" data-act="toggle">▶ 开始专注</div>`;
                    return;
                }
                const shown = s.mode === "stopwatch" ? s.elapsed : Math.max(0, s.remaining);
                timerEl.innerHTML = `
                    <div class="syfe-pl__timerrow">
                        <span class="syfe-pl__timerph">${s.mode === "pomodoro" ? (s.phase === "focus" ? "专注" : "休息") : s.mode === "countdown" ? "倒计时" : "正计时"}</span>
                        <span class="syfe-pl__timerclock" data-role="clock">${formatDuration(shown)}</span>
                        <span class="fn__flex-1"></span>
                        <span class="syfe-pl__timeract" data-act="toggle">${s.running ? "⏸" : "▶"}</span>
                        <span class="syfe-pl__timeract" data-act="stop">■</span>
                    </div>`;
            };

            const renderAll = () => {
                renderOverview();
                renderLists();
                renderTimer();
            };
            renderAll();

            // —— 工具栏 ——
            this.element.querySelector(".syfe-pl__toolbar")?.addEventListener("click", (ev) => {
                const act = (ev.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
                if (act === "open") openPlannerTab(plugin);
                else if (act === "settings") openPlannerSettingsDialog(plugin, renderOverview);
            });

            // —— 列表区交互 ——
            listEl.addEventListener("click", (ev) => {
                const target = ev.target as HTMLElement;
                const habitRow = target.closest("[data-kind='habit']") as HTMLElement | null;
                if (habitRow) {
                    const id = habitRow.dataset.habit!;
                    if (target.dataset.act === "check") {
                        toggleCheckin(plugin, id, todayKey());
                        renderOverview();
                        renderLists();
                    }
                    return;
                }
                const taskRow = target.closest("[data-kind='task']") as HTMLElement | null;
                if (taskRow) {
                    const id = taskRow.dataset.id!;
                    if (target.dataset.act === "check") {
                        completeTask(plugin, id, getTask(id)?.status !== "done");
                        renderOverview();
                        renderLists();
                    } else {
                        openTaskDialog(plugin, getTask(id), () => {
                            renderOverview();
                            renderLists();
                        });
                    }
                    return;
                }
                const cdRow = target.closest("[data-cd]") as HTMLElement | null;
                if (cdRow) {
                    // 侧栏不放大表单,直接开 Tab 的倒数日页
                    openPlannerTab(plugin, {view: "countdowns"});
                }
            });

            listEl.addEventListener("keydown", (ev) => {
                const input = ev.target as HTMLInputElement;
                if (input.dataset?.role !== "quick" || (ev as KeyboardEvent).key !== "Enter") return;
                const title = input.value.trim();
                if (!title) return;
                addTask(plugin, {title, listId: INBOX_LIST_ID, due: todayKey()});
                input.value = "";
                renderOverview();
                renderLists();
                // 重建后输入框是新节点,继续让用户连着输
                const next = listEl.querySelector("[data-role='quick']") as HTMLInputElement | null;
                next?.focus();
            });

            // 右键:习惯行给「连续 / 编辑」菜单
            listEl.addEventListener("contextmenu", (ev) => {
                const habitRow = (ev.target as HTMLElement).closest("[data-kind='habit']") as HTMLElement | null;
                if (!habitRow) return;
                ev.preventDefault();
                const id = habitRow.dataset.habit!;
                const habit = getHabits(true).find(h => h.id === id);
                if (!habit) return;
                const menu = new Menu();
                menu.addItem({
                    iconHTML: "🔥",
                    label: `连续 ${habitStreak(habit)} 天`,
                    type: "readonly",
                });
                menu.addItem({
                    iconHTML: "📅",
                    label: "打开习惯热力图",
                    click: () => openPlannerTab(plugin, {view: "habits"}),
                });
                menu.addItem({
                    iconHTML: "⚙",
                    label: "设置",
                    click: () => openPlannerSettingsDialog(plugin),
                });
                menu.open({x: ev.clientX, y: ev.clientY});
            });

            // —— 计时条 ——
            this._timerClick = (ev: MouseEvent) => {
                const act = (ev.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
                if (!act) return;
                if (act === "toggle") {
                    if (timerSnapshot().running) pauseTimer();
                    else startTimer();
                    renderTimer();
                } else if (act === "stop") {
                    openPlannerTab(plugin, {view: "timer"});
                }
            };
            timerEl.addEventListener("click", this._timerClick);

            this._changed = () => {
                requestAnimationFrame(() => {
                    renderOverview();
                    renderLists();
                });
            };
            window.addEventListener(PLANNER_CHANGED_EVENT, this._changed);

            this._tick = () => {
                if (!this._timerEl) return;
                const clock = this._timerEl.querySelector("[data-role='clock']") as HTMLElement | null;
                if (!clock) return;
                const s = timerSnapshot();
                clock.textContent = formatDuration(s.mode === "stopwatch" ? s.elapsed : Math.max(0, s.remaining));
            };
            window.addEventListener(TIMER_TICK_EVENT, this._tick);
        },
        resize() {
            // flex 布局,无需处理
        },
        destroy(this: PlannerDockInstance) {
            if (this._changed) window.removeEventListener(PLANNER_CHANGED_EVENT, this._changed);
            if (this._tick) window.removeEventListener(TIMER_TICK_EVENT, this._tick);
            this._changed = undefined;
            this._tick = undefined;
            this._timerClick = undefined;
            this._listEl = undefined;
            this._timerEl = undefined;
        },
    };
}
