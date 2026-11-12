// 插件库 ↔ Git 远端双向同步(仅桌面端:要顺着链接读写外部真实文件)。
//
// 为什么需要基准(baseline):只有「本地当前」和「远端当前」两份快照时,一个文件在一侧消失
// 既可能是"这侧删了"也可能是"另一侧新增",无法区分,猜错的代价是删掉用户数据。
// 所以每次同步成功都记下两侧一致的 git blob sha,下次做 本地/远端/基准 三方比对。
//
// 安全边界(刻意不对称):
//   本地删除 → 提交远端删除(git 历史可找回)
//   远端删除 → **只报告,不删外部文件**(外部数据没有回收站,不可逆)
//   两侧都改 → 冲突,跳过并列出,绝不静默覆盖
//   链接断开/外部盘未挂载 → 本地扫描为空而基准非空时直接中止,避免把远端清空
//   点号开头的文件/目录一律不同步(.git、.env、.DS_Store 等),与思源同步的取舍一致
import {joinPath} from "../utils/path";
import {getNativeRequire} from "../utils/native-require";
import {buildGitRepoPath} from "../utils/git-repo-path";
import {libraryEntryPath} from "../utils/library-path";
import {
    LibraryEntry,
    LibraryGitBinding,
    getLibraryEntry,
    librarySystemPath,
    markLibrarySynced,
    removeLibraryEntry,
} from "./library";
import {
    GitBatchChange,
    gitCommitBatch,
    gitDownloadFile,
    gitFileSha,
    gitListFilesRecursive,
} from "./git-repo";
import {isNativeFsAvailable, nativeLstat, nativeWriteBinaryFile} from "./native-fs";

// 单文件上限:GitHub/Gitee 的提交接口按请求体积计费,过大直接失败
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 一次提交的文件数与字节数上限:超了拆成多个提交(每个都是完整可用的 commit)
const MAX_BATCH_FILES = 30;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;

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
    skipped: LibrarySyncIssue[];
    // 远端已删、本地仍在:只报告,外部文件保持原样
    remoteDeleted: string[];
}

function emptyReport(): LibrarySyncReport {
    return {pushed: 0, pulled: 0, removedRemote: 0, commits: 0, conflicts: [], skipped: [], remoteDeleted: []};
}

function requireDesktop(): void {
    if (!isNativeFsAvailable()) {
        throw new Error("插件库同步需要思源桌面端(移动端请直接编辑,内容会提交到 Git 远端)");
    }
}

function requireBinding(entry: LibraryEntry): LibraryGitBinding {
    if (!entry.git) {
        throw new Error(`「${entry.name}」还没绑定 Git 远程仓库,请先在右键菜单里绑定`);
    }
    return entry.git;
}

function remotePathOf(git: LibraryGitBinding, rel: string): string {
    return [git.path, rel].filter(Boolean).join("/");
}

function bindingRootVPath(git: LibraryGitBinding): string {
    return buildGitRepoPath({provider: git.provider, owner: git.owner, repo: git.repo, ref: git.ref, path: git.path});
}

// git blob sha = sha1("blob <字节数>\0" + 内容)。与远端树里的 sha 同一口径,
// 因此不用下载远端内容就能判断两侧是否一致。
function gitBlobSha(bytes: Uint8Array): string {
    const crypto = getNativeRequire()!("crypto") as typeof import("crypto");
    const h = crypto.createHash("sha1");
    h.update(`blob ${bytes.length}\0`);
    h.update(bytes);
    return h.digest("hex");
}

interface LocalFile {
    rel: string;
    sha: string;
    size: number;
}

// 扫描条目本地内容。只保留 sha 与大小,字节读完即弃 —— 大目录不会把内存吃满;
// 需要推送的文件在提交前再读一次(只有真正变过的文件才付这份代价)。
async function scanLocal(entry: LibraryEntry, rootSys: string, skipped: LibrarySyncIssue[]): Promise<LocalFile[]> {
    const fs = getNativeRequire()!("fs") as typeof import("fs");
    if (!entry.isDir) {
        const st = await fs.promises.stat(rootSys);
        if (st.size > MAX_FILE_BYTES) {
            skipped.push({path: entry.name, reason: `超过 ${MAX_FILE_BYTES / 1024 / 1024}MB,不同步`});
            return [];
        }
        const bytes = new Uint8Array(await fs.promises.readFile(rootSys));
        return [{rel: "", sha: gitBlobSha(bytes), size: bytes.length}];
    }
    const out: LocalFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
        for (const name of await fs.promises.readdir(dir)) {
            const childRel = rel ? `${rel}/${name}` : name;
            if (name.startsWith(".")) {
                skipped.push({path: childRel, reason: "点号开头,不同步"});
                continue;
            }
            const full = joinPath(dir, name);
            // lstat 不跟随链接:外部目录里若还有符号链接,跳过而不是钻进去(防回环、防意外外泄)
            const st = await fs.promises.lstat(full);
            if (st.isSymbolicLink()) {
                skipped.push({path: childRel, reason: "内部链接,不同步"});
                continue;
            }
            if (st.isDirectory()) {
                await walk(full, childRel);
                continue;
            }
            if (!st.isFile()) continue;
            if (st.size > MAX_FILE_BYTES) {
                skipped.push({path: childRel, reason: `超过 ${MAX_FILE_BYTES / 1024 / 1024}MB,不同步`});
                continue;
            }
            const bytes = new Uint8Array(await fs.promises.readFile(full));
            out.push({rel: childRel, sha: gitBlobSha(bytes), size: bytes.length});
        }
    };
    await walk(rootSys, "");
    return out;
}

