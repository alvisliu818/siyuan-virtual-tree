// 插件库:把外部文件/文件夹以**正向链接**接进思源数据目录,再借 Git 远端与移动端互通。
//
// 数据流(用户选定的方案):
//   桌面端  库内条目 = junction/符号链接/硬链接 → 外部真实路径(同一份数据,不搬移)
//   传输    桌面端把库内容提交到 GitHub/Gitee 私有仓库(api/git-repo.ts)
//   移动端  链接不会被思源同步过来,但 library.json 会 → 移动端按注册表把库内路径
//           重定向到已绑定的 github:// / gitee:// 路径,查看与编辑都走 Git,提交即回传
//   回程    桌面端拉取远端改动,顺着链接写回外部真实路径
//
// 为什么库内路径在桌面端必须走原生 fs:内核 putFile 用 gulu.File.WriteFileSafer(temp+rename),
// 对库根的「文件链接」条目会把链接本身替换成普通文件 —— 链接断了,外部文件也收不到改动。
// 原生 fs.writeFile 是原地截断写,链接与外部数据都保住。
import {DirEntry} from "../types";
import {STORAGE_LIBRARY} from "../constants";
import {basename, isKernelPath, joinPath} from "../utils/path";
import {getWorkspacePath, toSystemPath} from "../utils/system-path";
import {parseStoredData} from "../utils/stored-data";
import {isMobileFrontend} from "../utils/platform";
import {
    LIBRARY_ROOT,
    isLibraryEntryRoot,
    isLibraryPath,
    isLibraryRoot,
    libraryEntryNameOf,
    libraryEntryPath,
    libraryRelPath,
} from "../utils/library-path";
import {GitProvider, buildGitRepoPath, isGitRepoPath} from "../utils/git-repo-path";
import {
    nativeCreateLink,
    nativeLstat,
    nativeMkdir,
    nativeReadDir,
    nativeReadlink,
    nativeRemoveFile,
    nativeRemoveLink,
    nativeRenameFile,
    isNativeFsAvailable,
} from "./native-fs";
import {gitRename} from "./git-repo";
import {getNativeRequire} from "../utils/native-require";

export type LibraryLinkKind = "junction" | "symlink" | "hardlink";

// 库条目绑定的 Git 远端位置(移动端就是靠它访问库内容的)
export interface LibraryGitBinding {
    provider: GitProvider;
    owner: string;
    repo: string;
    ref: string;
    path: string;   // 仓库内相对路径;"" = 仓库根
}

// 同步报告类型定义在这里而不是 library-sync.ts:注册表要存上次报告,
// 而 library-sync 依赖 library,反过来依赖会成环
export interface LibrarySyncIssue {
    path: string;
    reason: string;
}

export interface LibrarySyncReport {
    pushed: number;
    pulled: number;
    removedRemote: number;
    commits: number;
    conflicts: LibrarySyncIssue[];
    remoteDeleted: string[];
    skipped: LibrarySyncIssue[];
    at?: number;
}

export interface LibraryEntry {
    name: string;           // 库内显示名,同时是库根下的链接名
    target: string;         // 外部真实路径(系统绝对路径)
    isDir: boolean;
    linkKind: LibraryLinkKind;
    createdAt: number;
    git?: LibraryGitBinding;
    lastSyncAt?: number;
    // 上次同步成功时两侧一致的文件指纹(条目内相对路径 → git blob sha)。
    // 三方比对的基准:没有它就分不清「本地删了」与「远端新增」,只能靠猜,会丢数据。
    baseline?: Record<string, string>;
    lastReport?: LibrarySyncReport;
}

let entries: LibraryEntry[] = [];
let saver: ((data: string) => Promise<void>) | null = null;

