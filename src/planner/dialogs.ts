// 习惯 / 目标 / 任务 / 倒数日 / 清单 / 设置的编辑对话框。
//
// 统一走 formDialog:标题 + 若干「标签 / 控件」行 + 底部按钮。
// 思源自带的 Setting 类只支持纵向列表,做不了这种表单 + 分组布局,所以直接 HTML + 事件绑定。
import {Dialog, showMessage} from "siyuan";
import {
    Goal,
    HABIT_COLORS,
    GOAL_COLORS,
    Habit,
    HabitFreq,
    INBOX_LIST_ID,
    Task,
    TaskList,
} from "./types";
import {
    addCountdown,
    addGoal,
    addHabit,
    addSubtask,
    addTask,
    addTaskList,
    deleteHabit,
    deleteCountdown,
    deleteGoal,
    deleteSubtask,
    deleteTask,
    deleteTaskList,
    getGoals,
    getLists,
    getSettings,
    getData,
    IPlannerPlugin,
    seedSamples,
    resetPlanner,
    toggleSubtask,
    updateCountdown,
    updateGoal,
    updateHabit,
    updatePlannerSettings,
    updateSubtask,
    updateTask,
    updateTaskList,
} from "./store";
import {
    colorSwatches,
    el,
    emojiPicker,
    numberField,
    selectField,
    checkboxRow,
    textField,
    wirePickers,
} from "./ui-common";
import {todayKey, addDays, isValidKey} from "./dates";

// ==== 通用表单外壳 ====

interface FormOptions {
    title: string;
    width?: string;
    /** 已装配好的行容器 */
    body: HTMLElement;
    onSave(root: HTMLElement): void | boolean;
    /** 额外的危险/次要按钮:{id, label, cls} */
    extraButtons?: {id: string; label: string; cls?: string; onClick(): void}[];
}

function formDialog(opts: FormOptions): Dialog {
    const extra = (opts.extraButtons || [])
        .map(b => `<button class="b3-button ${b.cls || "b3-button--outline"}" id="${b.id}">${b.label}</button>`)
        .join("");
    const dialog = new Dialog({
        title: opts.title,
        content: `<div class="b3-dialog__content syfe-pl__form"></div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-pl-cancel">取消</button>
                ${extra}
                <button class="b3-button b3-button--text" id="syfe-pl-save">保存</button>
            </div>`,
        width: opts.width || "520px",
    });
    const content = dialog.element.querySelector(".syfe-pl__form") as HTMLElement;
    content.appendChild(opts.body);

    const close = () => dialog.destroy();
    dialog.element.querySelector("#syfe-pl-cancel")?.addEventListener("click", close);
    dialog.element.querySelector("#syfe-pl-save")?.addEventListener("click", () => {
        if (opts.onSave(content) !== false) close();
    });
    for (const b of opts.extraButtons || []) {
        dialog.element.querySelector("#" + b.id)?.addEventListener("click", () => {
            b.onClick();
            close();
        });
    }
    // 回车提交
    content.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter" && (ev.target as HTMLElement)?.tagName !== "TEXTAREA") {
            ev.preventDefault();
            if (opts.onSave(content) !== false) close();
        }
    });
    wirePickers(content);
    // 焦点给第一个输入框
    (content.querySelector("input,select,textarea") as HTMLElement | null)?.focus();
    return dialog;
}

/** 「标签 + 控件」一行 */
export function formRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const row = el("div", "syfe-pl__formrow");
    row.appendChild(el("div", "syfe-pl__formlabel", label));
    const body = el("div", "syfe-pl__formctrl");
    body.appendChild(control);
    if (hint) body.appendChild(el("div", "syfe-pl__formhint", hint));
    row.appendChild(body);
    return row;
}

/** 隐藏的取值输入框:配合色板/emoji 选择器 */
function hiddenValue(name: string, value: string): HTMLElement {
    const input = el("input") as HTMLInputElement;
    input.type = "hidden";
    input.name = name;
    input.value = value;
    return input;
}

function val<T = string>(root: HTMLElement, id: string): T {
    return (root.querySelector(`#${id}`) as HTMLInputElement)?.value as unknown as T;
}

function hiddenVal(root: HTMLElement, name: string): string {
    return (root.querySelector(`input[name="${name}"]`) as HTMLInputElement)?.value || "";
}

function checked(root: HTMLElement, id: string): boolean {
    return (root.querySelector(`#${id}`) as HTMLInputElement)?.checked || false;
}

// ==== 习惯 ====

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekdayRow(def: number[]): HTMLElement {
    const wrap = el("div", "syfe-pl__daywrap");
    wrap.id = "syfe-habit-days";
    renderDayChips(wrap, def);
    return wrap;
}

