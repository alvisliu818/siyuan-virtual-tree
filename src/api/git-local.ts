// 本地 Git 操作(桌面端):经 child_process.execFile 调 git CLI。
//
// 与 api/git-repo.ts 的分工:那边是 GitHub/Gitee 的 REST 后端(虚拟路径 github://…,
// 移动端可用);这边是用户磁盘上真实仓库的 git 命令(移动端没有 Node,一律不可用)。
//
// 安全:一律 execFile + 数组参数,**不经 shell**,所以路径/提交信息里的引号、$、反引号
// 都只是普通字符,不存在命令注入。windowsHide 避免 Windows 上弹黑框。
import {getNativeRequire} from "../utils/native-require";
import {dirname} from "../utils/path";

export interface GitStatusEntry {
    path: string;          // 相对仓库根;改名时是新路径
    origPath?: string;     // 改名/复制前的路径
    index: string;         // porcelain 的 X:暂存区状态
    worktree: string;      // porcelain 的 Y:工作区状态
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    conflicted: boolean;
}

export interface GitStatus {
    root: string;
    branch: string | null; // detached HEAD 时为 null
    detached: boolean;
    head: string;          // 短 sha;空仓库(无提交)时为 ""
    upstream: string | null;
    ahead: number;
    behind: number;
    entries: GitStatusEntry[];
}

export interface GitLogEntry {
    sha: string;
    short: string;
    author: string;
    date: string;
    subject: string;
    parents: string[];
}

export interface GitBranch {
    name: string;
    current: boolean;
    remote: boolean;
    short: string;
}

// 冲突状态码(porcelain v1 的 XY 组合)
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

let available: boolean | null = null;

function cp(): any {
    const req = getNativeRequire();
    if (!req) throw new Error("本地 Git 操作需要思源桌面端(移动端没有 Node)");
    return req("child_process");
}

interface RunOpts {
    timeout?: number;
    // 读命令不该抢 index 锁:并发查状态时避免 "Unable to create index.lock"
    readOnly?: boolean;
    allowExit?: number[];
}

function runGit(cwd: string, args: string[], opts: RunOpts = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            cp().execFile("git", ["-c", "core.quotepath=false", ...args], {
                cwd,
                encoding: "utf8",
                timeout: opts.timeout ?? 30000,
                maxBuffer: 32 * 1024 * 1024,
                windowsHide: true,
                env: {
                    ...process.env,
                    // 鉴权失败时立刻报错,而不是挂在终端等输入(渲染进程里没人能回答)
                    GIT_TERMINAL_PROMPT: "0",
                    ...(opts.readOnly ? {GIT_OPTIONAL_LOCKS: "0"} : {}),
                },
            }, (err: any, stdout: string, stderr: string) => {
                const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
                if (err && !(opts.allowExit || []).includes(code)) {
                    reject(new Error(gitLocalErrorMessage(err, stdout, stderr, args)));
                    return;
                }
                resolve(String(stdout || ""));
            });
        } catch (e) {
            reject(new Error(`无法启动 git: ${(e as Error)?.message || e}`));
        }
    });
}

function gitLocalErrorMessage(err: any, stdout: string, stderr: string, args: string[]): string {
    const raw = String(stderr || stdout || err?.message || "").trim();
    const lower = raw.toLowerCase();
    if (err?.code === "ENOENT" || lower.includes("enoent")) {
        return "找不到 git 命令,请确认已安装 Git 并加入 PATH";
    }
    if (lower.includes("not a git repository")) {
        return "该目录不在 Git 仓库里";
    }
    if (lower.includes("timed out") || err?.killed) {
        return `git ${args[0] || ""} 超时,已中止`;
    }
    if (lower.includes("non-fast-forward") || lower.includes("fetch first") || lower.includes("rejected")) {
        return "推送被拒绝:远端有本地没有的提交,请先拉取合并";
    }
    if (lower.includes("authentication failed") || lower.includes("could not read username") || lower.includes("permission denied")) {
        return "Git 鉴权失败:请确认凭据管理器里存了可用凭据,或改用 SSH 远端";
    }
    if (lower.includes("conflict") && lower.includes("merge")) {
        return "合并产生冲突,请在改动列表里处理冲突文件后再提交(或中止合并)";
    }
    if (lower.includes("please tell me who you are")) {
        return "Git 未配置用户身份,请先设置 user.name 与 user.email";
    }
    if (lower.includes("index.lock")) {
        return "Git 索引被占用(可能有其他 git 进程在跑),稍后重试";
    }
    // 首行通常就是最有用的那句;git 的 hint 段落太长,截掉
    return raw.split("\n").filter(l => l.trim() && !l.trim().startsWith("hint:")).slice(0, 4).join("\n") || `git ${args[0] || ""} 失败`;
}

