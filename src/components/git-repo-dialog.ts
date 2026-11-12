// GitHub / Gitee 仓库挂载对话框:仓库地址 → 分支/标签 → 逐层浏览后挂载。
// - 仓库区:粘贴 https 地址 / git@ SSH 地址 / owner/repo 简写,或从「我的仓库」里选
//   (按已保存令牌的可见范围列出);读取仓库信息与分支列表;
//   分支名含斜杠(feature/login)也能正确往返(虚拟路径里 ref 按 URL 编码存放)。
// - 令牌区:两家各一个可选令牌。公开仓库不填也能浏览,但匿名配额只有 60 次/小时,
//   且写回提交必须有令牌。
// - 挂载区(onPicked 提供时显示):可挂仓库根、子目录,也可挂单个文件;
//   allowDestPick 时还能选挂到虚拟文档树的哪个位置(默认取调用方右键落点)。
// 挂载结果回调 onPicked(vPath, label, {isDir, parentUid}),vPath 为 github:// 或 gitee:// 虚拟路径。
import {Dialog, showMessage} from "siyuan";
import {
    getGitRepoConfig,
    gitListDir,
    gitListMyRepos,
    gitListRefs,
    gitRepoInfo,
    gitVerifyToken,
    saveGitRepoConfig,
    GitMyRepo,
} from "../api/git-repo";
import {
    GitProvider,
    buildGitRepoPath,
    gitRepoRootLabel,
    parseRepoInput,
} from "../utils/git-repo-path";
import {listMountTargets} from "../mount-tree";
import {fileIconHTML} from "../utils/icons";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PROVIDER_LABEL: Record<GitProvider, string> = {github: "GitHub", gitee: "Gitee"};

export interface GitPickInfo {
    isDir: boolean;
    parentUid: string | null;
}

