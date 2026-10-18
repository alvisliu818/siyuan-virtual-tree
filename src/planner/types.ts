// 「习惯 · 目标 · 打卡 · 计时 · 任务 · 待办 · 倒数日」统一数据模型。
//
// 设计取舍(2026-10-19):
// - 全部存在插件自有的一份 planner.json(data/storage/petal/<插件名>/),不走思源文档。
//   理由:打卡/计时是高频写入,落到文档会带来块 ID 维护、同步冲突、手改文档等一大堆问题,
//   而这些数据本质是"面板私有的运行时数据",不是笔记内容。
// - 任务/待办**共用同一实体** Task:待办只是"清单(Inbox)+ 快速勾选"这个视图。
//   两条 entity 各自演化会导致两边永远同步不全(曾经的项目里踩过同类坑)。
// - 目标是任务的**聚合视角**:source=manual/tasks/habits 决定进度怎么算,
//   任务与习惯反向持有 goalId,两边改动任意一侧进度自动跟着变。

/** 本地日期键 YYYY-MM-DD(一律按本地时区,不用 toISOString —— 那会落到 UTC 上错位一天) */
export type DateKey = string;

/** 习惯重复频率 */
export type HabitFreq = "daily" | "weekly" | "monthly";

export interface Habit {
    id: string;
    name: string;
    /** emoji 或单字,不用 SVG(侧栏小空间里 emoji 渲染成本最低) */
    icon: string;
    /** 主题十六进制色,用于进度环与热力图 */
    color: string;
    freq: HabitFreq;
    /**
     * 生效的日子,freq 决定其含义:
     *  - daily  :忽略(每天都生效)
     *  - weekly :0=周日 … 6=周六
     *  - monthly:1…31(遇到当月不足 31 天时按最后一天)
     */
    days: number[];
    /** 每日目标次数(喝水 8 杯 = 8),>=1 */
    target: number;
    /** 单位:次/杯/页/分钟 */
    unit: string;
    startDate: DateKey;
    /** 可选:挑战型习惯的结束日,过期后自动归档展示 */
    endDate?: DateKey;
    archived: boolean;
    note: string;
    /** 关联目标(打卡会推进该目标的 habits 型进度) */
    goalId?: string;
    order: number;
    createdAt: number;
}

/** 某习惯在某一天的打卡聚合(count 支持一天内多次累加) */
export interface Checkin {
    count: number;
    note?: string;
    /** 最后一次更新时间戳 */
    at: number;
}

export type GoalSource = "manual" | "tasks" | "habits" | "checkins";

export type GoalStatus = "active" | "done" | "archived";

export interface Goal {
    id: string;
    title: string;
    desc: string;
    color: string;
    icon: string;
    /** 量化目标值(source=manual 时的分母) */
    targetValue: number;
    unit: string;
    /** source=manual 时手动推进的当前值 */
    manualValue: number;
    /** 进度来源 */
    source: GoalSource;
    /** 目标日(仅用于展示倒数,不参与进度计算) */
    due?: DateKey;
    status: GoalStatus;
    order: number;
    createdAt: number;
}

export type TaskStatus = "todo" | "doing" | "done";

/** 0=无 1=低 2=中 3=高 */
export type Priority = 0 | 1 | 2 | 3;

export interface Subtask {
    id: string;
    title: string;
    done: boolean;
}

/** 重复规则:完成任务后生成下一次 */
export interface RecurRule {
    every: number;
    unit: "day" | "week" | "month";
    /** done = 完成后按完成日顺延;due = 按原定截止日顺延(避免逾期任务越滚越后) */
    from: "done" | "due";
}

export interface Task {
    id: string;
    title: string;
    note: string;
    status: TaskStatus;
    doneAt?: number;
    /** 截止日 YYYY-MM-DD */
    due?: DateKey;
    /** 截止时间 HH:MM(可选,搭配 due) */
    dueTime?: string;
    priority: Priority;
    /** 所属清单(Inbox 清单即"待办") */
    listId: string;
    goalId?: string;
    habitId?: string;
    tags: string[];
    subtasks: Subtask[];
    /** 预估番茄数(番茄钟用) */
    estimatePomodoros?: number;
    /** 已完成番茄数 */
    donePomodoros?: number;
    /** 计时累计秒(由计时器回填) */
    spentSec: number;
    recur?: RecurRule;
    order: number;
    createdAt: number;
    updatedAt: number;
}

export interface TaskList {
    id: string;
    name: string;
    color: string;
    icon: string;
    /** 内置 Inbox 清单不可删除 */
    builtin?: boolean;
    order: number;
}

/** until = 距离还有 X 天(倒数);since = 已经过去 X 天(纪念日) */
export type CountdownKind = "until" | "since";