function renderDayChips(wrap: HTMLElement, days: number[], freq: HabitFreq = "weekly"): void {
    wrap.innerHTML = "";
    const selected = new Set(days);
    const toggle = (n: number) => {
        if (selected.has(n)) selected.delete(n);
        else selected.add(n);
        renderDayChips(wrap, Array.from(selected).sort((a, b) => a - b), freq);
    };
    if (freq === "monthly") {
        for (let d = 1; d <= 31; d++) {
            const chip = el("span", "syfe-pl__daychip" + (selected.has(d) ? " is-active" : ""), String(d));
            chip.addEventListener("click", () => toggle(d));
            wrap.appendChild(chip);
        }
    } else {
        // 周一开头(大部分用户的心智模型),但存储仍是 0=周日的标准值
        const order = [1, 2, 3, 4, 5, 6, 0];
        for (const wd of order) {
            const chip = el("span", "syfe-pl__daychip" + (selected.has(wd) ? " is-active" : ""), WEEKDAY_LABELS[wd]);
            chip.addEventListener("click", () => toggle(wd));
            wrap.appendChild(chip);
        }
    }
}

export function openHabitDialog(plugin: IPlannerPlugin, habit?: Habit, onDone?: () => void): void {
    const isNew = !habit;
    const h = habit || {
        id: "", name: "", icon: "⭐", color: HABIT_COLORS[0], freq: "daily" as HabitFreq,
        days: [], target: 1, unit: "次", startDate: todayKey(), endDate: undefined,
        archived: false, note: "", goalId: undefined, order: 0, createdAt: 0,
    };
    const body = el("div", "syfe-pl__formbody");

    body.appendChild(formRow("名称", textField("syfe-habit-name", h.name, "如:每天读书 30 分钟")));
    const iconRow = el("div", "syfe-pl__formctrl");
    iconRow.appendChild(hiddenValue("icon", h.icon));
    iconRow.appendChild(el("div", "syfe-pl__gridwrap", emojiPicker(h.icon, "icon")));
    body.appendChild(formRow("图标", iconRow));

    const colorRow = el("div", "syfe-pl__formctrl");
    colorRow.appendChild(hiddenValue("color", h.color));
    colorRow.appendChild(el("div", "syfe-pl__gridwrap", colorSwatches(HABIT_COLORS, h.color, "color")));
    body.appendChild(formRow("颜色", colorRow));

    const freqRow = el("div", "syfe-pl__formctrl");
    const freqSel = selectField<HabitFreq>("syfe-habit-freq", [
        {value: "daily", label: "每天"},
        {value: "weekly", label: "每周的某几天"},
        {value: "monthly", label: "每月的某几天"},
    ], h.freq) as HTMLSelectElement;
    freqRow.appendChild(freqSel);
    const dayHost = weekdayRow(h.days);
    freqRow.appendChild(dayHost);
    const syncDays = () => {
        const show = freqSel.value !== "daily";
        dayHost.style.display = show ? "" : "none";
    };
    freqSel.addEventListener("change", () => {
        const freq = freqSel.value as HabitFreq;
        renderDayChips(dayHost, [], freq);
        syncDays();
    });
    renderDayChips(dayHost, h.days, h.freq);
    syncDays();
    body.appendChild(formRow("频率", freqRow, "「每周/每月」时点选具体生效的日子,不打卡的日子不会打断连续记录"));

    const targetRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    targetRow.appendChild(numberField("syfe-habit-target", h.target, 1, 999));
    targetRow.appendChild(textField("syfe-habit-unit", h.unit, "单位"));
    body.appendChild(formRow("每日目标", targetRow, "计数型习惯(如喝 8 杯水)填 8;一次性习惯填 1"));

    const dateRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    const startInput = el("input", "b3-text-field") as HTMLInputElement;
    startInput.type = "date";
    startInput.id = "syfe-habit-start";
    startInput.value = h.startDate;
    dateRow.appendChild(startInput);
    const endInput = el("input", "b3-text-field") as HTMLInputElement;
    endInput.type = "date";
    endInput.id = "syfe-habit-end";
    endInput.value = h.endDate || "";
    dateRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "至"));
    dateRow.appendChild(endInput);
    body.appendChild(formRow("起止日期", dateRow, "结束日期可留空,表示长期习惯"));

    const goals = getGoals("active");
    body.appendChild(formRow("关联目标", selectField("syfe-habit-goal",
        [{value: "", label: "（不关联）"}].concat(goals.map(g => ({value: g.id, label: g.title}))),
        h.goalId || ""), "关联后,打卡会推进该目标的完成进度"));

    const note = el("textarea", "b3-text-field fn__block") as HTMLTextAreaElement;
    note.id = "syfe-habit-note";
    note.rows = 3;
    note.value = h.note;
    body.appendChild(formRow("备注", note));

    formDialog({
        title: isNew ? "新建习惯" : "编辑习惯",
        body,
        extraButtons: isNew ? [] : [{
            id: "syfe-pl-delete",
            label: "删除",
            cls: "b3-button--outline syfe-pl__danger",
            onClick: () => {
                deleteHabit(plugin, h.id);
                onDone?.();
            },
        }],
        onSave: (root) => {
            const name = val(root, "syfe-habit-name").trim();
            if (!name) {
                showMessage("习惯名称不能为空");
                return false;
            }
            const freq = freqSel.value as HabitFreq;
            const startDate = val(root, "syfe-habit-start");
            const endDateRaw = val(root, "syfe-habit-end");
            if (!isValidKey(startDate)) {
                showMessage("开始日期无效");
                return false;
            }
            const patch = {
                name,
                icon: hiddenVal(root, "icon") || "⭐",
                color: hiddenVal(root, "color") || HABIT_COLORS[0],
                freq,
                days: freq === "daily" ? [] : collectDays(dayHost),
                target: Math.max(1, Number(val(root, "syfe-habit-target")) || 1),
                unit: val(root, "syfe-habit-unit").trim() || "次",
                startDate,
                endDate: isValidKey(endDateRaw) ? endDateRaw : undefined,
                goalId: val(root, "syfe-habit-goal") || undefined,
                note: (root.querySelector("#syfe-habit-note") as HTMLTextAreaElement)?.value || "",
            } as Partial<Habit>;
            if (isNew) addHabit(plugin, patch);
            else updateHabit(plugin, h.id, patch);
            onDone?.();
        },
    });
}