/** git CLI 是否可用(桌面端 + 已安装 git)。结果缓存:装没装 git 一个会话内不会变 */
export async function isGitLocalAvailable(): Promise<boolean> {
    if (available !== null) return available;
    if (!getNativeRequire()) {
        available = false;
        return false;
    }
    try {
        await runGit(process.env.HOME || process.cwd(), ["--version"], {timeout: 10000, readOnly: true});
        available = true;
    } catch {
        available = false;
    }
    return available;
}

/** 路径所属仓库根;不在仓库里返回 null。文件路径自动取所在目录 */
export async function findRepoRoot(path: string): Promise<string | null> {
    if (!path || !(await isGitLocalAvailable())) return null;
    const cwd = path.replace(/\\/g, "/");
    try {
        const out = await runGit(cwd, ["rev-parse", "--show-toplevel"], {timeout: 10000, readOnly: true});
        return out.trim().replace(/\\/g, "/") || null;
    } catch {
        // 目录不存在时 cwd 会失败,退回父目录再试一次(文件路径常见)
        try {
            const out = await runGit(dirname(cwd), ["rev-parse", "--show-toplevel"], {timeout: 10000, readOnly: true});
            return out.trim().replace(/\\/g, "/") || null;
        } catch {
            return null;
        }
    }
}

// porcelain v1 -z:分支头 "## …",条目 "XY path\0",改名额外跟一个 "oldpath\0"
// untracked-files 用 git 默认的 normal(未跟踪目录折叠成一条):all 在大仓库上
// 要遍历整棵未跟踪树,实测在整个工作区级别的仓库里 30s 都跑不完
export async function gitLocalStatus(root: string): Promise<GitStatus> {
    const out = await runGit(root, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"], {readOnly: true, timeout: 60000});
    const parts = out.split("\0");
    const st: GitStatus = {
        root, branch: null, detached: false, head: "", upstream: null, ahead: 0, behind: 0, entries: [],
    };
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (!rec) continue;
        if (rec.startsWith("## ")) {
            const head = rec.slice(3);
            // 空仓库(还没有任何提交):"No commits yet on main" / "Initial commit on main"
            const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(head);
            if (unborn) {
                st.branch = unborn[1];
            } else if (head.startsWith("HEAD (no branch)")) {
                st.detached = true;
            } else {
                // "main...origin/main [ahead 1, behind 2]" / "main" / "release/1.2"
                // 分支名可以含 ".",所以这里不能用 [^.]+ 截断
                const m = /^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(head);
                st.branch = m?.[1] || null;
                st.upstream = m?.[2] || null;
                const flags = m?.[3] || "";
                st.ahead = Number(/ahead (\d+)/.exec(flags)?.[1] || 0);
                st.behind = Number(/behind (\d+)/.exec(flags)?.[1] || 0);
            }
            continue;
        }
        if (rec.length < 4) continue;
        const xy = rec.slice(0, 2);
        const path = rec.slice(3);
        const renamed = xy.includes("R") || xy.includes("C");
        const origPath = renamed ? (parts[++i] || undefined) : undefined;
        const untracked = xy === "??";
        const conflicted = CONFLICT_CODES.has(xy);
        st.entries.push({
            path,
            origPath,
            index: xy[0],
            worktree: xy[1],
            untracked,
            conflicted,
            staged: !untracked && !conflicted && xy[0] !== " " && xy[0] !== "?",
            unstaged: conflicted || (xy[1] !== " " && xy[1] !== "?"),
        });
    }
    try {
        st.head = (await runGit(root, ["rev-parse", "--short", "HEAD"], {timeout: 10000, readOnly: true})).trim();
    } catch {
        st.head = "";   // 空仓库还没有 HEAD
    }
    return st;
}

/** 工作区/暂存区 diff。untracked=true 时把未跟踪文件合成全新增 diff(git diff 对它无输出) */
export async function gitLocalDiff(root: string, opts: {staged?: boolean; path?: string; untracked?: boolean} = {}): Promise<string> {
    if (opts.untracked && opts.path) {
        const req = getNativeRequire()!;
        const fs = req("fs") as typeof import("fs");
        const full = `${root}/${opts.path}`;
        try {
            const st = await fs.promises.stat(full);
            if (st.size > 2 * 1024 * 1024) return `文件过大(${Math.round(st.size / 1024)}KB),未展开`;
            const text = await fs.promises.readFile(full, "utf8");
            const lines = text.split("\n");
            if (lines[lines.length - 1] === "") lines.pop();
            return `--- /dev/null\n+++ b/${opts.path}\n@@ -0,0 +1,${lines.length} @@\n`
                + lines.map(l => "+" + l).join("\n") + "\n";
        } catch (e) {
            return `无法读取文件: ${(e as Error)?.message || e}`;
        }
    }
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (opts.staged) args.push("--cached");
    if (opts.path) args.push("--", opts.path);
    return await runGit(root, args, {readOnly: true});
}

