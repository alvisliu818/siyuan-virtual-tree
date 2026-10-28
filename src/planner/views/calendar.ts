// 大日历视图:月网格里看任务、习惯打卡、专注记录、倒数日。
//
// 与其他视图的关系:纯只读聚合(store 现查,不缓存),数据变了靠外层
// PLANNER_CHANGED_EVENT 整视图重绘。点击某天在下方展开当日明细。
// 月份/选中日的浏览状态存模块级变量 —— 同一会话内切走再切回来不丢位置。
import {ViewCtx} from "../context";
import {getData, getHabits, getTasks, completeTask, getCheckin} from "../store";
import {Countdown, DateKey, Task} from "../types";
import {
    addDays,
    addMonths,
    dateKey,
    formatCN,
    isToday,
    monthStart,
    parseKey,
    todayKey,
    weekdayOf,
} from "../dates";
import {escapeHTML} from "../ui-common";

/** 浏览状态:当前月(以该月任意一天的 key 表示)与选中的日子 */
let viewMonthAnchor = dateKey();
let selectedDay: DateKey | null = null;

const WEEKDAY_LABELS_SUN_FIRST = ["日", "一", "二", "三", "四", "五", "六"];

export function renderCalendar(ctx: ViewCtx): void {
    const {container, plugin} = ctx;
    const settings = getData().settings;
    const weekStart = settings.weekStart;
    const today = todayKey();
    if (!selectedDay) selectedDay = today;

    const anchor = parseKey(viewMonthAnchor);
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const first = monthStart(viewMonthAnchor);
    // 网格从周起始日开始,铺满 42 格(6 行),含前后月补位
    const gridStartOffset = (weekdayOf(first) - weekStart + 7) % 7;
    const gridStart = addDays(first, -gridStartOffset);

    const tasksByDay = tasksByDate();
    const habitsByDay = habitsByDate();
    const focusByDay = focusMinutesByDate();
    const countdowns = getData().countdowns;

    const weekdayHeads = Array.from({length: 7}, (_, i) => WEEKDAY_LABELS_SUN_FIRST[(i + weekStart) % 7]);

    let cellsHTML = "";
    for (let i = 0; i < 42; i++) {
        const key = addDays(gridStart, i);
        const d = parseKey(key);
        const inMonth = d.getFullYear() === year && d.getMonth() === month;
        const classes = ["syfe-pl__cal-cell"];
        if (!inMonth) classes.push("is-other");
        if (isToday(key)) classes.push("is-today");
        if (key === selectedDay) classes.push("is-selected");
        cellsHTML += `
            <div class="${classes.join(" ")}" data-day="${key}">
                <div class="syfe-pl__cal-daynum">${d.getDate()}</div>
                ${dayMarkersHTML(key, tasksByDay, habitsByDay, focusByDay, countdowns)}
            </div>`;
    }

    container.innerHTML = `
        <div class="syfe-pl__section" id="syfe-pl-calendar">
            <div class="syfe-pl__sechead">
                <span class="syfe-pl__sectitle">日历</span>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--outline syfe-pl__minibtn" data-cal-act="prev">‹</button>
                <span class="syfe-pl__cal-month">${year} 年 ${month + 1} 月</span>
                <button class="b3-button b3-button--outline syfe-pl__minibtn" data-cal-act="next">›</button>
                <button class="b3-button b3-button--outline syfe-pl__minibtn" data-cal-act="today">今天</button>
            </div>
            <div class="syfe-pl__cal-weekdays">
                ${weekdayHeads.map(w => `<div class="syfe-pl__cal-weekday">${w}</div>`).join("")}
            </div>
            <div class="syfe-pl__cal-grid">${cellsHTML}</div>
            <div class="syfe-pl__cal-detail" id="syfe-pl-cal-detail"></div>
        </div>`;

    const section = container.querySelector("#syfe-pl-calendar") as HTMLElement;

    section.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const act = (target.closest("[data-cal-act]") as HTMLElement | null)?.dataset.calAct;
        if (act === "prev") {
            viewMonthAnchor = addMonths(viewMonthAnchor, -1);
            renderCalendar(ctx);
            return;
        }
        if (act === "next") {
            viewMonthAnchor = addMonths(viewMonthAnchor, 1);
            renderCalendar(ctx);
            return;
        }
        if (act === "today") {
            viewMonthAnchor = todayKey();
            selectedDay = todayKey();
            renderCalendar(ctx);
            return;
        }
        const cell = target.closest(".syfe-pl__cal-cell") as HTMLElement | null;
        if (cell?.dataset.day) {
            selectedDay = cell.dataset.day;
            section.querySelectorAll(".syfe-pl__cal-cell").forEach(c => c.classList.toggle("is-selected", (c as HTMLElement).dataset.day === selectedDay));
            renderDayDetail(plugin, section.querySelector(".syfe-pl__cal-detail") as HTMLElement, selectedDay);
        }
    });

    renderDayDetail(plugin, section.querySelector(".syfe-pl__cal-detail") as HTMLElement, selectedDay);
}

