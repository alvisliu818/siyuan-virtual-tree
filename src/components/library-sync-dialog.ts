// 插件库条目的 Git 绑定与同步对话框(桌面端)。
//
// 库内条目是指向外部真实路径的正向链接,思源同步不会跟随链接,所以移动端拿不到内容。
// 这里把条目绑定到一个 GitHub / Gitee 仓库(建议私有):桌面端顺着链接读写外部文件并推送到远端,
// 移动端通过同一个远端浏览、编辑、提交,下次桌面同步再把改动写回外部文件。
//
// 冲突处理是**两趟**:第一趟同步只列出冲突不动手,用户逐条选「用本地/用远端」,
// 第二趟带着裁决再同步。没选的一律继续跳过,绝不静默覆盖任何一侧。
import {Dialog, showMessage, confirm} from "siyuan";
import {openGitRepoDialog} from "./git-repo-dialog";
import {openGitHistoryDialog} from "./git-history-dialog";
import {parseGitRepoPath} from "../utils/git-repo-path";
import {
    LibraryGitBinding,
    LibrarySyncReport,
    getLibraryEntry,
    libraryLinkState,
    setLibraryGitBinding,
} from "../api/library";
import {gitListRefs} from "../api/git-repo";
import {syncLibraryEntry} from "../api/library-sync";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bindingLabel(git: LibraryGitBinding): string {
    const host = git.provider === "github" ? "GitHub" : "Gitee";
    return `${host} ${git.owner}/${git.repo}${git.path ? " / " + git.path : ""}`;
}