export async function gitLocalStage(root: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await runGit(root, ["add", "--", ...paths]);
}

export async function gitLocalUnstage(root: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // 空仓库还没有 HEAD,reset 会失败;此时用 rm --cached 把文件退回未跟踪
    let hasHead = true;
    try {
        await runGit(root, ["rev-parse", "--verify", "HEAD"], {timeout: 10000, readOnly: true});
    } catch {
        hasHead = false;
    }
    if (hasHead) await runGit(root, ["reset", "-q", "HEAD", "--", ...paths]);
    else await runGit(root, ["rm", "--cached", "-q", "--", ...paths]);
}

export async function gitLocalCommit(root: string, message: string): Promise<string> {
    const msg = (message || "").trim();
    if (!msg) throw new Error("提交信息不能为空");
    const out = await runGit(root, ["commit", "-m", msg], {timeout: 60000});
    return out.trim();
}

export async function gitLocalPush(root: string, opts: {remote?: string; branch?: string; setUpstream?: boolean} = {}): Promise<string> {
    const args = ["push"];
    if (opts.setUpstream) args.push("--set-upstream");
    if (opts.remote) args.push(opts.remote);
    if (opts.branch) args.push(opts.branch);
    // 输出在 stderr(git 的进度信息一律走 stderr),所以两边都收
    return await runGit(root, args, {timeout: 180000});
}

export async function gitLocalPull(root: string, opts: {rebase?: boolean} = {}): Promise<string> {
    const args = ["pull"];
    if (opts.rebase) args.push("--rebase");
    return await runGit(root, args, {timeout: 180000});
}

/** 中止进行中的合并,回到合并前状态(拉取撞出冲突时的退路) */
export async function gitLocalMergeAbort(root: string): Promise<void> {
    await runGit(root, ["merge", "--abort"], {timeout: 60000});
}

/** 推送当前分支:有上游直接推,没有则挑一个远端建立跟踪(优先 origin) */
export async function gitLocalPushCurrent(root: string): Promise<void> {
    const st = await gitLocalStatus(root);
    if (st.upstream) {
        await gitLocalPush(root);
        return;
    }
    const remotes = await gitLocalRemotes(root).catch(() => []);
    const remote = remotes.find(r => r.name === "origin")?.name || remotes[0]?.name;
    if (!remote) throw new Error("该仓库没有配置远端,无法推送。请先 git remote add");
    await gitLocalPush(root, {setUpstream: true, remote, branch: st.branch || undefined});
}

export async function gitLocalBranches(root: string): Promise<GitBranch[]> {
    // 用完整 refname 判断本地/远端:本地分支名也可以含 "/",靠短名猜会错
    const out = await runGit(root, [
        "for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(HEAD)",
        "refs/heads", "refs/remotes",
    ], {readOnly: true});
    const list: GitBranch[] = [];
    for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const [ref, name, short, head] = line.split("\0");
        // origin/HEAD 是符号引用不是分支;它的 refname:short 会被 git 缩成 "origin",
        // 所以必须按完整 refname 判断,按短名过滤会漏
        if (!ref || !name || ref.endsWith("/HEAD")) continue;
        list.push({name, short: short || "", current: head === "*", remote: ref.startsWith("refs/remotes/")});
    }
    return list;
}

export async function gitLocalCheckout(root: string, branch: string, create = false): Promise<void> {
    const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
    await runGit(root, args, {timeout: 60000});
}

export async function gitLocalLog(root: string, opts: {limit?: number; path?: string} = {}): Promise<GitLogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const args = ["log", `-n${limit}`, "--date=iso", "--pretty=format:%H%x00%h%x00%an%x00%ad%x00%s%x00%P"];
    if (opts.path) args.push("--", opts.path);
    // 空仓库没有提交,git log 回 128:当成空历史而不是报错
    const out = await runGit(root, args, {readOnly: true, allowExit: [128]});
    const list: GitLogEntry[] = [];
    for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const [sha, short, author, date, subject, parents] = line.split("\0");
        if (!sha) continue;
        list.push({sha, short: short || "", author: author || "", date: date || "", subject: subject || "", parents: (parents || "").split(" ").filter(Boolean)});
    }
    return list;
}

/** 单个提交的改动(带 patch);path 给定时只看该文件 */
export async function gitLocalShow(root: string, sha: string, path?: string): Promise<string> {
    const args = ["show", "--no-color", "--no-ext-diff", "--format=commit %H%nAuthor: %an%nDate:   %ad%n%n    %s%n", sha];
    if (path) args.push("--", path);
    return await runGit(root, args, {readOnly: true});
}

export async function gitLocalRemotes(root: string): Promise<{name: string; url: string}[]> {
    const out = await runGit(root, ["remote", "-v"], {readOnly: true});
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
        const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
        if (m) map.set(m[1], m[2]);
    }
    return [...map.entries()].map(([name, url]) => ({name, url}));
}