export interface Countdown {
    id: string;
    title: string;
    date: DateKey;
    time?: string;
    kind: CountdownKind;
    /** 每年重复(生日/周年):把年份换成最近一次 */
    repeatYearly: boolean;
    color: string;
    icon: string;
    note: string;
    pinned: boolean;
    order: number;
}

export type TimerMode = "pomodoro" | "stopwatch" | "countdown";
export type PomodoroPhase = "focus" | "short" | "long";

/** 一次完成的专注记录 */
export interface FocusSession {
    id: string;
    mode: TimerMode;
    phase?: PomodoroPhase;
    /** 实际时长(秒) */
    seconds: number;
    taskId?: string;
    habitId?: string;
    startedAt: number;
    endedAt: number;
    dateKey: DateKey;
}

/**
 * 计时器的持久化形态。
 * 关键:**不存 elapsedSec 绝对值而存 runningSince 时间戳** —— 页面刷新/重启后
 * 用它和 now 相减还原已过时长,否则面板一关计时就归零。
 */
export interface PersistedTimer {
    running: boolean;
    mode: TimerMode;
    phase: PomodoroPhase;
    /** 目标秒数(stopwatch 模式下无意义) */
    targetSec: number;
    /** 暂停时已累积的秒数 */
    elapsedSec: number;
    /** 运行中则为启动时刻的时间戳(ms),暂停时为 0 */
    runningSince: number;
    taskId?: string;
    habitId?: string;
    /** 本次专注已经过的番茄数(用于决定何时进长休) */
    round: number;
}

export interface PomodoroConfig {
    focus: number;
    short: number;
    long: number;
    /** 每 N 个番茄后进长休 */
    longEvery: number;
    autoStartBreak: boolean;
    autoStartNext: boolean;
}

export interface PlannerSettings {
    pomodoro: PomodoroConfig;
    /** 倒计时模式的默认分钟数 */
    defaultCountdownMin: number;
    /** 结束是否提示 */
    notify: boolean;
    /** 结束是否响铃(WebAudio 合成音,不带资源文件) */
    sound: boolean;
    /** 一周的第一天:0=周日 1=周一 */
    weekStart: 0 | 1;
    /** 习惯热力图的周数 */
    heatmapWeeks: number;
}

export interface PlannerData {
    version: number;
    habits: Habit[];
    /** habitId -> dateKey -> Checkin */
    checkins: Record<string, Record<string, Checkin>>;
    goals: Goal[];
    tasks: Task[];
    lists: TaskList[];
    countdowns: Countdown[];
    sessions: FocusSession[];
    timer: PersistedTimer;
    settings: PlannerSettings;
}

export const PLANNER_VERSION = 1;

export const DEFAULT_POMODORO: PomodoroConfig = {
    focus: 25,
    short: 5,
    long: 15,
    longEvery: 4,
    autoStartBreak: true,
    autoStartNext: false,
};

export const DEFAULT_SETTINGS: PlannerSettings = {
    pomodoro: {...DEFAULT_POMODORO},
    defaultCountdownMin: 25,
    notify: true,
    sound: true,
    weekStart: 1,
    heatmapWeeks: 15,
};

/** 内置 Inbox 清单 = 界面上的「待办」 */
export const INBOX_LIST_ID = "inbox";

export function createDefaultData(): PlannerData {
    return {
        version: PLANNER_VERSION,
        habits: [],
        checkins: {},
        goals: [],
        tasks: [],
        lists: [{id: INBOX_LIST_ID, name: "待办", color: "#4c8bff", icon: "📥", builtin: true, order: 0}],
        countdowns: [],
        sessions: [],
        timer: {
            running: false,
            mode: "pomodoro",
            phase: "focus",
            targetSec: DEFAULT_POMODORO.focus * 60,
            elapsedSec: 0,
            runningSince: 0,
            round: 0,
        },
        settings: {...DEFAULT_SETTINGS, pomodoro: {...DEFAULT_POMODORO}},
    };
}

// 习惯预设色板(侧栏空间小,统一偏中饱和,暗/亮主题都不会糊)
export const HABIT_COLORS = [
    "#e0574a", "#e8853c", "#d9a027", "#5aa84f", "#2fa89b",
    "#3d8fd1", "#4c6fdc", "#8257c9", "#c2569b", "#8a7c6b",
];

export const GOAL_COLORS = [
    "#e0574a", "#dd7a2f", "#c99a1f", "#57a34c", "#2ba597",
    "#3f8ed0", "#4b6fd6", "#7f56c6", "#bd5498", "#7d7360",
];

export function newId(prefix: string): string {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
