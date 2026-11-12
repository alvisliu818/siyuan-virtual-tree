// GitHub / Gitee 仓库后端:把仓库某个分支(ref)映射为 github:// 与 gitee:// 虚拟路径,
// 支持浏览、读取,以及**写回提交**(保存文件 / 新建 / 删除 / 改名)。
//
// 读:GET /repos/{o}/{r}/git/trees/{ref}?recursive=1 一次取回整棵树(两家都支持递归,
//    且 {ref} 可直接传分支名),缓存后列目录不再发请求 —— 未认证 60 次/小时的配额下
//    这是唯一可用的做法(逐目录列会把配额瞬间打光)。
//    文件内容:GitHub 走 contents + Accept: application/vnd.github.raw 取原始字节;
//    Gitee 的 contents 恒返回 base64 JSON(raw 媒体类型被忽略),解码即可。
// 写:GitHub 单文件走 Contents API(PUT/DELETE,需要当前 blob sha);
//    目录删除与改名走 Git Data API(ref → commit → tree → commit → ref)一次提交完成。
//    Gitee **没有** Git Data 写接口,但有批量提交接口 POST /repos/{o}/{r}/commits
//    (actions: create/update/delete/move),所有写操作都用它,天然原子。
// 传输:复用 api/http.ts(桌面端 Node https,浏览器端思源内核代理)。
import {DirEntry} from "../types";
import {STORAGE_GIT_CONFIG} from "../constants";
import {parseStoredData} from "../utils/stored-data";
import {decodeAuto} from "../utils/encoding";
import {httpRequest, HttpResponse} from "./http";
import {
    GitProvider,
    GitRepoLocation,
    buildGitRepoPath,
    gitRepoChildVPath,
    gitRepoKey,
    parseGitRepoPath,
} from "../utils/git-repo-path";

// ==== 配置(持久化到插件数据 git-repo.json)====
export interface GitRepoConfig {
    githubToken: string;   // GitHub 个人访问令牌( classic repo / 细粒度 Contents 读写)
    giteeToken: string;    // Gitee 私人令牌(scope: projects)
}

const DEFAULT_CONFIG: GitRepoConfig = {githubToken: "", giteeToken: ""};

let gitConfig: GitRepoConfig = {...DEFAULT_CONFIG};
let gitSaver: ((data: string) => Promise<void>) | null = null;

// 加载配置并设置持久化回调(插件 onLayoutReady 时调用)
export async function initGitRepoStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    gitSaver = (data: string) => plugin.saveData(STORAGE_GIT_CONFIG, data);
    gitConfig = {...DEFAULT_CONFIG};
    try {
        const raw = await plugin.loadData(STORAGE_GIT_CONFIG);
        // 首次使用文件不存在时 loadData 返回空串,必须安全解析
        const parsed = parseStoredData(raw);
        if (parsed && typeof parsed === "object") {
            gitConfig = {
                githubToken: String(parsed.githubToken || "").trim(),
                giteeToken: String(parsed.giteeToken || "").trim(),
            };
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载 Git 仓库配置失败:", e);
    }
}

async function persistGitConfig(): Promise<void> {
    if (!gitSaver) return;
    try {
        await gitSaver(JSON.stringify(gitConfig));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存 Git 仓库配置失败:", e);
    }
}

// 保存令牌(清空缓存:换令牌后可见仓库范围会变)
export async function saveGitRepoConfig(next: Partial<GitRepoConfig>): Promise<void> {
    gitConfig = {
        githubToken: (next.githubToken ?? gitConfig.githubToken).trim(),
        giteeToken: (next.giteeToken ?? gitConfig.giteeToken).trim(),
    };
    clearGitRepoCache();
    await persistGitConfig();
}

export function getGitRepoConfig(): GitRepoConfig {
    return {...gitConfig};
}