/** 从 chips 容器回收选中的日子(freq 决定读取顺序还是 1-31) */
function collectDays(host: HTMLElement): number[] {
    const out: number[] = [];
    host.querySelectorAll(".syfe-pl__daychip.is-active").forEach(node => {
        const label = node.textContent || "";
        const asNum = Number(label);
        if (Number.isFinite(asNum) && asNum >= 1 && asNum <= 31) {
            out.push(asNum);
        } else {
            const idx = WEEKDAY_LABELS.indexOf(label);
            if (idx >= 0) out.push(idx);
        }
    });
    return out.sort((a, b) => a - b);
}

// ==== 目标 ====

export function openGoalDialog(plugin: IPlannerPlugin, goal?: Goal, onDone?: () => void): void {
    const isNew = !goal;
    const g = goal || {
        id: "", title: "", desc: "", color: GOAL_COLORS[0], icon: "🎯",
        targetValue: 100, unit: "%", manualValue: 0, source: "manual" as const,
        due: undefined, status: "active" as const, order: 0, createdAt: 0,
    };
    const body = el("div", "syfe-pl__formbody");
    body.appendChild(formRow("标题", textField("syfe-goal-title", g.title, "如:年底前读 24 本书")));

    const iconRow = el("div", "syfe-pl__formctrl");
    iconRow.appendChild(hiddenValue("icon", g.icon));
    iconRow.appendChild(el("div", "syfe-pl__gridwrap", emojiPicker(g.icon, "icon")));
    body.appendChild(formRow("图标", iconRow));

    const colorRow = el("div", "syfe-pl__formctrl");
    colorRow.appendChild(hiddenValue("color", g.color));
    colorRow.appendChild(el("div", "syfe-pl__gridwrap", colorSwatches(GOAL_COLORS, g.color, "color")));
    body.appendChild(formRow("颜色", colorRow));

    const desc = el("textarea", "b3-text-field fn__block") as HTMLTextAreaElement;
    desc.id = "syfe-goal-desc";
    desc.rows = 3;
    desc.value = g.desc;
    body.appendChild(formRow("描述", desc));

    const srcSel = selectField<Goal["source"]>("syfe-goal-source", [
        {value: "manual", label: "手动填写进度"},
        {value: "tasks", label: "按关联任务的完成比例"},
        {value: "habits", label: "按关联习惯的打卡累计"},
        {value: "checkins", label: "按全部习惯的打卡累计"},
    ], g.source) as HTMLSelectElement;
    body.appendChild(formRow("进度来源", srcSel));

    const manualHost = el("div", "syfe-pl__formctrl syfe-pl__inline");
    manualHost.appendChild(numberField("syfe-goal-value", g.manualValue, 0, 999999));
    manualHost.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "/"));
    manualHost.appendChild(numberField("syfe-goal-target", g.targetValue, 1, 999999));
    manualHost.appendChild(textField("syfe-goal-unit", g.unit, "单位"));
    const manualRow = formRow("进度 / 目标值", manualHost, "所选来源是任务或习惯时,进度自动计算,这项无效");
    body.appendChild(manualRow);

    const syncSource = () => {
        const manual = srcSel.value === "manual";
        manualRow.style.display = manual ? "" : "none";
    };
    srcSel.addEventListener("change", syncSource);
    syncSource();

    const dueInput = el("input", "b3-text-field fn__block") as HTMLInputElement;
    dueInput.type = "date";
    dueInput.id = "syfe-goal-due";
    dueInput.value = g.due || "";
    body.appendChild(formRow("目标日", dueInput, "只用于显示剩余天数,不影响进度计算"));

    formDialog({
        title: isNew ? "新建目标" : "编辑目标",
        body,
        extraButtons: isNew ? [] : [{
            id: "syfe-pl-delete",
            label: "删除",
            cls: "b3-button--outline syfe-pl__danger",
            onClick: () => {
                deleteGoal(plugin, g.id);
                onDone?.();
            },
        }],
        onSave: (root) => {
            const title = val(root, "syfe-goal-title").trim();
            if (!title) {
                showMessage("目标标题不能为空");
                return false;
            }
            const dueRaw = val(root, "syfe-goal-due");
            const patch = {
                title,
                desc: (root.querySelector("#syfe-goal-desc") as HTMLTextAreaElement)?.value || "",
                icon: hiddenVal(root, "icon") || "🎯",
                color: hiddenVal(root, "color") || GOAL_COLORS[0],
                source: srcSel.value as Goal["source"],
                manualValue: Number(val(root, "syfe-goal-value")) || 0,
                targetValue: Math.max(1, Number(val(root, "syfe-goal-target")) || 100),
                unit: val(root, "syfe-goal-unit").trim() || "%",
                due: isValidKey(dueRaw) ? dueRaw : undefined,
            } as Partial<Goal>;
            if (isNew) addGoal(plugin, patch);
            else updateGoal(plugin, g.id, patch);
            onDone?.();
        },
    });
}

