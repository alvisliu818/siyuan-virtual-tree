// 「今日」视图 —— Dock 与 Tab 通用的日常落地页。
// 排序刻意按"当下要做什么"来:打卡 → 今天的任务 → 最近的倒数日 → 专注入口,
// 而不是按功能模块排,每天打开第一眼看到的就该是还没做的那几件事。
import {ViewCtx} from "../context";
import {
    getData,
    getHabits,
    getTask,
    getTasks,
    addTask,
    completeTask,
    INBOX_LIST_ID,
    toggleCheckin,
} from "../store";
import {
    habitDay,
    habitStreak,
    isHabitScheduled,
    sortedCountdownInfos,
    todaySummary,
    weekFocusSec,
} from "../stats";
import {countdownCardHTML} from "./countdowns";
import {openCountdownDialog, openHabitDialog, openTaskDialog} from "../dialogs";
import {bindTimerTarget, setTimerMode, startTimer} from "../timer";
import {daysLabel, formatCN, formatHumanDuration, todayKey, weekdayCN} from "../dates";
import {emptyState, escapeHTML, ringHTML, sectionShell, setSectionBody} from "../ui-common";
import {Habit, Task} from "../types";

export function renderToday(ctx: ViewCtx): void {
    const {plugin, container} = ctx;
    const today = todayKey();
    const summary = todaySummary();
    container.innerHTML = "";

    // —— 头部环形概览 ——
    // 没有任何习惯时,环退化为"今天的待办是否清空",否则一直显示 0% 会让人以为坏了
    const heroRatio = summary.habitsTotal
        ? summary.habitsRatio
        : (summary.tasksDue + summary.tasksOverdue > 0 ? 0 : 1);
    const hero = document.createElement("div");
    hero.className = "syfe-pl__hero";
    hero.innerHTML = `
        <div class="syfe-pl__heroring">
            ${ringHTML({
        ratio: heroRatio,
        size: 92,
        stroke: 9,
        color: "var(--b3-theme-primary, #4285f4)",
        label: `${Math.round(heroRatio * 100)}%`,
        sub: "今日",
    })}
        </div>
        <div class="syfe-pl__herometa">
            <div class="syfe-pl__herotitle">${formatCN(today)} ${weekdayCN(today)}</div>
            <div class="syfe-pl__herostats">
                <span class="syfe-pl__stat"><b>${summary.habitsDone}</b>/${summary.habitsTotal} 习惯</span>
                <span class="syfe-pl__stat">今日待办 <b>${summary.tasksDue}</b></span>
                <span class="syfe-pl__stat ${summary.tasksOverdue ? "is-danger" : ""}">逾期 <b>${summary.tasksOverdue}</b></span>
                <span class="syfe-pl__stat">本周专注 <b>${formatHumanDuration(weekFocusSec())}</b></span>
            </div>
        </div>`;
    container.appendChild(hero);

    container.appendChild(buildHabitSection(ctx, today, summary));
    container.appendChild(buildTaskSection(ctx, today));
    container.appendChild(buildCountdownSection(ctx));
    container.appendChild(buildQuickTimerSection(ctx));
}

// ==== 今日打卡 ====

function buildHabitSection(ctx: ViewCtx, today: string, summary: {habitsDone: number; habitsTotal: number}): HTMLElement {
    const {plugin, container} = ctx;
    const sec = sectionShell("", "今日打卡", `${summary.habitsDone}/${summary.habitsTotal}`);
    const habits = getHabits(false).filter(h => isHabitScheduled(h, today));
    if (habits.length === 0) {
        const total = getHabits(false).length;
        setSectionBody(sec, emptyState(
            total === 0 ? "还没有习惯" : "今天排班的习惯都在这儿了",
            total === 0 ? "到「习惯」页新建第一个" : "",
        ));
    } else {
        setSectionBody(sec, `<div class="syfe-pl__todayhabits">${habits.map(h => todayHabitHTML(h, today)).join("")}</div>`);
        sec.querySelector(".syfe-pl__secbody")?.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement;
            const host = target.closest("[data-habit]") as HTMLElement | null;
            const id = host?.dataset.habit;
            if (!id) return;
            toggleCheckin(plugin, id, today);
            renderToday(ctx);
        });
        // 右键 = 编辑(面板空间紧张,编辑入口藏在这里)
        sec.querySelector(".syfe-pl__secbody")?.addEventListener("contextmenu", (ev) => {
            const target = ev.target as HTMLElement;
            const host = target.closest("[data-habit]") as HTMLElement | null;
            const id = host?.dataset.habit;
            if (!id) return;
            ev.preventDefault();
            openHabitDialog(plugin, getHabits().find(h => h.id === id), () => renderToday(ctx));
        });
    }
    const btn = document.createElement("button");
    btn.className = "b3-button b3-button--outline syfe-pl__addbtn";
    btn.textContent = "+ 新建习惯";
    btn.addEventListener("click", () => openHabitDialog(plugin, undefined, () => renderToday(ctx)));
    sec.querySelector(".syfe-pl__sechead")!.appendChild(btn);
    void container;
    return sec;
}

