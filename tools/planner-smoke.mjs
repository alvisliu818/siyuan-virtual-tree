// planner 日期/统计纯函数的冒烟验证。
// 用 esbuild 把 TS bundle 成 CJS 后在 node 里跑断言 —— 不依赖任何浏览器 API,
// 所以 store/timer 那些要 window 的模块不参与,只测 dates 与依赖它的纯计算。
import {execFileSync} from "child_process";
import {writeFileSync, mkdtempSync} from "fs";
import {join} from "path";
import {tmpdir} from "os";

const root = process.cwd();
const entry = join(tmpdir(), "pl-smoke-" + Date.now() + ".ts");

writeFileSync(entry, `
import * as D from "${root.replace(/\\/g, "/")}/src/planner/dates";
import * as S from "${root.replace(/\\/g, "/")}/src/planner/stats";
(globalThis as any).__D = D;
(globalThis as any).__S = S;
`);

const outfile = entry.replace(/\.ts$/, ".js");
const esbuildBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
execFileSync(esbuildBin, [
    entry, "--bundle", "--platform=node", "--format=cjs", "--outfile=" + outfile,
], {stdio: "pipe", shell: process.platform === "win32"});

const {createRequire} = await import("module");
createRequire(import.meta.url)(outfile);
const D = globalThis.__D;
const S = globalThis.__S;

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        pass++;
    } else {
        fail++;
        console.log(`  ✗ ${label}\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`);
    }
}

console.log("— dates —");
const today = D.todayKey();
eq("todayKey 格式", /^\d{4}-\d{2}-\d{2}$/.test(today), true);
// 本地时区:必须是本地日期,不能是 UTC(东八区早上 8 点前会差一天)
const now = new Date();
const localManual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
eq("todayKey 按本地时区", D.todayKey(), localManual);
eq("addDays +1", D.addDays("2026-01-31", 1), "2026-02-01");
eq("addDays 跨年 -1", D.addDays("2026-01-01", -1), "2025-12-31");
eq("addDays 闰年 2/28+1", D.addDays("2024-02-28", 1), "2024-02-29");
eq("addDays 平年 2/28+1", D.addDays("2026-02-28", 1), "2026-03-01");
eq("diffDays 同日", D.diffDays("2026-03-01", "2026-03-01"), 0);
eq("diffDays 正", D.diffDays("2026-03-01", "2026-03-08"), 7);
eq("diffDays 负", D.diffDays("2026-03-08", "2026-03-01"), -7);
eq("weekdayOf 2026-10-19(周一)", D.weekdayOf("2026-10-19"), 1);
eq("startOfWeek 周一开头", D.startOfWeek("2026-10-19", 1), "2026-10-19");
eq("startOfWeek 周日开头(2026-10-18 是周日)", D.startOfWeek("2026-10-18", 0), "2026-10-18");
eq("startOfWeek 周一开头 → 上周一", D.startOfWeek("2026-10-18", 1), "2026-10-12");
eq("addMonths 1/31 + 1 → 2/28", D.addMonths("2026-01-31", 1), "2026-02-28");
eq("addMonths 跨年", D.addMonths("2026-12-15", 1), "2027-01-15");
eq("addYears 闰日 → 平年 2/28", D.addYears("2024-02-29", 1), "2025-02-28");
eq("monthEnd 2 月", D.monthEnd("2024-02-10"), "2024-02-29");
eq("isValidKey 拒绝非法", D.isValidKey("2026-02-30"), false);
eq("isValidKey 接受合法", D.isValidKey("2026-02-28"), true);
eq("isOverdue 昨天", D.isOverdue(D.addDays(today, -1)), true);
eq("isOverdue 今天不算", D.isOverdue(today), false);
eq("formatDuration 一分半", D.formatDuration(90), "01:30");
eq("formatDuration 一小时", D.formatDuration(3661), "1:01:01");
eq("formatHumanDuration 45 分", D.formatHumanDuration(45 * 60), "45 分钟");
eq("relativeLabel 今天", D.relativeLabel(today), "今天");
eq("relativeLabel 明天", D.relativeLabel(D.addDays(today, 1)), "明天");
eq("daysLabel 3 天后", D.daysLabel(D.addDays(today, 3)), "3 天后");

console.log("— countdown 年度重复 —");
// 今年的节点已过 → 顺延明年;今年还没到 → 用今年
const past = {id: "c", title: "x", date: "1990-06-01", kind: "until", repeatYearly: true, color: "", icon: "", note: "", pinned: false, order: 0};
eq("yearly:已过 → 明年", S.effectiveCountdownDate(past, "2026-10-19"), "2027-06-01");
const future = {...past, date: "1995-12-25"};
eq("yearly:未到 → 今年", S.effectiveCountdownDate(future, "2026-10-19"), "2026-12-25");
const noRepeat = {...past, repeatYearly: false};
eq("非 yearly 原样返回", S.effectiveCountdownDate(noRepeat, "2026-10-19"), "1990-06-01");

console.log("— 习惯排班 —");
const daily = {id: "h", name: "", icon: "", color: "", freq: "daily", days: [], target: 1, unit: "", startDate: "2026-01-01", archived: false, note: "", order: 0, createdAt: 0};
eq("daily 每天都生效", S.isHabitScheduled(daily, "2026-10-19"), true);
const weekly135 = {...daily, freq: "weekly", days: [1, 3, 5]};
eq("weekly 周一生效", S.isHabitScheduled(weekly135, "2026-10-19"), true);
eq("weekly 周二不生效", S.isHabitScheduled(weekly135, "2026-10-20"), false);
const monthly31 = {...daily, freq: "monthly", days: [31]};
eq("monthly 31 号在 10 月落到月末", S.isHabitScheduled(monthly31, "2026-10-31"), true);
eq("monthly 2 月落到 2/28", S.isHabitScheduled(monthly31, "2026-02-28"), true);
eq("monthly 非月末不算", S.isHabitScheduled(monthly31, "2026-10-30"), false);
eq("startDate 之前不生效", S.isHabitScheduled({...daily, startDate: "2027-01-01"}, "2026-10-19"), false);

console.log("— 任务分组 —");
const mkTask = (id, due) => ({id, title: id, note: "", status: "todo", due, priority: 0, listId: "inbox", tags: [], subtasks: [], spentSec: 0, order: 0, createdAt: 0, updatedAt: 0});
const buckets = S.bucketTasksByDue([
    mkTask("a", "2026-10-01"),   // 已过期
    mkTask("b", "2026-10-19"),   // 今天
    mkTask("c", "2026-10-22"),   // 未来 7 天内
    mkTask("d", "2027-01-01"),   // 更远
    mkTask("e"),                 // 无日期
], "2026-10-19");
eq("逾期项归入 overdue", buckets.find((b) => b.id === "overdue")?.tasks.map((t) => t.id), ["a"]);
eq("今天项归入 today", buckets.find((b) => b.id === "today")?.tasks.map((t) => t.id), ["b"]);
eq("7 天内归入 week", buckets.find((b) => b.id === "week")?.tasks.map((t) => t.id), ["c"]);
eq("更远归入 later", buckets.find((b) => b.id === "later")?.tasks.map((t) => t.id), ["d"]);
eq("无日期归入 none", buckets.find((b) => b.id === "none")?.tasks.map((t) => t.id), ["e"]);

console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) process.exit(1);
