// 「统计」视图:纯展示,没有写操作。
// 图表不用第三方库 —— 柱状图就是一堆带高度的 div,热力图就是 grid。
// 引 Chart.js 之类会让打包体积和 CSP 都变复杂,而这些图形的表达需求其实只到"柱子"为止。
import {ViewCtx} from "../context";
import {getData, getHabits, getSettings, getTasks} from "../store";
import {
    dailyStats,
    habitBestStreak,
    habitCompletionRate,
    habitStreak,
    habitTotalCheckins,
    weekFocusSec,
} from "../stats";
import {addDays, daysLabel, formatCN, formatDuration, formatHumanDuration, todayKey} from "../dates";
import {escapeHTML, ringHTML} from "../ui-common";

export function renderStatsView(ctx: ViewCtx): void {
    const {container} = ctx;
    const today = todayKey();
    const days = Number(container.dataset.days || 14);
    const stats = dailyStats(days);
    const totalFocus = stats.reduce((s, d) => s + d.focusSec, 0);
    const maxFocus = Math.max(1, ...stats.map(d => d.focusSec));
    const todayRow = stats[stats.length - 1];
    const habits = getHabits(false);
    const week = weekFocusSec();
    const sessionsToday = getData().sessions.filter(s => s.dateKey === today);
    const pomodorosToday = sessionsToday.filter(s => s.mode === "pomodoro" && s.phase === "focus").length;
    const checkins = habits.reduce((s, h) => s + habitTotalCheckins(h.id), 0);
    const bestStreak = habits.reduce((m, h) => Math.max(m, habitBestStreak(h)), 0);

    // 与 timer 视图同理:监听挂在一次性 root 上,不挂 ctx.container(它是 Tab 的常驻节点,
    // 每渲染一次挂一遍就会累积)。
    container.innerHTML = "";
    const root = document.createElement("div");
    root.className = "syfe-pl__viewroot";
    root.innerHTML = `
        <div class="syfe-pl__toolbar">
            <span class="syfe-pl__seg">
                ${[7, 14, 30].map(d => `<span class="syfe-pl__segitem${days === d ? " is-active" : ""}" data-days="${d}">近 ${d} 天</span>`).join("")}
            </span>
        </div>

        <div class="syfe-pl__kpis">
            ${kpi("今日专注", formatHumanDuration(todayRow?.focusSec || 0))}
            ${kpi("本周专注", formatHumanDuration(week))}
            ${kpi("今日番茄", String(pomodorosToday))}
            ${kpi(`近 ${days} 天累计`, formatHumanDuration(totalFocus))}
            ${kpi("累计打卡", `${checkins} 次`)}
            ${kpi("最佳连续", `${bestStreak} 天`)}
        </div>

        <div class="syfe-pl__panel">
            <div class="syfe-pl__panelhead">专注时长分布</div>
            <div class="syfe-pl__barchart">
                ${stats.map(d => {
        const h = Math.max(2, Math.round((d.focusSec / maxFocus) * 120));
        const doneRatio = d.habitsTotal ? d.habitsDone / d.habitsTotal : 0;
        return `<div class="syfe-pl__barmain" title="${escapeHTML(formatCN(d.key))} 专注 ${formatDuration(d.focusSec)} · 习惯 ${d.habitsDone}/${d.habitsTotal}">
                        <div class="syfe-pl__barwrap">
                            <div class="syfe-pl__barcol" style="height:${h}px"></div>
                            <div class="syfe-pl__bardot" style="opacity:${doneRatio}"></div>
                        </div>
                        <div class="syfe-pl__barlabel">${d.key.slice(8)}</div>
                    </div>`;
    }).join("")}
            </div>
            <div class="syfe-pl__small syfe-pl__legend">
                柱子 = 当日专注时长;底部小点亮度 = 当日习惯完成比例
            </div>
        </div>

        <div class="syfe-pl__panel">
            <div class="syfe-pl__panelhead">习惯表现(近 30 天)</div>
            ${habits.length === 0 ? `<div class="syfe-pl__hintline">还没有习惯</div>` : `
            <div class="syfe-pl__habitrows">${habits.map(h => {
        const rate = habitCompletionRate(h, 30);
        const streak = habitStreak(h);
        const best = habitBestStreak(h);
        const strip = Array.from({length: 30}).map((_, i) => {
            const key = addDays(today, -29 + i);
            const count = getData().checkins[h.id]?.[key]?.count || 0;
            return `<span class="syfe-pl__minicell${count >= h.target ? " is-done" : count > 0 ? " is-part" : ""}"
                        style="background:${count >= h.target ? h.color : "transparent"}"
                        title="${escapeHTML(key)} ${count}/${h.target}"></span>`;
        }).join("");
        return `<div class="syfe-pl__habitrow">
                    <div class="syfe-pl__habitrowhead">
                        <span>${escapeHTML(h.icon)} ${escapeHTML(h.name)}</span>
                        <span class="fn__flex-1"></span>
                        <span class="syfe-pl__small">完成率 <b>${Math.round(rate * 100)}%</b></span>
                        <span class="syfe-pl__small">连续 ${streak} / 最佳 ${best} 天</span>
                    </div>
                    <div class="syfe-pl__ministrip">${strip}</div>
                </div>`;
    }).join("")}</div>`}
        </div>

        <div class="syfe-pl__panel">
            <div class="syfe-pl__panelhead">投入时间最多的任务</div>
            ${renderTopTasks()}
        </div>

        <div class="syfe-pl__panel">
            <div class="syfe-pl__panelhead">本周习惯完成占比</div>
            <div class="syfe-pl__weekring">${renderWeekRing()}</div>
        </div>`;
    container.appendChild(root);

    root.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const d = target.dataset.days;
        if (!d) return;
        // 跨度记在常驻容器上 —— root 每次重建会被丢弃,存它那里等于白点
        container.dataset.days = d;
        renderStatsView(ctx);
    });
}

