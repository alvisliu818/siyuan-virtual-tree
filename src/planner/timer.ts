// 计时引擎(番茄钟 / 正计时 / 倒计时)。Dock 与 Tab 共用同一个单例,保证两处显示同一个时间。
//
// 两个关键点:
// 1. **时长一律由时间戳推算**,不用 setInterval 累加 tick 次数。后台标签页会被浏览器/ Electron
//    节流到 1 秒一次甚至更慢,累加法会把时间走丢;时间戳法即使节流也只影响刷新频率,不影响准确度。
// 2. **跨刷新可恢复**:持久化的是 runningSince(启动时刻),重新加载时用 now - runningSince 还原。
//    只存 elapsedSec 的做法前提是"面板不关",一旦关掉就归零(很多插件就是这么丢的)。
import {showMessage} from "siyuan";
import {FocusSession, newId, PersistedTimer, PomodoroPhase, TimerMode} from "./types";
import {addSession, getData, getSettings, IPlannerPlugin, persistQuietly} from "./store";
import {todayKey} from "./dates";

export interface TimerTarget {
    taskId?: string;
    habitId?: string;
}

export interface TimerSnapshot {
    mode: TimerMode;
    phase: PomodoroPhase;
    running: boolean;
    /** 已过秒(含小数) */
    elapsed: number;
    /** 剩余秒(countdown/pomodoro 有,stopwatch 为 Infinity) */
    remaining: number;
    /** 进度 0..1 */
    ratio: number;
    targetSec: number;
    round: number;
    taskId?: string;
    habitId?: string;
}

export const TIMER_TICK_EVENT = "syfe:planner-timer-tick";
export const TIMER_DONE_EVENT = "syfe:planner-timer-done";

let pluginRef: IPlannerPlugin | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function state(): PersistedTimer {
    return getData().timer;
}

export function initPlannerTimer(plugin: IPlannerPlugin): void {
    pluginRef = plugin;
    // 上次退出时若在运行,进来就继续跑(时长靠 runningSince 还原)
    if (state().running) ensureTicker();
    notify();
}

// ==== 读取 ====

/** 已过秒。运行中按 wall-clock 还原,暂停则取快照值。 */
export function timerElapsed(): number {
    const s = state();
    if (!s.running || !s.runningSince) return s.elapsedSec;
    return s.elapsedSec + (Date.now() - s.runningSince) / 1000;
}

export function timerSnapshot(): TimerSnapshot {
    const s = state();
    const elapsed = timerElapsed();
    const stopwatch = s.mode === "stopwatch";
    const remaining = stopwatch ? Infinity : Math.max(0, s.targetSec - elapsed);
    return {
        mode: s.mode,
        phase: s.phase,
        running: s.running,
        elapsed,
        remaining,
        ratio: stopwatch ? 0 : Math.min(1, elapsed / Math.max(1, s.targetSec)),
        targetSec: s.targetSec,
        round: s.round,
        taskId: s.taskId,
        habitId: s.habitId,
    };
}

export function phaseTargetSec(phase: PomodoroPhase): number {
    const cfg = getSettings().pomodoro;
    const map: Record<PomodoroPhase, number> = {focus: cfg.focus, short: cfg.short, long: cfg.long};
    return Math.max(60, map[phase] * 60);
}

export function phaseLabel(phase: PomodoroPhase): string {
    return phase === "focus" ? "专注" : phase === "short" ? "短休息" : "长休息";
}

// ==== 控制 ====

/** 开始 / 继续 */
export function startTimer(): void {
    const s = state();
    if (s.running) return;
    s.running = true;
    // 只记录启动时刻 —— 已累积的部分留在 elapsedSec 里,两者相加才是总时长
    s.runningSince = Date.now();
    ensureTicker();
    sync();
    notify();
}

export function pauseTimer(): void {
    const s = state();
    if (!s.running) return;
    s.elapsedSec = timerElapsed();
    s.running = false;
    s.runningSince = 0;
    stopTicker();
    sync();
    notify();
}

/** 重置当前段(番茄钟回到该相位的完整时长) */
export function resetTimer(): void {
    const s = state();
    s.running = false;
    s.runningSince = 0;
    s.elapsedSec = 0;
    if (s.mode === "pomodoro") s.targetSec = phaseTargetSec(s.phase);
    stopTicker();
    sync();
    notify();
}

/** 切换模式;番茄钟相位与圆次一并复位 */
export function setTimerMode(mode: TimerMode, opts?: {minutes?: number; phase?: PomodoroPhase}): void {
    const s = state();
    stopTicker();
    s.mode = mode;
    s.running = false;
    s.runningSince = 0;
    s.elapsedSec = 0;
    if (mode === "pomodoro") {
        s.phase = opts?.phase || "focus";
        s.targetSec = phaseTargetSec(s.phase);
        s.round = 0;
    } else if (mode === "countdown") {
        s.phase = "focus";
        s.targetSec = Math.max(60, (opts?.minutes || getSettings().defaultCountdownMin) * 60);
        s.round = 0;
    } else {
        s.phase = "focus";
        s.targetSec = 0;
        s.round = 0;
    }
    sync();
    notify();
}

export function setCountdownMinutes(min: number): void {
    const s = state();
    s.targetSec = Math.max(60, min * 60);
    s.elapsedSec = 0;
    s.running = false;
    s.runningSince = 0;
    stopTicker();
    sync();
    notify();
}