export async function initLibraryStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    saver = (data: string) => plugin.saveData(STORAGE_LIBRARY, data);
    entries = [];
    try {
        const parsed = parseStoredData(await plugin.loadData(STORAGE_LIBRARY));
        if (Array.isArray(parsed)) {
            entries = parsed
                .filter((e: any) => e && typeof e.name === "string" && typeof e.target === "string")
                .map((e: any) => ({
                    name: String(e.name),
                    target: String(e.target),
                    isDir: e.isDir === true,
                    linkKind: (["junction", "symlink", "hardlink"].includes(e.linkKind) ? e.linkKind : "junction") as LibraryLinkKind,
                    createdAt: Number(e.createdAt) || 0,
                    git: e.git && typeof e.git.owner === "string" ? e.git as LibraryGitBinding : undefined,
                    lastSyncAt: Number(e.lastSyncAt) || undefined,
                    baseline: e.baseline && typeof e.baseline === "object" ? e.baseline as Record<string, string> : undefined,
                    lastReport: e.lastReport && typeof e.lastReport === "object" ? e.lastReport as LibrarySyncReport : undefined,
                }));
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载插件库注册表失败:", e);
        entries = [];
    }
}

async function persist(): Promise<void> {
    if (!saver) return;
    try {
        await saver(JSON.stringify(entries));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存插件库注册表失败:", e);
    }
}

export function getLibraryEntries(): LibraryEntry[] {
    return entries.slice();
}

export function getLibraryEntry(name: string): LibraryEntry | undefined {
    return entries.find(e => e.name === name);
}

export function getLibraryEntryByPath(path: string): LibraryEntry | undefined {
    const name = libraryEntryNameOf(path);
    return name ? getLibraryEntry(name) : undefined;
}

// ===== 路径分流 =====

export function librarySystemPath(path: string): string {
    return toSystemPath(path, getWorkspacePath());
}

// 库内路径 → 条目绑定的 Git 远端虚拟路径;未绑定或库根返回 null
export function libraryRemotePathOf(path: string): string | null {
    const name = libraryEntryNameOf(path);
    if (!name) return null;
    const git = getLibraryEntry(name)?.git;
    if (!git) return null;
    const rel = libraryRelPath(path);
    const remote = [git.path, rel].filter(Boolean).join("/");
    return buildGitRepoPath({provider: git.provider, owner: git.owner, repo: git.repo, ref: git.ref, path: remote});
}

// 供 api/file.ts 在每个读写入口调用:把库内路径换成当前形态真正能访问的路径。
// 桌面端 → 系统绝对路径(落到原生 fs 分支,保住链接);移动端 → 已绑定的 Git 虚拟路径。
export function redirectLibraryPath(path: string): string {
    if (!isLibraryPath(path)) return path;
    if (isNativeFsAvailable()) return librarySystemPath(path);
    const remote = libraryRemotePathOf(path);
    if (remote) return remote;
    const name = libraryEntryNameOf(path);
    throw new Error(name
        ? `「${name}」还没绑定 Git 远程仓库,移动端无法访问。请在桌面端右键该条目 →「Git 同步…」`
        : "移动端只能打开已绑定 Git 远程仓库的库条目");
}

// 列库目录:桌面端读真实链接,移动端按注册表合成(链接在那边不存在)
export async function libraryListDir(path: string): Promise<DirEntry[]> {
    if (isNativeFsAvailable()) {
        const sys = librarySystemPath(path);
        if (isLibraryRoot(path)) await nativeMkdir(sys);   // 首次展开时把库根建出来
        return nativeReadDir(sys);
    }
    if (!isLibraryRoot(path)) {
        // 已绑定条目的子路径在库根那一层就被换成 github:// 了,走到这里说明没绑定
        const name = libraryEntryNameOf(path);
        throw new Error(`「${name}」还没绑定 Git 远程仓库,移动端无法浏览。请在桌面端右键该条目 →「Git 同步…」`);
    }
    return entries.map(e => {
        const remote = libraryRemotePathOf(libraryEntryPath(e.name));
        return {
            name: e.name,
            isDir: e.isDir,
            size: 0,
            updated: e.lastSyncAt ? new Date(e.lastSyncAt).toISOString() : "",
            // 绑定了远端就直接给 Git 虚拟路径,后续浏览/编辑/提交全部复用现成的 Git 后端
            ...(remote ? {path: remote} : {}),
        };
    });
}