// ==== 每日聚合 ====

interface DayTask {
    task: Task;
}

function tasksByDate(): Map<DateKey, DayTask[]> {
    const out = new Map<DateKey, DayTask[]>();
    for (const t of getTasks()) {
        if (!t.due) continue;
        const list = out.get(t.due) || [];
        list.push({task: t});
        out.set(t.due, list);
    }
    return out;
}

function habitsByDate(): Map<DateKey, {name: string; icon: string; color: string; count: number; target: number}[]> {
    const out = new Map<DateKey, {name: string; icon: string; color: string; count: number; target: number}[]>();
    const habits = getHabits();
    for (const key of Object.keys(getData().checkins)) {
        const days = getData().checkins[key] || {};
        for (const day of Object.keys(days)) {
            const c = days[day];
            if (!c || c.count <= 0) continue;
            const h = habits.find(x => x.id === key);
            if (!h) continue;
            const list = out.get(day) || [];
            list.push({name: h.name, icon: h.icon, color: h.color, count: c.count, target: h.target});
            out.set(day, list);
        }
    }
    return out;
}

function focusMinutesByDate(): Map<DateKey, number> {
    const out = new Map<DateKey, number>();
    for (const s of getData().sessions) {
        out.set(s.dateKey, (out.get(s.dateKey) || 0) + s.seconds / 60);
    }
    return out;
}

