// Tab / Dock 各视图共享的上下文。
// 只塞两样东西:插件(落盘用)与目标容器。其余状态一律从 store 现读 —— 不在这里复制数据快照,
// 免得视图之间出现"这边改了那边没改"的陈旧状态。
import {IPlannerPlugin} from "./store";

export interface ViewCtx {
    plugin: IPlannerPlugin;
    container: HTMLElement;
}

/** 「今日 / 习惯 / 目标 / 任务 / 待办 / 计时 / 倒数日 / 统计」八个分区 */
export type ViewId = "today" | "habits" | "goals" | "tasks" | "todo" | "timer" | "countdowns" | "stats";

export interface ViewDef {
    id: ViewId;
    label: string;
    icon: string;
}