export function gitTokenOf(provider: GitProvider): string {
    return provider === "github" ? gitConfig.githubToken : gitConfig.giteeToken;
}

// ==== 传输 ====
const API_BASE: Record<GitProvider, string> = {
    github: "https://api.github.com",
    gitee: "https://gitee.com/api/v5",
};

const PROVIDER_LABEL: Record<GitProvider, string> = {github: "GitHub", gitee: "Gitee"};

function gitHeaders(provider: GitProvider, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
        Accept: "application/json",
        "Accept-Encoding": "identity", // 避免 gzip,无需解压
        "User-Agent": "siyuan-virtual-tree",
        ...extra,
    };
    const token = gitTokenOf(provider);
    // 两家都接受 Bearer(Gitee 官方文档写的是 access_token 查询参数,实测 Bearer 同样有效,
    // 用请求头可避免令牌出现在 URL / 日志里)
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

function repoApi(loc: {provider: GitProvider; owner: string; repo: string}): string {
    return `${API_BASE[loc.provider]}/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}`;
}

// 仓库内路径逐段编码(空格/中文/百分号),分隔符保持字面 "/"
function encPath(p: string): string {
    return p.split("/").map(encodeURIComponent).join("/");
}

// 错误信息:把 HTTP 状态与响应体翻译成可操作的中文提示
function gitErrorMessage(provider: GitProvider, resp: HttpResponse, op: string): string {
    const text = decodeAuto(new Uint8Array(resp.bytes));
    let msg = "";
    try {
        const json = JSON.parse(text);
        msg = String(json?.message || json?.error || "");
    } catch {
        msg = text.slice(0, 200);
    }
    const label = PROVIDER_LABEL[provider];
    const tail = msg ? `(${msg})` : "";
    switch (resp.status) {
        case 401:
            return `${op}失败:${label} 访问令牌无效或已过期,请在设置里更新${tail}`;
        case 403:
            if (/rate limit|速率|too many|abuse/i.test(msg)) {
                return `${op}失败:${label} API 速率已用尽(未配置令牌时仅 60 次/小时),请配置访问令牌或稍后重试${tail}`;
            }
            return `${op}失败:无权限 —— 令牌缺少仓库读写权限(GitHub: repo / Contents 读写;Gitee: projects),或分支受保护${tail}`;
        case 404:
            return `${op}失败:仓库或路径不存在;私有仓库需要配置有效的访问令牌${tail}`;
        case 409:
            return `${op}失败:冲突 —— 远端已被改动,或仓库为空(空仓库请先提交一个文件),请刷新后重试${tail}`;
        case 422:
            return `${op}失败:参数校验失败(通常是文件 sha 已过期或分支受保护),请刷新后重试${tail}`;
        default:
            return `${op}失败:HTTP ${resp.status}${tail}`;
    }
}

async function gitRequest(
    provider: GitProvider,
    url: string,
    opts: {method?: string; headers?: Record<string, string>; body?: any} = {},
): Promise<HttpResponse> {
    const body = opts.body === undefined ? null : JSON.stringify(opts.body);
    return await httpRequest(url, {
        method: opts.method || "GET",
        headers: gitHeaders(provider, {
            ...(body !== null ? {"Content-Type": "application/json"} : {}),
            ...opts.headers,
        }),
        body,
    });
}

// 请求并解析 JSON;非 2xx 抛可读错误
async function gitJSON<T = any>(
    provider: GitProvider,
    url: string,
    opts: {method?: string; headers?: Record<string, string>; body?: any} = {},
    op = "操作",
): Promise<T> {
    const resp = await gitRequest(provider, url, opts);
    if (resp.status >= 400) throw new Error(gitErrorMessage(provider, resp, op));
    const text = decodeAuto(new Uint8Array(resp.bytes));
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`${op}失败:响应不是 JSON(HTTP ${resp.status})`);
    }
}