/** 给目标手动推进 / 回退数值的轻对话框 */
export function openGoalProgressDialog(plugin: IPlannerPlugin, goal: Goal, onDone?: () => void): void {
    const body = el("div", "syfe-pl__formbody");
    const field = numberField("syfe-goal-step", 1, -999999, 999999);
    body.appendChild(formRow(`「${goal.title}」当前值 ${goal.manualValue} ${goal.unit}`, field,
        "填正数推进,填负数回退"));
    formDialog({
        title: "推进目标",
        width: "420px",
        body,
        onSave: (root) => {
            const step = Number(val(root, "syfe-goal-step")) || 0;
            if (!step) return;
            updateGoal(plugin, goal.id, {manualValue: Math.max(0, goal.manualValue + step)});
            onDone?.();
        },
    });
}

// ==== 任务 ====

export function openTaskDialog(plugin: IPlannerPlugin, task?: Task, onDone?: () => void): void {
    const isNew = !task;
    const t = task || {
        id: "", title: "", note: "", status: "todo" as const, due: todayKey(), dueTime: undefined,
        priority: 0 as Task["priority"], listId: INBOX_LIST_ID, goalId: undefined, habitId: undefined,
        tags: [], subtasks: [], spentSec: 0, recur: undefined, order: 0, createdAt: 0, updatedAt: 0,
    };
    const body = el("div", "syfe-pl__formbody");
    body.appendChild(formRow("标题", textField("syfe-task-title", t.title, "要做什么?")));

    body.appendChild(formRow("所属清单", selectField("syfe-task-list",
        getLists().map(l => ({value: l.id, label: l.name})), t.listId)));

    body.appendChild(formRow("状态", selectField<Task["status"]>("syfe-task-status", [
        {value: "todo", label: "待开始"},
        {value: "doing", label: "进行中"},
        {value: "done", label: "已完成"},
    ], t.status)));

    const dueRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    const dueInput = el("input", "b3-text-field") as HTMLInputElement;
    dueInput.type = "date";
    dueInput.id = "syfe-task-due";
    dueInput.value = t.due || "";
    dueRow.appendChild(dueInput);
    const timeInput = el("input", "b3-text-field") as HTMLInputElement;
    timeInput.type = "time";
    timeInput.id = "syfe-task-time";
    timeInput.value = t.dueTime || "";
    dueRow.appendChild(timeInput);
    const todayBtn = el("button", "b3-button b3-button--outline syfe-pl__minibtn", "今天");
    todayBtn.type = "button";
    todayBtn.addEventListener("click", () => {
        dueInput.value = todayKey();
    });
    dueRow.appendChild(todayBtn);
    const tomorrowBtn = el("button", "b3-button b3-button--outline syfe-pl__minibtn", "明天");
    tomorrowBtn.type = "button";
    tomorrowBtn.addEventListener("click", () => {
        dueInput.value = addDays(todayKey(), 1);
    });
    dueRow.appendChild(tomorrowBtn);
    body.appendChild(formRow("截止", dueRow));

    body.appendChild(formRow("优先级", selectField("syfe-task-priority", [
        {value: "0", label: "无"},
        {value: "1", label: "低"},
        {value: "2", label: "中"},
        {value: "3", label: "高"},
    ], String(t.priority))));

    body.appendChild(formRow("关联目标", selectField("syfe-task-goal",
        [{value: "", label: "（不关联）"}].concat(getGoals("active").map(g => ({value: g.id, label: g.title}))),
        t.goalId || "")));

    body.appendChild(formRow("标签", textField("syfe-task-tags", t.tags.join(", "), "多个标签用逗号分隔")));

    // —— 子任务:可增删勾选,改动写进内存草稿,保存时才落库 ——
    let draftSubtasks = (t.subtasks || []).map(s => ({...s}));
    const subHost = el("div", "syfe-pl__subs");
    const renderSubs = () => {
        subHost.innerHTML = draftSubtasks.map(s => `
            <div class="syfe-pl__subrow" data-id="${s.id}">
                <input type="checkbox" class="b3-check" data-act="toggle" ${s.done ? "checked" : ""}>
                <input type="text" class="b3-text-field fn__flex-1" data-act="title" value="${s.title.replace(/"/g, "&quot;")}">
                <button type="button" class="b3-button b3-button--outline syfe-pl__iconbtn" data-act="del" title="删除">×</button>
            </div>`).join("") || `<div class="syfe-pl__formhint">还没有子步骤</div>`;
    };
    renderSubs();
    subHost.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const row = target.closest(".syfe-pl__subrow") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.id!;
        const act = (target as HTMLElement).dataset.act;
        if (act === "del") {
            draftSubtasks = draftSubtasks.filter(s => s.id !== id);
            renderSubs();
        }
    });
    subHost.addEventListener("change", (ev) => {
        const target = ev.target as HTMLInputElement;
        const row = target.closest(".syfe-pl__subrow") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.id!;
        const item = draftSubtasks.find(s => s.id === id);
        if (!item) return;
        if (target.dataset.act === "toggle") item.done = target.checked;
        if (target.dataset.act === "title") item.title = target.value;
    });
    const addSubBtn = el("button", "b3-button b3-button--outline syfe-pl__minibtn", "+ 添加子步骤");
    addSubBtn.type = "button";
    addSubBtn.addEventListener("click", () => {
        draftSubtasks.push({id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: "", done: false});
        renderSubs();
    });
    const subWrap = el("div", "syfe-pl__formctrl");
    subWrap.appendChild(subHost);
    subWrap.appendChild(addSubBtn);
    body.appendChild(formRow("子步骤", subWrap));

    const recurEnabled = checkboxRow("syfe-task-recur", "设置重复", !!t.recur);
    const recurHost = el("div", "syfe-pl__formctrl syfe-pl__inline");
    recurHost.appendChild(numberField("syfe-task-recur-every", t.recur?.every || 1, 1, 365));
    recurHost.appendChild(selectField("syfe-task-recur-unit", [
        {value: "day", label: "天"},
        {value: "week", label: "周"},
        {value: "month", label: "月"},
    ], t.recur?.unit || "day"));
    recurHost.appendChild(selectField("syfe-task-recur-from", [
        {value: "due", label: "按截止日顺延"},
        {value: "done", label: "按完成日顺延"},
    ], t.recur?.from || "due"));
    const recurRow = formRow("重复", recurHost, "完成后自动生成下一次;截止日为空时该项不生效");
    recurEnabled.querySelector("input")?.addEventListener("change", (ev) => {
        recurRow.style.display = (ev.target as HTMLInputElement).checked ? "" : "none";
    });
    recurRow.style.display = t.recur ? "" : "none";
    body.appendChild(formRow("重复", recurEnabled));
    body.appendChild(recurRow);

    const note = el("textarea", "b3-text-field fn__block") as HTMLTextAreaElement;
    note.id = "syfe-task-note";
    note.rows = 4;
    note.value = t.note;
    body.appendChild(formRow("备注", note));

    formDialog({
        title: isNew ? "新建任务" : "编辑任务",
        body,
        extraButtons: isNew ? [] : [{
            id: "syfe-pl-delete",
            label: "删除",
            cls: "b3-button--outline syfe-pl__danger",
            onClick: () => {
                deleteTask(plugin, t.id);
                onDone?.();
            },
        }],
        onSave: (root) => {
            const title = val(root, "syfe-task-title").trim();
            if (!title) {
                showMessage("任务标题不能为空");
                return false;
            }
            const dueRaw = val(root, "syfe-task-due");
            const timeRaw = val(root, "syfe-task-time");
            const recurOn = checked(root, "syfe-task-recur");
            const tags = val(root, "syfe-task-tags")
                .split(/[,，]/).map(x => x.trim()).filter(Boolean);
            const patch = {
                title,
                note: (root.querySelector("#syfe-task-note") as HTMLTextAreaElement)?.value || "",
                status: val<Task["status"]>(root, "syfe-task-status"),
                listId: val(root, "syfe-task-list") || INBOX_LIST_ID,
                due: isValidKey(dueRaw) ? dueRaw : undefined,
                dueTime: /^\d{2}:\d{2}$/.test(timeRaw) ? timeRaw : undefined,
                priority: Number(val(root, "syfe-task-priority")) as Task["priority"],
                goalId: val(root, "syfe-task-goal") || undefined,
                tags,
                subtasks: draftSubtasks.filter(s => s.title.trim()),
                recur: recurOn && isValidKey(dueRaw) ? {
                    every: Math.max(1, Number(val(root, "syfe-task-recur-every")) || 1),
                    unit: val<"day" | "week" | "month">(root, "syfe-task-recur-unit"),
                    from: val<"due" | "done">(root, "syfe-task-recur-from"),
                } : undefined,
            } as Partial<Task>;
            if (isNew) {
                addTask(plugin, patch);
            } else {
                updateTask(plugin, t.id, patch);
            }
            onDone?.();
        },
    });
}

