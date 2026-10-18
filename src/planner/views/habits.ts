// 「习惯」视图:卡片式管理 + 热力图 + 连续记录。
//
// 交互决定:
// - 归档而不是删除:习惯一旦有了历史打卡,删掉就是把数据一起埋了;归档只是从日常面板隐藏。
// - 排序调整用「上移/下移」按钮而不是拖拽:侧栏/面板里拖拽需要额外的全套处理(占位计算、
//   自动滚屏),收益不抵复杂度,按钮在几十个习惯的量级够用。
import {showMessage} from "siyuan";
import {ViewCtx} from "../context";
import {
    deleteHabit,
    getHabits,
    getData,
    getSettings,
    reorderHabit,
    setCheckin,
    updateHabit,
} from "../store";
import {
    habitBestStreak,
    habitCompletionRate,
    habitHeatmap,
    habitStreak,
    habitTotalCheckins,
    isHabitScheduled,
    HeatCell,
} from "../stats";
import {openHabitDialog} from "../dialogs";
import {addDays, todayKey} from "../dates";
import {escapeHTML, emptyState, ringHTML} from "../ui-common";
import {Habit} from "../types";

export function renderHabits(ctx: ViewCtx): void {
    const {plugin, container} = ctx;
    container.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "syfe-pl__toolbar";
    const addBtn = document.createElement("button");
    addBtn.className = "b3-button b3-button--text";
    addBtn.textContent = "+ 新建习惯";
    addBtn.addEventListener("click", () => openHabitDialog(plugin, undefined, () => renderHabits(ctx)));
    toolbar.appendChild(addBtn);
    const showArchived = document.createElement("label");
    showArchived.className = "syfe-pl__switch";
    const cb = document.createElement("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.className = "b3-switch";
    cb.checked = !!container.dataset.showArchived;
    cb.addEventListener("change", () => {
        container.dataset.showArchived = cb.checked ? "1" : "";
        renderHabits(ctx);
    });
    showArchived.appendChild(cb);
    showArchived.appendChild(document.createTextNode("显示已归档"));
    toolbar.appendChild(showArchived);
    container.appendChild(toolbar);

    const all = getHabits(true);
    const archived = all.filter(h => h.archived);
    const active = all.filter(h => !h.archived);
    const list = cb.checked ? all : active;

    if (list.length === 0) {
        container.innerHTML += emptyState(
            "还没有习惯",
            "习惯是每天/每周重复的事;打卡记录会累积成连续天数",
        );
        return;
    }
    if (archived.length && !cb.checked) {
        const tip = document.createElement("div");
        tip.className = "syfe-pl__hintline";
        tip.textContent = `另有 ${archived.length} 个已归档习惯,勾选「显示已归档」可查看`;
        container.appendChild(tip);
    }

    const grid = document.createElement("div");
    grid.className = "syfe-pl__habitgrid";
    grid.innerHTML = list.map(h => habitCardHTML(h, list)).join("");
    container.appendChild(grid);

    grid.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const host = target.closest("[data-habit]") as HTMLElement | null;
        const id = host?.dataset.habit;
        if (!id) return;
        const habit = getHabits(true).find(h => h.id === id);
        if (!habit) return;
        const act = target.dataset.act;
        const idx = list.findIndex(h => h.id === id);
        if (act === "edit") {
            openHabitDialog(plugin, habit, () => renderHabits(ctx));
        } else if (act === "archive") {
            updateHabit(plugin, id, {archived: !habit.archived});
            showMessage(habit.archived ? "已取消归档" : "已归档");
            renderHabits(ctx);
        } else if (act === "delete") {
            deleteHabit(plugin, id);
            renderHabits(ctx);
        } else if (act === "up") {
            reorderHabit(plugin, id, idx - 1);
            renderHabits(ctx);
        } else if (act === "down") {
            reorderHabit(plugin, id, idx + 1);
            renderHabits(ctx);
        } else if (act === "heat") {
            // 展开/收起热力图:DOM 里翻转 class,CSS 用 max-height 过渡
            host.classList.toggle("is-heat-open");
        } else if (act === "today") {
            // 日历格点击 = 补卡/撤销。只给过去 60 天开这个口子,未来日期不许提前打卡
            const day = target.dataset.day!;
            const cur = getData().checkins[id]?.[day]?.count || 0;
            setCheckin(plugin, id, day, cur >= habit.target ? 0 : habit.target);
            renderHabits(ctx);
        }
    });
}