// ==== base64 ====
function bytesToB64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function b64ToBytes(b64: string): ArrayBuffer {
    const bin = atob(String(b64 || "").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}

// ==== 仓库元信息与分支 ====
export interface GitRepoInfo {
    defaultBranch: string;
    isPrivate: boolean;
    description: string;
}

export async function gitRepoInfo(provider: GitProvider, owner: string, repo: string): Promise<GitRepoInfo> {
    const json = await gitJSON<any>(provider, `${API_BASE[provider]}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {}, "读取仓库信息");
    return {
        defaultBranch: String(json?.default_branch || "main"),
        isPrivate: !!json?.private,
        description: String(json?.description || ""),
    };
}

// 分支与 tag(挂载对话框的选择器用);tag 拉取失败不影响分支
export async function gitListRefs(provider: GitProvider, owner: string, repo: string): Promise<{branches: string[]; tags: string[]}> {
    const base = `${API_BASE[provider]}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const branches = await gitJSON<any[]>(provider, `${base}/branches?per_page=100`, {}, "读取分支列表");
    let tags: string[] = [];
    try {
        const rs = await gitJSON<any[]>(provider, `${base}/tags?per_page=100`, {}, "读取标签列表");
        tags = (Array.isArray(rs) ? rs : []).map(t => String(t?.name || "")).filter(Boolean);
    } catch {
        // 无 tag 或无权限:只给分支
    }
    return {
        branches: (Array.isArray(branches) ? branches : []).map(b => String(b?.name || "")).filter(Boolean),
        tags,
    };
}

// 验证令牌(设置里「保存并验证」用):返回登录名
export async function gitVerifyToken(provider: GitProvider): Promise<string> {
    const url = provider === "github" ? "https://api.github.com/user" : `${API_BASE.gitee}/user`;
    const json = await gitJSON<any>(provider, url, {}, "验证访问令牌");
    return String(json?.login || json?.name || json?.username || "");
}

// ==== 整树缓存 ====
interface GitTreeEntry {
    path: string;
    isDir: boolean;
    size: number;
    sha: string;
    mode: string;
}

interface GitTree {
    ts: number;
    entries: Map<string, GitTreeEntry>;
    truncated: boolean;   // 树过大被服务端截断 → 列目录改用逐目录 contents 接口
}

const treeCache = new Map<string, GitTree>();          // key = gitRepoKey
const dirCache = new Map<string, {ts: number; entries: DirEntry[]}>();  // 截断树的逐目录缓存
const TREE_TTL = 5 * 60 * 1000;

// 清空缓存(不传 key 清空全部;写操作后与面板刷新时调用)
export function clearGitRepoCache(key?: string): void {
    if (!key) {
        treeCache.clear();
        dirCache.clear();
        return;
    }
    treeCache.delete(key);
    for (const k of Array.from(dirCache.keys())) {
        if (k === key || k.startsWith(key + "|")) dirCache.delete(k);
    }
}

async function loadTree(loc: GitRepoLocation): Promise<GitTree> {
    const key = gitRepoKey(loc);
    const cached = treeCache.get(key);
    if (cached && Date.now() - cached.ts < TREE_TTL) return cached;
    const url = `${repoApi(loc)}/git/trees/${encodeURIComponent(loc.ref)}?recursive=1`;
    const resp = await gitRequest(loc.provider, url);
    // 空仓库没有任何 ref:GitHub 回 409(Git Repository is empty),Gitee 回 404。
    // 按空树处理,这样仍能靠「新建文件」提交出第一个 commit。
    if (resp.status !== 404 && resp.status !== 409 && resp.status >= 400) {
        throw new Error(gitErrorMessage(loc.provider, resp, "读取仓库文件树"));
    }
    let json: any = null;
    if (resp.status < 400) {
        const text = decodeAuto(new Uint8Array(resp.bytes));
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`读取仓库文件树失败:响应不是 JSON(HTTP ${resp.status})`);
        }
    }
    const entries = new Map<string, GitTreeEntry>();
    for (const it of Array.isArray(json?.tree) ? json.tree : []) {
        const path = String(it?.path || "");
        if (!path) continue;
        // type=commit 是子模块:内容不在本仓库,列出来只会是打不开的死行,跳过
        if (it?.type === "commit") continue;
        entries.set(path, {
            path,
            isDir: it?.type === "tree",
            size: Number(it?.size) || 0,
            sha: String(it?.sha || ""),
            // Gitee 的目录 mode 是 "40000"(无前导零),统一补齐成 git 标准写法
            mode: String(it?.mode || (it?.type === "tree" ? "040000" : "100644")).padStart(6, "0"),
        });
    }
    const tree: GitTree = {ts: Date.now(), entries, truncated: !!json?.truncated};
    if (treeCache.size > 40) treeCache.clear();
    treeCache.set(key, tree);
    return tree;
}

