// 动作挂载对话框(创建/编辑):脚本(shell)、JS 片段,可附工作目录。
// 确认后回调 onPicked(vPath, name) —— 调用方完成挂载(编辑态由调用方先移除旧项)。
import {Dialog, showMessage} from "siyuan";
import {ActionSpec, ActionType, makeActionVPath} from "../utils/action-mount";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openActionMountDialog(opts: {
    title?: string;
    /** 编辑态:回填既有配置 */
    initial?: {name: string; spec: ActionSpec};
    onPicked: (vPath: string, name: string, spec: ActionSpec) => void;
}): void {
    const title = opts.title || "挂载脚本/命令";
    const initial = opts.initial;
    const spec0 = initial?.spec;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content">
                <label class="b3-form__label">名称(树中显示)</label>
                <input id="syfe-am-name" class="b3-text-field fn__block" value="${escapeHTML(initial?.name || "")}" placeholder="如:构建脚本 / 清理临时文件" />
                <label class="b3-form__label">动作类型</label>
                <select id="syfe-am-type" class="b3-select fn__block">
                    <option value="shell">命令行 / 脚本(桌面端执行,如 python build.py)</option>
                    <option value="js">JS 片段(在思源页面上下文执行,全端可用)</option>
                </select>
                <label class="b3-form__label" id="syfe-am-cmd-label">内容</label>
                <textarea id="syfe-am-cmd" class="b3-text-field fn__block" rows="6" style="font-family:var(--b3-font-family-code);white-space:pre;" placeholder="命令行(可用管道/重定向)或 JS 代码"></textarea>
                <div id="syfe-am-cwd-sec">
                    <label class="b3-form__label">工作目录(可选,shell 生效)</label>
                    <input id="syfe-am-cwd" class="b3-text-field fn__block" value="${escapeHTML(spec0?.cwd || "")}" placeholder="如 E:\\HOME\\Code 或 /data" />
                </div>
                <div class="b3-form__hint" id="syfe-am-hint">shell:点击条目即执行,stdout/stderr/退出码显示在结果对话框(超时 120s)。</div>
            </div>
            <div class="b3-dialog__actions">
                <button class="b3-button b3-button--text" id="syfe-am-ok">挂载</button>
            </div>`,
        width: "560px",
    });
    // 回填类型/内容
    (dialog.element.querySelector("#syfe-am-type") as HTMLSelectElement).value = spec0?.type || "shell";
    (dialog.element.querySelector("#syfe-am-cmd") as HTMLTextAreaElement).value = spec0?.cmd || "";
    const cmdLabel = dialog.element.querySelector("#syfe-am-cmd-label") as HTMLElement;
    const hintEl = dialog.element.querySelector("#syfe-am-hint") as HTMLElement;
    const cmdEl = dialog.element.querySelector("#syfe-am-cmd") as HTMLTextAreaElement;
    const syncHint = () => {
        const type = (dialog.element.querySelector("#syfe-am-type") as HTMLSelectElement).value;
        if (type === "shell") {
            cmdLabel.textContent = "命令行 / 脚本";
            cmdEl.placeholder = "命令行,如:python build.py --release(可含管道/重定向)";
            hintEl.textContent = "shell:点击条目即执行,stdout/stderr/退出码显示在结果对话框(超时 120s);仅桌面端。";
        } else {
            cmdLabel.textContent = "JS 片段";
            cmdEl.placeholder = "在思源页面上下文执行,如:console.log(window.siyuan.config.system.workspaceDir)";
            hintEl.textContent = "js:点击条目在页面上下文执行,可用 window.siyuan 等全局;console 输出与返回值显示在结果对话框;全端可用。";
        }
    };
    syncHint();
    (dialog.element.querySelector("#syfe-am-type") as HTMLSelectElement).addEventListener("change", syncHint);

    const commit = () => {
        const name = (dialog.element.querySelector("#syfe-am-name") as HTMLInputElement).value.trim();
        const type = (dialog.element.querySelector("#syfe-am-type") as HTMLSelectElement).value as ActionType;
        const cmd = (dialog.element.querySelector("#syfe-am-cmd") as HTMLTextAreaElement).value.trim();
        const cwd = (dialog.element.querySelector("#syfe-am-cwd") as HTMLInputElement).value.trim();
        if (!name) {
            showMessage("请填写名称", 3000, "error");
            return;
        }
        if (!cmd) {
            showMessage("请填写动作内容", 3000, "error");
            return;
        }
        const spec: ActionSpec = {type, cmd, ...(type === "shell" && cwd ? {cwd} : {})};
        opts.onPicked(makeActionVPath(spec), name, spec);
        dialog.destroy();
    };
    dialog.element.querySelector("#syfe-am-ok")!.addEventListener("click", commit);
    dialog.element.addEventListener("keydown", (ke: KeyboardEvent) => {
        // textarea 里 Ctrl+Enter 提交(裸 Enter 需要换行)
        if (ke.key === "Enter" && (ke.ctrlKey || ke.metaKey)) commit();
    });
}