/** 今日视图里的一个习惯方块:点圆形按钮 +1,点满了再点一次取消 */
function todayHabitHTML(habit: Habit, today: string): string {
    const d = habitDay(habit.id, today);
    const streak = habitStreak(habit);
    return `<div class="syfe-pl__todayhabit${d.done ? " is-done" : ""}" data-habit="${escapeHTML(habit.id)}"
        title="${escapeHTML(habit.name)} · 右键编辑">
        <div class="syfe-pl__checkcircle" style="--pl-color:${escapeHTML(habit.color)}">
            <span class="syfe-pl__checknum">${d.count}<small>/${d.target}</small></span>
            ${d.done ? "<span class=\"syfe-pl__checkok\">✓</span>" : ""}
        </div>
        <div class="syfe-pl__todayname">${escapeHTML(habit.icon)} ${escapeHTML(habit.name)}</div>
        <div class="syfe-pl__todaysub">${streak > 0 ? `连续 ${streak} 天` : escapeHTML(habit.unit)}</div>
    </div>`;
}

// ==== 今日任务 ====

function buildTaskSection(ctx: ViewCtx, today: string): HTMLElement {
    const {plugin} = ctx;
    const sec = sectionShell("", "今天的任务", "");
    const body = sec.querySelector(".syfe-pl__secbody") as HTMLElement;

    const renderRows = () => {
        const open = getTasks().filter(t => t.status !== "done");
        const overdue = open.filter(t => !!t.due && t.due < today);
        const dueToday = open.filter(t => t.due === today);
        const rows = [...overdue.map(t => taskRowHTML(t, "overdue")), ...dueToday.map(t => taskRowHTML(t, "today"))];
        const listHost = body.querySelector(".syfe-pl__tasklist") as HTMLElement;
        listHost.innerHTML = rows.length
            ? rows.join("")
            : emptyState("今天的清单清空了", "去「待办」看看还没安排日期的事");
    };

    body.innerHTML = `<div class="syfe-pl__tasklist"></div>
        <div class="syfe-pl__quickadd">
            <input class="b3-text-field fn__block" data-role="quick" placeholder="想做点什么?回车直接加到今天">
        </div>`;
    renderRows();

    // 快速录入:回车即建 → 保留输入框焦点,连续录入不用回头点
    body.querySelector("[data-role='quick']")?.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key !== "Enter") return;
        const input = ev.target as HTMLInputElement;
        const title = input.value.trim();
        if (!title) return;
        addTask(plugin, {title, listId: INBOX_LIST_ID, due: today});
        input.value = "";
        renderRows();
    });

    body.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const row = target.closest(".syfe-pl__task") as HTMLElement | null;
        const id = row?.dataset.id;
        if (!id) return;
        if (target.matches("[data-act='check']")) {
            completeTask(plugin, id, getTask(id)?.status !== "done");
            renderRows();
        } else if (target.matches("[data-act='focus']")) {
            bindTimerTarget({taskId: id});
            setTimerMode("pomodoro");
            startTimer();
            ctx.container.dispatchEvent(new CustomEvent("syfe-pl:goto-timer", {bubbles: true}));
        } else {
            openTaskDialog(plugin, getTask(id), renderRows);
        }
    });

    const btn = document.createElement("button");
    btn.className = "b3-button b3-button--outline syfe-pl__addbtn";
    btn.textContent = "+ 完整编辑";
    btn.addEventListener("click", () => openTaskDialog(plugin, undefined, renderRows));
    sec.querySelector(".syfe-pl__sechead")!.appendChild(btn);
    return sec;
}

