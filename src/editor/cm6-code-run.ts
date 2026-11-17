// CM6 代码卡片运行:运行按钮 + 卡片下方结果面板 + stdin 输入。
//
// 复用 protyle 侧基建(code-block-run-exec:真子进程 + stdin 管道,支持 input();
// code-block-run:ANSI 上色),样式直接复用全局 .syfe-cb-run 类。
//
// 与 protyle 版的差异:
//  - CM6 卡片 DOM 是 Decoration.replace 的纯视觉层,不进思源文档 → 面板可以挂在
//    卡片**内部**(protyle 版必须挂外面防 .sy 污染,这里没那个问题);
//  - 块身份没有稳定 id → 结果缓存按「语言+代码内容」键,会话内存不持久化:
//    编辑代码即换键,改回原内容旧结果立即可见;widget 重建(编辑/滚动)从缓存恢复;
//  - v1 只有干净进程运行(Python/Node),无 Jupyter 内核模式 —— 内核注册表按
//    文档 id 记忆,CM6 卡片层不知道所属文档 id,要接需要宿主 tab 传入。
//
// 状态生命周期:states/handles 常驻(session);面板 DOM 随 widget 生灭,
// 输出变化经 subscribeRun 通知在屏面板刷新(输入框聚焦时只刷 body,防打断打字)。

import {ansiToHtml} from "../protyle/code-block-run";
import {runNodeCode, runPythonCode, type RunHandle} from "../protyle/code-block-run-exec";

export type CodeRunLang = "python" | "node";

/** 代码块语言 → 可运行后端;null = 不支持运行(不显示运行按钮) */
export function runLangOf(lang: string): CodeRunLang | null {
    const t = String(lang || "").trim().toLowerCase();
    if (t === "python" || t === "py" || t === "py3" || t === "python3") return "python";
    if (t === "js" || t === "javascript" || t === "node" || t === "nodejs" || t === "cjs" || t === "mjs") return "node";
    return null;
}

/** 运行态缓存键:语言 + 代码内容(编辑代码即换键,改回原内容旧结果立即可见) */
export function codeRunKey(lang: string, code: string): string {
    return (runLangOf(lang) || "?") + "\u0000" + code;
}

interface RunState {
    output: string;
    exitCode: number | null;
    collapsed: boolean;
    running: boolean;
}

const states = new Map<string, RunState>();
const handles = new Map<string, RunHandle>();
const listeners = new Map<string, Set<() => void>>();

function stateOf(key: string): RunState {
    let st = states.get(key);
    if (!st) {
        st = {output: "", exitCode: null, collapsed: false, running: false};
        states.set(key, st);
    }
    return st;
}

function notify(key: string): void {
    const set = listeners.get(key);
    if (!set) return;
    for (const fn of Array.from(set)) {
        try { fn(); } catch { /* 面板已销毁等 */ }
    }
}

export function runStateOf(key: string): RunState {
    return stateOf(key);
}

/** 订阅运行态变化(面板刷新用);返回退订函数 */
export function subscribeCodeRun(key: string, fn: () => void): () => void {
    let set = listeners.get(key);
    if (!set) {
        set = new Set();
        listeners.set(key, set);
    }
    set.add(fn);
    return () => {
        const cur = listeners.get(key);
        if (!cur) return;
        cur.delete(fn);
        if (!cur.size) listeners.delete(key);
    };
}

/** 运行的工作目录:工作空间根(相对路径读写、包导入的合理基准) */
function runCwd(): string {
    return (window as any).siyuan?.config?.system?.workspaceDir || "";
}

export function startCodeRun(lang: CodeRunLang, code: string, key: string): void {
    const st = stateOf(key);
    if (st.running) return;
    handles.get(key)?.interrupt();
    handles.delete(key);
    st.output = "";
    st.exitCode = null;
    st.running = true;
    notify(key);
    const options = {
        code,
        cwd: runCwd(),
        onOutput: (chunk: string) => {
            const s = stateOf(key);
            s.output += chunk;
            // 超长输出截断保性能(保留尾部,最近的内容才是用户关心的)
            if (s.output.length > 2_000_000) s.output = s.output.slice(-1_000_000);
            notify(key);
        },
        onExit: (code: number) => {
            const s = stateOf(key);
            s.exitCode = code;
            s.running = false;
            handles.delete(key);
            notify(key);
        },
    };
    try {
        const h = lang === "python" ? runPythonCode(options) : runNodeCode(options);
        handles.set(key, h);
    } catch (e: any) {
        st.running = false;
        st.output += `\n[无法启动进程] ${e?.message || e}\n`;
        st.exitCode = -1;
        notify(key);
    }
}

export function interruptCodeRun(key: string): void {
    handles.get(key)?.interrupt();
}

export function sendCodeRunInput(key: string, line: string): void {
    handles.get(key)?.sendInput(line);
    // 回显写进缓存:后续输出刷新用整段 output 覆盖 body,只改 DOM 会被抹掉
    stateOf(key).output += line + "\n";
    notify(key);
}

export function clearCodeRun(key: string): void {
    handles.get(key)?.interrupt();
    handles.delete(key);
    const st = stateOf(key);
    st.output = "";
    st.exitCode = null;
    st.running = false;
    notify(key);
}

