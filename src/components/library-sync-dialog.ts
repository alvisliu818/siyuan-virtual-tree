// 插件库条目的 Git 绑定与同步对话框(桌面端)。
//
// 库内条目是指向外部真实路径的正向链接,思源同步不会跟随链接,所以移动端拿不到内容。
// 这里把条目绑定到一个 GitHub / Gitee 仓库(建议私有):桌面端顺着链接读写外部文件并推送到远端,
// 移动端通过同一个远端浏览、编辑、提交,下次桌面同步再把改动写回外部文件。
import {Dialog, showMessage} from "siyuan";
import {openGitRepoDialog} from "./git-repo-dialog";
import {parseGitRepoPath} from "../utils/git-repo-path";
import {
    LibraryGitBinding,
    getLibraryEntry,
    libraryLinkState,
    setLibraryGitBinding,
} from "../api/library";
import {LibrarySyncReport, syncLibraryEntry} from "../api/library-sync";

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bindingLabel(git: LibraryGitBinding): string {
    const host = git.provider === "github" ? "GitHub" : "Gitee";
    return `${host} ${git.owner}/${git.repo}@${git.ref}${git.path ? " / " + git.path : ""}`;
}

function reportHTML(r: LibrarySyncReport): string {
    const parts = [
        `推送 ${r.pushed} 个`,
        `拉取 ${r.pulled} 个`,
        `远端删除 ${r.removedRemote} 个`,
        `共 ${r.commits} 次提交`,
    ];
    const list = (title: string, items: string[], note: string): string => items.length === 0 ? "" : `
        <div class="syfe-gitrepo__hint" style="margin-top:8px;">
            <b>${esc(title)}(${items.length})</b> ${esc(note)}<br />
            ${items.slice(0, 20).map(p => `· ${esc(p)}`).join("<br />")}
            ${items.length > 20 ? `<br />… 另有 ${items.length - 20} 项` : ""}
        </div>`;
    return `
        <div class="syfe-gitrepo__status">${esc(parts.join(" · "))}</div>
        ${list("冲突", r.conflicts.map(c => `${c.path} — ${c.reason}`), "两侧都改过,已跳过,请手动决定保留哪一份")}
        ${list("远端已删除", r.remoteDeleted, "本地文件保持原样,未删除;如需恢复远端请手动处理")}
        ${list("未同步", r.skipped.map(s => `${s.path} — ${s.reason}`), "按规则排除")}`;
}

export function openLibrarySyncDialog(name: string, onChange?: () => void): void {
    const entry = getLibraryEntry(name);
    if (!entry) {
        showMessage(`插件库里没有条目「${name}」`, 4000, "error");
        return;
    }

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
                        <button class="b3-button b3-button--text" id="syfe-lib-pick">选择仓库…</button>
                        <button class="b3-button b3-button--text" id="syfe-lib-unbind">解除绑定</button>
                    </div>
                </div>
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">同步</div>
                    <div class="syfe-gitrepo__hint">
                        双向同步:本地改动推到远端,远端改动写回外部文件。两侧都改过的文件会列为冲突并跳过,不会静默覆盖;
                        远端已删除的文件只报告,<b>不会删除你的外部文件</b>。点号开头的文件/目录(.git、.env 等)与内部链接不同步。
                    </div>
                    <div class="syfe-gitrepo__actions">
                        <button class="b3-button" id="syfe-lib-sync">立即同步</button>
                        <span class="syfe-gitrepo__status" id="syfe-lib-status"></span>
                    </div>
                    <div id="syfe-lib-report"></div>
                </div>
            </div>`,
        width: "600px",
    });

    const el = (id: string): HTMLElement => dialog.element.querySelector("#" + id) as HTMLElement;
    const entryEl = el("syfe-lib-entry");
    const bindingEl = el("syfe-lib-binding");
    const statusEl = el("syfe-lib-status");
    const reportEl = el("syfe-lib-report");
    const syncBtn = el("syfe-lib-sync") as HTMLButtonElement;
    const unbindBtn = el("syfe-lib-unbind") as HTMLButtonElement;
    let syncing = false;

    const renderBinding = () => {
        const cur = getLibraryEntry(name);
        bindingEl.textContent = cur?.git ? bindingLabel(cur.git) : "未绑定(移动端无法访问)";
        unbindBtn.style.display = cur?.git ? "" : "none";
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

    const runSync = () => {
        if (syncing) return;
        syncing = true;
        syncBtn.disabled = true;
        reportEl.innerHTML = "";
        void (async () => {
            try {
                const report = await syncLibraryEntry(name, msg => { statusEl.textContent = msg; });
                reportEl.innerHTML = reportHTML(report);
                statusEl.textContent = "同步完成";
                onChange?.();
            } catch (e) {
                statusEl.textContent = "同步失败";
                showMessage(`${(e as Error)?.message || e}`, 8000, "error");
            } finally {
                syncing = false;
                renderBinding();
            }
        })();
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const id = ((ev.target as HTMLElement).closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-lib-sync") {
            runSync();
            return;
        }
        if (id === "syfe-lib-unbind") {
            void (async () => {
                await setLibraryGitBinding(name, null);
                renderBinding();
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
                        renderBinding();
                        onChange?.();
                        showMessage(`已绑定 ${bindingLabel(git)},点「立即同步」开始`, 4000, "info");
                    } catch (e) {
                        showMessage(`绑定失败: ${(e as Error)?.message || e}`, 6000, "error");
                    }
                })();
            },
        });
    });
}