/** Dock / Tab 里的「快速添加任务」输入框:回车即建 */
export function quickAddTask(plugin: IPlannerPlugin, title: string, listId?: string): Task | null {
    const name = (title || "").trim();
    if (!name) return null;
    return addTask(plugin, {title: name, listId: listId || INBOX_LIST_ID, due: todayKey()});
}

// ==== 倒数日 ====

export function openCountdownDialog(plugin: IPlannerPlugin, cd?: import("./types").Countdown, onDone?: () => void): void {
    const isNew = !cd;
    const c = cd || {
        id: "", title: "", date: addDays(todayKey(), 30), time: undefined, kind: "until" as const,
        repeatYearly: false, color: "#8257c9", icon: "📅", note: "", pinned: false, order: 0,
    };
    const body = el("div", "syfe-pl__formbody");
    body.appendChild(formRow("标题", textField("syfe-cd-title", c.title, "如:生日 / 考试 / 项目交付")));

    const iconRow = el("div", "syfe-pl__formctrl");
    iconRow.appendChild(hiddenValue("icon", c.icon));
    iconRow.appendChild(el("div", "syfe-pl__gridwrap", emojiPicker(c.icon, "icon")));
    body.appendChild(formRow("图标", iconRow));

    const colorRow = el("div", "syfe-pl__formctrl");
    colorRow.appendChild(hiddenValue("color", c.color));
    colorRow.appendChild(el("div", "syfe-pl__gridwrap", colorSwatches(GOAL_COLORS, c.color, "color")));
    body.appendChild(formRow("颜色", colorRow));

    body.appendChild(formRow("类型", selectField("syfe-cd-kind", [
        {value: "until", label: "倒数:还剩多少天"},
        {value: "since", label: "纪念:已经多少天"},
    ], c.kind)));

    const dateRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    const dateInput = el("input", "b3-text-field") as HTMLInputElement;
    dateInput.type = "date";
    dateInput.id = "syfe-cd-date";
    dateInput.value = c.date;
    dateRow.appendChild(dateInput);
    const timeInput = el("input", "b3-text-field") as HTMLInputElement;
    timeInput.type = "time";
    timeInput.id = "syfe-cd-time";
    timeInput.value = c.time || "";
    dateRow.appendChild(timeInput);
    body.appendChild(formRow("日期", dateRow));

    body.appendChild(formRow("每年重复", checkboxRow("syfe-cd-repeat", "每年重复(生日 / 周年)", c.repeatYearly)));
    body.appendChild(formRow("置顶", checkboxRow("syfe-cd-pinned", "固定在面板顶部", c.pinned)));

    const note = el("textarea", "b3-text-field fn__block") as HTMLTextAreaElement;
    note.id = "syfe-cd-note";
    note.rows = 3;
    note.value = c.note;
    body.appendChild(formRow("备注", note));

    formDialog({
        title: isNew ? "新建倒数日" : "编辑倒数日",
        width: "480px",
        body,
        extraButtons: isNew ? [] : [{
            id: "syfe-pl-delete",
            label: "删除",
            cls: "b3-button--outline syfe-pl__danger",
            onClick: () => {
                deleteCountdown(plugin, c.id);
                onDone?.();
            },
        }],
        onSave: (root) => {
            const title = val(root, "syfe-cd-title").trim();
            const date = val(root, "syfe-cd-date");
            if (!title) {
                showMessage("标题不能为空");
                return false;
            }
            if (!isValidKey(date)) {
                showMessage("日期无效");
                return false;
            }
            const timeRaw = val(root, "syfe-cd-time");
            const patch = {
                title,
                date,
                time: /^\d{2}:\d{2}$/.test(timeRaw) ? timeRaw : undefined,
                kind: val<"until" | "since">(root, "syfe-cd-kind"),
                repeatYearly: checked(root, "syfe-cd-repeat"),
                pinned: checked(root, "syfe-cd-pinned"),
                icon: hiddenVal(root, "icon") || "📅",
                color: hiddenVal(root, "color") || "#8257c9",
                note: (root.querySelector("#syfe-cd-note") as HTMLTextAreaElement)?.value || "",
            };
            if (isNew) addCountdown(plugin, patch);
            else updateCountdown(plugin, c.id, patch);
            onDone?.();
        },
    });
}

