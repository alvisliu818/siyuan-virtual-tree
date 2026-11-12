// 远程仓库(GitHub / Gitee)提交历史与 diff。
//
// 纯 REST,经 api/http.ts 的统一传输层:桌面走 Node https,移动端走内核代理,
// 所以同一个对话框两端都能用。本地仓库的历史走 dock/git-dock.ts(git CLI)。
import {Dialog, showMessage} from "siyuan";
import {GitProvider} from "../utils/git-repo-path";
import {gitListRefs, gitListCommits, gitCommitFiles, GitRemoteCommit} from "../api/git-repo";
import {openGitDiffDialog} from "./git-diff-dialog";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface GitHistoryOptions {
    provider: GitProvider;
    owner: string;
    repo: string;
    ref: string;
    path?: string;                       // 只看影响该路径的提交
    title?: string;
    onBranchChange?: (ref: string) => void;   // 插件库换绑定分支时回传
}

const STATUS_LABEL: Record<string, string> = {
    added: "新增", removed: "删除", modified: "修改", renamed: "改名", changed: "改动",
};

export function openGitHistoryDialog(opts: GitHistoryOptions): void {
    const host = opts.provider === "github" ? "GitHub" : "Gitee";
    let ref = opts.ref;
    let commits: GitRemoteCommit[] = [];
    let loading = false;

    const dialog = new Dialog({
        title: opts.title || `提交历史:${opts.owner}/${opts.repo}`,
        content: `
            <div class="b3-dialog__content syfe-githist">
                <div class="syfe-githist__bar">
                    <span class="syfe-githist__repo">${esc(host)} ${esc(opts.owner)}/${esc(opts.repo)}</span>
                    <select class="b3-select syfe-githist__ref" title="分支"></select>
                    <span class="block__icon ariaLabel syfe-githist__refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                </div>
                ${opts.path ? `<div class="syfe-githist__filter">只看影响 <b>${esc(opts.path)}</b> 的提交</div>` : ""}
                <div class="syfe-githist__list"></div>
            </div>`,
        width: "620px",
        height: "76vh",
    });

    const listEl = dialog.element.querySelector(".syfe-githist__list") as HTMLElement;
    const refSel = dialog.element.querySelector(".syfe-githist__ref") as HTMLSelectElement;

    const renderList = () => {
        if (loading) {
            listEl.innerHTML = `<div class="syfe-githist__hint">读取中…</div>`;
            return;
        }
        if (commits.length === 0) {
            listEl.innerHTML = `<div class="syfe-githist__hint">该分支没有提交${opts.path ? "(或没有影响此路径的提交)" : ""}</div>`;
            return;
        }
        listEl.innerHTML = commits.map((c, i) => `
            <div class="syfe-githist__row" data-idx="${i}" title="${esc(c.sha)}">
                <span class="syfe-githist__sha">${esc(c.short)}</span>
                <span class="syfe-githist__msg">${esc(c.message.split("\n")[0])}</span>
                <span class="syfe-githist__meta">${esc(c.author)} · ${esc(c.date.slice(0, 10))}</span>
            </div>`).join("");
    };

    const load = async () => {
        loading = true;
        renderList();
        try {
            commits = await gitListCommits(opts.provider, opts.owner, opts.repo, ref, {limit: 50, path: opts.path});
        } catch (e) {
            loading = false;
            listEl.innerHTML = `<div class="syfe-githist__hint syfe-githist__hint--error">${esc(String((e as Error)?.message || e))}</div>`;
            return;
        }
        loading = false;
        renderList();
    };

    const loadRefs = async () => {
        try {
            const refs = await gitListRefs(opts.provider, opts.owner, opts.repo);
            const all = refs.branches.includes(ref) ? refs.branches : [ref, ...refs.branches];
            refSel.innerHTML = all.map(b => `<option value="${esc(b)}"${b === ref ? " selected" : ""}>${esc(b)}</option>`).join("");
        } catch {
            // 分支列表拿不到(无权限/网络):保留当前分支,历史照常读
            refSel.innerHTML = `<option value="${esc(ref)}">${esc(ref)}</option>`;
        }
    };

    const openCommit = async (c: GitRemoteCommit) => {
        try {
            const detail = await gitCommitFiles(opts.provider, opts.owner, opts.repo, c.sha);
            if (detail.files.length === 0) {
                openGitDiffDialog(`${c.short} ${c.message.split("\n")[0]}`, "", `${c.author} · ${c.date}\n该接口未返回文件改动`);
                return;
            }
            const summary = detail.files.map(f =>
                `${STATUS_LABEL[f.status] || f.status} ${f.path}${f.prevPath ? ` ← ${f.prevPath}` : ""} (+${f.additions} −${f.deletions})`).join("\n");
            const patch = detail.files.map(f => {
                const head = `diff --git a/${f.prevPath || f.path} b/${f.path}`;
                return f.patch ? `${head}\n${f.patch}` : `${head}\n(${STATUS_LABEL[f.status] || f.status},接口未提供 patch)`;
            }).join("\n");
            openGitDiffDialog(`${c.short} ${c.message.split("\n")[0]}`, patch, `${c.author} · ${c.date}\n${summary}`);
        } catch (e) {
            showMessage(`读取提交详情失败: ${String((e as Error)?.message || e)}`, 6000, "error");
        }
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        if (target.closest(".syfe-githist__refresh")) { void load(); return; }
        const row = target.closest(".syfe-githist__row") as HTMLElement | null;
        if (!row) return;
        const c = commits[Number(row.dataset.idx)];
        if (c) void openCommit(c);
    });

    refSel.addEventListener("change", () => {
        const next = refSel.value;
        if (!next || next === ref) return;
        ref = next;
        opts.onBranchChange?.(next);
        void load();
    });

    void loadRefs();
    void load();
}