// 删除库内路径:条目根只摘链接(外部数据与远端都不动),条目内部是外部真实文件,按普通删除处理
export async function libraryRemove(path: string): Promise<void> {
    if (isLibraryEntryRoot(path)) {
        await removeLibraryEntry(libraryEntryNameOf(path));
        return;
    }
    await nativeRemoveFile(redirectLibraryPath(path));
}

// 改名/移动库内路径。条目根改名后注册表必须跟着改,否则「取消同步」按名字找不到条目。
export async function libraryRename(path: string, newPath: string): Promise<void> {
    const from = redirectLibraryPath(path);
    const to = redirectLibraryPath(newPath);
    if (isGitRepoPath(from) || isGitRepoPath(to)) {
        await gitRename(from, to);
        return;
    }
    await nativeRenameFile(from, to);
    if (!isLibraryEntryRoot(path)) return;
    const entry = getLibraryEntry(libraryEntryNameOf(path));
    if (!entry) return;
    if (isLibraryEntryRoot(newPath)) entry.name = libraryEntryNameOf(newPath);
    else entries = entries.filter(e => e !== entry);   // 链接被移出库,不再是库条目
    await persist();
}

// ===== 链接创建 / 解除 =====

function normSys(p: string): string {
    const fwd = (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    // Windows 盘符/UNC 大小写不敏感;POSIX 路径不能折叠大小写
    return /^[A-Za-z]:/.test(fwd) || fwd.startsWith("//") ? fwd.toLowerCase() : fwd;
}

function containsPath(ancestor: string, descendant: string): boolean {
    const a = normSys(ancestor);
    const d = normSys(descendant);
    return d === a || d.startsWith(a + "/");
}

// 库根下可用的唯一名字:同名自动加 " (2)" 后缀
function uniqueName(base: string): string {
    const taken = new Set(entries.map(e => e.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base} (${i})`;
        if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`库里同名条目过多,无法为「${base}」生成唯一名字`);
}

function requireFs(): void {
    if (!isNativeFsAvailable()) {
        throw new Error("插件库的链接操作需要思源桌面端(移动端没有 Node,无法创建 junction)");
    }
}

// 把外部文件/文件夹接进库。target 可以是系统绝对路径,也可以是内核路径(/data/...)。
export async function addLibraryEntry(target: string, name?: string): Promise<LibraryEntry> {
    requireFs();
    const req = getNativeRequire();
    const fs = req!("fs") as typeof import("fs");
    const absTarget = toSystemPath((target || "").trim(), getWorkspacePath());
    if (!absTarget || isKernelPath(absTarget)) throw new Error("请提供外部文件或文件夹的绝对路径");

    const libSys = librarySystemPath(LIBRARY_ROOT);
    // 自指与回环:库内路径接进库没意义;库根的祖先接进库会让 junction 无限递归
    if (containsPath(libSys, absTarget)) throw new Error("该路径已在插件库内,不需要重复添加");
    if (containsPath(absTarget, libSys)) {
        throw new Error("该文件夹包含插件库自身,添加后会造成链接回环,已拒绝");
    }
    const dup = entries.find(e => normSys(e.target) === normSys(absTarget));
    if (dup) throw new Error(`该路径已在库中(条目「${dup.name}」)`);

    let st: import("fs").Stats;
    try {
        st = await fs.promises.stat(absTarget);
    } catch {
        throw new Error(`路径不存在或无法访问: ${absTarget}`);
    }
    const isDir = st.isDirectory();
    const entryName = uniqueName((name || "").trim() || basename(absTarget));
    const linkPath = joinPath(libSys, entryName);
    await nativeMkdir(libSys);

    let linkKind: LibraryLinkKind;
    if (isDir) {
        // junction 不需要管理员权限,且思源同步会整棵跳过(正是我们要的)
        await nativeCreateLink(absTarget, linkPath, "junction");
        linkKind = "junction";
    } else {
        try {
            await nativeCreateLink(absTarget, linkPath, "symlink");
            linkKind = "symlink";
        } catch (e) {
            // 文件符号链接需要管理员/开发者模式;降级到硬链接(同样无需权限,但要求同一卷)
            try {
                await nativeCreateLink(absTarget, linkPath, "hardlink");
                linkKind = "hardlink";
            } catch {
                throw new Error(`无法为文件创建链接:${(e as Error).message}。`
                    + "硬链接降级也失败(通常是因为外部文件与思源工作空间不在同一个磁盘分区)。"
                    + "可开启 Windows「开发者模式」后重试,或改为添加它所在的文件夹。");
            }
        }
    }

    const entry: LibraryEntry = {
        name: entryName,
        target: absTarget,
        isDir,
        linkKind,
        createdAt: Date.now(),
    };
    entries.push(entry);
    await persist();
    return entry;
}

// 取消同步:只摘掉库内链接并清注册表,**外部真实数据一个字节都不动**。
// Git 远端如何处理由设置里的取消同步模式决定(见 api/library-sync.ts),不在这里做。
export async function removeLibraryEntry(name: string): Promise<void> {
    requireFs();
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    const linkPath = librarySystemPath(libraryEntryPath(name));
    if (await nativeLstat(linkPath)) await nativeRemoveLink(linkPath);
    entries = entries.filter(e => e.name !== name);
    await persist();
}

// 条目当前的链接状态(右键菜单/图标用):链接是否还在、指向哪里
export async function libraryLinkState(name: string): Promise<{exists: boolean; isLink: boolean; target: string}> {
    const entry = getLibraryEntry(name);
    const linkPath = librarySystemPath(libraryEntryPath(name));
    const st = await nativeLstat(linkPath);
    if (!st) return {exists: false, isLink: false, target: entry?.target || ""};
    const real = st.isLink ? await nativeReadlink(linkPath) : null;
    // junction 的 readlink 结果带 NT 对象前缀(\??\E:\...),去掉才是用户认得的路径
    const cleaned = real ? real.replace(/^\\\?\?\\/, "") : "";
    return {exists: true, isLink: st.isLink, target: cleaned || entry?.target || ""};
}

// ===== Git 绑定 =====

export async function setLibraryGitBinding(name: string, git: LibraryGitBinding | null): Promise<void> {
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    // 基准是「针对某个远端某个分支」的指纹。换了仓库/分支/子目录还留着旧基准,
    // 三方比对会把两个不相干的历史混在一起判,可能误删远端或误覆盖本地
    const keyOf = (g?: LibraryGitBinding | null) => g ? `${g.provider}/${g.owner}/${g.repo}@${g.ref}:${g.path}` : "";
    if (keyOf(entry.git) !== keyOf(git)) {
        delete entry.baseline;
        delete entry.lastReport;
        delete entry.lastSyncAt;
    }
    if (git) entry.git = git;
    else delete entry.git;
    await persist();
}

// 同步成功后落基准:baseline 是本次两侧达成一致的文件指纹,下次同步靠它做三方比对。
// 报告一并存下来,下次打开对话框还能看到上次同步的结果(冲突/远端删除尤其需要留痕)
export async function markLibrarySynced(name: string, baseline: Record<string, string>, report?: LibrarySyncReport): Promise<void> {
    const entry = getLibraryEntry(name);
    if (!entry) return;
    entry.lastSyncAt = Date.now();
    entry.baseline = baseline;
    if (report) entry.lastReport = {...report, at: entry.lastSyncAt};
    await persist();
}

// 移动端形态判定导出给 UI 用(库根在移动端要显示"内容来自 Git 远端"的提示)
export function isLibraryRemoteOnly(): boolean {
    return isMobileFrontend() || !isNativeFsAvailable();
}