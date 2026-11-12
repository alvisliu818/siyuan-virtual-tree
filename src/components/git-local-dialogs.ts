// 右键菜单用的本地 Git 对话框:提交指定路径、查看本地历史。
// 面板(dock/git-dock.ts)是常驻操作台,这里是"针对某个文件/文件夹"的一次性动作。
import {Dialog, showMessage} from "siyuan";
import {basename} from "../utils/path";
import {openGitDiffDialog} from "./git-diff-dialog";
import {
    gitLocalStatus, gitLocalStage, gitLocalCommit, gitLocalLog, gitLocalShow, GitLogEntry,
} from "../api/git-local";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 绝对路径 → 仓库内相对路径。右键仓库根时两者相等,必须得到 ""(否则会把绝对路径
// 当成相对路径去 git add,既暂存不到东西也可能误提交整个仓库)
function relOf(root: string, path?: string): string {
    if (!path) return "";
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === r) return "";
    return p.startsWith(r + "/") ? p.slice(r.length + 1) : "";
}

/**
 * 提交指定路径(文件或多文件夹)。path 为空则提交仓库里所有已暂存改动。
 * 只暂存该路径,不会把用户其他改动一起裹进这次提交。
 */
export function openGitCommitDialog(root: string, path?: string, onDone?: () => void): void {
    const rel = relOf(root, path);
    // 右键仓库根时 rel 是 "",但仍要暂存整棵树 —— 用 "." 而不是跳过暂存。
    // path 完全没给才是"只提交已暂存改动"
    const stagePath = path ? (rel || ".") : null;
    const title = rel ? `提交:${basename(rel)}` : `提交:${basename(root)}`;
    let busy = false;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-gitrepo">
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">仓库</div>
                    <div class="syfe-gitrepo__hint">${esc(root)}${stagePath ? `<br />本次暂存并提交 <b>${esc(rel || "整个仓库")}</b>` : "<br />提交当前所有已暂存改动"}</div>
                    <div class="syfe-gitrepo__status syfe-gitc__state">读取改动…</div>
                </div>
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">提交信息</div>
                    <textarea class="b3-text-field fn__block syfe-gitc__msg" rows="3" placeholder="必填"></textarea>
                    <div class="syfe-gitrepo__actions" style="margin-top:8px;">
                        <button class="b3-button syfe-gitc__ok">暂存并提交</button>
                        <span class="syfe-gitrepo__status syfe-gitc__status"></span>
                    </div>
                </div>
            </div>`,
        width: "560px",
    });

    const stateEl = dialog.element.querySelector(".syfe-gitc__state") as HTMLElement;
    const msgEl = dialog.element.querySelector(".syfe-gitc__msg") as HTMLTextAreaElement;
    const okBtn = dialog.element.querySelector(".syfe-gitc__ok") as HTMLButtonElement;
    const statusEl = dialog.element.querySelector(".syfe-gitc__status") as HTMLElement;

    void (async () => {
        try {
            const st = await gitLocalStatus(root);
            const mine = rel ? st.entries.filter(e => e.path === rel || e.path.startsWith(rel + "/")) : st.entries;
            if (mine.length === 0) {
                stateEl.textContent = rel ? "该路径没有改动" : "工作区干净,没有改动";
                okBtn.disabled = true;
                return;
            }
            stateEl.innerHTML = mine.slice(0, 30).map(e =>
                `· ${esc(e.path)} <span style="opacity:.6">(${e.conflicted ? "冲突" : e.untracked ? "未跟踪" : e.staged ? "已暂存" : "未暂存"})</span>`).join("<br />")
                + (mine.length > 30 ? `<br />… 另有 ${mine.length - 30} 项` : "");
            if (mine.some(e => e.conflicted)) {
                stateEl.innerHTML += `<br /><b style="color:var(--b3-card-error-color)">含冲突文件,请先在 Git 面板里处理冲突</b>`;
                okBtn.disabled = true;
            }
            msgEl.focus();
        } catch (e) {
            stateEl.textContent = String((e as Error)?.message || e);
            okBtn.disabled = true;
        }
    })();

    const submit = () => {
        if (busy || okBtn.disabled) return;
        const msg = msgEl.value.trim();
        if (!msg) { showMessage("请填写提交信息", 3000, "info"); return; }
        busy = true;
        okBtn.disabled = true;
        statusEl.textContent = "提交中…";
        void (async () => {
            try {
                if (stagePath) await gitLocalStage(root, [stagePath]);
                await gitLocalCommit(root, msg);
                showMessage("已提交", 2500, "info");
                dialog.destroy();
                onDone?.();
            } catch (e) {
                busy = false;
                okBtn.disabled = false;
                statusEl.textContent = "";
                showMessage(`提交失败: ${String((e as Error)?.message || e)}`, 7000, "error");
            }
        })();
    };

    okBtn.addEventListener("click", submit);
    msgEl.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); }
    });
}

/** 本地提交历史;path 给定时只看影响该路径的提交 */
export function openGitLocalHistoryDialog(root: string, path?: string): void {
    const rel = relOf(root, path);
    let commits: GitLogEntry[] = [];
    let loading = false;

    const dialog = new Dialog({
        title: rel ? `提交历史:${basename(rel)}` : `提交历史:${basename(root)}`,
        content: `
            <div class="b3-dialog__content syfe-githist">
                <div class="syfe-githist__bar">
                    <span class="syfe-githist__repo">${esc(root)}</span>
                    <span class="block__icon ariaLabel syfe-githist__refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                </div>
                ${rel ? `<div class="syfe-githist__filter">只看影响 <b>${esc(rel)}</b> 的提交</div>` : ""}
                <div class="syfe-githist__list"></div>
            </div>`,
        width: "620px",
        height: "76vh",
    });
    const listEl = dialog.element.querySelector(".syfe-githist__list") as HTMLElement;

    const render = () => {
        if (loading) { listEl.innerHTML = `<div class="syfe-githist__hint">读取中…</div>`; return; }
        if (commits.length === 0) {
            listEl.innerHTML = `<div class="syfe-githist__hint">没有提交历史${rel ? "(或没有影响此路径的提交)" : ""}</div>`;
            return;
        }
        listEl.innerHTML = commits.map((c, i) => `
            <div class="syfe-githist__row" data-idx="${i}" title="${esc(c.sha)}">
                <span class="syfe-githist__sha">${esc(c.short)}</span>
                <span class="syfe-githist__msg">${esc(c.subject)}</span>
                <span class="syfe-githist__meta">${esc(c.author)} · ${esc(c.date.slice(0, 10))}</span>
            </div>`).join("");
    };

    const load = async () => {
        loading = true;
        render();
        try {
            commits = await gitLocalLog(root, {limit: 50, path: rel || undefined});
        } catch (e) {
            loading = false;
            listEl.innerHTML = `<div class="syfe-githist__hint syfe-githist__hint--error">${esc(String((e as Error)?.message || e))}</div>`;
            return;
        }
        loading = false;
        render();
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        if (target.closest(".syfe-githist__refresh")) { void load(); return; }
        const row = target.closest(".syfe-githist__row") as HTMLElement | null;
        if (!row) return;
        const c = commits[Number(row.dataset.idx)];
        if (!c) return;
        void (async () => {
            try {
                const text = await gitLocalShow(root, c.sha, rel || undefined);
                openGitDiffDialog(`${c.short} ${c.subject}`, text, `${c.author} · ${c.date}`);
            } catch (e) {
                showMessage(`读取提交详情失败: ${String((e as Error)?.message || e)}`, 6000, "error");
            }
        })();
    });

    void load();
}