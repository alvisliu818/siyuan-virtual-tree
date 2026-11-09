// 思源块 ↔ 习惯与目标项目绑定:数据层。
//
// 绑定存块属性 custom-planner,值 = 逗号分隔的 type:id(一个块可绑多个项目)。
// 属性名符合内核限制(小写字母/数字/连字符);全库绑定用一条 SQL 批量读,
// 避免对文档里每个块都发一次 getBlockAttrs。
import {getBlockAttrs, querySQL, setBlockAttrs} from "../api/file";
import {
    getCountdowns, getGoal, getGoals, getHabit, getHabits, getTask, getTasks,
    openTasks, setCheckin, setTaskStatus,
} from "../planner/store";
import {countdownInfo, goalProgress, habitDay, isHabitDoneOn} from "../planner/stats";
import {todayKey} from "../planner/dates";
import {ViewId} from "../planner/context";

export const BIND_ATTR = "custom-planner";
export type BindType = "habit" | "goal" | "task" | "countdown";
export const BIND_TYPES: BindType[] = ["habit", "goal", "task", "countdown"];
export const BIND_LABELS: Record<BindType, string> = {
    habit: "习惯", goal: "目标", task: "任务", countdown: "倒数日",
};
export const BIND_VIEWS: Record<BindType, ViewId> = {
    habit: "habits", goal: "goals", task: "tasks", countdown: "countdowns",
};

export interface Binding {
    type: BindType;
    id: string;
}

export interface BindInfo extends Binding {
    name: string;
    icon: string;
    state: string;
    done: boolean;      // 是否处于「完成」态(task/habit 才有意义)
    missing: boolean;   // 项目已被删除/归档
}

export function parseBindings(value: string): Binding[] {
    const out: Binding[] = [];
    const seen = new Set<string>();
    for (const raw of String(value || "").split(/[,，\s]+/)) {
        const seg = raw.trim();
        if (!seg) continue;
        const colon = seg.indexOf(":");
        if (colon < 1) continue;
        const type = seg.slice(0, colon) as BindType;
        const id = seg.slice(colon + 1);
        if (!BIND_TYPES.includes(type) || !id) continue;
        const key = `${type}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({type, id});
    }
    return out;
}

export function serializeBindings(list: Binding[]): string {
    return list.map(b => `${b.type}:${b.id}`).join(",");
}

export async function loadBindings(blockId: string): Promise<Binding[]> {
    const attrs = await getBlockAttrs(blockId) || {};
    return parseBindings(String(attrs[BIND_ATTR] || ""));
}

export async function saveBindings(blockId: string, list: Binding[]): Promise<void> {
    // 空列表传 null → 内核移除该属性(kernel/api/attr.go:75)
    await setBlockAttrs(blockId, {
        [BIND_ATTR]: list.length ? serializeBindings(list) : null as any,
    });
}

/** 一条 SQL 拿全库所有绑定块;切换文档/初始化时调用。 */
export async function loadAllBindings(): Promise<Map<string, Binding[]>> {
    const map = new Map<string, Binding[]>();
    try {
        const rows = await querySQL(
            `SELECT block_id, value FROM attributes WHERE name = '${BIND_ATTR}' AND value <> '' LIMIT 2000`);
        for (const r of (rows || [])) {
            const id = String(r?.block_id || "");
            if (!id) continue;
            const list = parseBindings(String(r?.value || ""));
            if (list.length) map.set(id, list);
        }
    } catch {
        // SQL 失败时退化为逐块读取(菜单绑定路径仍可用)
    }
    return map;
}

/** 项目当前展示信息(名称/图标/状态),用于选择器与块旁徽标。 */
export function describe(list: Binding[]): BindInfo[] {
    const today = todayKey();
    return list.map(b => {
        const base = {type: b.type, id: b.id, name: "", icon: "", state: "", done: false, missing: true};
        if (b.type === "habit") {
            const h = getHabit(b.id);
            if (!h) return {...base, name: "已删除的习惯"};
            const d = habitDay(h.id, today);
            return {...base, name: h.name, icon: h.icon || "⭐", state: `${d.count}/${d.target}`,
                done: d.done, missing: !!h.archived};
        }
        if (b.type === "goal") {
            const g = getGoal(b.id);
            if (!g) return {...base, name: "已删除的目标"};
            return {...base, name: g.title, icon: g.icon || "🎯",
                state: `${Math.round(goalProgress(g).ratio * 100)}%`,
                done: g.status === "done", missing: g.status === "archived"};
        }
        if (b.type === "task") {
            const t = getTask(b.id);
            if (!t) return {...base, name: "已删除的任务"};
            const label = t.status === "done" ? "已完成" : t.status === "doing" ? "进行中" : "待办";
            return {...base, name: t.title, icon: "☑", state: label,
                done: t.status === "done", missing: false};
        }
        const c = getCountdowns().find(x => x.id === b.id);
        if (!c) return {...base, name: "已删除的倒数日"};
        const info = countdownInfo(c, today);
        return {...base, name: c.title, icon: c.icon || "⏳",
            state: `${Math.abs(info.days)} 天`, done: false, missing: false};
    });
}

/** 选择器候选:活跃习惯 / 非归档目标 / 未完成任务 / 全部倒数日。 */
export function allCandidates(): BindInfo[] {
    const list: Binding[] = [];
    for (const h of getHabits(false)) list.push({type: "habit", id: h.id});
    for (const g of getGoals("active")) list.push({type: "goal", id: g.id});
    for (const t of openTasks()) list.push({type: "task", id: t.id});
    for (const c of getCountdowns()) list.push({type: "countdown", id: c.id});
    void getTasks;
    return describe(list);
}

/** 完成态读取:任务 status / 习惯今日是否打卡;目标与倒数日不参与勾选同步。 */
export function isItemDone(b: Binding): boolean {
    if (b.type === "task") return getTask(b.id)?.status === "done";
    if (b.type === "habit") return isHabitDoneOn(b.id, todayKey());
    return false;
}

/** 完成态写入:任务 setTaskStatus / 习惯 setCheckin(目标次数)。 */
export function setItemDone(plugin: any, b: Binding, done: boolean): void {
    if (b.type === "task") {
        if (getTask(b.id)) setTaskStatus(plugin, b.id, done ? "done" : "todo");
    } else if (b.type === "habit") {
        const h = getHabit(b.id);
        if (h) setCheckin(plugin, b.id, todayKey(), done ? Math.max(1, h.target) : 0);
    }
}

/** 该块是否有参与勾选同步的绑定(只有任务块需要) */
export function syncableBindings(list: Binding[]): Binding[] {
    return list.filter(b => b.type === "task" || b.type === "habit");
}