/** 绑定正在计时的对象(任务 / 习惯);完成之后由 checkout 决定记到谁头上 */
export function bindTimerTarget(t: TimerTarget): void {
    const s = state();
    s.taskId = t.taskId;
    s.habitId = t.habitId;
    sync();
    notify();
}

/** 手动结束并记账(正计时/倒计时用;番茄钟通常由自动完成触发) */
export function stopAndRecord(): void {
    const s = state();
    const elapsed = timerElapsed();
    checkout(Math.round(elapsed), true);
    s.running = false;
    s.runningSince = 0;
    s.elapsedSec = 0;
    if (s.mode === "pomodoro") s.targetSec = phaseTargetSec(s.phase);
    stopTicker();
    sync();
    notify();
}

/** 跳过休息/专注段(番茄钟) */
export function skipPhase(): void {
    const s = state();
    if (s.mode !== "pomodoro") {
        stopAndRecord();
        return;
    }
    advancePhase(false);
}

// ==== 内部 ====

function ensureTicker(): void {
    if (ticker !== null) return;
    ticker = setInterval(() => {
        const s = state();
        if (!s.running) {
            stopTicker();
            return;
        }
        if (s.mode !== "stopwatch" && timerElapsed() >= s.targetSec) {
            onComplete();
            return;
        }
        notify();
    }, 500);
}

function stopTicker(): void {
    if (ticker !== null) {
        clearInterval(ticker);
        ticker = null;
    }
}

/** 一个阶段结束:记账 → 决定下一段 → 按配置决定是否自动开始 */
function onComplete(): void {
    const s = state();
    const seconds = Math.round(s.targetSec || timerElapsed());
    const wasPhase = s.phase;
    checkout(seconds, false);
    window.dispatchEvent(new CustomEvent(TIMER_DONE_EVENT, {detail: {mode: s.mode, phase: wasPhase, seconds}}));
    advancePhase(true);
}

function advancePhase(fromComplete: boolean): void {
    const s = state();
    const cfg = getSettings().pomodoro;
    if (s.mode !== "pomodoro") {
        s.running = false;
        s.runningSince = 0;
        s.elapsedSec = 0;
        stopTicker();
        sync();
        notify();
        return;
    }
    // 记录上一次是否由"自然完成"触发 —— 跳过的那一段不该让番茄计数 +1
    if (s.phase === "focus") {
        if (fromComplete) s.round = (s.round || 0) + 1;
        s.phase = s.round > 0 && s.round % Math.max(2, cfg.longEvery) === 0 ? "long" : "short";
    } else {
        s.phase = "focus";
    }
    s.elapsedSec = 0;
    s.targetSec = phaseTargetSec(s.phase);
    // 自动续接:休息结束自动回到专注 autoStartNext;专注结束自动进休息 autoStartBreak
    const auto = (s.phase !== "focus") ? cfg.autoStartBreak : cfg.autoStartNext;
    if (auto) {
        s.running = true;
        s.runningSince = Date.now();
        ensureTicker();
    } else {
        s.running = false;
        s.runningSince = 0;
        stopTicker();
    }
    sync();
    notify();
}

/** 写会话 + 提示 + 响铃 */
function checkout(seconds: number, manual: boolean): void {
    if (seconds < 1 || !pluginRef) return;
    const s = state();
    const session: FocusSession = {
        id: newId("f"),
        mode: s.mode,
        // 休息段也要记账,但统计页面过滤掉 —— 便于事后复盘"是不是休息太久"
        phase: s.mode === "pomodoro" ? s.phase : undefined,
        seconds,
        taskId: s.taskId,
        habitId: s.habitId,
        startedAt: Date.now() - seconds * 1000,
        endedAt: Date.now(),
        dateKey: todayKey(),
    };
    addSession(pluginRef, session);

    const cfg = getSettings();
    if (s.mode === "pomodoro") {
        if (s.phase === "focus") {
            if (cfg.notify) showMessage(`专注结束 · ${Math.round(seconds / 60)} 分钟`, 4000);
        } else if (cfg.notify) {
            showMessage("休息结束,回到专注", 3000);
        }
    } else if (cfg.notify) {
        showMessage(`${manual ? "计时已记录" : "倒计时结束"} · ${Math.round(seconds / 60)} 分钟`, 3000);
    }
    if (cfg.sound && !manual) beep(s.mode === "pomodoro" && s.phase !== "focus");
}

/** WebAudio 合成提示音 —— 不引入音频资源,免得打包体积和 CSP 都要让路 */
function beep(soft: boolean): void {
    try {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = soft ? "sine" : "triangle";
        osc.frequency.value = soft ? 660 : 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
        setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 1200);
    } catch {
        // 某些环境下 AudioContext 被策略限制静音;响不了不应该影响记账
    }
}

/**
 * 落盘。运行中不做周期性写入 —— runningSince 是固定的,读的时候再算即可,
 * 没必要每半秒写一次 json。这里走 store 的静默通道(只落盘、不发 PLANNER_CHANGED_EVENT)。
 */
function sync(): void {
    persistQuietly();
}

function notify(): void {
    window.dispatchEvent(new CustomEvent(TIMER_TICK_EVENT));
}

/** 卸载时停表(插件 onunload 调用) */
export function disposeTimer(): void {
    stopTicker();
}