// ==== 清单 ====

export function openListDialog(plugin: IPlannerPlugin, list?: TaskList, onDone?: () => void): void {
    const isNew = !list;
    const l = list || {id: "", name: "", color: "#8a7c6b", icon: "📋", order: 0};
    const body = el("div", "syfe-pl__formbody");
    body.appendChild(formRow("名称", textField("syfe-list-name", l.name, "如:工作 / 家庭 / 购物")));

    const iconRow = el("div", "syfe-pl__formctrl");
    iconRow.appendChild(hiddenValue("icon", l.icon));
    iconRow.appendChild(el("div", "syfe-pl__gridwrap", emojiPicker(l.icon, "icon")));
    body.appendChild(formRow("图标", iconRow));

    const colorRow = el("div", "syfe-pl__formctrl");
    colorRow.appendChild(hiddenValue("color", l.color));
    colorRow.appendChild(el("div", "syfe-pl__gridwrap", colorSwatches(GOAL_COLORS, l.color, "color")));
    body.appendChild(formRow("颜色", colorRow));

    formDialog({
        title: isNew ? "新建清单" : "编辑清单",
        width: "460px",
        body,
        extraButtons: (isNew || l.builtin) ? [] : [{
            id: "syfe-pl-delete",
            label: "删除清单",
            cls: "b3-button--outline syfe-pl__danger",
            onClick: () => {
                deleteTaskList(plugin, l.id);
                onDone?.();
            },
        }],
        onSave: (root) => {
            const name = val(root, "syfe-list-name").trim();
            if (!name) {
                showMessage("清单名称不能为空");
                return false;
            }
            const patch = {name, icon: hiddenVal(root, "icon") || "📋", color: hiddenVal(root, "color") || "#8a7c6b"};
            if (isNew) addTaskList(plugin, name, patch.color, patch.icon);
            else updateTaskList(plugin, l.id, patch);
            onDone?.();
        },
    });
}