async function scanRemote(git: LibraryGitBinding, isDir: boolean): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!isDir) {
        const sha = await gitFileSha(bindingRootVPath(git));
        if (sha) map.set("", sha);
        return map;
    }
    const prefix = git.path ? git.path + "/" : "";
    for (const f of await gitListFilesRecursive(bindingRootVPath(git))) {
        if (prefix && !f.path.startsWith(prefix)) continue;
        map.set(f.path.slice(prefix.length), f.sha);
    }
    return map;
}

// 分批提交:按文件数与累计字节切,避免单个请求过大被服务端拒
async function commitInBatches(
    git: LibraryGitBinding,
    items: {rel: string; bytes: Uint8Array | null}[],
    message: string,
    onProgress?: (msg: string) => void,
): Promise<number> {
    let commits = 0;
    let batch: GitBatchChange[] = [];
    let batchBytes = 0;
    const flush = async () => {
        if (batch.length === 0) return;
        await gitCommitBatch(bindingRootVPath(git), batch, message);
        commits++;
        onProgress?.(`已提交 ${commits} 次(${batch.length} 个文件)`);
        batch = [];
        batchBytes = 0;
    };
    for (const it of items) {
        const size = it.bytes ? it.bytes.length : 0;
        if (batch.length >= MAX_BATCH_FILES || (batchBytes + size > MAX_BATCH_BYTES && batch.length > 0)) {
            await flush();
        }
        batch.push({path: remotePathOf(git, it.rel), bytes: it.bytes});
        batchBytes += size;
    }
    await flush();
    return commits;
}

/**
 * 双向同步一个库条目。三方比对后先推后拉,冲突与远端删除只报告不动手。
 * 成功后把本次两侧一致的指纹写回注册表,作为下次的基准。
 */
export async function syncLibraryEntry(name: string, onProgress?: (msg: string) => void): Promise<LibrarySyncReport> {
    requireDesktop();
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    const git = requireBinding(entry);
    const rootSys = librarySystemPath(libraryEntryPath(name));
    if (!(await nativeLstat(rootSys))) {
        throw new Error(`库内链接不存在:${rootSys}。请重新添加该条目`);
    }

    const report = emptyReport();
    onProgress?.("扫描本地文件…");
    const localFiles = await scanLocal(entry, rootSys, report.skipped);
    const base = entry.baseline || {};
    // 链接断开/外部盘没挂时本地会扫成空,而基准里还有文件 —— 继续下去会把远端整棵删掉
    if (localFiles.length === 0 && Object.keys(base).length > 0) {
        throw new Error(`本地扫描到 0 个文件,但上次同步记录了 ${Object.keys(base).length} 个。`
            + "可能是链接断开或外部磁盘未挂载,已中止同步以免误删远端内容。");
    }
    const local = new Map(localFiles.map(f => [f.rel, f.sha]));

    onProgress?.("读取远端文件树…");
    const remote = await scanRemote(git, entry.isDir);

    const toUpdate: string[] = [];
    const toDelete: string[] = [];
    const toPull: string[] = [];
    const next: Record<string, string> = {};
    const rels = new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    for (const rel of rels) {
        const l = local.get(rel);
        const r = remote.get(rel);
        const b = base[rel];
        if (l && r) {
            if (l === r) {
                next[rel] = l;
            } else if (b && l === b) {
                toPull.push(rel);          // 只有远端改了
            } else if (b && r === b) {
                toUpdate.push(rel);        // 只有本地改了
            } else {
                report.conflicts.push({path: rel || entry.name, reason: "本地与远端都改过,已跳过;请手动决定保留哪一份"});
            }
        } else if (l && !r) {
            if (b) {
                // 远端删了、本地还在:只报告,外部文件不动。基准保留原值,
                // 否则下次同步会把它当"本地新增"又推回远端,等于撤销了远端的删除。
                report.remoteDeleted.push(rel || entry.name);
                next[rel] = b;
            } else {
                toUpdate.push(rel);        // 本地新增
            }
        } else if (!l && r) {
            if (b) toDelete.push(rel);     // 本地删了 → 提交远端删除
            else toPull.push(rel);         // 远端新增
        }
        // 两侧都没有:从基准里自然消失
    }

    // 待推送的文件此刻才读字节(只有真正变过的文件才付这份代价)
    const fs = getNativeRequire()!("fs") as typeof import("fs");
    const pushes: {rel: string; bytes: Uint8Array | null}[] = [];
    for (const rel of toUpdate) {
        pushes.push({
            rel,
            bytes: new Uint8Array(await fs.promises.readFile(rel ? joinPath(rootSys, rel) : rootSys)),
        });
    }
    const deletes: {rel: string; bytes: Uint8Array | null}[] = toDelete.map(rel => ({rel, bytes: null}));

    if (pushes.length > 0) {
        onProgress?.(`推送 ${pushes.length} 个文件…`);
        report.commits += await commitInBatches(git, pushes, `Sync ${entry.name}: update ${pushes.length} file(s) (siyuan-virtual-tree)`, onProgress);
        report.pushed = pushes.length;
    }
    if (deletes.length > 0) {
        onProgress?.(`提交 ${deletes.length} 个远端删除…`);
        report.commits += await commitInBatches(git, deletes, `Sync ${entry.name}: delete ${deletes.length} file(s) (siyuan-virtual-tree)`, onProgress);
        report.removedRemote = deletes.length;
    }
    for (const rel of toUpdate) next[rel] = local.get(rel)!;
    for (const rel of toDelete) delete next[rel];

    if (toPull.length > 0) {
        onProgress?.(`拉取 ${toPull.length} 个文件…`);
        for (const rel of toPull) {
            const vPath = buildGitRepoPath({
                provider: git.provider, owner: git.owner, repo: git.repo, ref: git.ref,
                path: remotePathOf(git, rel),
            });
            const bytes = new Uint8Array(await gitDownloadFile(vPath));
            // 顺着链接原地写:外部真实文件被更新,链接本身不受影响
            await nativeWriteBinaryFile(rel ? joinPath(rootSys, rel) : rootSys, bytes);
            next[rel] = remote.get(rel)!;
            report.pulled++;
        }
    }

    await markLibrarySynced(name, next);
    onProgress?.("同步完成");
    return report;
}

