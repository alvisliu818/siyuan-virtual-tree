// GitHub / Gitee 仓库虚拟路径(纯语法层,无 IO;仓库数据访问见 api/git-repo.ts)
//
// 虚拟路径格式(与真实文件路径、bdpan:// 网盘路径、sydoc:// 虚拟文档路径区分):
//   github://<owner>/<repo>@<ref>[/<仓库内路径>]
//   gitee://<owner>/<repo>@<ref>[/<仓库内路径>]
// 例:github://siyuan-note/siyuan@main、gitee://mirrors/git@master:README.md 的形态见下
//   github://octocat/Hello-World@main/README.md
//   gitee://oschina/git-osc@develop/src/main.java
//
// ref = 分支名 / tag / commit SHA。**按 encodeURIComponent 编码后存放**,
// 因为分支名可以含斜杠(feature/login),不编码就无法区分 ref 与仓库内路径的边界。
// 常见分支(main / master / v1.0)编码后原样,路径可读性不受影响。
// 仓库内路径按原样存放(不编码),构造 API URL 时再逐段编码 —— 文件名里的 "%" 才不会被误解。
// 统一使用 "/" 分隔符,与 path.ts 的通用工具(dirname/basename/joinPath)兼容。
export const GITHUB_PREFIX = "github://";
export const GITEE_PREFIX = "gitee://";

export type GitProvider = "github" | "gitee";

// 解析结果:一个仓库内的具体位置
export interface GitRepoLocation {
    provider: GitProvider;
    owner: string;
    repo: string;
    ref: string;    // 已解码的分支/tag/SHA
    path: string;   // 仓库内相对路径;"" = 仓库根
}

export function isGitRepoPath(p: string): boolean {
    return typeof p === "string" && (p.startsWith(GITHUB_PREFIX) || p.startsWith(GITEE_PREFIX));
}

export function isGitHubPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(GITHUB_PREFIX);
}

export function isGiteePath(p: string): boolean {
    return typeof p === "string" && p.startsWith(GITEE_PREFIX);
}

export function gitProviderOf(p: string): GitProvider | null {
    if (isGitHubPath(p)) return "github";
    if (isGiteePath(p)) return "gitee";
    return null;
}

// 解析虚拟路径;格式不合法(缺 owner/repo/ref)返回 null
export function parseGitRepoPath(vPath: string): GitRepoLocation | null {
    const provider = gitProviderOf(vPath);
    if (!provider) return null;
    const prefix = provider === "github" ? GITHUB_PREFIX : GITEE_PREFIX;
    const body = vPath.slice(prefix.length).replace(/\/+$/, "");
    const at = body.indexOf("@");
    if (at <= 0) return null;
    const slug = body.slice(0, at);
    const slash = slug.indexOf("/");
    if (slash <= 0 || slash === slug.length - 1) return null;
    const owner = slug.slice(0, slash);
    const repo = slug.slice(slash + 1).replace(/\.git$/i, "");
    if (!owner || !repo) return null;
    const rest = body.slice(at + 1);
    const sep = rest.indexOf("/");
    const encodedRef = sep < 0 ? rest : rest.slice(0, sep);
    if (!encodedRef) return null;
    let ref = encodedRef;
    try {
        ref = decodeURIComponent(encodedRef);
    } catch {
        // 手改过的路径可能含非法百分号转义:按原样当 ref 用
    }
    const path = (sep < 0 ? "" : rest.slice(sep + 1)).replace(/^\/+|\/+$/g, "");
    return {provider, owner, repo, ref, path};
}

// 构造虚拟路径(ref 编码、仓库内路径原样)
export function buildGitRepoPath(loc: GitRepoLocation): string {
    const prefix = loc.provider === "github" ? GITHUB_PREFIX : GITEE_PREFIX;
    const base = `${prefix}${loc.owner}/${loc.repo}@${encodeURIComponent(loc.ref)}`;
    const path = (loc.path || "").replace(/^\/+|\/+$/g, "");
    return path ? `${base}/${path}` : base;
}

// 仓库根虚拟路径
export function gitRepoRootPath(provider: GitProvider, owner: string, repo: string, ref: string): string {
    return buildGitRepoPath({provider, owner, repo, ref, path: ""});
}

