// 「任务」与「待办」两个视图 —— 同一个实体,两套用法。
//
// 区别只在于给多少字段和操作:
//  - todo  = 快速清单:一行一个,勾掉就完事,重点是低摩擦录入
//  - tasks = 完整管理:筛选、清单、看板、优先级、子步骤、目标关联
// 共用 renderer,靠 mode 切换"露出多少",避免两份实现各自漂移。
import {ViewCtx} from "../context";
import {
    addTask,
    completeTask,
    deleteTask,
    getGoals,
    getLists,
    getTasks,
    INBOX_LIST_ID,
    listName,
    openTasks,
    reorderTask,
    setTaskStatus,
    updateTask,
} from "../store";
import {bucketTasksByDue, taskSubtaskProgress} from "../stats";
import {openListDialog, openTaskDialog} from "../dialogs";
import {addDays, daysLabel, todayKey} from "../dates";
import {barHTML, emptyState, escapeHTML} from "../ui-common";
import {Task, TaskStatus} from "../types";

export type TasksMode = "tasks" | "todo";

interface Filters {
    listId: string;
    status: "open" | "all" | "done";
    priority: number;
    goalId: string;
    view: "list" | "board";
}

function readFilters(container: HTMLElement, mode: TasksMode): Filters {
    const q = (id: string) => (container.querySelector("#" + id) as HTMLSelectElement | HTMLInputElement | null)?.value;
    return {
        listId: mode === "todo" ? INBOX_LIST_ID : (q("syfe-pl-filter-list") ?? ""),
        status: (mode === "todo" ? (container.dataset.status as Filters["status"]) || "all"
            : (q("syfe-pl-filter-status") as Filters["status"]) || "open"),
        priority: mode === "todo" ? 0 : Number(q("syfe-pl-filter-priority") || 0),
        goalId: mode === "todo" ? "" : (q("syfe-pl-filter-goal") ?? ""),
        view: (mode === "todo" ? "list" : (container.dataset.view as "list" | "board") || "list"),
    };
}

