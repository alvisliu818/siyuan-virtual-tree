// 派生计算:全部是纯函数,读 store 的内存快照、算出 UI 要展示的东西。
// 刻意不缓存 —— 数据量级只是几百条,每次重绘算一遍比重算后还要保证缓存失效更简单可靠。
//
// 几个约定:
// - 「完成」= count >= target,而不是 count > 0。计数型习惯(target=8)只做了一半不算完成。
// - streak 只在**该习惯排班生效的日子**上连算,跳过的休息日不断链(周更习惯才不会每周一就清零)。
// - 今天尚未打卡时,streak 从昨天起算 —— 否则每天早上打开面板都会显示"已断链",这是最伤士气的假信号。
import {
    checkinCount,
    getData,
    getHabit,
    getSettings,
    getTasks,
} from "./store";
import {Countdown, DateKey, Goal, Habit, PomodoroPhase, Task} from "./types";
import {
    addDays,
    addYears,
    dateKey,
    diffDays,
    startOfWeek,
    todayKey,
    weekdayOf,
} from "./dates";

// ==== 习惯排班与完成度 ====

/** 该习惯在某天是否排班生效 */
export function isHabitScheduled(habit: Habit, key: DateKey): boolean {
    if (key < habit.startDate) return false;
    if (habit.endDate && key > habit.endDate) return false;
    if (habit.freq === "daily") return true;
    if (!habit.days || habit.days.length === 0) return true;   // 空表按每天处理(避免习惯凭空消失)
    if (habit.freq === "weekly") return habit.days.includes(weekdayOf(key));
    // monthly:1…31;当月不足 31 天时按月末那天生效
    const dayOfMonth = Number(key.slice(8, 10));
    const lastDay = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
    return habit.days.includes(dayOfMonth)
        || (habit.days.some(d => d > lastDay) && dayOfMonth === lastDay);
}

export interface HabitDay {
    count: number;
    target: number;
    ratio: number;    // 0..1,超过目标也钳到 1
    done: boolean;
    scheduled: boolean;
}

export function habitDay(habitId: string, key: DateKey): HabitDay {
    const habit = getHabit(habitId);
    if (!habit) return {count: 0, target: 1, ratio: 0, done: false, scheduled: false};
    const target = Math.max(1, habit.target);
    const count = checkinCount(habitId, key);
    const scheduled = isHabitScheduled(habit, key);
    const ratio = target > 0 ? Math.min(1, count / target) : 0;
    return {count, target, ratio, done: count >= target, scheduled};
}

export function isHabitDoneOn(habitId: string, key: DateKey): boolean {
    const h = getHabit(habitId);
    if (!h || !isHabitScheduled(h, key)) return false;
    return checkinCount(habitId, key) >= Math.max(1, h.target);
}

/**
 * 当前连续完成天数。
 * anchor 之前向回溯:排班日未完成 → 断链;非排班日 → 跳过。
 * 今天尚未完成时从昨天起算(见文件头注释)。
 */
export function habitStreak(habit: Habit, from?: DateKey): number {
    const today = todayKey();
    let cursor = addDays(from || today, -1);
    // 今天/锚点日已经完成 → 从它本身开始算;否则从昨天开始
    if (isHabitDoneOn(habit.id, from || today)) {
        cursor = from || today;
    }
    let streak = 0;
    // 上限 400 天:足够长,又能防止 startDate 缺失时的无限循环
    const guard = 400;
    for (let i = 0; i < guard; i++) {
        if (cursor < habit.startDate) break;
        if (isHabitScheduled(habit, cursor)) {
            if (!isHabitDoneOn(habit.id, cursor)) break;
            streak++;
        }
        cursor = addDays(cursor, -1);
    }
    return streak;
}