// 供 path-kind.ts 同步判断目录用:树已在内存时零成本,未加载返回 null(调用方继续兜底)
export function gitRepoCachedIsDir(vPath: string): boolean | null {
    const loc = parseGitRepoPath(vPath);
    if (!loc) return null;
    if (!loc.path) return true;   // 仓库根恒为目录
    const tree = treeCache.get(gitRepoKey(loc));
    if (!tree || tree.truncated) return null;
    const hit = tree.entries.get(loc.path);
    return hit ? hit.isDir : null;
}

function toDirEntry(loc: GitRepoLocation, vBase: string, e: {name: string; isDir: boolean; size: number}): DirEntry {
    return {
        name: e.name,
        isDir: e.isDir,
        size: e.size,
        updated: "",   // 树接口不带修改时间
        path: gitRepoChildVPath(vBase, e.name),
    };
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
    return entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
}

// 树被截断时的兜底:逐目录 contents 接口(两家都支持,目录返回数组)
async function listDirByContents(loc: GitRepoLocation, vBase: string): Promise<DirEntry[]> {
    const cacheKey = gitRepoKey(loc) + "|" + loc.path;
    const cached = dirCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TREE_TTL) return cached.entries;
    const url = `${repoApi(loc)}/contents/${encPath(loc.path)}?ref=${encodeURIComponent(loc.ref)}`;
    const json = await gitJSON<any>(loc.provider, url, {}, "读取仓库目录");
    const list = Array.isArray(json) ? json : [];
    const entries = sortEntries(list.map((it: any) => toDirEntry(loc, vBase, {
        name: String(it?.name || ""),
        isDir: it?.type === "dir" || it?.type === "tree",
        size: Number(it?.size) || 0,
    })).filter(e => !!e.name));
    if (dirCache.size > 300) dirCache.clear();
    dirCache.set(cacheKey, {ts: Date.now(), entries});
    return entries;
}

// 列出虚拟目录下的条目(条目自带 github:// / gitee:// 子路径)
export async function gitListDir(vPath: string): Promise<DirEntry[]> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    const vBase = buildGitRepoPath(loc);
    const tree = await loadTree(loc);
    if (tree.truncated) return await listDirByContents(loc, vBase);
    const prefix = loc.path ? loc.path + "/" : "";
    const out: DirEntry[] = [];
    for (const e of tree.entries.values()) {
        if (prefix && !e.path.startsWith(prefix)) continue;
        const rest = e.path.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;   // 只要直接子项
        out.push(toDirEntry(loc, vBase, {name: rest, isDir: e.isDir, size: e.size}));
    }
    return sortEntries(out);
}