/** 倒数日在某年某月的落点(每年重复的按同年同月日取;普通项只认原始日期) */
function countdownOccurrenceInMonth(cd: Countdown, year: number, month: number): DateKey | null {
    const d = parseKey(cd.date);
    if (cd.repeatYearly) {
        if (d.getMonth() !== month) return null;
        const candidate = `${year}-${String(month + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return candidate;
    }
    if (d.getFullYear() !== year || d.getMonth() !== month) return null;
    return cd.date;
}

function dayMarkersHTML(
    key: DateKey,
    tasksByDay: Map<DateKey, DayTask[]>,
    habitsByDay: Map<DateKey, {name: string; icon: string; color: string; count: number; target: number}[]>,
    focusByDay: Map<DateKey, number>,
    countdowns: Countdown[],
): string {
    const parts: string[] = [];
    const tasks = (tasksByDay.get(key) || []).slice(0, 3);
    for (const {task} of tasks) {
        const done = task.status === "done";
        parts.push(`<div class="syfe-pl__cal-task${done ? " is-done" : ""}">${escapeHTML(task.title)}</div>`);
    }
    const extraTasks = (tasksByDay.get(key) || []).length - tasks.length;
    if (extraTasks > 0) {
        parts.push(`<div class="syfe-pl__cal-task syfe-pl__cal-more">+${extraTasks}</div>`);
    }
    const habits = habitsByDay.get(key) || [];
    if (habits.length > 0) {
        parts.push(`<div class="syfe-pl__cal-dots">${habits.map(h =>
            `<span class="syfe-pl__cal-dot" title="${escapeHTML(h.name)} ${h.count}/${h.target}" style="background:${h.color}"></span>`).join("")}</div>`);
    }
    const minutes = Math.round(focusByDay.get(key) || 0);
    if (minutes > 0) {
        parts.push(`<div class="syfe-pl__cal-focus" title="专注 ${minutes} 分钟">🍅${minutes >= 60 ? Math.round(minutes / 60 * 10) / 10 + "h" : minutes + "m"}</div>`);
    }
    const anchor = parseKey(key);
    const cds = countdowns.map(cd => ({cd, at: countdownOccurrenceInMonth(cd, anchor.getFullYear(), anchor.getMonth())}))
        .filter(x => x.at === key);
    if (cds.length > 0) {
        parts.push(`<div class="syfe-pl__cal-cd" title="${escapeHTML(cds.map(x => x.cd.title).join(" / "))}">📌</div>`);
    }
    return parts.length ? `<div class="syfe-pl__cal-markers">${parts.join("")}</div>` : "";
}

// ==== 选中日的明细 ====

function renderDayDetail(plugin: any, host: HTMLElement, day: DateKey): void {
    if (!host) return;
    const tasks = getTasks().filter(t => t.due === day);
    const habits = getHabits().map(h => ({h, c: getCheckin(h.id, day)?.count ?? 0})).filter(x => x.c > 0);
    const minutes = Math.round((getData().sessions.filter(s => s.dateKey === day).reduce((acc, s) => acc + s.seconds, 0)) / 60);
    const cds = getData().countdowns.filter(cd => cd.date === day || (cd.repeatYearly && parseKey(cd.date).getMonth() === parseKey(day).getMonth() && parseKey(cd.date).getDate() === parseKey(day).getDate()));

    const rows: string[] = [];
    for (const {task} of tasks.map(t => ({task: t}))) {
        const done = task.status === "done";
        rows.push(`
            <div class="syfe-pl__detail-row" data-task="${task.id}">
                <input type="checkbox" class="b3-checkbox" data-detail-task="${task.id}" ${done ? "checked" : ""}>
                <span class="syfe-pl__detail-task${done ? " is-done" : ""}">${escapeHTML(task.title)}</span>
                ${task.dueTime ? `<span class="syfe-pl__detail-time">${task.dueTime}</span>` : ""}
            </div>`);
    }
    for (const {h, c} of habits) {
        rows.push(`<div class="syfe-pl__detail-row"><span class="syfe-pl__detail-dot" style="background:${h.color}"></span>${escapeHTML(h.icon)} ${escapeHTML(h.name)} <span class="syfe-pl__detail-time">${c}/${h.target} ${escapeHTML(h.unit)}</span></div>`);
    }
    if (minutes > 0) {
        rows.push(`<div class="syfe-pl__detail-row"><span>⏱️ 专注 ${minutes} 分钟</span></div>`);
    }
    for (const cd of cds) {
        rows.push(`<div class="syfe-pl__detail-row"><span>📌 ${escapeHTML(cd.title)}</span></div>`);
    }
    if (rows.length === 0) {
        rows.push(`<div class="syfe-pl__detail-empty">这一天没有安排</div>`);
    }

    host.innerHTML = `
        <div class="syfe-pl__detailhead">${formatCN(day)}${isToday(day) ? " · 今天" : ""}</div>
        ${rows.join("")}`;

    // 勾选/取消任务完成(与任务视图同一 completeTask 通道,完成会触发重绘)
    host.querySelectorAll("input[data-detail-task]").forEach(input => {
        input.addEventListener("change", () => {
            const id = (input as HTMLInputElement).dataset.detailTask as string;
            const t = getTasks().find(x => x.id === id);
            if (!t) return;
            completeTask(plugin, id, t.status !== "done");
        });
    });
}
