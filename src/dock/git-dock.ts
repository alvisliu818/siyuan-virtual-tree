// 侧边栏「Git」面板:对磁盘上的真实仓库做 status / diff / 暂存 / 提交 / 推送 / 拉取 / 分支 / 历史。
//
// 仅桌面端注册:全部能力来自 git CLI(api/git-local.ts),移动端没有 Node。
// 远程仓库(github:// 挂载、插件库绑定)的历史与 diff 走 REST,见 components/git-history-dialog.ts。
import {Dialog, showMessage, confirm} from "siyuan";
import {GIT_DOCK_TYPE} from "../constants";
import {getRoots, MountItem, MOUNT_TREE_CHANGED_EVENT} from "../mount-tree";
import {getWorkspacePath} from "../utils/system-path";
import {basename} from "../utils/path";
import {openGitDiffDialog} from "../components/git-diff-dialog";
import {GIT_OPEN_EVENT} from "../utils/git-panel";
import {
    GitStatus, GitStatusEntry, GitLogEntry, GitBranch,
    isGitLocalAvailable, findRepoRoot, gitLocalStatus, gitLocalDiff,
    gitLocalStage, gitLocalUnstage, gitLocalCommit, gitLocalPushCurrent, gitLocalPull,
    gitLocalBranches, gitLocalCheckout, gitLocalLog, gitLocalShow, gitLocalMergeAbort,
} from "../api/git-local";

export interface IPluginForGit {
    app: any;
    name: string;
    config: any;
}

interface GitDockInstance {
    element: HTMLElement;
    _clickHandler?: (e: MouseEvent) => void;
    _changeHandler?: (e: Event) => void;
    _mountHandler?: () => void;
    _openHandler?: (ev: Event) => void;
    _candidates?: string[];
    _root?: string | null;
    _status?: GitStatus | null;
    _log?: GitLogEntry[];
    _branches?: GitBranch[];
    _tab?: "changes" | "log";
    _busy?: boolean;
}

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 候选仓库路径:挂载树里的文件夹挂载(含嵌套)+ 工作空间根。去重后供下拉选择
function collectCandidates(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (p?: string) => {
        if (!p) return;
        const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
        // 远程虚拟路径不是磁盘仓库,跳过
        if (!norm || /^(github|gitee|bdpan|sydoc):/i.test(norm)) return;
        const key = norm.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(norm);
    };
    const walk = (items: MountItem[]) => {
        for (const it of items) {
            if (it.kind === "file" && it.isDir) push(it.path);
            if (it.children?.length) walk(it.children);
        }
    };
    try {
        walk(getRoots());
    } catch {
        // 挂载树还没初始化:只用工作空间根
    }
    push(getWorkspacePath());
    return out;
}

const STATUS_LABEL: Record<string, string> = {
    M: "修改", A: "新增", D: "删除", R: "改名", C: "复制", U: "冲突", "?": "未跟踪",
};

function entryBadge(e: GitStatusEntry): string {
    if (e.conflicted) return "冲突";
    if (e.untracked) return "未跟踪";
    return STATUS_LABEL[e.index !== " " ? e.index : e.worktree] || "改动";
}

