// 「计时」视图:番茄钟 / 正计时 / 倒计时三种模式的控制台。
//
// 刷新策略是这个视图唯一 tricky 的地方:tick 每 500ms 一次,如果每次都整屏重建 innerHTML,
// 「倒计时分钟数」输入框会在打字途中被掀掉。所以拆成两步 —— render 全量画骨架,
// patch 只改时间数字与环的 dasharray,DOM 节点不重建。
import {ViewCtx} from "../context";
import {
    bindTimerTarget,
    pauseTimer,
    phaseLabel,
    resetTimer,
    setCountdownMinutes,
    setTimerMode,
    skipPhase,
    startTimer,
    stopAndRecord,
    timerSnapshot,
} from "../timer";
import {getHabits, getSettings, getTasks, getTask, getData} from "../store";
import {formatDuration, todayKey} from "../dates";
import {escapeHTML, ringHTML} from "../ui-common";
import {TimerMode} from "../types";

export function renderTimerView(ctx: ViewCtx): void {
    const {container} = ctx;
    const snap = timerSnapshot();
    const cfg = getSettings();

    container.innerHTML = `
        <div class="syfe-pl__timerwrap">
            <div class="syfe-pl__seg syfe-pl__modeseg">
                ${(["pomodoro", "stopwatch", "countdown"] as TimerMode[]).map(m =>
        `<span class="syfe-pl__segitem${snap.mode === m ? " is-active" : ""}" data-mode="${m}">${modeLabel(m)}</span>`).join("")}
            </div>

            <div class="syfe-pl__timerphase" data-role="phase"></div>
            <div class="syfe-pl__timerclock" data-role="clock"></div>
            <div class="syfe-pl__timerring" data-role="ring"></div>
            <div class="syfe-pl__timersub" data-role="sub"></div>

            <div class="syfe-pl__timerctrl">
                <button class="b3-button b3-button--text" data-act="toggle" data-role="toggle"></button>
                <button class="b3-button b3-button--outline" data-act="reset">重置</button>
                <button class="b3-button b3-button--outline" data-act="stop">结束并记录</button>
                <button class="b3-button b3-button--outline" data-act="skip">跳过本段</button>
            </div>

            <div class="syfe-pl__formrow" data-role="cdrow">
                <div class="syfe-pl__formlabel">时长</div>
                <div class="syfe-pl__formctrl syfe-pl__inline">
                    <input type="number" class="b3-text-field" data-role="cdmin" min="1" max="600"
                        value="${cfg.defaultCountdownMin}" style="width:96px">
                    <span class="syfe-pl__formhint syfe-pl__inlinehint">分钟</span>
                </div>
            </div>

            <div class="syfe-pl__formrow">
                <div class="syfe-pl__formlabel">计入习惯</div>
                <div class="syfe-pl__formctrl">
                    <select class="b3-select fn__block" data-role="habit">
                        <option value="">（不计入）</option>
                        ${getHabits(false).map(h => `<option value="${escapeHTML(h.id)}"${snap.habitId === h.id ? " selected" : ""}>${escapeHTML(h.icon)} ${escapeHTML(h.name)}</option>`).join("")}
                    </select>
                </div>
            </div>
            <div class="syfe-pl__formrow">
                <div class="syfe-pl__formlabel">计入任务</div>
                <div class="syfe-pl__formctrl">
                    <select class="b3-select fn__block" data-role="task">
                        <option value="">（不计入）</option>
                        ${getTasks().filter(t => t.status !== "done").map(t =>
        `<option value="${escapeHTML(t.id)}"${snap.taskId === t.id ? " selected" : ""}>${escapeHTML(t.title)}</option>`).join("")}
                    </select>
                </div>
            </div>

            <div class="syfe-pl__timertip">
                番茄专注 ${cfg.pomodoro.focus} 分钟 · 短休 ${cfg.pomodoro.short} · 长休 ${cfg.pomodoro.long}(每 ${cfg.pomodoro.longEvery} 轮)
            </div>

            <div class="syfe-pl__todaylog" data-role="log"></div>
        </div>`;

    // —— 事件绑定(只绑一次,不随 tick 重建) ——
    container.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const mode = target.dataset.mode;
        if (mode) {
            setTimerMode(mode as TimerMode);
            renderTimerView(ctx);
            return;
        }
        const act = target.dataset.act;
        if (!act) return;
        if (act === "toggle") {
            if (timerSnapshot().running) pauseTimer();
            else startTimer();
            patchTimerView(container);
        } else if (act === "reset") {
            resetTimer();
            patchTimerView(container);
        } else if (act === "stop") {
            stopAndRecord();
            renderTimerView(ctx);
        } else if (act === "skip") {
            skipPhase();
            renderTimerView(ctx);
        }
    });
    container.querySelector("[data-role='cdmin']")?.addEventListener("change", (ev) => {
        const min = Number((ev.target as HTMLInputElement).value) || 1;
        setCountdownMinutes(min);
        patchTimerView(container);
    });
    const rebind = () => {
        const habitSel = container.querySelector("[data-role='habit']") as HTMLSelectElement | null;
        const taskSel = container.querySelector("[data-role='task']") as HTMLSelectElement | null;
        bindTimerTarget({habitId: habitSel?.value || undefined, taskId: taskSel?.value || undefined});
        patchTimerView(container);
    };
    container.querySelector("[data-role='habit']")?.addEventListener("change", rebind);
    container.querySelector("[data-role='task']")?.addEventListener("change", rebind);

    patchTimerView(container);
}