export function renderTasks(ctx: ViewCtx, mode: TasksMode): void {
    const {plugin, container} = ctx;
    const today = todayKey();
    const filters = readFilters(container, mode);
    const all = getTasks();

    let rows = all;
    if (filters.listId) rows = rows.filter(t => t.listId === filters.listId);
    if (filters.status === "open") rows = rows.filter(t => t.status !== "done");
    if (filters.status === "done") rows = rows.filter(t => t.status === "done");
    if (filters.priority) rows = rows.filter(t => t.priority >= filters.priority);
    if (filters.goalId) rows = rows.filter(t => t.goalId === filters.goalId);

    const openCount = openTasks().length;
    const container2 = container;
    container2.innerHTML = "";

    // —— 筛选栏(只有「任务」模式有) ——
    if (mode === "tasks") {
        const bar = document.createElement("div");
        bar.className = "syfe-pl__toolbar syfe-pl__filterbar";
        bar.innerHTML = `
            <select class="b3-select" id="syfe-pl-filter-list" title="按清单筛选">
                <option value="">全部清单</option>
                ${getLists().map(l => `<option value="${escapeHTML(l.id)}"${l.id === filters.listId ? " selected" : ""}>${escapeHTML(l.name)}</option>`).join("")}
            </select>
            <select class="b3-select" id="syfe-pl-filter-status">
                <option value="open"${filters.status === "open" ? " selected" : ""}>未完成</option>
                <option value="all"${filters.status === "all" ? " selected" : ""}>全部</option>
                <option value="done"${filters.status === "done" ? " selected" : ""}>已完成</option>
            </select>
            <select class="b3-select" id="syfe-pl-filter-priority">
                <option value="0"${filters.priority === 0 ? " selected" : ""}>全部优先级</option>
                <option value="2"${filters.priority === 2 ? " selected" : ""}>≥ 中</option>
                <option value="3"${filters.priority === 3 ? " selected" : ""}>高</option>
            </select>
            <select class="b3-select" id="syfe-pl-filter-goal">
                <option value="">全部目标</option>
                ${getGoals("active").map(g => `<option value="${escapeHTML(g.id)}"${g.id === filters.goalId ? " selected" : ""}>${escapeHTML(g.title)}</option>`).join("")}
            </select>
            <span class="fn__flex-1"></span>
            <span class="syfe-pl__seg">
                <span class="syfe-pl__segitem${filters.view === "list" ? " is-active" : ""}" data-view="list">列表</span>
                <span class="syfe-pl__segitem${filters.view === "board" ? " is-active" : ""}" data-view="board">看板</span>
            </span>
            <button class="b3-button b3-button--outline syfe-pl__minibtn" id="syfe-pl-lists">管理清单</button>
            <button class="b3-button b3-button--text" id="syfe-pl-newtask">+ 新建任务</button>`;
        container2.appendChild(bar);
        bar.addEventListener("change", () => renderTasks(ctx, mode));
        bar.addEventListener("click", (ev) => {
            const t = ev.target as HTMLElement;
            if (t.dataset.view) {
                container2.dataset.view = t.dataset.view;
                renderTasks(ctx, mode);
            } else if (t.id === "syfe-pl-newtask") {
                openTaskDialog(plugin, undefined, () => renderTasks(ctx, mode));
            } else if (t.id === "syfe-pl-lists") {
                openListDialog(plugin, undefined, () => renderTasks(ctx, mode));
            }
        });
    }

    // —— 快速录入栏 ——
    const quick = document.createElement("div");
    quick.className = "syfe-pl__quickadd";
    const input = document.createElement("input");
    input.className = "b3-text-field fn__block";
    input.placeholder = mode === "todo" ? "想做点什么?回车加到「待办」" : "快速新建任务,回车加入今天";
    input.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key !== "Enter") return;
        const title = input.value.trim();
        if (!title) return;
        // 待办模式不加默认日期 —— 待办本来就是"还没安排时间"的事
        addTask(plugin, {
            title,
            listId: filters.listId || INBOX_LIST_ID,
            due: mode === "todo" ? undefined : today,
        });
        input.value = "";
        renderTasks(ctx, mode);
    });
    quick.appendChild(input);
    container2.appendChild(quick);

    if (rows.length === 0) {
        container2.innerHTML += emptyState(
            openCount === 0 ? "清单是空的" : "当前筛选下没有任务",
            openCount === 0 ? "" : "试试放宽筛选条件",
        );
        return;
    }

    const body = document.createElement("div");
    body.className = "syfe-pl__taskarea";
    if (mode === "tasks" && filters.view === "board") {
        body.innerHTML = renderBoard(rows);
    } else {
        body.innerHTML = renderBuckets(rows, mode);
    }
    container2.appendChild(body);

    body.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const row = target.closest("[data-id]") as HTMLElement | null;
        const id = row?.dataset.id;
        if (!id) return;
        const act = target.dataset.act;
        if (act === "check") {
            completeTask(plugin, id, getTaskSafe(id)?.status !== "done");
            renderTasks(ctx, mode);
        } else if (act === "status") {
            setTaskStatus(plugin, id, target.dataset.status as TaskStatus);
            renderTasks(ctx, mode);
        } else if (act === "delete") {
            deleteTask(plugin, id);
            renderTasks(ctx, mode);
        } else if (act === "tomorrow") {
            const t = getTaskSafe(id);
            if (t) updateTask(plugin, id, {due: addDays(today, 1)});
            renderTasks(ctx, mode);
        } else if (act === "today") {
            updateTask(plugin, id, {due: today});
            renderTasks(ctx, mode);
        } else if (act === "up" || act === "down") {
            const list = rows.filter(t => (filters.listId ? t.listId === filters.listId : true));
            const idx = list.findIndex(t => t.id === id);
            reorderTask(plugin, id, act === "up" ? idx - 1 : idx + 1, filters.listId);
            renderTasks(ctx, mode);
        } else {
            openTaskDialog(plugin, getTaskSafe(id), () => renderTasks(ctx, mode));
        }
    });
}

function getTaskSafe(id: string): Task | undefined {
    return getTasks().find(t => t.id === id);
}

// ==== 列表视图 ====

function renderBuckets(rows: Task[], mode: TasksMode): string {
    const dones = rows.filter(t => t.status === "done");
    const opens = rows.filter(t => t.status !== "done");
    const buckets = bucketTasksByDue(opens);
    const html = buckets.map(b => `
        <div class="syfe-pl__bucket${b.tone === "overdue" ? " is-overdue" : ""}">
            <div class="syfe-pl__buckethead">
                <span class="syfe-pl__bucketname">${escapeHTML(b.label)}</span>
                <span class="syfe-pl__bucketcount">${b.tasks.length}</span>
            </div>
            <div class="syfe-pl__tasklist">${b.tasks.map(t => taskCardHTML(t, mode)).join("")}</div>
        </div>`).join("");
    const doneHtml = dones.length && mode === "todo"
        ? `<div class="syfe-pl__bucket">
            <div class="syfe-pl__buckethead">
                <span class="syfe-pl__bucketname">已完成</span>
                <span class="syfe-pl__bucketcount">${dones.length}</span>
            </div>
            <div class="syfe-pl__tasklist">${dones.map(t => taskCardHTML(t, mode)).join("")}</div>
        </div>`
        : "";
    return `<div class="syfe-pl__buckets">${html}${doneHtml}</div>`;
}