function taskRowHTML(t: Task, tone: "overdue" | "today"): string {
    const sub = t.subtasks.length ? `${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}` : "";
    return `<div class="syfe-pl__task" data-id="${escapeHTML(t.id)}">
        <span class="syfe-pl__taskcheck" data-act="check"></span>
        <span class="syfe-pl__taskbody">
            <span class="syfe-pl__tasktitle">${escapeHTML(t.title)}</span>
            <span class="syfe-pl__taskmeta">
                <span class="syfe-pl__tone syfe-pl__tone--${tone}">${tone === "overdue" ? daysLabel(t.due!) : "今天"}</span>
                ${t.goalId ? `<span class="syfe-pl__metaitem" title="已关联目标">🎯</span>` : ""}
                ${sub ? `<span class="syfe-pl__metaitem">子步骤 ${sub}</span>` : ""}
                ${t.priority >= 2 ? `<span class="syfe-pl__pri syfe-pl__pri--${t.priority}">${t.priority === 3 ? "高" : "中"}</span>` : ""}
            </span>
        </span>
        <span class="syfe-pl__taskgo" data-act="focus" title="对着它开始计时">▶</span>
    </div>`;
}

// ==== 倒数日 ====

function buildCountdownSection(ctx: ViewCtx): HTMLElement {
    const {plugin, container} = ctx;
    const sec = sectionShell("", "倒数日", "");
    const infos = sortedCountdownInfos().slice(0, 4);
    setSectionBody(sec, infos.length
        ? `<div class="syfe-pl__cdgrid">${infos.map(i => countdownCardHTML(i)).join("")}</div>`
        : emptyState("还没有倒数日", "生日、考试、交付日都可以记下来"));
    sec.querySelector(".syfe-pl__secbody")?.addEventListener("click", (ev) => {
        const card = (ev.target as HTMLElement).closest("[data-cd]") as HTMLElement | null;
        const id = card?.dataset.cd;
        if (!id) return;
        const cd = getData().countdowns.find(c => c.id === id);
        if (cd) openCountdownDialog(plugin, cd, () => renderToday(ctx));
    });
    const btn = document.createElement("button");
    btn.className = "b3-button b3-button--outline syfe-pl__addbtn";
    btn.textContent = "+ 新建";
    btn.addEventListener("click", () => openCountdownDialog(plugin, undefined, () => renderToday(ctx)));
    sec.querySelector(".syfe-pl__sechead")!.appendChild(btn);
    void container;
    return sec;
}

// ==== 专注入口 ====

function buildQuickTimerSection(ctx: ViewCtx): HTMLElement {
    const sec = sectionShell("", "开始专注", "");
    const habitOptions = getHabits(false)
        .map(h => `<option value="${escapeHTML(h.id)}">${escapeHTML(h.icon)} ${escapeHTML(h.name)}</option>`).join("");
    const taskOptions = getTasks().filter(t => t.status !== "done").slice(0, 50)
        .map(t => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.title)}</option>`).join("");
    setSectionBody(sec, `
        <div class="syfe-pl__quicktimer">
            <div class="syfe-pl__formrow">
                <div class="syfe-pl__formlabel">计入习惯</div>
                <div class="syfe-pl__formctrl">
                    <select class="b3-select fn__block" data-role="habit">
                        <option value="">（不计入）</option>
                        ${habitOptions}
                    </select>
                </div>
            </div>
            <div class="syfe-pl__formrow">
                <div class="syfe-pl__formlabel">计入任务</div>
                <div class="syfe-pl__formctrl">
                    <select class="b3-select fn__block" data-role="task">
                        <option value="">（不计入）</option>
                        ${taskOptions}
                    </select>
                </div>
            </div>
            <div class="syfe-pl__qtactions">
                <button class="b3-button b3-button--text" data-act="pomodoro">开始番茄钟</button>
                <button class="b3-button b3-button--outline" data-act="stopwatch">正计时</button>
                <button class="b3-button b3-button--outline" data-act="countdown">倒计时</button>
            </div>
        </div>`);
    sec.querySelector(".syfe-pl__secbody")?.addEventListener("click", (ev) => {
        const act = (ev.target as HTMLElement).dataset.act;
        if (!act) return;
        const root = sec.querySelector(".syfe-pl__secbody") as HTMLElement;
        bindTimerTarget({
            habitId: (root.querySelector("[data-role='habit']") as HTMLSelectElement).value || undefined,
            taskId: (root.querySelector("[data-role='task']") as HTMLSelectElement).value || undefined,
        });
        setTimerMode(act as "pomodoro" | "stopwatch" | "countdown");
        startTimer();
        ctx.container.dispatchEvent(new CustomEvent("syfe-pl:goto-timer", {bubbles: true}));
    });
    return sec;
}

/** Dock 用:只要今天习惯那一小片 */
export function renderTodayHabitsOnly(ctx: ViewCtx): void {
    const today = todayKey();
    const habits = getHabits(false).filter(h => isHabitScheduled(h, today));
    ctx.container.innerHTML = habits.length
        ? habits.map(h => todayHabitHTML(h, today)).join("")
        : `<div class="syfe-pl__hintline">今天没有排班的习惯</div>`;
}
