// 动作挂载:虚拟树里的"脚本/命令/按钮"条目 —— 点击即执行。
//
// 虚拟路径:action://<encodeURIComponent(JSON(spec))>,叶子挂载项(kind=file),
// 挂载项名即显示名。零新挂载 kind(与 weblink:// 同策略)。
//
// 动作类型:
//   shell —— 桌面端执行命令行/脚本(node child_process.exec,超时 120s),
//            stdout/stderr/退出码显示在结果对话框;移动端无 shell,报可读错误。
//   js    —— 在思源页面上下文执行 JS 片段(全端可用),可访问 window.siyuan
//            等全局;console.log 输出与返回值一并显示。
// 编辑 = 移除旧挂载 + 按新配置重新挂载(挂载项 path 即配置本体)。
import {getNativeRequire, isNodeModulesAvailable} from "./native-require";

export const ACTION_PREFIX = "action://";

export type ActionType = "shell" | "js";

export interface ActionSpec {
    type: ActionType;
    /** shell:命令行(shell 解析);js:JS 片段源码 */
    cmd: string;
    /** shell 可选工作目录 */
    cwd?: string;
}

// 构造动作挂载的虚拟路径
export function makeActionVPath(spec: ActionSpec): string {
    return ACTION_PREFIX + encodeURIComponent(JSON.stringify(spec));
}

export function isActionPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(ACTION_PREFIX);
}

// 解析动作配置;损坏的编码返回 null
export function actionSpecOf(p: string): ActionSpec | null {
    try {
        const spec = JSON.parse(decodeURIComponent(p.slice(ACTION_PREFIX.length)));
        if (!spec || (spec.type !== "shell" && spec.type !== "js")) return null;
        if (typeof spec.cmd !== "string" || !spec.cmd.trim()) return null;
        return {type: spec.type, cmd: spec.cmd, cwd: typeof spec.cwd === "string" ? spec.cwd : undefined};
    } catch {
        return null;
    }
}

export interface ActionResult {
    output: string;
    isError: boolean;
}

// 执行动作;输出统一文本(结果对话框展示)
export async function runAction(spec: ActionSpec): Promise<ActionResult> {
    if (spec.type === "shell") {
        if (!isNodeModulesAvailable()) {
            return {output: "脚本/命令执行仅桌面端可用(移动端没有 Node 环境)。", isError: true};
        }
        try {
            const cp = getNativeRequire()!("child_process");
            const result = await new Promise<{stdout: string; stderr: string; code: number | null; err?: Error}>((resolve) => {
                const child = cp.exec(spec.cmd, {
                    cwd: spec.cwd || undefined,
                    timeout: 120_000,
                    maxBuffer: 10 * 1024 * 1024,
                    windowsHide: true,
                }, (err: Error | null, stdout: string, stderr: string) => {
                    resolve({stdout, stderr, code: err && (err as any).code !== undefined ? (err as any).code : (err ? 1 : 0), err: err && err.message !== "command failed" ? err : undefined});
                });
                void child;
            });
            const parts: string[] = [];
            if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
            if (result.stderr.trim()) parts.push("[stderr]\n" + result.stderr.trimEnd());
            parts.push(`[退出码] ${result.code}`);
            if (result.err && result.err.message && result.err.message !== "command failed") {
                parts.push(`[错误] ${result.err.message}`);
            }
            return {output: parts.join("\n\n") || "(无输出)", isError: result.code !== 0};
        } catch (e) {
            return {output: `执行失败: ${(e as Error)?.message || e}`, isError: true};
        }
    }
    // js:页面上下文执行,捕获 console 输出与返回值
    const logs: string[] = [];
    const fmt = (v: unknown): string => {
        if (typeof v === "string") return v;
        try {
            return JSON.stringify(v, null, 1);
        } catch {
            return String(v);
        }
    };
    const fakeConsole = {
        log: (...args: unknown[]) => logs.push(args.map(fmt).join(" ")),
        warn: (...args: unknown[]) => logs.push("[warn] " + args.map(fmt).join(" ")),
        error: (...args: unknown[]) => logs.push("[error] " + args.map(fmt).join(" ")),
        info: (...args: unknown[]) => logs.push(args.map(fmt).join(" ")),
    };
    try {
        const fn = new Function("console", spec.cmd);
        const result = await fn(fakeConsole);
        const parts: string[] = [];
        if (logs.length) parts.push(logs.join("\n"));
        if (result !== undefined) parts.push("[返回值]\n" + fmt(result));
        return {output: parts.join("\n") || "(执行完成,无输出)", isError: false};
    } catch (e) {
        const parts: string[] = [];
        if (logs.length) parts.push(logs.join("\n"));
        parts.push(`[异常] ${(e as Error)?.message || e}`);
        return {output: parts.join("\n"), isError: true};
    }
}

// 执行并在对话框展示结果(树行点击入口)
export async function executeActionMount(plugin: {app: unknown}, vPath: string, fallbackName: string): Promise<void> {
    const spec = actionSpecOf(vPath);
    if (!spec) {
        throw new Error("动作配置无法解析(挂载项可能已损坏),请删除后重新挂载");
    }
    void plugin;
    const {Dialog} = await import("siyuan");
    const dlg = new Dialog({
        title: `执行中…`,
        content: `<div class="b3-dialog__content"><pre class="syfe-action-out" style="max-height:50vh;overflow:auto;font-family:var(--b3-font-family-code);font-size:12px;white-space:pre-wrap;">运行中…</pre></div>`,
        width: "640px",
    });
    const pre = dlg.element.querySelector(".syfe-action-out") as HTMLElement;
    try {
        const r = await runAction(spec);
        pre.textContent = r.output;
        pre.style.color = r.isError ? "var(--b3-theme-error)" : "";
    } catch (e) {
        pre.textContent = `执行失败: ${(e as Error)?.message || e}`;
        pre.style.color = "var(--b3-theme-error)";
    }
    void fallbackName;
}