// ==== 读取文件 ====
// 取文件元信息(sha / 是否目录);不存在返回 null。
// 注意 Gitee 对不存在的路径返回 200 + 空数组,不能只看状态码。
async function fileInfo(loc: GitRepoLocation): Promise<{sha: string; isDir: boolean; size: number; mode: string} | null> {
    const tree = await loadTree(loc);
    if (!tree.truncated) {
        const hit = tree.entries.get(loc.path);
        return hit ? {sha: hit.sha, isDir: hit.isDir, size: hit.size, mode: hit.mode} : null;
    }
    const url = `${repoApi(loc)}/contents/${encPath(loc.path)}?ref=${encodeURIComponent(loc.ref)}`;
    const resp = await gitRequest(loc.provider, url);
    if (resp.status === 404) return null;
    if (resp.status >= 400) throw new Error(gitErrorMessage(loc.provider, resp, "读取文件信息"));
    const json = JSON.parse(decodeAuto(new Uint8Array(resp.bytes)));
    if (Array.isArray(json)) {
        // 目录(或 Gitee 的"不存在"空数组):按名字回查,查不到就是不存在
        const hit = json.find((it: any) => String(it?.path || "") === loc.path);
        return hit ? {sha: String(hit.sha || ""), isDir: hit.type === "dir", size: Number(hit.size) || 0, mode: "100644"} : null;
    }
    if (!json || typeof json !== "object") return null;
    return {sha: String(json.sha || ""), isDir: json.type === "dir", size: Number(json.size) || 0, mode: "100644"};
}

export async function gitDownloadFile(vPath: string): Promise<ArrayBuffer> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    if (!loc.path) throw new Error("不能下载目录");
    const url = `${repoApi(loc)}/contents/${encPath(loc.path)}?ref=${encodeURIComponent(loc.ref)}`;
    if (loc.provider === "github") {
        // raw 媒体类型:直接回原始字节(≤100MB;私有仓库带令牌同样可用)
        const resp = await gitRequest(loc.provider, url, {headers: {Accept: "application/vnd.github.raw"}});
        if (resp.status >= 400) throw new Error(gitErrorMessage(loc.provider, resp, "下载文件"));
        return resp.bytes;
    }
    const json = await gitJSON<any>(loc.provider, url, {}, "下载文件");
    const content = String(json?.content || "");
    if (content) return b64ToBytes(content);
    if (Number(json?.size) > 0) {
        // contents 接口对大文件可能不回 content:退回 raw 地址(Node https 会自动跟随 302)
        const raw = `https://gitee.com/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}/raw/${encodeURIComponent(loc.ref)}/${encPath(loc.path)}`;
        const resp = await httpRequest(raw, {headers: gitHeaders(loc.provider)});
        if (resp.status >= 400) throw new Error(gitErrorMessage(loc.provider, resp, "下载文件"));
        return resp.bytes;
    }
    return new ArrayBuffer(0);   // 空文件
}

// ==== 写回提交 ====
// 写操作必须串行:GitHub 明确说明 contents 的 PUT/DELETE 并发会互相冲突
const writeChains = new Map<string, Promise<any>>();

function serializeWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeChains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    writeChains.set(key, next.then(() => undefined, () => undefined));
    return next;
}

function commitMessage(verb: string, path: string): string {
    return `${verb} ${path} (siyuan-virtual-tree)`;
}

// 写入前置校验:固定 commit 只读;匿名不能提交
function assertWritable(loc: GitRepoLocation): void {
    if (/^[0-9a-f]{40}$/i.test(loc.ref)) {
        throw new Error("该挂载指向固定 commit,为只读;请改挂分支后再编辑");
    }
    if (!gitTokenOf(loc.provider)) {
        throw new Error(`提交到 ${PROVIDER_LABEL[loc.provider]} 需要访问令牌,请先在「设置 → Git 仓库」里配置`);
    }
}