export function toggleFoldCodeRun(key: string): void {
    stateOf(key).collapsed = !stateOf(key).collapsed;
    notify(key);
}

// ===== 面板渲染 =====

function bodyHtml(st: RunState): string {
    // 带 ANSI 颜色码的输出渲染成彩色(转义后上色);超长输出退回纯文本保性能
    if (/\x1b\[/.test(st.output) && st.output.length <= 400000) return ansiToHtml(st.output);
    return nullToEmpty(escapeHtmlOf(st.output));
}

function escapeHtmlOf(s: string): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nullToEmpty(s: string): string {
    return s;
}

/**
 * 把结果面板渲染进容器(卡片内、代码正文下方)。
 * 容器随 widget 重建时重新调用即可;返回面板的退订函数(widget destroy 时调)。
 * 输出增量到达时:输入框聚焦 → 只刷 body(防打断打字);否则整面板重建。
 */
export function renderCodeRunPanel(container: HTMLElement, key: string): () => void {
    const rebuild = () => renderCodeRunPanel(container, key);
    const prevSub = (container as any).__syfeRunSub as (() => void) | undefined;
    if (prevSub) prevSub();
    const unsub = subscribeCodeRun(key, () => {
        const active = container.ownerDocument.activeElement;
        if (active && container.contains(active) && (active as HTMLElement).tagName === "INPUT") {
            const st = runStateOf(key);
            const body = container.querySelector(".syfe-cb-run__body") as HTMLElement | null;
            if (body) {
                body.innerHTML = bodyHtml(st);
                body.scrollTop = body.scrollHeight;
            }
            return;
        }
        rebuild();
    });
    (container as any).__syfeRunSub = unsub;

    const st = runStateOf(key);
    // 没有任何输出且没在跑 → 不显示面板(空壳留着省得下次重建)
    if (!st.output && !st.running) {
        container.innerHTML = "";
        container.style.display = "none";
        return unsub;
    }
    container.style.display = "";
    const collapsed = st.collapsed;

    const head = document.createElement("div");
    head.className = st.exitCode !== null && st.exitCode !== 0
        ? "syfe-cb-run__head syfe-cb-run__head--err" : "syfe-cb-run__head";
    const title = st.running ? "运行中…"
        : (st.exitCode !== null && st.exitCode !== 0 ? `已结束(退出码 ${st.exitCode})` : "输出");
    head.innerHTML = `<span class="syfe-cb-run__title">${escapeHtmlOf(title)}</span>`
        + `<span style="flex:1"></span>`
        + `<span class="syfe-cb-run__btn2" data-act="run" style="${st.running ? "color:var(--b3-theme-danger)" : ""}">${st.running ? "■ 停止" : "▶ 运行"}</span>`
        + `<span class="syfe-cb-run__btn2" data-act="copy" title="复制全部输出(纯文本)">⧉ 复制</span>`
        + `<span class="syfe-cb-run__btn2" data-act="fold">${collapsed ? "▾ 展开" : "▴ 折叠"}</span>`
        + `<span class="syfe-cb-run__btn2" data-act="clear">✕ 清除</span>`;

    const body = document.createElement("div");
    body.className = "syfe-cb-run__body";
    if (!collapsed) {
        body.innerHTML = bodyHtml(st);
        body.scrollTop = body.scrollHeight;
    } else {
        body.style.display = "none";
    }

    container.innerHTML = "";
    container.appendChild(head);
    container.appendChild(body);

    // stdin 输入行:仅运行中且未折叠时显示(input() 在等输入时用户直接打字回车)
    if (!collapsed && st.running) {
        const row = document.createElement("div");
        row.className = "syfe-cb-run__stdin";
        const field = document.createElement("input");
        field.type = "text";
        field.placeholder = "程序在等输入,在这里输入后回车";
        field.addEventListener("keydown", (e: KeyboardEvent) => {
            // 拦冒泡:CM6 键位(Tab/Enter/表格导航)不能在输入框里接管按键
            e.stopPropagation();
            if (e.key !== "Enter") return;
            e.preventDefault();
            const value = field.value;
            field.value = "";
            if (!value) return;
            sendCodeRunInput(key, value);
        });
        row.appendChild(field);
        container.appendChild(row);
        // 程序一开跑就聚焦,省一次点击;面板重建(输出刷新)后保持焦点
        if (container.ownerDocument.activeElement === container.ownerDocument.body) {
            setTimeout(() => {
                if (runStateOf(key).running && container.isConnected) field.focus();
            }, 0);
        }
    }

    head.addEventListener("click", (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const act = target.closest(".syfe-cb-run__btn2")?.getAttribute("data-act");
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        if (act === "run") {
            const running = runStateOf(key).running;
            if (running) interruptCodeRun(key);
        } else if (act === "copy") {
            const text = (runStateOf(key).output || "").replace(/\x1b\[[0-9;]*m/g, "");
            void navigator.clipboard.writeText(text);
        } else if (act === "fold") {
            toggleFoldCodeRun(key);
        } else if (act === "clear") {
            clearCodeRun(key);
        }
    });

    return unsub;
}