function taskCardHTML(t: Task, mode: TasksMode): string {
    const today = todayKey();
    const sub = taskSubtaskProgress(t);
    const overdue = !!t.due && t.due < today && t.status !== "done";
    const dueText = t.due ? (t.due === today ? "今天" : daysLabel(t.due)) : "";
    const listLabel = t.listId && t.listId !== INBOX_LIST_ID ? listName(t.listId) : "";
    const spent = t.spentSec > 0 ? `${Math.round(t.spentSec / 60)}′` : "";
    return `<div class="syfe-pl__taskcard${t.status === "done" ? " is-done" : ""}${overdue ? " is-overdue" : ""}" data-id="${escapeHTML(t.id)}">
        <span class="syfe-pl__bigcheck" data-act="check" title="完成/取消">${t.status === "done" ? "✓" : ""}</span>
        <div class="syfe-pl__cardmain">
            <div class="syfe-pl__cardtitle${t.status === "done" ? " is-strike" : ""}">${escapeHTML(t.title)}</div>
            <div class="syfe-pl__taskmeta">
                ${dueText ? `<span class="syfe-pl__tone syfe-pl__tone--${overdue ? "overdue" : "normal"}">${escapeHTML(dueText)}${t.dueTime ? " " + escapeHTML(t.dueTime) : ""}</span>` : ""}
                ${listLabel ? `<span class="syfe-pl__metaitem">${escapeHTML(listLabel)}</span>` : ""}
                ${t.priority >= 2 ? `<span class="syfe-pl__pri syfe-pl__pri--${t.priority}">${t.priority === 3 ? "高" : "中"}</span>` : ""}
                ${sub.total ? `<span class="syfe-pl__metaitem">${barHTML(sub.done / sub.total, "var(--b3-theme-primary)", 4)} ${sub.done}/${sub.total}</span>` : ""}
                ${t.recur ? `<span class="syfe-pl__metaitem" title="重复任务">↻</span>` : ""}
                ${spent ? `<span class="syfe-pl__metaitem" title="已投入时长">⏱ ${spent}</span>` : ""}
                ${t.goalId ? `<span class="syfe-pl__metaitem" title="已关联目标">🎯</span>` : ""}
            </div>
            ${t.note ? `<div class="syfe-pl__cardnote">${escapeHTML(t.note)}</div>` : ""}
            ${sub.total && mode === "tasks" ? `<div class="syfe-pl__sublist">${(t.subtasks || []).map(s =>
        `<span class="syfe-pl__subpill${s.done ? " is-done" : ""}">${escapeHTML(s.title)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="syfe-pl__rowacts">
            <span class="syfe-pl__cardact" data-act="today" title="设为今天">今</span>
            <span class="syfe-pl__cardact" data-act="tomorrow" title="推到明天">→</span>
            <span class="syfe-pl__cardact" data-act="up" title="上移">↑</span>
            <span class="syfe-pl__cardact" data-act="down" title="下移">↓</span>
            <span class="syfe-pl__cardact syfe-pl__danger" data-act="delete" title="删除">🗑</span>
        </div>
    </div>`;
}

// ==== 看板视图 ====

function renderBoard(rows: Task[]): string {
    const cols: {key: TaskStatus; label: string}[] = [
        {key: "todo", label: "待开始"},
        {key: "doing", label: "进行中"},
        {key: "done", label: "已完成"},
    ];
    return `<div class="syfe-pl__board">${cols.map(c => {
        const list = rows.filter(t => t.status === c.key);
        return `<div class="syfe-pl__boardcol">
            <div class="syfe-pl__boardhead">
                <span>${escapeHTML(c.label)}</span>
                <span class="syfe-pl__bucketcount">${list.length}</span>
            </div>
            <div class="syfe-pl__boardbody">
                ${list.map(t => boardCardHTML(t, cols)).join("") || `<div class="syfe-pl__hintline syfe-pl__hintline--tiny">空</div>`}
            </div>
        </div>`;
    }).join("")}</div>`;
}

function boardCardHTML(t: Task, cols: {key: TaskStatus; label: string}[]): string {
    const today = todayKey();
    const overdue = !!t.due && t.due < today && t.status !== "done";
    const dueText = t.due ? (t.due === today ? "今天" : daysLabel(t.due)) : "";
    const others = cols.filter(c => c.key !== t.status)
        .map(c => `<span class="syfe-pl__move" data-act="status" data-status="${c.key}">→ ${escapeHTML(c.label)}</span>`).join("");
    return `<div class="syfe-pl__boardcard${overdue ? " is-overdue" : ""}" data-id="${escapeHTML(t.id)}">
        <div class="syfe-pl__cardtitle">${escapeHTML(t.title)}</div>
        <div class="syfe-pl__taskmeta">
            ${dueText ? `<span class="syfe-pl__tone syfe-pl__tone--${overdue ? "overdue" : "normal"}">${escapeHTML(dueText)}</span>` : ""}
            ${t.priority >= 2 ? `<span class="syfe-pl__pri syfe-pl__pri--${t.priority}">${t.priority === 3 ? "高" : "中"}</span>` : ""}
        </div>
        <div class="syfe-pl__boardacts">${others}
            <span class="syfe-pl__cardact syfe-pl__danger" data-act="delete" title="删除">🗑</span>
        </div>
    </div>`;
}