export function openGitRepoDialog(opts: {
    provider?: GitProvider;
    title?: string;
    onPicked?: (vPath: string, label: string, info: GitPickInfo) => void;
    // 显示「挂载位置」下拉(挂载入口用;库绑定入口不需要)
    allowDestPick?: boolean;
    // 默认挂载位置;传函数时打开对话框才解析(虚拟文档/块行的落点是异步解析的)
    defaultParentUid?: string | null | (() => Promise<string | null>);
} = {}): void {
    const title = opts.title || "Git 仓库";
    const cfg = getGitRepoConfig();
    // 入口 provider 只用于裸 owner/repo 简写的归属;粘贴完整地址时以地址里的主机名为准
    const entryProvider: GitProvider = opts.provider || "github";
    let curProvider: GitProvider = entryProvider;
    let curRepo: {owner: string; repo: string} | null = null;
    let curRef = "";
    let browseSub = "";      // 仓库内相对路径,"" = 仓库根
    let repoLoading = false;
    let destUid: string | null = null;
    let myRepos: GitMyRepo[] = [];
    let myReposLoading = false;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-gitrepo">
                <div class="syfe-gitrepo__sec" id="syfe-git-repo-sec">
                    <div class="syfe-gitrepo__title">仓库</div>
                    <div class="syfe-gitrepo__hint">粘贴仓库地址(如 https://github.com/siyuan-note/siyuan、git@gitee.com:owner/repo.git),或直接填 owner/repo 简写;也可以从「我的仓库」里选。</div>
                    <label class="syfe-gitrepo__field"><span>地址</span><input id="syfe-git-url" type="text" class="b3-text-field fn__flex-1" placeholder="${entryProvider === "gitee" ? "https://gitee.com/owner/repo 或 owner/repo" : "https://github.com/owner/repo 或 owner/repo"}" /></label>
                    <label class="syfe-gitrepo__field"><span>我的仓库</span>
                        <select id="syfe-git-myrepos" class="b3-select fn__flex-1"><option value="">点右侧按钮按令牌列出</option></select>
                        <button class="b3-button b3-button--text" id="syfe-git-myrepos-load" style="flex:none;">列出</button>
                    </label>
                    <label class="syfe-gitrepo__field"><span>分支</span><select id="syfe-git-ref" class="b3-select fn__flex-1"><option value="">先读取仓库</option></select></label>
                    <div class="syfe-gitrepo__actions">
                        <button class="b3-button b3-button--text" id="syfe-git-load">读取仓库</button>
                        <span class="syfe-gitrepo__status" id="syfe-git-repo-status"></span>
                    </div>
                </div>
                <div class="syfe-gitrepo__sec">
                    <div class="syfe-gitrepo__title">访问令牌(可选)</div>
                    <div class="syfe-gitrepo__hint">公开仓库不填令牌也能浏览,但匿名配额仅 60 次/小时;<b>私有仓库与写回提交必须填令牌</b>。<br />GitHub:Settings → Developer settings → Personal access tokens(classic 勾 repo,细粒度给 Contents 读写);Gitee:设置 → 私人令牌(勾 projects)。令牌仅保存在本地插件数据。</div>
                    <label class="syfe-gitrepo__field"><span>GitHub</span><input id="syfe-git-token-github" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.githubToken)}" placeholder="ghp_… / github_pat_…(可留空)" /></label>
                    <label class="syfe-gitrepo__field"><span>Gitee</span><input id="syfe-git-token-gitee" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.giteeToken)}" placeholder="Gitee 私人令牌(可留空)" /></label>
                    <div class="syfe-gitrepo__actions">
                        <button class="b3-button b3-button--text" id="syfe-git-token-save">保存并验证</button>
                        <span class="syfe-gitrepo__status" id="syfe-git-token-status"></span>
                    </div>
                </div>
                <div class="syfe-gitrepo__sec" id="syfe-git-mount-sec" style="display:none;">
                    <div class="syfe-gitrepo__title">选择挂载目标</div>
                    <label class="syfe-gitrepo__field" id="syfe-git-dest-field" style="display:none;"><span>挂载位置</span>
                        <select id="syfe-git-dest" class="b3-select fn__flex-1"></select>
                    </label>
                    <div class="syfe-mount__crumb" id="syfe-git-crumb"></div>
                    <div class="syfe-mount__list" id="syfe-git-list"></div>
                </div>
            </div>`,
        width: "600px",
    });
    const urlEl = dialog.element.querySelector("#syfe-git-url") as HTMLInputElement;
    const refEl = dialog.element.querySelector("#syfe-git-ref") as HTMLSelectElement;
    const repoStatusEl = dialog.element.querySelector("#syfe-git-repo-status") as HTMLElement;
    const tokenStatusEl = dialog.element.querySelector("#syfe-git-token-status") as HTMLElement;
    const crumbEl = dialog.element.querySelector("#syfe-git-crumb") as HTMLElement;
    const listEl = dialog.element.querySelector("#syfe-git-list") as HTMLElement;
    const mountSecEl = dialog.element.querySelector("#syfe-git-mount-sec") as HTMLElement;
    const repoSecEl = dialog.element.querySelector("#syfe-git-repo-sec") as HTMLElement;
    const destFieldEl = dialog.element.querySelector("#syfe-git-dest-field") as HTMLElement;
    const destEl = dialog.element.querySelector("#syfe-git-dest") as HTMLSelectElement;
    const myReposEl = dialog.element.querySelector("#syfe-git-myrepos") as HTMLSelectElement;
    if (opts.onPicked) mountSecEl.style.display = "";
    else repoSecEl.style.display = "none";   // 设置页进来只配令牌

    // 挂载位置下拉:顶层 + 现有全部挂载项(与右键「挂载到…下」同一份目标列表)
    const renderDestOptions = () => {
        const targets = listMountTargets();
        destEl.innerHTML = targets.map(t =>
            `<option value="${escapeHTML(t.uid || "")}">${escapeHTML(t.label)}</option>`).join("");
        destEl.value = destUid || "";
    };
    if (opts.onPicked && opts.allowDestPick) {
        destFieldEl.style.display = "";
        renderDestOptions();
        void (async () => {
            const d = opts.defaultParentUid;
            destUid = typeof d === "function" ? await d() : (d ?? null);
            destEl.value = destUid || "";
        })();
    }

    const inputVal = (id: string): string => ((dialog.element.querySelector("#" + id) as HTMLInputElement)?.value || "").trim();
    const curVPath = (): string => buildGitRepoPath({
        provider: curProvider,
        owner: curRepo!.owner,
        repo: curRepo!.repo,
        ref: curRef,
        path: browseSub,
    });

    const pick = (vPath: string, label: string, isDir: boolean) => {
        dialog.destroy();
        opts.onPicked?.(vPath, label, {isDir, parentUid: destUid});
    };

    // 渲染挂载区:仓库根 / 子目录浏览层
    const renderMount = async () => {
        if (!curRepo || !curRef) {
            crumbEl.innerHTML = `<span>选择挂载目标</span>`;
            listEl.innerHTML = `<div class="syfe-mount__hint">请先在上方填写仓库地址并点「读取仓库」</div>`;
            return;
        }
        const vPath = curVPath();
        const label = gitRepoRootLabel(vPath).replace(/^\[[^\]]+\]\s*/, "");
        crumbEl.innerHTML = `
            ${browseSub ? `<span class="syfe-mount__back" data-act="back" title="返回上一级">‹ 返回</span>` : ""}
            <span class="syfe-mount__mountcur" title="${escapeHTML(label)}">${escapeHTML(label)}</span>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--small" data-act="pick-cur">${browseSub ? "挂载当前目录" : "挂载仓库根"}</button>`;
        listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
        try {
            const entries = await gitListDir(vPath);
            // 目录在前、文件在后;文件也能直接挂(挂单个文件时下游按文件打开,不展开)
            const sorted = [...entries].sort((a, b) =>
                (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
            if (sorted.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">空目录(可直接挂载当前目录)</div>`;
                return;
            }
            listEl.innerHTML = sorted.map(e => `
                <div class="syfe-mount__row" data-vpath="${escapeHTML(e.path || "")}" data-name="${escapeHTML(e.name)}" data-isdir="${e.isDir ? "1" : "0"}">
                    ${e.isDir
                        ? `<svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>`
                        : `<span class="syfe-mount__icon">${fileIconHTML(e.name)}</span>`}
                    <span class="syfe-mount__name" title="${escapeHTML(e.name)}">${escapeHTML(e.name)}</span>
                    <span class="fn__flex-1"></span>
                    ${e.isDir ? `<button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>` : ""}
                    <button class="b3-button b3-button--small" data-act="pick">挂载</button>
                </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String((e as any)?.message || e))}</div>`;
        }
    };

    // 读取仓库:解析地址 → 仓库信息 + 分支/标签 → 渲染挂载区
    const loadRepo = () => {
        if (repoLoading) return;
        const parsed = parseRepoInput(urlEl.value, curProvider);
        if (!parsed) {
            showMessage("无法识别仓库地址,请填 https 地址或 owner/repo", 4000, "error");
            return;
        }
        curProvider = parsed.provider;
        curRepo = {owner: parsed.owner, repo: parsed.repo};
        repoLoading = true;
        repoStatusEl.textContent = "读取中…";
        void (async () => {
            try {
                const info = await gitRepoInfo(curProvider, parsed.owner, parsed.repo);
                const refs = await gitListRefs(curProvider, parsed.owner, parsed.repo);
                const want = parsed.ref || info.defaultBranch;
                const opts: string[] = [];
                const group = (name: string, list: string[]) => {
                    if (list.length === 0) return;
                    opts.push(`<optgroup label="${name}">${list.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join("")}</optgroup>`);
                };
                group("分支", refs.branches);
                group("标签", refs.tags);
                // 地址里带的 ref 不在列表里(如 commit SHA、超出 100 条的分支)也要能选
                if (want && !refs.branches.includes(want) && !refs.tags.includes(want)) {
                    opts.unshift(`<option value="${escapeHTML(want)}">${escapeHTML(want)}</option>`);
                }
                refEl.innerHTML = opts.length ? opts.join("") : `<option value="${escapeHTML(want)}">${escapeHTML(want)}</option>`;
                curRef = want;
                refEl.value = want;
                browseSub = "";
                repoStatusEl.textContent = `${PROVIDER_LABEL[curProvider]} ${parsed.owner}/${parsed.repo} · ${info.isPrivate ? "私有" : "公开"}${info.description ? " · " + info.description : ""}`;
                await renderMount();
            } catch (e) {
                curRepo = null;
                curRef = "";
                repoStatusEl.textContent = "读取失败";
                refEl.innerHTML = `<option value="">先读取仓库</option>`;
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
                await renderMount();
            } finally {
                repoLoading = false;
            }
        })();
    };

    // 保存令牌:两家一起存,只验证填了的那家
    const saveTokens = () => {
        const githubToken = inputVal("syfe-git-token-github");
        const giteeToken = inputVal("syfe-git-token-gitee");
        tokenStatusEl.textContent = "保存中…";
        void (async () => {
            await saveGitRepoConfig({githubToken, giteeToken});
            const parts: string[] = [];
            const failed: string[] = [];
            for (const [provider, token] of [["github", githubToken], ["gitee", giteeToken]] as [GitProvider, string][]) {
                if (!token) continue;
                try {
                    const login = await gitVerifyToken(provider);
                    parts.push(`${PROVIDER_LABEL[provider]}: ${login || "已连接"}`);
                } catch (e) {
                    failed.push(`${PROVIDER_LABEL[provider]}: ${(e as any)?.message || e}`);
                }
            }
            tokenStatusEl.textContent = parts.length || failed.length
                ? [...parts, ...failed].join(" / ")
                : "未填令牌(公开仓库可浏览,写回提交需要令牌)";
            if (failed.length) showMessage(failed.join("\n"), 6000, "error");
            else if (parts.length) showMessage("令牌验证通过", 2500, "info");
            // 换令牌后可见仓库范围会变,已读过的仓库重新拉一次
            if (curRepo) loadRepo();
        })();
    };

    // 按已保存令牌列出可见仓库,选中即填地址并读取
    const loadMyRepos = () => {
        if (myReposLoading) return;
        myReposLoading = true;
        myReposEl.innerHTML = `<option value="">读取中…</option>`;
        void (async () => {
            try {
                myRepos = await gitListMyRepos(curProvider);
                if (myRepos.length === 0) {
                    myReposEl.innerHTML = `<option value="">该令牌下没有仓库</option>`;
                    return;
                }
                myReposEl.innerHTML = `<option value="">共 ${myRepos.length} 个,选一个…</option>`
                    + myRepos.map((r, i) =>
                        `<option value="${i}">${escapeHTML(r.fullName)}${r.isPrivate ? "(私有)" : ""}</option>`).join("");
            } catch (e) {
                myReposEl.innerHTML = `<option value="">列出失败</option>`;
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
            } finally {
                myReposLoading = false;
            }
        })();
    };

    refEl.addEventListener("change", () => {
        curRef = refEl.value;
        browseSub = "";
        void renderMount();
    });
    urlEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            loadRepo();
        }
    });
    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const id = (target.closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-git-load") {
            loadRepo();
            return;
        }
        if (id === "syfe-git-token-save") {
            saveTokens();
            return;
        }
        if (id === "syfe-git-myrepos-load") {
            loadMyRepos();
            return;
        }
        if (!mountSecEl.contains(target)) return;
        const btn = target.closest("[data-act]") as HTMLElement | null;
        const row = target.closest(".syfe-mount__row") as HTMLElement | null;
        const enter = (vPath: string) => {
            // 行上的 vpath 是完整虚拟路径,取仓库内相对部分作为浏览位置
            const base = buildGitRepoPath({provider: curProvider, owner: curRepo!.owner, repo: curRepo!.repo, ref: curRef, path: ""});
            browseSub = vPath.startsWith(base + "/") ? vPath.slice(base.length + 1) : "";
            void renderMount();
        };
        if (btn) {
            const act = btn.dataset.act;
            if (act === "back") {
                const idx = browseSub.lastIndexOf("/");
                browseSub = idx > 0 ? browseSub.slice(0, idx) : "";
                void renderMount();
                return;
            }
            if (act === "pick" && row?.dataset.vpath) {
                pick(row.dataset.vpath, row.dataset.name || "仓库条目", row.dataset.isdir === "1");
                return;
            }
            if (act === "pick-cur" && curRepo) {
                pick(curVPath(), browseSub || `${curRepo.owner}/${curRepo.repo}@${curRef}`, true);
                return;
            }
            if (act === "enter" && row?.dataset.vpath) {
                enter(row.dataset.vpath);
                return;
            }
            return;
        }
        // 点行本身:目录进入浏览,文件不响应(文件用行末「挂载」)
        if (row?.dataset.vpath && row.dataset.isdir === "1") enter(row.dataset.vpath);
    });

    destEl.addEventListener("change", () => { destUid = destEl.value || null; });
    myReposEl.addEventListener("change", () => {
        const r = myRepos[Number(myReposEl.value)];
        if (!r) return;
        curProvider = r.provider;
        urlEl.value = r.fullName;
        loadRepo();
    });

    void renderMount();
}