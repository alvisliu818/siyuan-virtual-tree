// planner 的唯一数据源:内存缓存 + 单文件 planner.json 持久化。
//
// 惯例同 src/start-page.ts / src/tags/tag-store.ts:
//  - loadData/saveData 异步 → 内存缓存兜住同步渲染,改动后防抖落盘;
//  - 所有写操作都经过 mutate(),它统一负责「改内存 → 落盘 → 广播」三件事,
//    避免某处忘了发事件导致 Dock 与 Tab 显示不一致(两个视图共享同一份数据,最容易出这种 bug)。
//
// 不做的两件事:
//  - 不做跨窗口实时同步(思源多窗口各自加载插件实例,最后写入者胜;这是个人面板可接受的行为)
//  - 不做向思源文档的导出/导入(2026-10-19 决策:数据留在插件侧)
import {
    Checkin,
    Countdown,
    createDefaultData,
    FocusSession,
    Goal,
    Habit,
    INBOX_LIST_ID,
    newId,
    PlannerData,
    PlannerSettings,
    Subtask,
    Task,
    TaskList,
    TaskStatus,
} from "./types";
import {addDays, isValidKey, todayKey} from "./dates";

const STORAGE_KEY = "planner.json";

// 顺手把 Inbox 清单 id 透出去 —— 它是「待办」的同义词,视图层到处要用,
// 不该让每个视图都回头去 types 里再引一次。
export {INBOX_LIST_ID} from "./types";

/** 数据变化(Dock / Tab 都监听它重绘) */
export const PLANNER_CHANGED_EVENT = "syfe:planner-changed";

/** 面板最小化的插件接口(便于单测与复用) */
export interface IPlannerPlugin {
    name: string;
    loadData(storageName: string): Promise<any>;
    saveData(storageName: string, content: any): Promise<any>;
}

let cached: PlannerData = createDefaultData();
let loaded = false;
let pluginRef: IPlannerPlugin | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 最近一次我们自己写入的时间戳(用于指出"这次变更是我发的") */
let lastWriteAt = 0;

// ==== 落盘 ====

function emitChanged(detail?: any): void {
    window.dispatchEvent(new CustomEvent(PLANNER_CHANGED_EVENT, {detail}));
}

async function writeNow(p: IPlannerPlugin): Promise<void> {
    try {
        lastWriteAt = Date.now();
        await p.saveData(STORAGE_KEY, cached);
    } catch (e) {
        console.error("[planner] 保存失败:", e);
    }
}

/** 立即落盘(卸载/关窗前调用) */
export function flushPlanner(): void {
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (pluginRef) void writeNow(pluginRef);
}

function schedulePersist(): void {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pluginRef) void writeNow(pluginRef);
    }, 400);
}

/**
 * 只落盘、不广播。
 * 计时器每 500ms 要更新一下自己的状态,tick 走的是独立的 TIMER_TICK_EVENT;
 * 若这里也发 PLANNER_CHANGED_EVENT,列表/热力图会跟着每半秒重绘一次。
 */
export function persistQuietly(): void {
    schedulePersist();
}

/** 所有写操作的唯一入口 */
function mutate<T>(fn: () => T, detail?: any): T {
    const r = fn();
    schedulePersist();
    emitChanged(detail);
    return r;
}

// ==== 载入与清洗 ====