export function createGitDockConfig(plugin: IPluginForGit) {
    return {
        type: GIT_DOCK_TYPE,
        config: {
            position: "LeftBottom" as const,
            size: {width: 280, height: 0},
            icon: "iconGithub",
            title: "Git",
            hotkey: "",
            show: false,
            index: 5,
        },
        data: {},
        init(this: GitDockInstance) {
            this.element.classList.add("syfe-git-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-git__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconGithub"></use></svg>
                        <span class="block__logotext">Git</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-action="pick-path" aria-label="打开其他目录" data-position="north">
                        <svg><use xlink:href="#iconFolder"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                </div>
                <div class="syfe-git__repo">
                    <select class="b3-select syfe-git__repo-select"></select>
                </div>
                <div class="syfe-git__branchbar">
                    <select class="b3-select syfe-git__branch-select" title="切换分支"></select>
                    <span class="syfe-git__aheadbehind"></span>
                    <span class="block__icon ariaLabel" data-action="new-branch" aria-label="新建分支" data-position="north">
                        <svg><use xlink:href="#iconAdd"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="pull" aria-label="拉取" data-position="north">
                        <svg><use xlink:href="#iconDownload"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="push" aria-label="推送" data-position="north">
                        <svg><use xlink:href="#iconUpload"></use></svg>
                    </span>
                </div>
                <div class="syfe-git__tabs">
                    <span class="syfe-git__tab syfe-git__tab--on" data-tab="changes">改动</span>
                    <span class="syfe-git__tab" data-tab="log">历史</span>
                </div>
                <div class="fn__flex-1 syfe-git__scroll">
                    <div class="syfe-git__body"></div>
                </div>
                <div class="syfe-git__commitbar">
                    <textarea class="b3-text-field syfe-git__msg" rows="2" placeholder="提交信息(必填)"></textarea>
                    <button class="b3-button b3-button--text syfe-git__commit">提交</button>
                </div>`;

            const self = this;
            const bodyEl = this.element.querySelector(".syfe-git__body") as HTMLElement;
            const repoSel = this.element.querySelector(".syfe-git__repo-select") as HTMLSelectElement;
            const branchSel = this.element.querySelector(".syfe-git__branch-select") as HTMLSelectElement;
            const abEl = this.element.querySelector(".syfe-git__aheadbehind") as HTMLElement;
            const msgEl = this.element.querySelector(".syfe-git__msg") as HTMLTextAreaElement;
            const commitBar = this.element.querySelector(".syfe-git__commitbar") as HTMLElement;
            self._tab = "changes";
            self._log = [];
            self._branches = [];

            const setBusy = (v: boolean, note = "") => {
                self._busy = v;
                if (v) bodyEl.innerHTML = `<div class="syfe-git__hint">${esc(note || "读取中…")}</div>`;
            };

            const fail = (e: any) => {
                self._busy = false;
                const msg = String(e?.message || e);
                bodyEl.innerHTML = `<div class="syfe-git__hint syfe-git__hint--error">${esc(msg)}</div>`;
                showMessage(msg, 6000, "error");
            };

            const renderRepoOptions = () => {
                const list = collectCandidates();
                self._candidates = list;
                repoSel.innerHTML = list.map((p, i) =>
                    `<option value="${i}">${esc(basename(p) || p)}</option>`).join("")
                    + `<option value="-1">其他目录…</option>`;
                repoSel.title = self._root || "选择仓库";
            };

            const renderBranches = () => {
                const st = self._status;
                const cur = st?.detached ? `(detached ${st.head})` : (st?.branch || "");
                const locals = self._branches!.filter(b => !b.remote);
                const remotes = self._branches!.filter(b => b.remote);
                branchSel.innerHTML =
                    (st?.detached ? `<option value="" selected>${esc(cur)}</option>` : "")
                    + locals.map(b => `<option value="${esc(b.name)}"${b.name === cur ? " selected" : ""}>${esc(b.name)}</option>`).join("")
                    + (remotes.length ? `<optgroup label="远端">${remotes.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join("")}</optgroup>` : "");
                branchSel.disabled = !self._root;
                const ahead = st?.ahead || 0;
                const behind = st?.behind || 0;
                abEl.textContent = (ahead || behind) ? `↑${ahead} ↓${behind}` : "";
                abEl.title = st?.upstream ? `上游:${st.upstream}` : "没有上游分支";
            };

            const groupRows = (title: string, items: GitStatusEntry[], kind: string): string => {
                if (items.length === 0) return "";
                return `<div class="syfe-git__group">${esc(title)}(${items.length})</div>`
                    + items.map(e => {
                        const idx = self._status!.entries.indexOf(e);
                        const canStage = kind !== "staged";
                        const canUnstage = kind === "staged";
                        return `
                        <div class="syfe-git__row" data-idx="${idx}" data-kind="${kind}" title="${esc(e.path)}">
                            <span class="syfe-git__badge syfe-git__badge--${kind}">${esc(entryBadge(e))}</span>
                            <span class="syfe-git__path">${esc(e.path)}${e.origPath ? `<span class="syfe-git__orig"> ← ${esc(e.origPath)}</span>` : ""}</span>
                            ${canUnstage ? `<span class="syfe-git__mini" data-mini="unstage" title="取消暂存">−</span>` : ""}
                            ${canStage ? `<span class="syfe-git__mini" data-mini="stage" title="暂存">+</span>` : ""}
                        </div>`;
                    }).join("");
            };

            const renderChanges = () => {
                const st = self._status;
                if (!st) return;
                const conflicted = st.entries.filter(e => e.conflicted);
                const staged = st.entries.filter(e => e.staged && !e.conflicted);
                const unstaged = st.entries.filter(e => e.unstaged && !e.conflicted && !e.untracked);
                const untracked = st.entries.filter(e => e.untracked);
                if (st.entries.length === 0) {
                    bodyEl.innerHTML = `<div class="syfe-git__hint">工作区干净,没有改动</div>`;
                    return;
                }
                bodyEl.innerHTML =
                    groupRows("冲突", conflicted, "conflict")
                    + (conflicted.length ? `<div class="syfe-git__group-actions"><span class="syfe-git__link" data-action="merge-abort">中止合并</span></div>` : "")
                    + groupRows("已暂存", staged, "staged")
                    + groupRows("未暂存", unstaged, "unstaged")
                    + groupRows("未跟踪", untracked, "untracked")
                    + `<div class="syfe-git__group-actions">
                         <span class="syfe-git__link" data-action="stage-all">全部暂存</span>
                         <span class="syfe-git__link" data-action="unstage-all">全部取消暂存</span>
                       </div>`;
            };

            const renderLog = () => {
                const list = self._log || [];
                if (list.length === 0) {
                    bodyEl.innerHTML = `<div class="syfe-git__hint">没有提交历史</div>`;
                    return;
                }
                bodyEl.innerHTML = list.map((c, i) => `
                    <div class="syfe-git__commit-row" data-log="${i}" title="${esc(c.sha)}">
                        <span class="syfe-git__sha">${esc(c.short)}</span>
                        <span class="syfe-git__subject">${esc(c.subject)}</span>
                        <span class="syfe-git__meta">${esc(c.author)} · ${esc(c.date.slice(0, 10))}</span>
                    </div>`).join("");
            };

            const render = () => {
                const tabs = Array.from(this.element.querySelectorAll(".syfe-git__tab"));
                tabs.forEach(t => t.classList.toggle("syfe-git__tab--on", (t as HTMLElement).dataset.tab === self._tab));
                commitBar.style.display = self._tab === "changes" && !!self._root ? "" : "none";
                renderBranches();
                if (!self._root) {
                    bodyEl.innerHTML = `<div class="syfe-git__hint">所选目录不在 Git 仓库里。换一个目录,或点右上角文件夹图标手动指定。</div>`;
                    return;
                }
                if (self._tab === "changes") renderChanges();
                else renderLog();
            };

            // 读状态 + 分支 + 历史(历史只在切到历史页时才拉,省一次 git 调用)
            const reload = async (withLog = false) => {
                if (!self._root) { render(); return; }
                setBusy(true, "读取仓库状态…");
                try {
                    const [st, br] = await Promise.all([
                        gitLocalStatus(self._root),
                        gitLocalBranches(self._root).catch(() => [] as GitBranch[]),
                    ]);
                    self._status = st;
                    self._branches = br;
                    if (withLog || self._tab === "log") {
                        self._log = await gitLocalLog(self._root, {limit: 50}).catch(() => [] as GitLogEntry[]);
                    }
                    self._busy = false;
                    render();
                } catch (e) {
                    fail(e);
                }
            };

            const selectRepo = async (path: string) => {
                setBusy(true, "定位仓库…");
                const root = await findRepoRoot(path);
                self._root = root;
                self._status = null;
                self._log = [];
                repoSel.title = root || path;
                if (!root) {
                    self._busy = false;
                    render();
                    return;
                }
                await reload(true);
            };

            // 提交信息框回车提交(Ctrl+Enter 换行);Shift+Enter 也换行
            msgEl.addEventListener("keydown", (ev: KeyboardEvent) => {
                if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
                    ev.preventDefault();
                    void doCommit();
                }
            });

            const doCommit = async () => {
                if (!self._root || self._busy) return;
                const msg = msgEl.value.trim();
                if (!msg) { showMessage("请填写提交信息", 3000, "info"); return; }
                const st = self._status;
                if (!st || !st.entries.some(e => e.staged)) {
                    showMessage("没有已暂存的改动。先点行末 + 暂存,或「全部暂存」", 4000, "info");
                    return;
                }
                setBusy(true, "提交中…");
                try {
                    await gitLocalCommit(self._root, msg);
                    msgEl.value = "";
                    showMessage("已提交", 2000, "info");
                    await reload(true);
                } catch (e) { fail(e); }
            };

            const doPush = async () => {
                if (!self._root || self._busy) return;
                setBusy(true, "推送中…");
                try {
                    await gitLocalPushCurrent(self._root);
                    showMessage("推送完成", 2500, "info");
                    await reload();
                } catch (e) { fail(e); }
            };

            const doPull = async () => {
                if (!self._root || self._busy) return;
                setBusy(true, "拉取中…");
                try {
                    await gitLocalPull(self._root);
                    showMessage("拉取完成", 2500, "info");
                    await reload(true);
                } catch (e) {
                    // 拉取失败往往已经改了仓库状态(最常见:合并冲突)。
                    // 必须把状态读回来,否则用户看不到冲突文件、无从下手
                    showMessage(String((e as Error)?.message || e), 6000, "error");
                    await reload(true).catch(() => fail(e));
                }
            };

            const doMergeAbort = () => {
                if (!self._root) return;
                confirm("中止合并", "确定中止本次合并吗?工作区会回到合并前的状态,合并带来的改动全部丢弃。", () => {
                    void (async () => {
                        setBusy(true, "中止合并…");
                        try {
                            await gitLocalMergeAbort(self._root!);
                            showMessage("已中止合并", 2500, "info");
                            await reload(true);
                        } catch (e) { fail(e); }
                    })();
                }, () => {});
            };

            const openPathPicker = () => {
                const d = new Dialog({
                    title: "打开 Git 仓库",
                    content: `<div class="b3-dialog__content" style="padding:12px;">
                        <div class="b3-label__text" style="margin-bottom:8px;">填写仓库内任意文件或文件夹的绝对路径</div>
                        <input class="b3-text-field fn__block syfe-git__path-input" placeholder="E:/path/to/repo" />
                        <div style="margin-top:12px;text-align:right;"><button class="b3-button syfe-git__path-ok">打开</button></div>
                    </div>`,
                    width: "480px",
                });
                const input = d.element.querySelector(".syfe-git__path-input") as HTMLInputElement;
                input.focus();
                const ok = () => {
                    const v = input.value.trim();
                    if (!v) return;
                    d.destroy();
                    void selectRepo(v);
                };
                d.element.querySelector(".syfe-git__path-ok")!.addEventListener("click", ok);
                input.addEventListener("keydown", (ev: KeyboardEvent) => { if (ev.key === "Enter") ok(); });
            };

            const newBranch = () => {
                if (!self._root) return;
                const d = new Dialog({
                    title: "新建分支",
                    content: `<div class="b3-dialog__content" style="padding:12px;">
                        <div class="b3-label__text" style="margin-bottom:8px;">从当前 HEAD 新建并切换</div>
                        <input class="b3-text-field fn__block syfe-git__nb-input" placeholder="feature/xxx" />
                        <div style="margin-top:12px;text-align:right;"><button class="b3-button syfe-git__nb-ok">创建</button></div>
                    </div>`,
                    width: "420px",
                });
                const input = d.element.querySelector(".syfe-git__nb-input") as HTMLInputElement;
                input.focus();
                const ok = () => {
                    const name = input.value.trim();
                    if (!name) return;
                    d.destroy();
                    void (async () => {
                        setBusy(true, "创建分支…");
                        try {
                            await gitLocalCheckout(self._root!, name, true);
                            showMessage(`已切换到 ${name}`, 2500, "info");
                            await reload();
                        } catch (e) { fail(e); }
                    })();
                };
                d.element.querySelector(".syfe-git__nb-ok")!.addEventListener("click", ok);
                input.addEventListener("keydown", (ev: KeyboardEvent) => { if (ev.key === "Enter") ok(); });
            };

            const clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const mini = target.closest("[data-mini]") as HTMLElement | null;
                if (mini && self._root && !self._busy) {
                    const row = mini.closest(".syfe-git__row") as HTMLElement | null;
                    const entry = self._status?.entries[Number(row?.dataset.idx)];
                    if (!entry) return;
                    void (async () => {
                        setBusy(true, mini.dataset.mini === "stage" ? "暂存中…" : "取消暂存…");
                        try {
                            if (mini.dataset.mini === "stage") await gitLocalStage(self._root!, [entry.path]);
                            else await gitLocalUnstage(self._root!, [entry.path]);
                            await reload();
                        } catch (err) { fail(err); }
                    })();
                    return;
                }
                const commitRow = target.closest("[data-log]") as HTMLElement | null;
                if (commitRow && self._root) {
                    const c = self._log?.[Number(commitRow.dataset.log)];
                    if (!c) return;
                    void (async () => {
                        try {
                            const text = await gitLocalShow(self._root!, c.sha);
                            openGitDiffDialog(`${c.short} ${c.subject}`, text, `${c.author} · ${c.date}`);
                        } catch (err) { fail(err); }
                    })();
                    return;
                }
                const row = target.closest(".syfe-git__row") as HTMLElement | null;
                if (row && self._root) {
                    const entry = self._status?.entries[Number(row.dataset.idx)];
                    if (!entry) return;
                    void (async () => {
                        try {
                            const stagedOnly = entry.staged && !entry.unstaged;
                            const text = await gitLocalDiff(self._root!, {
                                staged: stagedOnly,
                                path: entry.path,
                                untracked: entry.untracked,
                            });
                            openGitDiffDialog(entry.path, text, stagedOnly ? "已暂存的改动" : entry.untracked ? "未跟踪文件" : "工作区改动");
                        } catch (err) { fail(err); }
                    })();
                    return;
                }
                const tab = target.closest("[data-tab]") as HTMLElement | null;
                if (tab) {
                    self._tab = tab.dataset.tab as "changes" | "log";
                    if (self._tab === "log" && self._root && (self._log || []).length === 0) void reload(true);
                    else render();
                    return;
                }
                const actionEl = target.closest("[data-action]") as HTMLElement | null;
                if (!actionEl) return;
                const action = actionEl.dataset.action;
                if (action === "refresh") { renderRepoOptions(); void reload(true); }
                else if (action === "pick-path") openPathPicker();
                else if (action === "push") void doPush();
                else if (action === "pull") void doPull();
                else if (action === "new-branch") newBranch();
                else if (action === "merge-abort") doMergeAbort();
                else if (action === "commit") void doCommit();
                else if (action === "stage-all" && self._root) {
                    const paths = self._status!.entries.filter(x => !x.staged || x.conflicted).map(x => x.path);
                    if (paths.length === 0) return;
                    void (async () => {
                        setBusy(true, "暂存中…");
                        try { await gitLocalStage(self._root!, paths); await reload(); } catch (err) { fail(err); }
                    })();
                } else if (action === "unstage-all" && self._root) {
                    const paths = self._status!.entries.filter(x => x.staged).map(x => x.path);
                    if (paths.length === 0) return;
                    void (async () => {
                        setBusy(true, "取消暂存…");
                        try { await gitLocalUnstage(self._root!, paths); await reload(); } catch (err) { fail(err); }
                    })();
                }
            };
            this._clickHandler = clickHandler;
            this.element.addEventListener("click", clickHandler);

            // 提交按钮没有 data-action(它在 commitbar 里),单独挂
            const commitBtn = this.element.querySelector(".syfe-git__commit") as HTMLElement;
            commitBtn.addEventListener("click", () => void doCommit());

            const changeHandler = (e: Event) => {
                const el = e.target as HTMLElement;
                if (el === repoSel) {
                    const v = Number(repoSel.value);
                    if (v === -1) { openPathPicker(); return; }
                    const path = self._candidates?.[v];
                    if (path) void selectRepo(path);
                    return;
                }
                if (el === branchSel) {
                    const name = branchSel.value;
                    if (!name || !self._root) return;
                    const cur = self._status?.branch;
                    if (name === cur) return;
                    const dirty = (self._status?.entries.length || 0) > 0;
                    const go = () => {
                        void (async () => {
                            setBusy(true, "切换分支…");
                            try {
                                await gitLocalCheckout(self._root!, name);
                                showMessage(`已切换到 ${name}`, 2500, "info");
                                await reload(true);
                            } catch (err) { fail(err); }
                        })();
                    };
                    // 带着未提交改动切分支可能失败或把改动带过去,先说清楚
                    if (dirty) confirm("切换分支", `当前有 ${self._status!.entries.length} 处未提交改动,切换分支可能失败或把改动带到新分支。仍要切换到「${name}」吗?`, go, () => { renderBranches(); });
                    else go();
                }
            };
            this._changeHandler = changeHandler;
            repoSel.addEventListener("change", changeHandler);
            branchSel.addEventListener("change", changeHandler);

            const mountHandler = () => { renderRepoOptions(); };
            this._mountHandler = mountHandler;
            window.addEventListener(MOUNT_TREE_CHANGED_EVENT, mountHandler);

            // 右键菜单「打开 Git 面板」:定位到指定路径所属仓库
            const openHandler = (ev: Event) => {
                const path = String((ev as CustomEvent).detail?.path || "");
                if (path) void selectRepo(path);
            };
            this._openHandler = openHandler;
            window.addEventListener(GIT_OPEN_EVENT, openHandler);

            renderRepoOptions();
            void (async () => {
                if (!(await isGitLocalAvailable())) {
                    bodyEl.innerHTML = `<div class="syfe-git__hint syfe-git__hint--error">找不到 git 命令。请确认已安装 Git 并加入 PATH。</div>`;
                    return;
                }
                const first = self._candidates?.[0];
                if (first) await selectRepo(first);
                else render();
            })();
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: GitDockInstance) {
            if (this._clickHandler) this.element.removeEventListener("click", this._clickHandler);
            if (this._mountHandler) window.removeEventListener(MOUNT_TREE_CHANGED_EVENT, this._mountHandler);
            if (this._openHandler) window.removeEventListener(GIT_OPEN_EVENT, this._openHandler);
            this._clickHandler = undefined;
            this._changeHandler = undefined;
            this._mountHandler = undefined;
            this._openHandler = undefined;
            this._candidates = undefined;
            this._root = undefined;
            this._status = undefined;
            this._log = undefined;
            this._branches = undefined;
        },
    };
}