function kpi(label: string, value: string): string {
    return `<div class="syfe-pl__kpi">
        <div class="syfe-pl__kpival">${escapeHTML(value)}</div>
        <div class="syfe-pl__kpilabel">${escapeHTML(label)}</div>
    </div>`;
}

function renderTopTasks(): string {
    const rows = getTasks()
        .filter(t => (t.spentSec || 0) > 0)
        .sort((a, b) => b.spentSec - a.spentSec)
        .slice(0, 8);
    if (rows.length === 0) return `<div class="syfe-pl__hintline">还没有给任何任务计过时</div>`;
    const max = rows[0].spentSec;
    return `<div class="syfe-pl__ranks">${rows.map((t, i) => `
        <div class="syfe-pl__rankrow">
            <span class="syfe-pl__rankno">${i + 1}</span>
            <span class="syfe-pl__rankname">${escapeHTML(t.title)}</span>
            <span class="syfe-pl__rankbar"><span style="width:${Math.round((t.spentSec / max) * 100)}%"></span></span>
            <span class="syfe-pl__ranktime">${formatDuration(t.spentSec)}</span>
            <span class="syfe-pl__rankdue">${t.due ? escapeHTML(daysLabel(t.due)) : ""}</span>
        </div>`).join("")}</div>`;
}

function renderWeekRing(): string {
    const days = dailyStats(7);
    const total = days.reduce((s, d) => s + (d.habitsTotal ? d.habitsDone / d.habitsTotal : 0), 0);
    const ratio = total / Math.max(1, days.length);
    return `<div class="syfe-pl__weekringshell">
        ${ringHTML({ratio, size: 108, stroke: 10, color: "var(--b3-theme-primary, #4285f4)", label: `${Math.round(ratio * 100)}%`})}
        <div class="syfe-pl__small">近 7 天平均完成率</div>
    </div>`;
}