// 只推送(取消同步的 push 模式用):把本地改动送上去,不做拉取
export async function pushLibraryEntry(name: string, onProgress?: (msg: string) => void): Promise<LibrarySyncReport> {
    requireDesktop();
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    const git = requireBinding(entry);
    const rootSys = librarySystemPath(libraryEntryPath(name));
    if (!(await nativeLstat(rootSys))) {
        throw new Error(`库内链接不存在:${rootSys}`);
    }
    const report = emptyReport();
    const localFiles = await scanLocal(entry, rootSys, report.skipped);
    const remote = await scanRemote(git, entry.isDir);
    const changed = localFiles.filter(f => remote.get(f.rel) !== f.sha);
    if (changed.length === 0) {
        onProgress?.("本地没有需要推送的改动");
        return report;
    }
    const fs = getNativeRequire()!("fs") as typeof import("fs");
    const items: {rel: string; bytes: Uint8Array | null}[] = [];
    for (const f of changed) {
        items.push({
            rel: f.rel,
            bytes: new Uint8Array(await fs.promises.readFile(f.rel ? joinPath(rootSys, f.rel) : rootSys)),
        });
    }
    onProgress?.(`推送 ${items.length} 个文件…`);
    report.commits = await commitInBatches(git, items, `Sync ${name}: update ${items.length} file(s) (siyuan-virtual-tree)`, onProgress);
    report.pushed = items.length;
    const next: Record<string, string> = {...(entry.baseline || {})};
    for (const f of changed) next[f.rel] = f.sha;
    await markLibrarySynced(name, next);
    return report;
}

// 在远端提交删除该条目的全部内容(取消同步的 deleteRemote 模式用)。
// 外部真实文件不动;git 历史里仍可找回。
export async function deleteRemoteLibraryEntry(name: string, onProgress?: (msg: string) => void): Promise<number> {
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    const git = requireBinding(entry);
    const remote = await scanRemote(git, entry.isDir);
    if (remote.size === 0) return 0;
    const items = Array.from(remote.keys()).map(rel => ({rel, bytes: null}));
    onProgress?.(`在远端删除 ${items.length} 个文件…`);
    await commitInBatches(git, items, `Unlink ${name}: remove ${items.length} file(s) (siyuan-virtual-tree)`, onProgress);
    return items.length;
}

/**
 * 取消同步:按设置的模式处理远端,然后摘掉库内链接。
 * 无论哪种模式,**外部真实文件都不会被删除或改写** —— 库内条目与外部是同一份数据,
 * "回写外部"在正向链接方案里本来就已经完成。
 */
export async function unlinkLibraryEntry(
    name: string,
    mode: "push" | "keep" | "deleteRemote",
    onProgress?: (msg: string) => void,
): Promise<{removedRemote: number; pushed: number}> {
    requireDesktop();
    const entry = getLibraryEntry(name);
    if (!entry) throw new Error(`插件库里没有条目「${name}」`);
    let pushed = 0;
    let removedRemote = 0;
    if (entry.git && mode === "push") {
        pushed = (await pushLibraryEntry(name, onProgress)).pushed;
    } else if (entry.git && mode === "deleteRemote") {
        removedRemote = await deleteRemoteLibraryEntry(name, onProgress);
    }
    await removeLibraryEntry(name);
    return {removedRemote, pushed};
}