/** 历史最佳连续天数(在已有的打卡范围内全量扫一遍) */
export function habitBestStreak(habit: Habit): number {
    const map = getData().checkins[habit.id] || {};
    const keys = Object.keys(map).filter(k => isHabitDoneOn(habit.id, k)).sort();
    if (keys.length === 0) return 0;
    let best = 1;
    let cur = 1;
    for (let i = 1; i < keys.length; i++) {
        let expected = addDays(keys[i - 1], 1);
        let advanced = 1;
        // 相邻两个完成日之间的休息日不计入断链
        while (expected < keys[i] && advanced < 8) {
            if (!isHabitScheduled(habit, expected)) {
                expected = addDays(expected, 1);
                advanced++;
            } else {
                break;
            }
        }
        if (expected === keys[i]) {
            cur++;
            best = Math.max(best, cur);
        } else {
            cur = 1;
        }
    }
    return best;
}

/** 近 N 天的完成率(只统计排班日) */
export function habitCompletionRate(habit: Habit, days: number): number {
    const today = todayKey();
    let scheduled = 0;
    let done = 0;
    for (let i = 0; i < days; i++) {
        const k = addDays(today, -i);
        if (!isHabitScheduled(habit, k)) continue;
        scheduled++;
        if (isHabitDoneOn(habit.id, k)) done++;
    }
    return scheduled === 0 ? 0 : done / scheduled;
}

export interface HeatCell {
    key: DateKey;
    count: number;
    target: number;
    ratio: number;
    done: boolean;
    scheduled: boolean;
    future: boolean;
}

/**
 * 热力图数据:weeks 列 × 7 行,列=周日..周六 或 周一..周日(跟随 weekStart)。
 * 返回按列优先展开的一维数组,UI 直接 grid 排。
 */
export function habitHeatmap(habit: Habit, weeks: number, anchorDay?: DateKey): HeatCell[] {
    const anchor = anchorDay || todayKey();
    const ws = getSettings().weekStart;
    const today = todayKey();
    const endOfWeek = addDays(startOfWeek(anchor, ws), 6);
    // 末列 = 今天所在周;从它往回推 weeks-1 周得到首日
    const start = addDays(addDays(endOfWeek, -6), -7 * (weeks - 1));
    const cells: HeatCell[] = [];
    for (let i = 0; i < weeks * 7; i++) {
        const key = addDays(start, i);
        if (key > anchor) {
            cells.push({key, count: 0, target: habit.target, ratio: 0, done: false, scheduled: false, future: true});
            continue;
        }
        const d = habitDay(habit.id, key);
        cells.push({key, count: d.count, target: d.target, ratio: d.ratio, done: d.done, scheduled: d.scheduled, future: key > today});
    }
    return cells;
}

/** 总打卡次数(所有日期求和) */
export function habitTotalCheckins(habitId: string): number {
    const map = getData().checkins[habitId] || {};
    return Object.values(map).reduce((s, c) => s + (c?.count || 0), 0);
}

// ==== 今日汇总 ====

export interface TodaySummary {
    habitsDone: number;
    habitsTotal: number;
    habitsRatio: number;
    tasksDue: number;
    tasksOverdue: number;
    tasksDoneToday: number;
    focusTodaySec: number;
    pomodorosToday: number;
}

export function todaySummary(): TodaySummary {
    const today = todayKey();
    const habits = getData().habits.filter(h => !h.archived && isHabitScheduled(h, today));
    const habitsDone = habits.filter(h => isHabitDoneOn(h.id, today)).length;
    const tasks = getTasks();
    const open = tasks.filter(t => t.status !== "done");
    const dueToday = open.filter(t => t.due === today).length;
    const overdue = open.filter(t => !!t.due && t.due < today).length;
    const doneToday = tasks.filter(t => t.status === "done" && t.doneAt && dateKey(t.doneAt) === today).length;
    const todays = getData().sessions.filter(s => s.dateKey === today);
    return {
        habitsDone,
        habitsTotal: habits.length,
        habitsRatio: habits.length ? habitsDone / habits.length : 0,
        tasksDue: dueToday,
        tasksOverdue: overdue,
        tasksDoneToday: doneToday,
        focusTodaySec: todays.reduce((s, x) => s + x.seconds, 0),
        pomodorosToday: todays.filter(s => s.mode === "pomodoro" && s.phase === "focus").length,
    };
}

// ==== 目标进度 ====