function habitCardHTML(habit: Habit, list: Habit[]): string {
    const idx = list.findIndex(h => h.id === habit.id);
    const streak = habitStreak(habit);
    const best = habitBestStreak(habit);
    const rate30 = habitCompletionRate(habit, 30);
    const total = habitTotalCheckins(habit.id);
    const today = todayKey();
    const doneToday = (getData().checkins[habit.id]?.[today]?.count || 0) >= habit.target;
    const weeks = getSettings().heatmapWeeks;
    const cells = habitHeatmap(habit, weeks);
    // 最近 7 天的小圆点条(比整块热力图更省空间,一眼看当天状态)
    const weekStrip = Array.from({length: 7}).map((_, i) => {
        const key = addDays(today, -6 + i);
        const count = getData().checkins[habit.id]?.[key]?.count || 0;
        const scheduled = isHabitScheduled(habit, key);
        const done = count >= habit.target;
        const cls = !scheduled ? "is-off" : done ? "is-done" : count > 0 ? "is-part" : "is-todo";
        return `<span class="syfe-pl__dot syfe-pl__dot--${cls}" title="${escapeHTML(key)} ${count}/${habit.target}"></span>`;
    }).join("");

    return `<div class="syfe-pl__habitcard${habit.archived ? " is-archived" : ""}" data-habit="${escapeHTML(habit.id)}">
        <div class="syfe-pl__habithead">
            <span class="syfe-pl__habiticon" style="background:${escapeHTML(habit.color)}22;color:${escapeHTML(habit.color)}">${escapeHTML(habit.icon)}</span>
            <span class="syfe-pl__habitname">${escapeHTML(habit.name)}</span>
            ${habit.goalId ? `<span class="syfe-pl__badge" title="已关联目标">🎯 目标</span>` : ""}
            <span class="fn__flex-1"></span>
            <span class="syfe-pl__cardacts">
                <span class="syfe-pl__cardact" data-act="up" title="上移">↑</span>
                <span class="syfe-pl__cardact" data-act="down" title="下移">↓</span>
                <span class="syfe-pl__cardact" data-act="archive" title="${habit.archived ? "取消归档" : "归档"}">${habit.archived ? "↩" : "🔒"}</span>
                <span class="syfe-pl__cardact" data-act="edit" title="编辑">✎</span>
                <span class="syfe-pl__cardact syfe-pl__danger" data-act="delete" title="删除">🗑</span>
            </span>
        </div>
        <div class="syfe-pl__habitbody">
            <div class="syfe-pl__habitrings">
                ${ringHTML({
        ratio: doneToday ? 1 : (getData().checkins[habit.id]?.[today]?.count || 0) / habit.target,
        size: 52,
        stroke: 6,
        color: habit.color,
        label: doneToday ? "✓" : String(getData().checkins[habit.id]?.[today]?.count || 0),
        sub: `/${habit.target}`,
    })}
                <div class="syfe-pl__habitringtext">
                    <div class="syfe-pl__bignum">${streak}<small>天</small></div>
                    <div class="syfe-pl__small">连续</div>
                </div>
            </div>
            <div class="syfe-pl__habitstats">
                <div><b>${freqLabel(habit)}</b> · 每天 ${habit.target} ${escapeHTML(habit.unit)}</div>
                <div>最佳连续 <b>${best}</b> 天 · 累计 <b>${total}</b> ${escapeHTML(habit.unit)}</div>
                <div>近 30 天完成率 <b>${Math.round(rate30 * 100)}%</b></div>
                <div class="syfe-pl__weekstrip">${weekStrip}</div>
            </div>
        </div>
        <div class="syfe-pl__habitfoot">
            <span class="syfe-pl__linkish" data-act="heat">${cells.length ? "热力图" : ""}</span>
            <span class="syfe-pl__small">${escapeHTML(habit.startDate)}${habit.endDate ? " → " + escapeHTML(habit.endDate) : " 起"}</span>
        </div>
        ${cells.length ? `<div class="syfe-pl__heatwrap">${renderHeatmapHTML(habit, cells, getSettings().weekStart)}</div>` : ""}
    </div>`;
}

function freqLabel(habit: Habit): string {
    if (habit.freq === "daily") return "每天";
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    if (habit.freq === "weekly") {
        if (!habit.days.length) return "每周";
        // 展示时按周一开头排序,和存储顺序无关
        const order = [1, 2, 3, 4, 5, 6, 0];
        const sorted = habit.days.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
        return "每周 " + sorted.map(d => names[d]).join("、");
    }
    return "每月 " + habit.days.slice().sort((a, b) => a - b).join("、") + " 日";
}

/** 热力图 HTML:7 行 × N 列的 grid。格子的深浅用 opacity 而不是色值,主题切换不用重算颜色 */
export function renderHeatmapHTML(habit: Habit, cells: HeatCell[], weekStart: 0 | 1): string {
    const today = todayKey();
    const labels = weekStart === 1 ? ["一", "二", "三", "四", "五", "六", "日"] : ["日", "一", "二", "三", "四", "五", "六"];
    const rows: string[] = [];
    const cols = cells.length / 7;
    // 首列渲染星期标签
    for (let r = 0; r < 7; r++) {
        const line: string[] = [];
        for (let c = 0; c < cols; c++) {
            const cell = cells[c * 7 + r];
            const ratio = cell.future ? -1 : (cell.scheduled ? cell.ratio : -1);
            const cls = !cell.scheduled && !cell.future ? "is-off" : cell.future ? "is-future" : cell.done ? "is-done" : "is-part";
            const title = cell.future
                ? cell.key
                : `${cell.key} ${cell.count}/${cell.target}${cell.scheduled ? "" : "（不排班）"}`;
            const clickable = !cell.future && cell.key >= addDays(today, -60) && cell.key <= today;
            line.push(`<span class="syfe-pl__cell syfe-pl__cell--${cls} ${clickable ? "is-clickable" : ""}"
                data-day="${escapeHTML(cell.key)}" title="${escapeHTML(title)}"
                style="--pl-cell:${escapeHTML(habit.color)}${cell.done ? "" : ""};opacity:${cell.done ? 1 : Math.max(0.18, ratio)}"></span>`);
        }
        rows.push(`<div class="syfe-pl__heatrow">
            <span class="syfe-pl__heatlabel">${labels[r]}</span>
            ${line.join("")}
        </div>`);
    }
    return `<div class="syfe-pl__heat">${rows.join("")}</div>`;
}