// ==== 设置 ====

export function openPlannerSettingsDialog(plugin: IPlannerPlugin, onDone?: () => void): void {
    const s = getSettings();
    const body = el("div", "syfe-pl__formbody");

    body.appendChild(formRow("番茄设置", el("div", "syfe-pl__formhint",
        "专注时长单位为分钟;每完成若干个专注段自动进入一次长休息")));

    const pomoRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    pomoRow.appendChild(numberField("syfe-pl-focus", s.pomodoro.focus, 1, 180));
    pomoRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "专注 /"));
    pomoRow.appendChild(numberField("syfe-pl-short", s.pomodoro.short, 1, 60));
    pomoRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "短休 /"));
    pomoRow.appendChild(numberField("syfe-pl-long", s.pomodoro.long, 1, 120));
    body.appendChild(formRow("时长(分钟)", pomoRow));

    const longEveryRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    longEveryRow.appendChild(numberField("syfe-pl-longevery", s.pomodoro.longEvery, 2, 12));
    longEveryRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "个专注后进长休息"));
    body.appendChild(formRow("长休息间隔", longEveryRow));

    body.appendChild(formRow("自动续接", checkboxRow("syfe-pl-autobreak", "专注结束自动开始休息", s.pomodoro.autoStartBreak)));
    body.appendChild(formRow("", checkboxRow("syfe-pl-autonext", "休息结束自动开始下一轮专注", s.pomodoro.autoStartNext)));

    const cdRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    cdRow.appendChild(numberField("syfe-pl-cdmin", s.defaultCountdownMin, 1, 600));
    cdRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "分钟(倒计时模式默认)"));
    body.appendChild(formRow("倒计时默认", cdRow));

    body.appendChild(formRow("提醒", checkboxRow("syfe-pl-notify", "阶段结束时显示提示", s.notify)));
    body.appendChild(formRow("", checkboxRow("syfe-pl-sound", "阶段结束时播放提示音", s.sound)));

    body.appendChild(formRow("一周起始于", selectField("syfe-pl-weekstart", [
        {value: "1", label: "周一"},
        {value: "0", label: "周日"},
    ], String(s.weekStart))));

    const heatRow = el("div", "syfe-pl__formctrl syfe-pl__inline");
    heatRow.appendChild(numberField("syfe-pl-heat", s.heatmapWeeks, 4, 53));
    heatRow.appendChild(el("span", "syfe-pl__formhint syfe-pl__inlinehint", "周"));
    body.appendChild(formRow("热力图跨度", heatRow));

    const stat = el("div", "syfe-pl__formhint syfe-pl__statbox");
    const data = getData();
    stat.textContent = `当前存档:${data.habits.length} 个习惯 · ${data.tasks.length} 项任务 · `
        + `${Object.keys(data.checkins).length} 个习惯有打卡记录 · ${data.sessions.length} 条专注记录`;
    body.appendChild(formRow("存档", stat));

    formDialog({
        title: "习惯与目标设置",
        width: "520px",
        body,
        extraButtons: [
            {
                id: "syfe-pl-seed",
                label: "载入示例数据",
                cls: "b3-button--outline",
                onClick: () => {
                    seedSamples(plugin);
                    showMessage("已载入示例数据");
                    onDone?.();
                },
            },
            {
                id: "syfe-pl-reset",
                label: "清空全部数据",
                cls: "b3-button--outline syfe-pl__danger",
                onClick: () => {
                    resetPlanner(plugin);
                    showMessage("已清空");
                    onDone?.();
                },
            },
        ],
        onSave: (root) => {
            updatePlannerSettings(plugin, {
                pomodoro: {
                    focus: Math.max(1, Number(val(root, "syfe-pl-focus")) || 25),
                    short: Math.max(1, Number(val(root, "syfe-pl-short")) || 5),
                    long: Math.max(1, Number(val(root, "syfe-pl-long")) || 15),
                    longEvery: Math.max(2, Number(val(root, "syfe-pl-longevery")) || 4),
                    autoStartBreak: checked(root, "syfe-pl-autobreak"),
                    autoStartNext: checked(root, "syfe-pl-autonext"),
                },
                defaultCountdownMin: Math.max(1, Number(val(root, "syfe-pl-cdmin")) || 25),
                notify: checked(root, "syfe-pl-notify"),
                sound: checked(root, "syfe-pl-sound"),
                weekStart: val(root, "syfe-pl-weekstart") === "0" ? 0 : 1,
                heatmapWeeks: Math.min(53, Math.max(4, Number(val(root, "syfe-pl-heat")) || 15)),
            });
            onDone?.();
        },
    });
}

// ==== 子任务的快速编辑(Tab 内直接编辑,不走对话框) ====

export function toggleSubtaskQuick(plugin: IPlannerPlugin, taskId: string, subId: string): void {
    toggleSubtask(plugin, taskId, subId);
}

export function removeSubtaskQuick(plugin: IPlannerPlugin, taskId: string, subId: string): void {
    deleteSubtask(plugin, taskId, subId);
}

export function appendSubtaskQuick(plugin: IPlannerPlugin, taskId: string, title: string): void {
    const name = (title || "").trim();
    if (!name) return;
    addSubtask(plugin, taskId, name);
}

export function renameSubtaskQuick(plugin: IPlannerPlugin, taskId: string, subId: string, title: string): void {
    updateSubtask(plugin, taskId, subId, {title});
}