export function openLibrarySyncDialog(name: string, onChange?: () => void): void {
    const entry = getLibraryEntry(name);
    if (!entry) {
        showMessage(`插件库里没有条目「${name}」`, 4000, "error");
        return;
    }

    // 冲突裁决:rel → 用哪一侧。同步成功后清空(已裁决的文件不再是冲突)
    let resolutions: Record<string, "local" | "remote"> = {};
    let syncing = false;

    const dialog = new Dialog({
        title: `插件库同步:${entry.name}`,
        content: `
            <div class="b3-dialog__content syfe-gitrepo">
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">条目</div>
                    <div class="syfe-gitrepo__hint" id="syfe-lib-entry"></div>
                </div>
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">Git 远程仓库</div>
                    <div class="syfe-gitrepo__hint">
                        ${entry.isDir
                            ? "选一个仓库(可只选其中某个子目录),条目内容会同步到那里。"
                            : "选一个仓库或子目录作为存放位置,远端文件名与条目同名。"}
                        建议用<b>私有仓库</b>并配置访问令牌(设置 → Git 仓库)。空仓库也可以,首次同步会自动建立分支。<br />
                        移动端只能访问已绑定远端的条目。
                    </div>
                    <div class="syfe-gitrepo__status" id="syfe-lib-binding"></div>
                    <div class="syfe-gitrepo__actions">
                        <select class="b3-select syfe-lib__ref" id="syfe-lib-ref" title="绑定分支"></select>
                        <button class="b3-button b3-button--text" id="syfe-lib-pick">选择仓库…</button>
                        <button class="b3-button b3-button--text" id="syfe-lib-history">远端历史</button>
                        <button class="b3-button b3-button--text" id="syfe-lib-unbind">解除绑定</button>
                    </div>
                </div>
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">同步</div>
                    <div class="syfe-gitrepo__hint">
                        双向同步:本地改动推到远端,远端改动写回外部文件。两侧都改过的文件会列为冲突并跳过,
                        可在下方逐条选「用本地/用远端」后再同步一次;远端已删除的文件只报告,<b>不会删除你的外部文件</b>。
                        点开头文件/目录(.env、.gitignore、.vscode 等)照常同步,只排除 .git/.hg/.svn 与内部链接。
                        <b>.env 之类可能含密钥,建议绑定私有仓库。</b>
                    </div>
                    <input class="b3-text-field fn__block syfe-lib__msg" id="syfe-lib-msg"
                        placeholder="提交信息(留空则自动生成)" style="margin:6px 0;" />
                    <div class="syfe-gitrepo__actions">
                        <button class="b3-button" id="syfe-lib-sync">立即同步</button>
                        <span class="syfe-gitrepo__status" id="syfe-lib-status"></span>
                    </div>
                    <div id="syfe-lib-report"></div>
                </div>
            </div>`,
        width: "640px",
    });

    const el = (id: string): HTMLElement => dialog.element.querySelector("#" + id) as HTMLElement;
    const entryEl = el("syfe-lib-entry");
    const bindingEl = el("syfe-lib-binding");
    const statusEl = el("syfe-lib-status");
    const reportEl = el("syfe-lib-report");
    const msgEl = el("syfe-lib-msg") as HTMLInputElement;
    const refSel = el("syfe-lib-ref") as HTMLSelectElement;
    const syncBtn = el("syfe-lib-sync") as HTMLButtonElement;
    const unbindBtn = el("syfe-lib-unbind") as HTMLButtonElement;
    const historyBtn = el("syfe-lib-history") as HTMLButtonElement;

    const list = (title: string, items: string[], note: string): string => items.length === 0 ? "" : `
        <div class="syfe-gitrepo__hint" style="margin-top:8px;">
            <b>${esc(title)}(${items.length})</b> ${esc(note)}<br />
            ${items.slice(0, 20).map(p => `· ${esc(p)}`).join("<br />")}
            ${items.length > 20 ? `<br />… 另有 ${items.length - 20} 项` : ""}
        </div>`;

    const reportHTML = (r: LibrarySyncReport): string => {
        const parts = [
            `推送 ${r.pushed} 个`, `拉取 ${r.pulled} 个`,
            `远端删除 ${r.removedRemote} 个`, `共 ${r.commits} 次提交`,
        ];
        const conflicts = r.conflicts.length === 0 ? "" : `
            <div class="syfe-gitrepo__hint" style="margin-top:8px;">
                <b>冲突(${r.conflicts.length})</b> 两侧都改过。逐条选一边后再点「立即同步」;不选的继续跳过。<br />
                ${r.conflicts.slice(0, 30).map(c => {
                    const rel = c.path === entry.name ? "" : c.path;
                    const pick = resolutions[rel];
                    return `<div class="syfe-lib__conflict">
                        <span class="syfe-lib__conflict-path" title="${esc(c.path)}">${esc(c.path)}</span>
                        <span class="syfe-lib__pick${pick === "local" ? " syfe-lib__pick--on" : ""}" data-rel="${esc(rel)}" data-pick="local">用本地</span>
                        <span class="syfe-lib__pick${pick === "remote" ? " syfe-lib__pick--on" : ""}" data-rel="${esc(rel)}" data-pick="remote">用远端</span>
                    </div>`;
                }).join("")}
                ${r.conflicts.length > 30 ? `<div>… 另有 ${r.conflicts.length - 30} 项</div>` : ""}
            </div>`;
        return `
            <div class="syfe-gitrepo__status">${esc(parts.join(" · "))}${r.at ? ` · ${esc(new Date(r.at).toLocaleString())}` : ""}</div>
            ${conflicts}
            ${list("远端已删除", r.remoteDeleted, "本地文件保持原样,未删除;如需恢复远端请手动处理")}
            ${list("未同步", r.skipped.map(s => `${s.path} — ${s.reason}`), "按规则排除")}`;
    };

    let lastReport: LibrarySyncReport | null = entry.lastReport || null;
    const renderReport = () => {
        reportEl.innerHTML = lastReport ? reportHTML(lastReport) : "";
    };

    const loadRefs = async () => {
        const git = getLibraryEntry(name)?.git;
        if (!git) {
            refSel.innerHTML = `<option value="">未绑定</option>`;
            refSel.disabled = true;
            return;
        }
        refSel.disabled = true;
        refSel.innerHTML = `<option value="${esc(git.ref)}">${esc(git.ref)}</option>`;
        try {
            const refs = await gitListRefs(git.provider, git.owner, git.repo);
            const all = refs.branches.includes(git.ref) ? refs.branches : [git.ref, ...refs.branches];
            refSel.innerHTML = all.map(b => `<option value="${esc(b)}"${b === git.ref ? " selected" : ""}>${esc(b)}</option>`).join("");
        } catch {
            // 分支列表拿不到:保留当前分支,不影响同步
        }
        refSel.disabled = false;
    };

    const renderBinding = () => {
        const cur = getLibraryEntry(name);
        bindingEl.textContent = cur?.git ? `${bindingLabel(cur.git)}@${cur.git.ref}` : "未绑定(移动端无法访问)";
        unbindBtn.style.display = cur?.git ? "" : "none";
        historyBtn.style.display = cur?.git ? "" : "none";
        refSel.style.display = cur?.git ? "" : "none";
        syncBtn.disabled = !cur?.git;
        statusEl.textContent = cur?.lastSyncAt
            ? `上次同步:${new Date(cur.lastSyncAt).toLocaleString()}`
            : "尚未同步过";
    };

    entryEl.textContent = `${entry.target}(${entry.isDir ? "文件夹" : "文件"})`;
    void (async () => {
        try {
            const st = await libraryLinkState(name);
            if (!st.exists) {
                entryEl.innerHTML = `${esc(entry.target)}<br /><b>库内链接已丢失</b>,请取消同步后重新添加`;
            } else if (!st.isLink) {
                entryEl.innerHTML = `${esc(entry.target)}<br /><b>库内已是真实文件而非链接</b>,同步会直接改写它,请确认后再继续`;
            }
        } catch {
            // 状态查不到不影响绑定与同步,保持基础信息
        }
    })();
    renderBinding();
    renderReport();
    void loadRefs();

    const runSync = () => {
        if (syncing) return;
        syncing = true;
        syncBtn.disabled = true;
        void (async () => {
            let ok = false;
            try {
                const report = await syncLibraryEntry(name, msg => { statusEl.textContent = msg; }, {
                    message: msgEl.value,
                    resolutions,
                });
                lastReport = report;
                ok = true;
                // 裁决已生效,清掉避免下次同步误用旧选择
                resolutions = {};
                renderReport();
                onChange?.();
            } catch (e) {
                showMessage(`${(e as Error)?.message || e}`, 8000, "error");
            } finally {
                syncing = false;
                renderBinding();
                // renderBinding 会把状态写回"上次同步/尚未同步过",这里必须覆盖,
                // 否则失败后看起来像什么都没发生
                statusEl.textContent = ok ? "同步完成" : "同步失败";
            }
        })();
    };

    const switchRef = (next: string) => {
        const git = getLibraryEntry(name)?.git;
        if (!git || !next || next === git.ref) return;
        confirm("切换绑定分支",
            `把「${name}」的远端分支从 ${git.ref} 换成 ${next}。\n`
            + "同步基准属于原来那个分支,切换后会清空基准与上次报告:下次同步会把两侧都有的不同文件判为冲突、"
            + "只在一侧的文件当作新增推送或拉取,不会按旧基准删除远端内容。仍要切换吗?",
            () => {
                void (async () => {
                    try {
                        await setLibraryGitBinding(name, {...git, ref: next});
                        resolutions = {};
                        lastReport = null;
                        renderReport();
                        renderBinding();
                        onChange?.();
                        showMessage(`已切换到 ${next},基准已重置`, 4000, "info");
                    } catch (e) {
                        showMessage(`切换分支失败: ${(e as Error)?.message || e}`, 6000, "error");
                        void loadRefs();
                    }
                })();
            },
            () => { void loadRefs(); });
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const pick = target.closest("[data-pick]") as HTMLElement | null;
        if (pick) {
            const rel = pick.dataset.rel || "";
            const side = pick.dataset.pick as "local" | "remote";
            // 再点一次已选中的 = 取消裁决,回到"跳过"
            if (resolutions[rel] === side) delete resolutions[rel];
            else resolutions[rel] = side;
            renderReport();
            return;
        }
        const id = (target.closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-lib-sync") { runSync(); return; }
        if (id === "syfe-lib-history") {
            const git = getLibraryEntry(name)?.git;
            if (!git) return;
            openGitHistoryDialog({
                provider: git.provider, owner: git.owner, repo: git.repo, ref: git.ref,
                path: git.path || undefined,
                title: `远端历史:${name}`,
            });
            return;
        }
        if (id === "syfe-lib-unbind") {
            void (async () => {
                await setLibraryGitBinding(name, null);
                resolutions = {};
                lastReport = null;
                renderReport();
                renderBinding();
                void loadRefs();
                onChange?.();
                showMessage("已解除 Git 绑定,库内链接与外部文件保持原样", 3500, "info");
            })();
            return;
        }
        if (id !== "syfe-lib-pick") return;
        openGitRepoDialog({
            provider: getLibraryEntry(name)?.git?.provider || "github",
            title: `选择「${entry.name}」的远程仓库`,
            onPicked: vPath => {
                void (async () => {
                    const loc = parseGitRepoPath(vPath);
                    if (!loc) {
                        showMessage(`无法识别仓库路径: ${vPath}`, 5000, "error");
                        return;
                    }
                    // 文件条目:选中的是存放目录,远端文件名沿用条目名
                    const git: LibraryGitBinding = {
                        provider: loc.provider,
                        owner: loc.owner,
                        repo: loc.repo,
                        ref: loc.ref,
                        path: entry.isDir ? loc.path : [loc.path, entry.name].filter(Boolean).join("/"),
                    };
                    try {
                        await setLibraryGitBinding(name, git);
                        resolutions = {};
                        lastReport = null;
                        renderReport();
                        renderBinding();
                        void loadRefs();
                        onChange?.();
                        showMessage(`已绑定 ${bindingLabel(git)}@${git.ref},点「立即同步」开始`, 4000, "info");
                    } catch (e) {
                        showMessage(`绑定失败: ${(e as Error)?.message || e}`, 6000, "error");
                    }
                })();
            },
        });
    });

    refSel.addEventListener("change", () => switchRef(refSel.value));
}