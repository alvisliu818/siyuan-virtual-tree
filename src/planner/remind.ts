// 任务/习惯提醒调度:到点发系统通知(Electron 渲染进程的 Web Notification API)。
//
// 触发规则:
//  - 任务:设了 due 只在截止当天到点提醒;没设 due 则每天到点提醒,直到完成/删除。
//    完成的任务不提醒(openTasks)。
//  - 习惯:当天被排程(isHabitScheduled)且当天计数未达标时,到点提醒。
// 去重:每个 remindKey(实体+日期)一天只发一次,状态记在 planner.json 的 notified
// 段 —— 重启后也不会对同一天的同一实体重发。
import {getCheckin, getHabits, getSettings, markNotified, openTasks} from "./store";
import {isHabitScheduled} from "./stats";
import {todayKey} from "./dates";
import {openPlannerTab} from "./tab";

/** 轮询间隔:分钟级提醒精度下 30s 足够,且几乎无开销 */
const CHECK_INTERVAL = 30 * 1000;

let tickerId: ReturnType<typeof setInterval> | null = null;
let hostRef: any = null;

export function initReminders(host: any): void {
    hostRef = host;
    if (!tickerId) {
        tickerId = setInterval(tick, CHECK_INTERVAL);
    }
}

export function disposeReminders(): void {
    if (tickerId) {
        clearInterval(tickerId);
        tickerId = null;
    }
}

function nowHM(): string {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function tick(): void {
    try {
        if (!getSettings().remindersEnabled) return;
        const day = todayKey();
        const hm = nowHM();
        for (const t of openTasks()) {
            if (!t.remindAt || hm < t.remindAt) continue;
            // 设了截止日 → 只在截止当天提醒;没设 → 每天提醒直到完成
            if (t.due && t.due !== day) continue;
            fireOnce(`task:${t.id}:${t.due ?? day}`, "任务提醒", `⏰ ${t.title}${t.due ? "(今天截止)" : ""}`);
        }
        for (const h of getHabits()) {
            if (h.archived || !h.remindAt || hm < h.remindAt) continue;
            if (!isHabitScheduled(h, day)) continue;
            if ((getCheckin(h.id, day)?.count ?? 0) >= h.target) continue;
            fireOnce(`habit:${h.id}:${day}`, "习惯提醒", `${h.icon || "⭐"} ${h.name} 今天还没完成`);
        }
    } catch {
        // 提醒失败不影响主流程
    }
}

/** 同一天同一键只发一次;点击通知打开习惯与目标面板 */
function fireOnce(key: string, title: string, body: string): void {
    const day = todayKey();
    const settings = getSettings();
    if (!settings.remindersEnabled) return;
    markNotified(key, day);
    systemNotify(title, body, settings.sound);
}

/**
 * 发系统通知(桌面端由 Electron 接管,Windows 走系统托盘通知)。
 * 环境不支持(老内核/无通知权限)时静默放弃 —— 调用方通常已另有 showMessage。
 */
export function systemNotify(title: string, body: string, sound = true): void {
    try {
        if (typeof Notification === "undefined") return;
        const n = new Notification(title, {body, silent: !sound});
        n.onclick = () => {
            try {
                window.focus();
            } catch {
                // ignore
            }
            if (hostRef) openPlannerTab(hostRef);
        };
    } catch {
        // ignore
    }
}