export interface GoalProgress {
    value: number;
    target: number;
    ratio: number;      // 0..1
    label: string;      // 例如 "3 / 24 本"
    sourceLabel: string;
}

export function goalTasks(goalId: string): Task[] {
    return getTasks().filter(t => t.goalId === goalId);
}

export function goalHabits(goalId: string): Habit[] {
    return getData().habits.filter(h => h.goalId === goalId && !h.archived);
}

/** 某习惯自开始日到今天"应完成"的单位总量(累计目标值) */
function expectedUnits(habit: Habit): number {
    const today = todayKey();
    let total = 0;
    let cursor = habit.startDate;
    // 上限 2000 天,防御异常数据
    for (let i = 0; i < 2000 && cursor <= today; i++) {
        if (isHabitScheduled(habit, cursor)) total += Math.max(1, habit.target);
        cursor = addDays(cursor, 1);
    }
    return Math.max(1, total);
}

export function goalProgress(goal: Goal): GoalProgress {
    if (goal.source === "manual") {
        const ratio = Math.min(1, goal.manualValue / Math.max(1, goal.targetValue));
        return {
            value: goal.manualValue,
            target: goal.targetValue,
            ratio,
            label: `${round1(goal.manualValue)} / ${round1(goal.targetValue)} ${goal.unit}`,
            sourceLabel: "手动",
        };
    }
    if (goal.source === "tasks") {
        const tasks = goalTasks(goal.id);
        const done = tasks.filter(t => t.status === "done").length;
        const ratio = tasks.length ? done / tasks.length : 0;
        return {
            value: done,
            target: tasks.length,
            ratio,
            label: `${done} / ${tasks.length} 项任务`,
            sourceLabel: "关联任务",
        };
    }
    const habits = goal.source === "habits" ? goalHabits(goal.id) : getData().habits.filter(h => !h.archived);
    let value = 0;
    let target = 0;
    for (const h of habits) {
        const map = getData().checkins[h.id] || {};
        const today = todayKey();
        for (const k of Object.keys(map)) {
            if (k < h.startDate || k > today) continue;
            value += map[k]?.count || 0;
        }
        target += expectedUnits(h);
    }
    const ratio = target > 0 ? Math.min(1, value / target) : 0;
    return {
        value,
        target,
        ratio,
        label: `${round1(value)} / ${round1(target)} ${goal.unit || "次"}`,
        sourceLabel: goal.source === "habits" ? "关联习惯" : "全部习惯",
    };
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

// ==== 倒数日 ====

export interface CountdownInfo {
    cd: Countdown;
    /** 换算过 repeatYearly 后的实际生效日期 */
    effective: DateKey;
    /** 相差天数(kind=until 为正=还剩多少天;since 为负差表示还未到) */
    days: number;
    /** 是否已过 */
    passed: boolean;
    sortKey: number;
}

/**
 * 处理 yearly 重复:把年份挪到"最近一次"。
 * 今年的已经过了 → 用明年;(到哪里还没到)用今年。
 */
export function effectiveCountdownDate(cd: Countdown, today?: DateKey): DateKey {
    if (!cd.repeatYearly) return cd.date;
    const anchor = today || todayKey();
    let d = cd.date;
    const thisYear = `${anchor.slice(0, 4)}${cd.date.slice(4)}`;
    // 今年的节点排在今天之后 → 用它;已经过去了 → 顺延到明年。
    // d 本身不再参与计算,保留变量只是为了让读代码的人看到原始日期的样子。
    void d;
    if (thisYear >= anchor) return thisYear;
    return addYears(thisYear, 1);
}

export function countdownInfo(cd: Countdown, today?: DateKey): CountdownInfo {
    const anchor = today || todayKey();
    const effective = effectiveCountdownDate(cd, anchor);
    const days = diffDays(anchor, effective);
    return {cd, effective, days, passed: days < 0, sortKey: Math.abs(days)};
}

/** 全部倒数日,按"离今天多近"升序 */
export function sortedCountdownInfos(today?: DateKey): CountdownInfo[] {
    return getData().countdowns
        .map(cd => countdownInfo(cd, today))
        .sort((a, b) => {
            if (a.cd.pinned !== b.cd.pinned) return a.cd.pinned ? -1 : 1;
            return a.sortKey - b.sortKey;
        });
}

// ==== 统计视图 ====

export interface DayStat {
    key: DateKey;
    habitsDone: number;
    habitsTotal: number;
    tasksDone: number;
    focusSec: number;
}

/** 近 days 天每日统计(图表用) */
export function dailyStats(days: number, today?: DateKey): DayStat[] {
    const anchor = today || todayKey();
    const habits = getData().habits.filter(h => !h.archived);
    const tasks = getTasks().filter(t => t.status === "done" && t.doneAt);
    const sessions = getData().sessions;
    const out: DayStat[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const key = addDays(anchor, -i);
        const scheduled = habits.filter(h => isHabitScheduled(h, key));
        out.push({
            key,
            habitsDone: scheduled.filter(h => isHabitDoneOn(h.id, key)).length,
            habitsTotal: scheduled.length,
            tasksDone: tasks.filter(t => dateKey(t.doneAt!) === key).length,
            focusSec: sessions.filter(s => s.dateKey === key).reduce((s, x) => s + x.seconds, 0),
        });
    }
    return out;
}

/** 周累计专注秒 */
export function weekFocusSec(today?: DateKey): number {
    const anchor = today || todayKey();
    const start = startOfWeek(anchor, getSettings().weekStart);
    return getData().sessions
        .filter(s => s.dateKey >= start && s.dateKey <= anchor)
        .reduce((sum, s) => sum + s.seconds, 0);
}

export function phaseLabel(phase: PomodoroPhase): string {
    return phase === "focus" ? "专注" : phase === "short" ? "短休息" : "长休息";
}

// ==== 任务分组（供任务 / 待办两个视图复用） ====

export interface TaskBucket {
    id: string;
    label: string;
    tasks: Task[];
    /** 分组色调:overdue 红 / today 主题 / week 中性 / later 浅 / none 灰 */
    tone?: "overdue" | "today" | "week" | "later" | "none";
}

/**
 * 四象限式的日期分组:逾期 → 今天 → 未来 7 天 → 更远 → 无日期。
 * 「待办」视图用它不加任何额外筛选,保证两个视图对同一批数据口径一致。
 */
export function bucketTasksByDue(tasks: Task[], today?: DateKey): TaskBucket[] {
    const anchor = today || todayKey();
    const weekEnd = addDays(anchor, 6);
    const buckets: TaskBucket[] = [
        {id: "overdue", label: "已逾期", tasks: [], tone: "overdue"},
        {id: "today", label: "今天", tasks: [], tone: "today"},
        {id: "week", label: "未来 7 天", tasks: [], tone: "week"},
        {id: "later", label: "以后", tasks: [], tone: "later"},
        {id: "none", label: "无日期", tasks: [], tone: "none"},
    ];
    const byId = new Map(buckets.map(b => [b.id, b]));
    for (const t of tasks) {
        if (!t.due) {
            byId.get("none")!.tasks.push(t);
        } else if (t.due < anchor) {
            byId.get("overdue")!.tasks.push(t);
        } else if (t.due === anchor) {
            byId.get("today")!.tasks.push(t);
        } else if (t.due <= weekEnd) {
            byId.get("week")!.tasks.push(t);
        } else {
            byId.get("later")!.tasks.push(t);
        }
    }
    // 组内按优先级降序 → 截止日升序 → order
    for (const b of buckets) {
        b.tasks.sort((a, c) => {
            if (c.priority !== a.priority) return c.priority - a.priority;
            if ((a.due || "") !== (c.due || "")) return (a.due || "9999").localeCompare(c.due || "9999");
            return a.order - c.order;
        });
    }
    return buckets.filter(b => b.tasks.length > 0);
}

/** 展示用的任务进度:子任务展开时的 x/y */
export function taskSubtaskProgress(t: Task): {done: number; total: number} {
    return {
        done: t.subtasks.filter(s => s.done).length,
        total: t.subtasks.length,
    };
}
