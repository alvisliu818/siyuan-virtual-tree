// 「目标」视图:目标是任务与习惯的聚合视角,本身不记录流水。
// 进度四个来源里,tasks/habits/checkins 都是实时算出来的 —— 改任意一侧,这里的环跟着变。
import {showMessage} from "siyuan";
import {ViewCtx} from "../context";
import {
    deleteGoal,
    getGoals,
    getData,
    reorderGoal,
    updateGoal,
} from "../store";
import {
    goalHabits,
    goalProgress,
    goalTasks,
} from "../stats";
import {openGoalDialog, openGoalProgressDialog} from "../dialogs";
import {daysLabel, todayKey} from "../dates";
import {barHTML, emptyState, escapeHTML, ringHTML} from "../ui-common";
import {Goal} from "../types";

export function renderGoals(ctx: ViewCtx): void {
    const {plugin, container} = ctx;
    container.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "syfe-pl__toolbar";
    const addBtn = document.createElement("button");
    addBtn.className = "b3-button b3-button--text";
    addBtn.textContent = "+ 新建目标";
    addBtn.addEventListener("click", () => openGoalDialog(plugin, undefined, () => renderGoals(ctx)));
    toolbar.appendChild(addBtn);
    const showAll = document.createElement("label");
    showAll.className = "syfe-pl__switch";
    const cb = document.createElement("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.className = "b3-switch";
    cb.checked = !!container.dataset.showAll;
    cb.addEventListener("change", () => {
        container.dataset.showAll = cb.checked ? "1" : "";
        renderGoals(ctx);
    });
    showAll.appendChild(cb);
    showAll.appendChild(document.createTextNode("显示已完成/归档"));
    toolbar.appendChild(showAll);
    container.appendChild(toolbar);

    const list = cb.checked ? getGoals() : getGoals("active");
    if (list.length === 0) {
        container.innerHTML += emptyState("还没有目标", "目标可以关联任务或习惯,进度自动跟着走");
        return;
    }

    const grid = document.createElement("div");
    grid.className = "syfe-pl__goalgrid";
    grid.innerHTML = list.map((g, i) => goalCardHTML(g, i, list.length)).join("");
    container.appendChild(grid);

    grid.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const host = target.closest("[data-goal]") as HTMLElement | null;
        const id = host?.dataset.goal;
        if (!id) return;
        const goal = getGoals().find(g => g.id === id) || getData().goals.find(g => g.id === id);
        if (!goal) return;
        const act = target.dataset.act;
        const idx = list.findIndex(g => g.id === id);
        if (act === "edit") {
            openGoalDialog(plugin, goal, () => renderGoals(ctx));
        } else if (act === "step") {
            openGoalProgressDialog(plugin, goal, () => renderGoals(ctx));
        } else if (act === "up") {
            reorderGoal(plugin, id, idx - 1);
            renderGoals(ctx);
        } else if (act === "down") {
            reorderGoal(plugin, id, idx + 1);
            renderGoals(ctx);
        } else if (act === "toggle") {
            const next = goal.status === "done" ? "active" : "done";
            updateGoal(plugin, id, {status: next});
            showMessage(next === "done" ? "目标已完成 🎉" : "已恢复进行中");
            renderGoals(ctx);
        } else if (act === "archive") {
            updateGoal(plugin, id, {status: goal.status === "archived" ? "active" : "archived"});
            renderGoals(ctx);
        } else if (act === "delete") {
            deleteGoal(plugin, id);
            renderGoals(ctx);
        }
    });
}

function goalCardHTML(goal: Goal, idx: number, total: number): string {
    const prog = goalProgress(goal);
    const tasks = goalTasks(goal.id);
    const habits = goalHabits(goal.id);
    const tasksDone = tasks.filter(t => t.status === "done").length;
    const dueText = goal.due ? `目标日 ${goal.due} · ${daysLabel(goal.due)}` : "";
    return `<div class="syfe-pl__goalcard${goal.status !== "active" ? " is-dim" : ""}" data-goal="${escapeHTML(goal.id)}">
        <div class="syfe-pl__goalhead">
            <span class="syfe-pl__goalicon" style="background:${escapeHTML(goal.color)}22;color:${escapeHTML(goal.color)}">${escapeHTML(goal.icon)}</span>
            <span class="syfe-pl__goaltitle">${escapeHTML(goal.title)}</span>
            ${goal.status === "done" ? `<span class="syfe-pl__badge is-ok">已完成</span>` : ""}
            ${goal.status === "archived" ? `<span class="syfe-pl__badge">已归档</span>` : ""}
            <span class="fn__flex-1"></span>
            <span class="syfe-pl__cardacts">
                <span class="syfe-pl__cardact" data-act="up" title="上移">↑</span>
                <span class="syfe-pl__cardact" data-act="down" title="下移">↓</span>
                <span class="syfe-pl__cardact" data-act="toggle" title="标记完成/恢复">${goal.status === "done" ? "↩" : "✓"}</span>
                <span class="syfe-pl__cardact" data-act="archive" title="归档">🔒</span>
                <span class="syfe-pl__cardact" data-act="edit" title="编辑">✎</span>
                <span class="syfe-pl__cardact syfe-pl__danger" data-act="delete" title="删除">🗑</span>
            </span>
        </div>
        ${goal.desc ? `<div class="syfe-pl__goaldesc">${escapeHTML(goal.desc)}</div>` : ""}
        <div class="syfe-pl__goalbody">
            <div class="syfe-pl__goalring">
                ${ringHTML({
        ratio: prog.ratio,
        size: 84,
        stroke: 9,
        color: goal.color,
        label: `${Math.round(prog.ratio * 100)}%`,
    })}
            </div>
            <div class="syfe-pl__goalmeta">
                <div class="syfe-pl__goalprog">${escapeHTML(prog.label)}</div>
                <div class="syfe-pl__small">进度来源:${escapeHTML(prog.sourceLabel)}</div>
                ${dueText ? `<div class="syfe-pl__small ${daysLabel(goal.due!).includes("前") ? "is-danger" : ""}">${escapeHTML(dueText)}</div>` : ""}
                <div class="syfe-pl__small">关联:${tasks.length} 项任务(完成 ${tasksDone}) · ${habits.length} 个习惯</div>
                ${barHTML(prog.ratio, goal.color)}
            </div>
        </div>
        <div class="syfe-pl__goalfoot">
            ${goal.source === "manual" ? `<button class="b3-button b3-button--outline syfe-pl__minibtn" data-act="step">推进 +</button>` : ""}
            ${goal.status === "done" ? "" : `<button class="b3-button b3-button--outline syfe-pl__minibtn" data-act="toggle">标记完成</button>`}
            <span class="syfe-pl__small">${idx + 1} / ${total}</span>
        </div>
    </div>`;
}
