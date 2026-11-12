// Git diff 查看器(本地仓库与远程仓库共用)。
// 统一 diff 按行前缀着色;侧栏面板太窄,所以一律用大对话框承载。
import {Dialog} from "siyuan";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 超大 diff 全量塞进 DOM 会卡死渲染进程,截断并说明
const MAX_LINES = 6000;

function lineClass(line: string): string {
    if (line.startsWith("+++") || line.startsWith("---")) return "syfe-gitdiff__meta";
    if (line.startsWith("+")) return "syfe-gitdiff__add";
    if (line.startsWith("-")) return "syfe-gitdiff__del";
    if (line.startsWith("@@")) return "syfe-gitdiff__hunk";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("rename ")
        || line.startsWith("similarity ") || line.startsWith("new file") || line.startsWith("deleted file")) {
        return "syfe-gitdiff__meta";
    }
    return "";
}

export function openGitDiffDialog(title: string, diff: string, subtitle = ""): void {
    const text = (diff || "").replace(/\r\n/g, "\n");
    if (!text.trim()) {
        new Dialog({
            title,
            content: `<div class="b3-dialog__content syfe-gitdiff"><div class="syfe-gitdiff__empty">没有差异</div></div>`,
            width: "720px",
        });
        return;
    }
    const all = text.split("\n");
    const lines = all.slice(0, MAX_LINES);
    const truncated = all.length > MAX_LINES;
    new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-gitdiff">
                ${subtitle ? `<div class="syfe-gitdiff__sub">${esc(subtitle)}</div>` : ""}
                <pre class="syfe-gitdiff__pre">${lines.map(l => `<span class="${lineClass(l)}">${esc(l) || " "}</span>`).join("\n")}</pre>
                ${truncated ? `<div class="syfe-gitdiff__empty">差异过长,只显示前 ${MAX_LINES} 行(共 ${all.length} 行)</div>` : ""}
            </div>`,
        width: "860px",
        height: "80vh",
    });
}