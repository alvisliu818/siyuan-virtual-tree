// 新标签页的「习惯与目标」速览分区:目标 / 习惯 / 倒数日 / 日历。
//
// 只从 planner 的 store + stats 现算 HTML,不搬运全屏面板里的增删改界面;
// 点卡片头跳到对应视图,点习惯行直接打卡(走 store,数据变更事件会让新标签页重绘)。
import {ViewId} from "../planner/context";
import {getData, getGoals, getHabits, getSettings, toggleCheckin} from "../planner/store";
import {goalProgress, habitDay, isHabitScheduled, sortedCountdownInfos, todaySummary} from "../planner/stats";
import {monthEnd, monthStart, todayKey, weekdayOf} from "../planner/dates";
import {openPlannerTab} from "../planner/tab";

const LIST_LIMIT = 3;
const HABIT_LIMIT = 4;

function esc(s: unknown): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function card(view: ViewId, icon: string, title: string, body: string): string {
    return `<div class="syfe-start__pl-card">
        <div class="syfe-start__pl-cardhead" data-pl-view="${view}" title="打开「${esc(title)}」">
            <span>${icon} ${esc(title)}</span>
            <span class="syfe-start__pl-goto">↗</span>
        </div>
        <div class="syfe-start__pl-cardbody">${body || `<div class="syfe-start__pl-empty">暂无${esc(title)}</div>`}</div>
    </div>`;
}

function row(icon: string, name: string, num: string, extra = ""): string {
    return `<div class="syfe-start__pl-row${extra}">
        <span class="syfe-start__pl-ico">${esc(icon)}</span>
        <span class="syfe-start__pl-name">${esc(name)}</span>
        <span class="syfe-start__pl-num">${esc(num)}</span>
    </div>`;
}

function goalsBody(): string {
    return getGoals("active").slice(0, LIST_LIMIT).map(g => {
        const p = goalProgress(g);
        const pct = Math.max(0, Math.min(100, Math.round(p.ratio * 100)));
        return `<div class="syfe-start__pl-item">
            ${row(g.icon || "🎯", g.title, `${pct}%`)}
            <div class="syfe-start__pl-bar"><i style="width:${pct}%;background:${esc(g.color || "var(--b3-theme-primary)")}"></i></div>
        </div>`;
    }).join("");
}

function habitsBody(today: string): string {
    return getHabits(false).filter(h => isHabitScheduled(h, today)).slice(0, HABIT_LIMIT).map(h => {
        const d = habitDay(h.id, today);
        return `<div class="syfe-start__pl-row syfe-start__pl-habit${d.done ? " is-done" : ""}"
            data-pl-checkin="${esc(h.id)}" title="点击打卡">
            <span class="syfe-start__pl-ico">${esc(h.icon || "⭐")}</span>
            <span class="syfe-start__pl-name">${esc(h.name)}</span>
            <span class="syfe-start__pl-num">${d.count}/${d.target}</span>
        </div>`;
    }).join("");
}

function countdownsBody(): string {
    return sortedCountdownInfos().slice(0, LIST_LIMIT).map(i => {
        const days = Math.abs(i.days);
        const text = i.cd.kind === "until"
            ? (i.passed ? `已过 ${days} 天` : days === 0 ? "就是今天" : `还剩 ${days} 天`)
            : (i.passed ? `已经 ${days} 天` : `还要 ${days} 天`);
        return row(i.cd.icon || "⏳", i.cd.title, text);
    }).join("");
}

/** 当月小月历:今日高亮,有未完成任务或打卡记录的日期打点。不加上/下月,启动台只看当月。 */
function calendarBody(today: string): string {
    const first = monthStart(today);
    const total = Number(monthEnd(today).slice(8));
    const weekStart = getSettings().weekStart === 0 ? 0 : 1;
    const lead = (weekdayOf(first) - weekStart + 7) % 7;
    const weekNames = weekStart === 1
        ? ["一", "二", "三", "四", "五", "六", "日"]
        : ["日", "一", "二", "三", "四", "五", "六"];

    const marked = new Set<string>();
    const data = getData();
    for (const t of data.tasks) {
        if (t.due && t.status !== "done") marked.add(t.due);
    }
    for (const map of Object.values(data.checkins)) {
        for (const [key, c] of Object.entries(map)) {
            if (c?.count) marked.add(key);
        }
    }

    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span class="syfe-start__pl-day is-blank"></span>`;
    for (let d = 1; d <= total; d++) {
        const key = `${first.slice(0, 8)}${String(d).padStart(2, "0")}`;
        const cls = ["syfe-start__pl-day"];
        if (key === today) cls.push("is-today");
        if (marked.has(key)) cls.push("is-marked");
        cells += `<span class="${cls.join(" ")}" title="${key}">${d}</span>`;
    }
    return `<div class="syfe-start__pl-calhead">${first.slice(0, 4)} 年 ${Number(first.slice(5, 7))} 月</div>
        <div class="syfe-start__pl-week">${weekNames.map(w => `<span>${w}</span>`).join("")}</div>
        <div class="syfe-start__pl-cal">${cells}</div>`;
}

const PLANNER_CARD_KEYS = ["goals", "habits", "countdowns", "calendar"];

/** 顺序串解析:未知项忽略、重复项只留第一次、缺失项按默认顺序补末尾。 */
function plannerCardOrder(text?: string): string[] {
    const out: string[] = [];
    for (const k of String(text || "").split(/[,，\s]+/)) {
        const key = k.trim().toLowerCase();
        if (PLANNER_CARD_KEYS.includes(key) && !out.includes(key)) out.push(key);
    }
    for (const k of PLANNER_CARD_KEYS) {
        if (!out.includes(k)) out.push(k);
    }
    return out;
}

/** 「习惯与目标」整段 HTML(由新标签页 render() 按需插入,卡片顺序可配)。 */
export function startPlannerSectionHTML(orderText?: string): string {
    const today = todayKey();
    const s = todaySummary();
    const bodies: Record<string, string> = {
        goals: card("goals", "🎯", "目标", goalsBody()),
        habits: card("habits", "⭐", "习惯", habitsBody(today)),
        countdowns: card("countdowns", "⏳", "倒数日", countdownsBody()),
        calendar: card("calendar", "📅", "日历", calendarBody(today)),
    };
    const cards = plannerCardOrder(orderText).map(k => bodies[k] || "").join("");
    return `<section class="syfe-start__section syfe-start__planner" data-section="planner">
        <div class="syfe-start__section-head">
            <svg><use xlink:href="#iconList"></use></svg>
            <span>习惯与目标</span>
            <span class="syfe-start__count">${s.habitsDone}/${s.habitsTotal} 已打卡</span>
            <span class="fn__flex-1"></span>
            <span class="syfe-start__pl-open" data-pl-view="today" title="打开完整面板">打开面板 ↗</span>
        </div>
        <div class="syfe-start__pl-grid">${cards}</div>
    </section>`;
}

/** 处理分区内的点击(打卡 / 跳转);返回 true 表示已消费,新标签页不再按文件条目处理。 */
export function handleStartPlannerClick(e: MouseEvent, plugin: any): boolean {
    const target = e.target as HTMLElement;
    const check = target.closest("[data-pl-checkin]") as HTMLElement | null;
    if (check?.dataset.plCheckin) {
        toggleCheckin(plugin, check.dataset.plCheckin, todayKey());
        return true;
    }
    const view = target.closest("[data-pl-view]") as HTMLElement | null;
    if (view?.dataset.plView) {
        openPlannerTab(plugin, {view: view.dataset.plView as ViewId});
        return true;
    }
    return false;
}