function num(v: any, dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function str(v: any, dflt = ""): string {
    return typeof v === "string" ? v : dflt;
}

function bool(v: any, dflt = false): boolean {
    return typeof v === "boolean" ? v : dflt;
}

function sanitizeHabit(h: any): Habit | null {
    if (!h || typeof h !== "object") return null;
    const id = str(h.id);
    if (!id) return null;
    const startDate = isValidKey(h.startDate) ? h.startDate : todayKey();
    return {
        id,
        name: str(h.name, "未命名习惯"),
        icon: str(h.icon, "⭐"),
        color: str(h.color, "#4c8bff"),
        freq: h.freq === "weekly" || h.freq === "monthly" ? h.freq : "daily",
        days: Array.isArray(h.days) ? h.days.filter((x: any) => Number.isFinite(Number(x))).map(Number) : [],
        target: Math.max(1, Math.round(num(h.target, 1))),
        unit: str(h.unit, "次"),
        startDate,
        endDate: isValidKey(h.endDate) ? h.endDate : undefined,
        archived: bool(h.archived),
        note: str(h.note),
        goalId: typeof h.goalId === "string" ? h.goalId : undefined,
        order: num(h.order, 0),
        createdAt: num(h.createdAt, Date.now()),
    };
}

function sanitizeGoal(g: any): Goal | null {
    if (!g || typeof g !== "object") return null;
    const id = str(g.id);
    if (!id) return null;
    return {
        id,
        title: str(g.title, "未命名目标"),
        desc: str(g.desc),
        color: str(g.color, "#3f8ed0"),
        icon: str(g.icon, "🎯"),
        targetValue: Math.max(1, num(g.targetValue, 100)),
        unit: str(g.unit, "%"),
        manualValue: num(g.manualValue, 0),
        source: ["manual", "tasks", "habits", "checkins"].includes(g.source) ? g.source : "manual",
        due: isValidKey(g.due) ? g.due : undefined,
        status: ["active", "done", "archived"].includes(g.status) ? g.status : "active",
        order: num(g.order, 0),
        createdAt: num(g.createdAt, Date.now()),
    };
}

function sanitizeTask(t: any): Task | null {
    if (!t || typeof t !== "object") return null;
    const id = str(t.id);
    if (!id) return null;
    return {
        id,
        title: str(t.title, "未命名任务"),
        note: str(t.note),
        status: (["todo", "doing", "done"].includes(t.status) ? t.status : "todo") as TaskStatus,
        doneAt: Number.isFinite(Number(t.doneAt)) ? Number(t.doneAt) : undefined,
        due: isValidKey(t.due) ? t.due : undefined,
        dueTime: /^\d{2}:\d{2}$/.test(t.dueTime) ? t.dueTime : undefined,
        priority: ([0, 1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 0) as Task["priority"],
        listId: str(t.listId, INBOX_LIST_ID),
        goalId: typeof t.goalId === "string" ? t.goalId : undefined,
        habitId: typeof t.habitId === "string" ? t.habitId : undefined,
        tags: Array.isArray(t.tags) ? t.tags.filter((x: any) => typeof x === "string") : [],
        subtasks: Array.isArray(t.subtasks) ? t.subtasks
            .filter((s: any) => s && typeof s.id === "string")
            .map((s: any) => ({id: s.id, title: str(s.title, ""), done: bool(s.done)})) : [],
        estimatePomodoros: Number.isFinite(Number(t.estimatePomodoros)) ? Number(t.estimatePomodoros) : undefined,
        donePomodoros: Number.isFinite(Number(t.donePomodoros)) ? Number(t.donePomodoros) : undefined,
        spentSec: Math.max(0, num(t.spentSec, 0)),
        recur: t.recur && Number.isFinite(Number(t.recur.every)) && ["day", "week", "month"].includes(t.recur.unit)
            ? {every: Math.max(1, Math.round(Number(t.recur.every))), unit: t.recur.unit, from: t.recur.from === "done" ? "done" : "due"}
            : undefined,
        order: num(t.order, 0),
        createdAt: num(t.createdAt, Date.now()),
        updatedAt: num(t.updatedAt, Number(t.createdAt) || Date.now()),
    };
}

function sanitizeList(l: any): TaskList | null {
    if (!l || typeof l !== "object") return null;
    const id = str(l.id);
    if (!id) return null;
    return {
        id,
        name: str(l.name, "清单"),
        color: str(l.color, "#8a7c6b"),
        icon: str(l.icon, "📋"),
        builtin: id === INBOX_LIST_ID ? true : bool(l.builtin),
        order: num(l.order, 0),
    };
}

function sanitizeCountdown(c: any): Countdown | null {
    if (!c || typeof c !== "object") return null;
    const id = str(c.id);
    if (!id) return null;
    if (!isValidKey(c.date)) return null;   // 日期不合法的倒数日没有意义,直接丢弃
    return {
        id,
        title: str(c.title, "未命名"),
        date: c.date,
        time: /^\d{2}:\d{2}$/.test(c.time) ? c.time : undefined,
        kind: c.kind === "since" ? "since" : "until",
        repeatYearly: bool(c.repeatYearly),
        color: str(c.color, "#8257c9"),
        icon: str(c.icon, "📅"),
        note: str(c.note),
        pinned: bool(c.pinned),
        order: num(c.order, 0),
    };
}

function sanitizeSession(s: any): FocusSession | null {
    if (!s || typeof s !== "object") return null;
    const id = str(s.id);
    if (!id) return null;
    return {
        id,
        mode: ["pomodoro", "stopwatch", "countdown"].includes(s.mode) ? s.mode : "pomodoro",
        phase: ["focus", "short", "long"].includes(s.phase) ? s.phase : undefined,
        seconds: Math.max(0, num(s.seconds, 0)),
        taskId: typeof s.taskId === "string" ? s.taskId : undefined,
        habitId: typeof s.habitId === "string" ? s.habitId : undefined,
        startedAt: num(s.startedAt, Date.now()),
        endedAt: num(s.endedAt, Date.now()),
        dateKey: isValidKey(s.dateKey) ? s.dateKey : todayKey(),
    };
}

function sanitizeCheckins(raw: any): PlannerData["checkins"] {
    const out: PlannerData["checkins"] = {};
    if (!raw || typeof raw !== "object") return out;
    for (const hid of Object.keys(raw)) {
        const byDate = raw[hid];
        if (!byDate || typeof byDate !== "object") continue;
        const cleaned: Record<string, Checkin> = {};
        for (const day of Object.keys(byDate)) {
            if (!isValidKey(day)) continue;
            const v = byDate[day];
            if (!v || typeof v !== "object") continue;
            cleaned[day] = {
                count: Math.max(0, Math.round(num(v.count, 0))),
                note: typeof v.note === "string" ? v.note : undefined,
                at: num(v.at, Date.now()),
            };
        }
        if (Object.keys(cleaned).length) out[hid] = cleaned;
    }
    return out;
}

/** 把磁盘数据洗成可信结构;任何坏字段都退回默认而不是抛错(损坏文件也要能加载) */
function sanitize(raw: any): PlannerData {
    const def = createDefaultData();
    if (!raw || typeof raw !== "object") return def;
    const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const pom = settings.pomodoro && typeof settings.pomodoro === "object" ? settings.pomodoro : {};
    const timer = raw.timer && typeof raw.timer === "object" ? raw.timer : {};

    const lists = Array.isArray(raw.lists) ? raw.lists.map(sanitizeList).filter(Boolean) as TaskList[] : [];
    if (!lists.some(l => l.id === INBOX_LIST_ID)) {
        lists.unshift({id: INBOX_LIST_ID, name: "待办", color: "#4c8bff", icon: "📥", builtin: true, order: 0});
    }

    const habits = Array.isArray(raw.habits) ? raw.habits.map(sanitizeHabit).filter(Boolean) as Habit[] : [];

    return {
        version: 1,
        habits,
        checkins: sanitizeCheckins(raw.checkins),
        goals: Array.isArray(raw.goals) ? raw.goals.map(sanitizeGoal).filter(Boolean) as Goal[] : [],
        tasks: Array.isArray(raw.tasks) ? raw.tasks.map(sanitizeTask).filter(Boolean) as Task[] : [],
        lists: normalizeOrder(lists),
        countdowns: Array.isArray(raw.countdowns) ? raw.countdowns.map(sanitizeCountdown).filter(Boolean) as Countdown[] : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions.map(sanitizeSession).filter(Boolean) as FocusSession[] : [],
        timer: {
            running: bool(timer.running),
            mode: ["pomodoro", "stopwatch", "countdown"].includes(timer.mode) ? timer.mode : "pomodoro",
            phase: ["focus", "short", "long"].includes(timer.phase) ? timer.phase : "focus",
            targetSec: Math.max(0, num(timer.targetSec, def.timer.targetSec)),
            elapsedSec: Math.max(0, num(timer.elapsedSec, 0)),
            // running 但没有 runningSince(脏数据)→ 视为停止,避免还原出巨大时长
            runningSince: bool(timer.running) ? num(timer.runningSince, 0) : 0,
            taskId: typeof timer.taskId === "string" ? timer.taskId : undefined,
            habitId: typeof timer.habitId === "string" ? timer.habitId : undefined,
            round: Math.max(0, Math.round(num(timer.round, 0))),
        },
        settings: {
            pomodoro: {
                focus: Math.max(1, Math.round(num(pom.focus, def.settings.pomodoro.focus))),
                short: Math.max(1, Math.round(num(pom.short, def.settings.pomodoro.short))),
                long: Math.max(1, Math.round(num(pom.long, def.settings.pomodoro.long))),
                longEvery: Math.max(2, Math.round(num(pom.longEvery, def.settings.pomodoro.longEvery))),
                autoStartBreak: bool(pom.autoStartBreak, def.settings.pomodoro.autoStartBreak),
                autoStartNext: bool(pom.autoStartNext, def.settings.pomodoro.autoStartNext),
            },
            defaultCountdownMin: Math.max(1, Math.round(num(settings.defaultCountdownMin, def.settings.defaultCountdownMin))),
            notify: bool(settings.notify, def.settings.notify),
            sound: bool(settings.sound, def.settings.sound),
            weekStart: num(settings.weekStart, 1) === 0 ? 0 : 1,
            heatmapWeeks: Math.min(53, Math.max(4, Math.round(num(settings.heatmapWeeks, def.settings.heatmapWeeks)))),
        },
    };
}

/** 让 T[] 的 order 变成 0..n-1 的连续序号(删除中间的条目后排序不会出现空洞/并列) */
function normalizeOrder<T extends {order: number}>(list: T[]): T[] {
    return list
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((it, i) => (it.order === i ? it : {...it, order: i}));
}

/** 计算新条目的 order(追加到末尾) */
function nextOrder<T extends {order: number}>(list: T[]): number {
    return list.reduce((m, it) => Math.max(m, it.order + 1), 0);
}

export async function loadPlanner(plugin: IPlannerPlugin): Promise<void> {
    pluginRef = plugin;
    try {
        const raw = await plugin.loadData(STORAGE_KEY);
        cached = sanitize(typeof raw === "string" && !raw.trim() ? null : raw);
    } catch {
        cached = createDefaultData();
    }
    loaded = true;
}

export function isLoaded(): boolean {
    return loaded;
}

export function getData(): PlannerData {
    return cached;
}

export function getSettings(): PlannerSettings {
    return cached.settings;
}

// ==== 通用：不 mutate 的直接读取 ====

export function getLists(): TaskList[] {
    return cached.lists.slice().sort((a, b) => a.order - b.order);
}

export function getList(id: string): TaskList | undefined {
    return cached.lists.find(l => l.id === id);
}

export function listName(id: string): string {
    return getList(id)?.name || "待办";
}

// ==== 习惯 ====

export function getHabits(includeArchived = true): Habit[] {
    const list = includeArchived ? cached.habits.slice() : cached.habits.filter(h => !h.archived);
    return list.sort((a, b) => a.order - b.order);
}

export function getHabit(id: string): Habit | undefined {
    return cached.habits.find(h => h.id === id);
}

export function addHabit(p: IPlannerPlugin, input: Partial<Habit>): Habit {
    const habit: Habit = {
        id: newId("h"),
        name: input.name || "新习惯",
        icon: input.icon || "⭐",
        color: input.color || "#4c8bff",
        freq: input.freq || "daily",
        days: input.days || [],
        target: Math.max(1, input.target || 1),
        unit: input.unit || "次",
        startDate: input.startDate || todayKey(),
        endDate: input.endDate,
        archived: false,
        note: input.note || "",
        goalId: input.goalId,
        order: nextOrder(cached.habits),
        createdAt: Date.now(),
    };
    return mutate(() => {
        cached.habits.push(habit);
        return habit;
    }, {kind: "habit", id: habit.id});
}

export function updateHabit(p: IPlannerPlugin, id: string, patch: Partial<Habit>): void {
    mutate(() => {
        const h = cached.habits.find(x => x.id === id);
        if (!h) return;
        Object.assign(h, patch, {target: patch.target ? Math.max(1, patch.target) : h.target});
    }, {kind: "habit", id});
}

export function deleteHabit(p: IPlannerPlugin, id: string): void {
    mutate(() => {
        cached.habits = normalizeOrder(cached.habits.filter(h => h.id !== id));
        delete cached.checkins[id];
        // 任务上残留的 habitId 悬空引用要清掉,否则计时归集时会查不到习惯
        for (const t of cached.tasks) {
            if (t.habitId === id) t.habitId = undefined;
        }
    }, {kind: "habit", id});
}

export function reorderHabit(p: IPlannerPlugin, id: string, toIndex: number): void {
    mutate(() => {
        const list = cached.habits.slice().sort((a, b) => a.order - b.order);
        const from = list.findIndex(h => h.id === id);
        if (from < 0) return;
        const target = Math.max(0, Math.min(list.length - 1, toIndex));
        if (from === target) return;
        const [item] = list.splice(from, 1);
        list.splice(target, 0, item);
        cached.habits = normalizeOrder(list);
    }, {kind: "habit", id});
}

// ==== 打卡 ====

export function getCheckin(habitId: string, day: string): Checkin | undefined {
    return cached.checkins[habitId]?.[day];
}

export function checkinCount(habitId: string, day: string): number {
    return getCheckin(habitId, day)?.count || 0;
}

/**
 * 打卡主交互:未达标 +1;已达标的再点一次视为「撤销」归零。
 * (target=1 时就是常规的勾选/取消)
 */
export function toggleCheckin(p: IPlannerPlugin, habitId: string, day: string): number {
    const habit = getHabit(habitId);
    if (!habit) return 0;
    const map = cached.checkins[habitId] || (cached.checkins[habitId] = {});
    const cur = map[day]?.count || 0;
    const next = cur >= habit.target ? 0 : cur + 1;
    mutate(() => {
        if (next === 0) {
            delete map[day];
        } else {
            map[day] = {...(map[day] || {count: 0, note: undefined, at: 0}), count: next, at: Date.now()};
        }
    }, {kind: "checkin", habitId, day});
    return next;
}

export function setCheckin(p: IPlannerPlugin, habitId: string, day: string, count: number, note?: string): void {
    mutate(() => {
        const map = cached.checkins[habitId] || (cached.checkins[habitId] = {});
        const c = Math.max(0, Math.round(count));
        if (c === 0 && !note) {
            delete map[day];
        } else {
            map[day] = {count: c, note: note || undefined, at: Date.now()};
        }
    }, {kind: "checkin", habitId, day});
}

/** 给已经存在的打卡加/改备注(备注为空且 count=0 时会整条删掉) */
export function setCheckinNote(p: IPlannerPlugin, habitId: string, day: string, note: string): void {
    mutate(() => {
        const map = cached.checkins[habitId] || (cached.checkins[habitId] = {});
        if (map[day]) map[day].note = note || undefined;
    }, {kind: "checkin", habitId, day});
}

// ==== 目标 ====

export function getGoals(status?: Goal["status"]): Goal[] {
    const list = status ? cached.goals.filter(g => g.status === status) : cached.goals.filter(g => g.status !== "archived");
    return list.sort((a, b) => a.order - b.order);
}

export function getGoal(id: string): Goal | undefined {
    return cached.goals.find(g => g.id === id);
}

export function addGoal(p: IPlannerPlugin, input: Partial<Goal>): Goal {
    const goal: Goal = {
        id: newId("g"),
        title: input.title || "新目标",
        desc: input.desc || "",
        color: input.color || "#3f8ed0",
        icon: input.icon || "🎯",
        targetValue: Math.max(1, input.targetValue || 100),
        unit: input.unit || "%",
        manualValue: input.manualValue || 0,
        source: input.source || "manual",
        due: input.due,
        status: "active",
        order: nextOrder(cached.goals),
        createdAt: Date.now(),
    };
    return mutate(() => {
        cached.goals.push(goal);
        return goal;
    }, {kind: "goal", id: goal.id});
}

export function updateGoal(p: IPlannerPlugin, id: string, patch: Partial<Goal>): void {
    mutate(() => {
        const g = cached.goals.find(x => x.id === id);
        if (g) Object.assign(g, patch);
    }, {kind: "goal", id});
}

export function deleteGoal(p: IPlannerPlugin, id: string): void {
    mutate(() => {
        cached.goals = normalizeOrder(cached.goals.filter(g => g.id !== id));
        for (const t of cached.tasks) if (t.goalId === id) t.goalId = undefined;
        for (const h of cached.habits) if (h.goalId === id) h.goalId = undefined;
    }, {kind: "goal", id});
}

export function reorderGoal(p: IPlannerPlugin, id: string, toIndex: number): void {
    mutate(() => {
        const list = cached.goals.slice().sort((a, b) => a.order - b.order);
        const from = list.findIndex(g => g.id === id);
        if (from < 0) return;
        const target = Math.max(0, Math.min(list.length - 1, toIndex));
        if (from === target) return;
        const [item] = list.splice(from, 1);
        list.splice(target, 0, item);
        cached.goals = normalizeOrder(list);
    }, {kind: "goal", id});
}

// ==== 任务 / 待办 ====

export function getTasks(): Task[] {
    return cached.tasks.slice();
}

/** 未完成的任务/待办 */
export function openTasks(): Task[] {
    return cached.tasks.filter(t => t.status !== "done");
}

export function getTask(id: string): Task | undefined {
    return cached.tasks.find(t => t.id === id);
}

export function addTask(p: IPlannerPlugin, input: Partial<Task>): Task {
    const now = Date.now();
    const task: Task = {
        id: newId("t"),
        title: input.title || "",
        note: input.note || "",
        status: input.status || "todo",
        due: input.due,
        dueTime: input.dueTime,
        priority: input.priority || 0,
        listId: input.listId || INBOX_LIST_ID,
        goalId: input.goalId,
        habitId: input.habitId,
        tags: input.tags || [],
        subtasks: input.subtasks || [],
        estimatePomodoros: input.estimatePomodoros,
        donePomodoros: input.donePomodoros || 0,
        spentSec: input.spentSec || 0,
        recur: input.recur,
        order: input.order !== undefined ? input.order : nextOrder(cached.tasks),
        createdAt: now,
        updatedAt: now,
    };
    return mutate(() => {
        cached.tasks.push(task);
        return task;
    }, {kind: "task", id: task.id});
}

export function updateTask(p: IPlannerPlugin, id: string, patch: Partial<Task>): void {
    mutate(() => {
        const t = cached.tasks.find(x => x.id === id);
        if (!t) return;
        Object.assign(t, patch, {updatedAt: Date.now()});
    }, {kind: "task", id});
}

export function deleteTask(p: IPlannerPlugin, id: string): void {
    mutate(() => {
        cached.tasks = cached.tasks.filter(t => t.id !== id);
    }, {kind: "task", id});
}

export function setTaskStatus(p: IPlannerPlugin, id: string, status: TaskStatus): void {
    mutate(() => {
        const t = cached.tasks.find(x => x.id === id);
        if (!t) return;
        t.status = status;
        t.doneAt = status === "done" ? Date.now() : undefined;
        t.updatedAt = Date.now();
    }, {kind: "task", id});
}

/**
 * 勾选完成/取消完成。完成时:
 *  - 全部子任务一并勾上(子任务只是拆分步骤,主项完成代表全部完成);
 *  - 有重复规则则按规则生成下一次 occurrence(原任务转为已完成,新的一条待办)。
 */
export function completeTask(p: IPlannerPlugin, id: string, done: boolean): Task | undefined {
    const source = getTask(id);
    if (!source) return undefined;
    mutate(() => {
        const t = cached.tasks.find(x => x.id === id);
        if (!t) return;
        t.status = done ? "done" : "todo";
        t.doneAt = done ? Date.now() : undefined;
        t.updatedAt = Date.now();
        if (done) {
            for (const s of t.subtasks) s.done = true;
        }
    }, {kind: "task", id});
    if (done && source.recur) spawnNextOccurrence(p, source);
    return getTask(id);
}

/** 按重复规则生成下一次 occurrence */
function spawnNextOccurrence(p: IPlannerPlugin, src: Task): void {
    if (!src.recur || !src.due) return;
    const stepFn = src.recur.unit === "day" ? addDays
        : src.recur.unit === "week" ? (k: string, n: number) => addDays(k, n * 7)
            : (k: string, n: number) => addMonthsSafe(k, n);
    // from=due :按原截止日顺延(原任务逾期也不会让后续全部跟着漂移)
    // from=done:按实际完成日
    const base = src.recur.from === "done" ? todayKey() : src.due;
    addTask(p, {
        ...src,
        id: undefined as any,
        status: "todo",
        doneAt: undefined,
        due: stepFn(base, src.recur.every),
        order: src.order,
        spentSec: 0,
        donePomodoros: 0,
        subtasks: (src.subtasks || []).map(s => ({...s, done: false})),
    });
}

function addMonthsSafe(key: string, n: number): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return key;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    const p2 = (x: number) => (x < 10 ? "0" + x : String(x));
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 未完成任务按 order 排序（同一清单内拖拖拽调整） */
export function reorderTask(p: IPlannerPlugin, id: string, toIndex: number, listId?: string): void {
    mutate(() => {
        const scope = listId ? cached.tasks.filter(t => t.listId === listId) : cached.tasks;
        const list = scope.slice().sort((a, b) => a.order - b.order);
        const from = list.findIndex(t => t.id === id);
        if (from < 0) return;
        const target = Math.max(0, Math.min(list.length - 1, toIndex));
        if (from === target) return;
        const [item] = list.splice(from, 1);
        list.splice(target, 0, item);
        list.forEach((t, i) => { t.order = i; });
    }, {kind: "task", id});
}

// —— 子任务 ——

export function addSubtask(p: IPlannerPlugin, taskId: string, title: string): void {
    mutate(() => {
        const t = cached.tasks.find(x => x.id === taskId);
        if (!t) return;
        t.subtasks.push({id: newId("s"), title, done: false});
        t.updatedAt = Date.now();
    }, {kind: "task", id: taskId});
}

export function toggleSubtask(p: IPlannerPlugin, taskId: string, subId: string): void {
    mutate(() => {
        const t = cached.tasks.find(x => x.id === taskId);
        const s = t?.subtasks.find(x => x.id === subId);
        if (s) s.done = !s.done;
    }, {kind: "task", id: taskId});
}

export function updateSubtask(p: IPlannerPlugin, taskId: string, subId: string, patch: Partial<Subtask>): void {
    mutate(() => {
        const s = cached.tasks.find(x => x.id === taskId)?.subtasks.find(x => x.id === subId);
        if (s) Object.assign(s, patch);
    }, {kind: "task", id: taskId});
}

export function deleteSubtask(p: IPlannerPlugin, taskId: string, subId: string): void {
    mutate(() => {
        const t = cached.tasks.find(x => x.id === taskId);
        if (t) t.subtasks = t.subtasks.filter(s => s.id !== subId);
    }, {kind: "task", id: taskId});
}

// —— 清单 ——

export function addTaskList(p: IPlannerPlugin, name: string, color?: string, icon?: string): TaskList {
    const list: TaskList = {
        id: newId("l"),
        name: name || "新清单",
        color: color || "#8a7c6b",
        icon: icon || "📋",
        order: nextOrder(cached.lists),
    };
    return mutate(() => {
        cached.lists.push(list);
        return list;
    }, {kind: "list", id: list.id});
}

export function updateTaskList(p: IPlannerPlugin, id: string, patch: Partial<TaskList>): void {
    mutate(() => {
        const l = cached.lists.find(x => x.id === id);
        if (l && !l.builtin) Object.assign(l, patch);
    }, {kind: "list", id});
}

/** 删除清单:其中的任务迁回 Inbox(不允许悄悄丢数据) */
export function deleteTaskList(p: IPlannerPlugin, id: string): void {
    if (id === INBOX_LIST_ID) return;
    mutate(() => {
        cached.lists = normalizeOrder(cached.lists.filter(l => l.id !== id));
        for (const t of cached.tasks) {
            if (t.listId === id) t.listId = INBOX_LIST_ID;
        }
    }, {kind: "list", id});
}

// ==== 倒数日 ====

export function getCountdowns(): Countdown[] {
    return cached.countdowns.slice();
}

export function addCountdown(p: IPlannerPlugin, input: Partial<Countdown>): Countdown | null {
    if (!input.date) return null;
    const cd: Countdown = {
        id: newId("c"),
        title: input.title || "新倒数日",
        date: input.date,
        time: input.time,
        kind: input.kind || "until",
        repeatYearly: input.repeatYearly || false,
        color: input.color || "#8257c9",
        icon: input.icon || "📅",
        note: input.note || "",
        pinned: input.pinned || false,
        order: nextOrder(cached.countdowns),
    };
    return mutate(() => {
        cached.countdowns.push(cd);
        return cd;
    }, {kind: "countdown", id: cd.id});
}

export function updateCountdown(p: IPlannerPlugin, id: string, patch: Partial<Countdown>): void {
    mutate(() => {
        const c = cached.countdowns.find(x => x.id === id);
        if (c) Object.assign(c, patch);
    }, {kind: "countdown", id});
}

export function deleteCountdown(p: IPlannerPlugin, id: string): void {
    mutate(() => {
        cached.countdowns = normalizeOrder(cached.countdowns.filter(c => c.id !== id));
    }, {kind: "countdown", id});
}

export function reorderCountdown(p: IPlannerPlugin, id: string, toIndex: number): void {
    mutate(() => {
        const list = cached.countdowns.slice().sort((a, b) => a.order - b.order);
        const from = list.findIndex(c => c.id === id);
        if (from < 0) return;
        const target = Math.max(0, Math.min(list.length - 1, toIndex));
        if (from === target) return;
        const [item] = list.splice(from, 1);
        list.splice(target, 0, item);
        cached.countdowns = normalizeOrder(list);
    }, {kind: "countdown", id});
}

// ==== 专注会话 ====

export function addSession(p: IPlannerPlugin, s: FocusSession): void {
    mutate(() => {
        cached.sessions.push(s);
        // 会话只保留最近 2000 条,防止长期积累把 json 撑到几 MB
        if (cached.sessions.length > 2000) {
            cached.sessions = cached.sessions.slice(cached.sessions.length - 2000);
        }
        // 时长回填到关联任务
        if (s.taskId) {
            const t = cached.tasks.find(x => x.id === s.taskId);
            if (t) {
                t.spentSec += s.seconds;
                if (s.mode === "pomodoro" && s.phase === "focus") {
                    t.donePomodoros = (t.donePomodoros || 0) + 1;
                }
            }
        }
        // 关联习惯:一个「专注」番茄完成 → 该习惯当天 +1(达 target 即算打卡完成)。
        // 只在**番茄模式的专注段**累计 —— 休息段和单纯的正计时不算,否则喝水 8 杯
        // 这种计数型习惯会被无关的计时意外打满。
        if (s.habitId && s.mode === "pomodoro" && s.phase === "focus") {
            const map = cached.checkins[s.habitId] || (cached.checkins[s.habitId] = {});
            const prev = map[s.dateKey]?.count || 0;
            map[s.dateKey] = {...(map[s.dateKey] || {count: 0, note: undefined, at: 0}), count: prev + 1, at: Date.now()};
        }
    }, {kind: "session", id: s.id});
}

export function getSessions(): FocusSession[] {
    return cached.sessions.slice();
}

// ==== 设置 ====

export function updatePlannerSettings(p: IPlannerPlugin, patch: Partial<PlannerSettings>): void {
    mutate(() => {
        Object.assign(cached.settings, patch);
    }, {kind: "settings"});
}

// ==== 一键导入示例数据（空面板引导用） ====

export function seedSamples(p: IPlannerPlugin): void {
    const today = todayKey();
    mutate(() => {
        const habit = addHabitInternal("每日运动", "🏃", "#5aa84f", 1, "次");
        addHabitInternal("每天读书", "📖", "#3d8fd1", 1, "分钟");
        addHabitInternal("喝足 8 杯水", "💧", "#2fa89b", 8, "杯");
        const goal = {
            id: newId("g"), title: "年底前读 24 本书", desc: "", color: "#3f8ed0", icon: "🎯",
            targetValue: 24, unit: "本", manualValue: 0, source: "manual" as const,
            due: undefined, status: "active" as const, order: 0, createdAt: Date.now(),
        };
        cached.goals.push(goal);
        const task: Task = {
            id: newId("t"), title: "示例：把这一天的安排过一遍", note: "",
            status: "todo", due: today, priority: 2, listId: INBOX_LIST_ID,
            tags: [], subtasks: [{id: newId("s"), title: "打开「待办」确认今日清单", done: false}],
            spentSec: 0, order: 0, createdAt: Date.now(), updatedAt: Date.now(),
        };
        cached.tasks.push(task);
        // 未来 30 天的一个倒数日,放进 deleted 颜色
        cached.countdowns.push({
            id: newId("c"), title: "示例：项目交付日", date: addDays(today, 30), kind: "until",
            repeatYearly: false, color: "#8257c9", icon: "🎁", note: "", pinned: true, order: 0,
        });
        // 给运动习惯造两周打卡,热力图不至于全灰看不出效果
        for (let i = 0; i < 14; i++) {
            if (i % 3 === 0) continue;
            const k = addDays(today, -i);
            (cached.checkins[habit.id] ||= {})[k] = {count: 1, at: Date.now()};
        }
        cached.checkins[habit.id] ||= {};
    }, {kind: "seed"});
}

function addHabitInternal(name: string, icon: string, color: string, target: number, unit: string): Habit {
    const h: Habit = {
        id: newId("h"), name, icon, color, freq: "daily", days: [], target, unit,
        startDate: todayKey(), archived: false, note: "", order: nextOrder(cached.habits),
        createdAt: Date.now(),
    };
    cached.habits.push(h);
    return h;
}

/** 全量替换(目前仅 Tab 的「清空数据」用) */
export function resetPlanner(p: IPlannerPlugin): void {
    mutate(() => {
        cached = createDefaultData();
    }, {kind: "reset"});
}