// GitHub:Git Data API 一次提交完成多处树变更(目录删除/改名/插件库批量同步用)。
// tree 项 {path, mode, type, sha};sha=null 表示删除,content 可代替 sha 直接建 blob
// (两者不能同时给,否则 GitHub 报错)。
async function githubTreeCommit(
    loc: GitRepoLocation,
    tree: {path: string; mode: string; type: string; sha?: string | null; content?: string}[],
    message: string,
): Promise<void> {
    const base = repoApi(loc);
    const branch = encodeURIComponent(loc.ref);
    const refResp = await gitRequest(loc.provider, `${base}/git/ref/heads/${branch}`);
    // 空仓库没有任何 ref(GitHub 回 404/409):首次提交不带 parent,提交后再创建分支引用。
    // 插件库绑定的往往就是刚建好的空私有仓库,这条路径必须能走通。
    const empty = refResp.status === 404 || refResp.status === 409;
    if (!empty && refResp.status >= 400) {
        throw new Error(gitErrorMessage(loc.provider, refResp, "读取分支引用"));
    }
    let parentSha = "";
    let baseTree = "";
    if (!empty) {
        const ref = JSON.parse(decodeAuto(new Uint8Array(refResp.bytes)));
        parentSha = String(ref?.object?.sha || "");
        if (!parentSha) throw new Error("提交失败:分支引用为空");
        const parent = await gitJSON<any>(loc.provider, `${base}/git/commits/${parentSha}`, {}, "读取提交");
        baseTree = String(parent?.tree?.sha || "");
    }
    const newTree = await gitJSON<any>(loc.provider, `${base}/git/trees`, {
        method: "POST",
        body: {...(baseTree ? {base_tree: baseTree} : {}), tree},
    }, "创建文件树");
    const commit = await gitJSON<any>(loc.provider, `${base}/git/commits`, {
        method: "POST",
        body: {message, tree: String(newTree?.sha || ""), parents: parentSha ? [parentSha] : []},
    }, "创建提交");
    const sha = String(commit?.sha || "");
    if (empty) {
        await gitJSON<any>(loc.provider, `${base}/git/refs`, {
            method: "POST",
            body: {ref: `refs/heads/${loc.ref}`, sha},
        }, "创建分支引用");
    } else {
        await gitJSON<any>(loc.provider, `${base}/git/refs/heads/${branch}`, {
            method: "PATCH",
            body: {sha},
        }, "更新分支引用");
    }
}

// Gitee:批量提交接口(单文件与目录操作共用)
async function giteeCommit(
    loc: GitRepoLocation,
    actions: {action: string; path: string; previous_path?: string; content?: string; encoding?: string}[],
    message: string,
): Promise<void> {
    await gitJSON<any>(loc.provider, `${repoApi(loc)}/commits`, {
        method: "POST",
        body: {branch: loc.ref, message, actions},
    }, "提交变更");
}

// 列出某目录下的全部文件路径(含子孙;目录本身在 git 里不是实体,不需要单独删)
async function collectFiles(loc: GitRepoLocation, dirPath: string): Promise<GitTreeEntry[]> {
    const tree = await loadTree(loc);
    const prefix = dirPath ? dirPath + "/" : "";
    if (!tree.truncated) {
        return Array.from(tree.entries.values()).filter(e => !e.isDir && e.path.startsWith(prefix));
    }
    // 截断树:逐层 contents 递归
    const out: GitTreeEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
        const url = `${repoApi(loc)}/contents/${encPath(dir)}?ref=${encodeURIComponent(loc.ref)}`;
        const json = await gitJSON<any>(loc.provider, url, {}, "读取仓库目录");
        for (const it of Array.isArray(json) ? json : []) {
            const p = String(it?.path || "");
            if (!p) continue;
            if (it?.type === "dir") await walk(p);
            else out.push({path: p, isDir: false, size: Number(it?.size) || 0, sha: String(it?.sha || ""), mode: "100644"});
        }
    };
    await walk(dirPath);
    return out;
}

// ==== 批量提交与递归列举(插件库同步用) ====

export interface GitBatchChange {
    path: string;              // 仓库内相对路径
    bytes: Uint8Array | null;  // null = 删除该文件
}

