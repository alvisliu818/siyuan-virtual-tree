// 本地日期工具。全部围绕 dateKey(YYYY-MM-DD)操作。
//
// 铁律:**任何地方都不要用 toISOString().slice(0,10)** —— 那是 UTC 日期,
// 东八区在 08:00 之前会算成前一天,打卡直接串位。一律走本文件。
import type {DateKey} from "./types";

function pad2(n: number): string {
    return n < 10 ? "0" + n : String(n);
}

/** Date / 时间戳 → YYYY-MM-DD */
export function dateKey(d: Date | number = new Date()): DateKey {
    const dt = typeof d === "number" ? new Date(d) : d;
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** YYYY-MM-DD → 本地零点的 Date(非法串返回今天) */
export function parseKey(key: DateKey): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    if (m) {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

export function isValidKey(key: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return false;
    const d = parseKey(key);
    return dateKey(d) === key;
}

export function todayKey(): DateKey {
    return dateKey(new Date());
}

/** 在日期键上加减天数(经由本地 Date.setDate,DST 由引擎处理) */
export function addDays(key: DateKey, n: number): DateKey {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
}

export function addMonths(key: DateKey, n: number): DateKey {
    const d = parseKey(key);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    // 目标月不足当前天数时钳到最后一天(1/31 + 1 月 = 2/28,不是 3/3)
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return dateKey(d);
}

/**
 * 加减年份。
 * 不能直接用 setFullYear —— 2024-02-29 + 1 年时它会**溢出**成 2025-03-01(JS Date 的既定行为),
 * 而用户的预期是钳到 2025-02-28。显式算目标年月并把日钳到当月最后一天。
 */
export function addYears(key: DateKey, n: number): DateKey {
    const d = parseKey(key);
    const y = d.getFullYear() + n;
    const day = d.getDate();
    const last = new Date(y, d.getMonth() + 1, 0).getDate();
    return dateKey(new Date(y, d.getMonth(), Math.min(day, last)));
}

/** b - a,单位天(正数表示 b 在 a 之后) */
export function diffDays(a: DateKey, b: DateKey): number {
    const ta = parseKey(a).getTime();
    const tb = parseKey(b).getTime();
    return Math.round((tb - ta) / 86400000);
}

/** 0=周日 … 6=周六 */
export function weekdayOf(key: DateKey): number {
    return parseKey(key).getDay();
}

/** 按 weekStart 求所在周的起始日 */
export function startOfWeek(key: DateKey, weekStart: 0 | 1): DateKey {
    const wd = weekdayOf(key);
    // 距周起点的偏移(weekStart=1 时周日算第 7 天)
    const offset = (wd - weekStart + 7) % 7;
    return addDays(key, -offset);
}

export function monthStart(key: DateKey): DateKey {
    return key.slice(0, 8) + "01";
}

export function monthEnd(key: DateKey): DateKey {
    const d = parseKey(key);
    return dateKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function yearMonthOf(key: DateKey): string {
    return key.slice(0, 7);
}

export function isToday(key: DateKey): boolean {
    return key === todayKey();
}

export function isFuture(key: DateKey): boolean {
    return key > todayKey();
}

/** 已过期且不是今天(任务逾期判定) */
export function isOverdue(key?: DateKey): boolean {
    return !!key && key < todayKey();
}

export function nowTime(): string {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayCN(key: DateKey): string {
    return WEEK_CN[weekdayOf(key)];
}

/** 10月19日 */
export function formatCN(key: DateKey): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    if (!m) return key || "";
    return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 2026年10月19日 */
export function formatCNFull(key: DateKey): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    if (!m) return key || "";
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/** 「今天 / 明天 / 昨天 / 周三 / 10月19日」——任务与倒数日的相对日展示 */
export function relativeLabel(key: DateKey): string {
    const today = todayKey();
    const diff = diffDays(today, key);
    if (diff === 0) return "今天";
    if (diff === 1) return "明天";
    if (diff === 2) return "后天";
    if (diff === -1) return "昨天";
    if (diff > 2 && diff < 7) return weekdayCN(key);
    if (Math.abs(diff) < 120) return formatCN(key);
    return formatCNFull(key);
}

/** 相对天数的紧凑标注(逾期显示红色时由调用方处理) */
export function daysLabel(key: DateKey): string {
    const diff = diffDays(todayKey(), key);
    if (diff === 0) return "今天";
    if (diff > 0) return `${diff} 天后`;
    return `${-diff} 天前`;
}

/** 秒 → mm:ss 或 h:mm:ss */
export function formatDuration(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(ss)}`;
    return `${pad2(m)}:${pad2(ss)}`;
}

/** 秒 → 人类可读时长(2 小时 15 分 / 45 分钟 / 30 秒) */
export function formatHumanDuration(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** 分钟数 → "25 分钟" / "1 小时 30 分" */
export function formatMinutes(min: number): string {
    return formatHumanDuration(min * 60);
}