function modeLabel(m: TimerMode): string {
    return m === "pomodoro" ? "番茄钟" : m === "stopwatch" ? "正计时" : "倒计时";
}

/** 只更新时间相关的部分:数字、环、按钮文案、今日记录 */
export function patchTimerView(container: HTMLElement): void {
    if (!container.querySelector("[data-role='clock']")) return;
    const snap = timerSnapshot();
    const clockEl = container.querySelector("[data-role='clock']") as HTMLElement;
    const ringEl = container.querySelector("[data-role='ring']") as HTMLElement;
    const phaseEl = container.querySelector("[data-role='phase']") as HTMLElement;
    const subEl = container.querySelector("[data-role='sub']") as HTMLElement;
    const toggleEl = container.querySelector("[data-role='toggle']") as HTMLElement;
    const cdRow = container.querySelector("[data-role='cdrow']") as HTMLElement;
    const logEl = container.querySelector("[data-role='log']") as HTMLElement;

    const shown = snap.mode === "stopwatch" ? snap.elapsed : Math.max(0, snap.remaining);
    clockEl.textContent = formatDuration(shown);
    clockEl.classList.toggle("is-running", snap.running);

    if (snap.mode === "stopwatch") {
        ringEl.innerHTML = "";
    } else {
        ringEl.innerHTML = ringHTML({
            ratio: snap.targetSec ? snap.elapsed / snap.targetSec : 0,
            size: 180,
            stroke: 10,
            color: snap.mode === "pomodoro"
                ? (snap.phase === "focus" ? "var(--b3-theme-primary, #4285f4)" : "#5aa84f")
                : "#8257c9",
        });
    }

    if (snap.mode === "pomodoro") {
        phaseEl.innerHTML = `<span class="syfe-pl__phasechip syfe-pl__phasechip--${snap.phase}">
            ${escapeHTML(phaseLabel(snap.phase))}</span>
            <span class="syfe-pl__small">本轮第 ${snap.round} 个专注${snap.running ? " · 进行中" : ""}</span>`;
    } else {
        phaseEl.innerHTML = `<span class="syfe-pl__phasechip">${escapeHTML(modeLabel(snap.mode))}</span>`;
    }

    const target = targetLabel(snap.habitId, snap.taskId);
    subEl.textContent = target ? `正在计入:${target}` : (snap.running ? "未绑定对象" : "");

    toggleEl.textContent = snap.running ? "暂停" : "开始";
    cdRow.style.display = snap.mode === "countdown" ? "" : "none";

    if (logEl) logEl.innerHTML = renderTodayLog();
}

function targetLabel(habitId?: string, taskId?: string): string {
    const parts: string[] = [];
    const h = habitId ? getHabits(true).find(x => x.id === habitId) : undefined;
    if (h) parts.push(`${h.icon} ${h.name}`);
    const t = taskId ? getTask(taskId) : undefined;
    if (t) parts.push(t.title);
    return parts.join(" · ");
}

function renderTodayLog(): string {
    const today = todayKey();
    const list = getData().sessions.filter(s => s.dateKey === today).slice().reverse();
    if (list.length === 0) return `<div class="syfe-pl__hintline">今天还没有计时记录</div>`;
    const total = list.reduce((s, x) => s + x.seconds, 0);
    return `<div class="syfe-pl__logtitle">今日记录 ${list.length} 条 · 合计 ${formatDuration(total)}</div>
        <div class="syfe-pl__loglist">${list.slice(0, 12).map(s => {
        const target = targetLabel(s.habitId, s.taskId);
        return `<div class="syfe-pl__logrow">
                <span class="syfe-pl__logdot syfe-pl__logdot--${s.mode}${s.phase === "focus" ? "" : " is-rest"}"></span>
                <span class="syfe-pl__logname">${escapeHTML(modeLabel(s.mode))}${s.phase ? " · " + escapeHTML(phaseLabel(s.phase)) : ""}</span>
                ${target ? `<span class="syfe-pl__metaitem">${escapeHTML(target)}</span>` : ""}
                <span class="fn__flex-1"></span>
                <span class="syfe-pl__logtime">${formatDuration(s.seconds)}</span>
            </div>`;
    }).join("")}</div>`;
}