// 一次提交写入/删除多个文件。vPath 只用来定位仓库与分支,changes.path 是仓库内相对路径。
export async function gitCommitBatch(vPath: string, changes: GitBatchChange[], message: string): Promise<void> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    if (changes.length === 0) return;
    assertWritable(loc);
    const key = gitRepoKey(loc);
    await serializeWrite(key, async () => {
        if (loc.provider === "github") {
            await githubTreeCommit(loc, changes.map(c => c.bytes
                ? {path: c.path, mode: "100644", type: "blob", content: bytesToB64(c.bytes)}
                : {path: c.path, mode: "100644", type: "blob", sha: null},
            ), message);
        } else {
            const tree = await loadTree(loc);
            await giteeCommit(loc, changes.map(c => {
                if (!c.bytes) return {action: "delete", path: c.path};
                return {
                    action: tree.entries.has(c.path) ? "update" : "create",
                    path: c.path,
                    content: bytesToB64(c.bytes),
                    encoding: "base64",
                };
            }), message);
        }
        clearGitRepoCache(key);
    });
}

// 递归列出某路径下的全部文件(带 blob sha 与大小),插件库做三方比对用
export async function gitListFilesRecursive(vPath: string): Promise<{path: string; sha: string; size: number}[]> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    const files = await collectFiles(loc, loc.path);
    return files.map(f => ({path: f.path, sha: f.sha, size: f.size}));
}

// 单个文件的 blob sha(不存在或指向目录时返回 null);插件库同步「文件条目」时用
export async function gitFileSha(vPath: string): Promise<string | null> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    const info = await fileInfo(loc);
    return info && !info.isDir ? info.sha : null;
}

// 保存文件(不存在则新建):GitHub Contents PUT / Gitee 批量提交
export async function gitUploadFile(vPath: string, bytes: Uint8Array): Promise<void> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    if (!loc.path) throw new Error("不能把内容写入仓库根");
    assertWritable(loc);
    const key = gitRepoKey(loc);
    await serializeWrite(key, async () => {
        const info = await fileInfo(loc);
        if (info?.isDir) throw new Error(`「${loc.path}」是目录,不能写入文件内容`);
        const content = bytesToB64(bytes);
        const message = commitMessage(info ? "Update" : "Add", loc.path);
        if (loc.provider === "github") {
            const url = `${repoApi(loc)}/contents/${encPath(loc.path)}`;
            const put = async (sha?: string) => await gitRequest(loc.provider, url, {
                method: "PUT",
                body: {message, content, branch: loc.ref, ...(sha ? {sha} : {})},
            });
            let resp = await put(info?.sha);
            // sha 过期(远端刚被改过)→ 重取一次再试;仍失败才报错
            if (resp.status === 409 || resp.status === 422) {
                clearGitRepoCache(key);
                const fresh = await fileInfo(loc);
                resp = await put(fresh?.sha);
            }
            if (resp.status >= 400) throw new Error(gitErrorMessage(loc.provider, resp, "保存文件"));
        } else {
            await giteeCommit(loc, [{
                action: info ? "update" : "create",
                path: loc.path,
                content,
                encoding: "base64",
            }], message);
        }
        clearGitRepoCache(key);
    });
}

// 新建文件夹:git 不存空目录,提交一个 .gitkeep 占位(通用约定)
export async function gitCreateDir(vPath: string): Promise<void> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    await gitUploadFile(gitRepoChildVPath(vPath, ".gitkeep"), new Uint8Array(0));
}