// 拼接虚拟子路径(vBase 为无结尾斜杠的虚拟路径)
export function gitRepoChildVPath(vBase: string, name: string): string {
    return vBase.replace(/\/+$/, "") + "/" + name;
}

// 仓库标识(缓存键):同一仓库同一 ref 共享一份树缓存
export function gitRepoKey(loc: GitRepoLocation): string {
    return `${loc.provider}:${loc.owner}/${loc.repo}@${loc.ref}`;
}

// 是否仓库根(挂载根行显示名用)
export function isGitRepoRoot(vPath: string): boolean {
    const loc = parseGitRepoPath(vPath);
    return !!loc && !loc.path;
}

// 挂载根的显示名(纯字符串,不触发网络)
export function gitRepoRootLabel(vPath: string): string {
    const loc = parseGitRepoPath(vPath);
    if (!loc) return "[Git 仓库] " + vPath;
    const tag = loc.provider === "github" ? "[GitHub]" : "[Gitee]";
    const tail = loc.path ? ` / ${loc.path}` : "";
    return `${tag} ${loc.owner}/${loc.repo}@${loc.ref}${tail}`;
}

// 网页地址(右键「在 GitHub/Gitee 中打开」用);目录传 isDir=true 走 /tree/
export function gitRepoWebUrl(vPath: string, isDir = false): string {
    const loc = parseGitRepoPath(vPath);
    if (!loc) return "";
    const host = loc.provider === "github" ? "https://github.com" : "https://gitee.com";
    const slug = `${loc.owner}/${loc.repo}`;
    // 分支名含斜杠时网页地址按原样拼接(GitHub/Gitee 均按最长匹配解析 ref)
    const ref = loc.ref.split("/").map(encodeURIComponent).join("/");
    if (!loc.path) return `${host}/${slug}/tree/${ref}`;
    const kind = isDir ? "tree" : "blob";
    const path = loc.path.split("/").map(encodeURIComponent).join("/");
    return `${host}/${slug}/${kind}/${ref}/${path}`;
}

// 从用户粘贴的仓库地址/简写解析出 provider 与 owner/repo。
// 支持:https://github.com/o/r(.git)(/tree/branch/...)、git@github.com:o/r.git、
//       https://gitee.com/o/r、o/r(裸简写用 defaultProvider,由对话框入口决定)
export function parseRepoInput(
    input: string,
    defaultProvider: GitProvider = "github",
): {provider: GitProvider; owner: string; repo: string; ref?: string} | null {
    const s = (input || "").trim();
    if (!s) return null;
    // 本插件自己的虚拟路径也接受(便于复制路径后重新挂载)
    const loc = parseGitRepoPath(s);
    if (loc) return {provider: loc.provider, owner: loc.owner, repo: loc.repo, ref: loc.ref};
    const hostMatch = s.match(/(?:https?:\/\/|git@)(github\.com|gitee\.com)[/:]([^/\s]+)\/([^/\s?#]+)/i);
    let provider: GitProvider | null = null;
    let owner = "";
    let repo = "";
    let rest = "";
    if (hostMatch) {
        provider = hostMatch[1].toLowerCase() === "github.com" ? "github" : "gitee";
        owner = hostMatch[2];
        repo = hostMatch[3];
        const idx = s.indexOf(hostMatch[0]);
        rest = s.slice(idx + hostMatch[0].length);
    } else {
        // 裸 owner/repo:URL 里没有主机名可判断,用调用方给定的 provider
        const bare = s.match(/^([^/\s@]+)\/([^/\s@]+)$/);
        if (!bare) return null;
        owner = bare[1];
        repo = bare[2];
    }
    repo = repo.replace(/\.git$/i, "");
    if (!owner || !repo) return null;
    // URL 尾巴里的 /tree/<ref> 或 /blob/<ref>/... → 取出 ref(分支名可能含斜杠,取到下一段已知关键字为止)
    let ref: string | undefined;
    const treeMatch = rest.match(/^\/(?:tree|blob)\/([^?#]+)/);
    if (treeMatch) {
        ref = decodeURIComponent(treeMatch[1].split("/")[0]);
    }
    return {provider: provider || defaultProvider, owner, repo, ref};
}