// 删除文件或目录(目录 = 一次提交删掉其下全部文件)
export async function gitRemove(vPath: string): Promise<void> {
    const loc = parseGitRepoPath(vPath);
    if (!loc) throw new Error(`不是合法的仓库路径: ${vPath}`);
    if (!loc.path) throw new Error("不能删除仓库根,请取消挂载");
    assertWritable(loc);
    const key = gitRepoKey(loc);
    await serializeWrite(key, async () => {
        const info = await fileInfo(loc);
        const isDir = info ? info.isDir : (await collectFiles(loc, loc.path)).length > 0;
        if (!info && !isDir) throw new Error(`仓库中未找到: ${loc.path}`);
        if (!isDir) {
            const message = commitMessage("Delete", loc.path);
            if (loc.provider === "github") {
                const url = `${repoApi(loc)}/contents/${encPath(loc.path)}`;
                const del = async (sha?: string) => await gitRequest(loc.provider, url, {
                    method: "DELETE",
                    body: {message, branch: loc.ref, sha: sha || ""},
                });
                let resp = await del(info?.sha);
                if (resp.status === 409 || resp.status === 422) {
                    clearGitRepoCache(key);
                    resp = await del((await fileInfo(loc))?.sha);
                }
                if (resp.status >= 400) throw new Error(gitErrorMessage(loc.provider, resp, "删除文件"));
            } else {
                await giteeCommit(loc, [{action: "delete", path: loc.path}], message);
            }
        } else {
            const files = await collectFiles(loc, loc.path);
            if (files.length === 0) throw new Error(`目录为空或不存在: ${loc.path}`);
            const message = commitMessage("Delete", loc.path + "/");
            if (loc.provider === "github") {
                await githubTreeCommit(loc, files.map(f => ({path: f.path, mode: f.mode, type: "blob", sha: null})), message);
            } else {
                await giteeCommit(loc, files.map(f => ({action: "delete", path: f.path})), message);
            }
        }
        clearGitRepoCache(key);
    });
}

// 改名/移动(同仓库同分支内):一次提交完成,不产生中间态
export async function gitRename(vPath: string, newPath: string): Promise<void> {
    const loc = parseGitRepoPath(vPath);
    const dst = parseGitRepoPath(newPath);
    if (!loc || !dst) throw new Error("不是合法的仓库路径");
    if (gitRepoKey(loc) !== gitRepoKey(dst)) throw new Error("不支持跨仓库或跨分支移动,请在同一挂载内改名");
    if (!loc.path || !dst.path) throw new Error("不能改名仓库根");
    assertWritable(loc);
    const key = gitRepoKey(loc);
    await serializeWrite(key, async () => {
        const info = await fileInfo(loc);
        const isDir = info ? info.isDir : (await collectFiles(loc, loc.path)).length > 0;
        if (!info && !isDir) throw new Error(`仓库中未找到: ${loc.path}`);
        const message = commitMessage("Rename", `${loc.path} → ${dst.path}`);
        if (!isDir) {
            if (loc.provider === "github") {
                await githubTreeCommit(loc, [
                    {path: dst.path, mode: info!.mode, type: "blob", sha: info!.sha},
                    {path: loc.path, mode: info!.mode, type: "blob", sha: null},
                ], message);
            } else {
                await giteeCommit(loc, [{action: "move", path: dst.path, previous_path: loc.path}], message);
            }
        } else {
            const files = await collectFiles(loc, loc.path);
            if (files.length === 0) throw new Error(`目录为空或不存在: ${loc.path}`);
            const prefix = loc.path + "/";
            if (loc.provider === "github") {
                const tree: {path: string; mode: string; type: string; sha: string | null}[] = [];
                for (const f of files) {
                    tree.push({path: dst.path + "/" + f.path.slice(prefix.length), mode: f.mode, type: "blob", sha: f.sha});
                    tree.push({path: f.path, mode: f.mode, type: "blob", sha: null});
                }
                await githubTreeCommit(loc, tree, message);
            } else {
                await giteeCommit(loc, files.map(f => ({
                    action: "move",
                    path: dst.path + "/" + f.path.slice(prefix.length),
                    previous_path: f.path,
                })), message);
            }
        }
        clearGitRepoCache(key);
    });
}