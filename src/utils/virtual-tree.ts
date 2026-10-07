// 虚拟挂载:把思源笔记本 / 文档树(含子文档)映射为文件树可浏览的虚拟目录。
//
// 虚拟路径格式(与真实文件路径区分,不与任何文件系统路径冲突):
//   sydoc://nb/<notebookId>  挂载整个笔记本(顶层 = 该笔记本的顶级文档)
//   sydoc://<docId>          挂载某个文档(其子文档树)
//
// 数据来源:
//   - 笔记本列表:  /api/notebook/lsNotebooks
//   - 子文档列表:  /api/filetree/listDocsByPath(每次一层)
//   - 文档归属:    SQL blocks 表查 box/path(展开单个文档节点时用,带缓存)
// 思源 .sy 文件名即文档 ID,/filetree/listDocsByPath 返回的 path 末段去掉 .sy 即 docId。
import {DirEntry} from "../types";
import {STORAGE_SY_MOUNTS} from "../constants";
import {querySQL, lsNotebooks, listDocsByPath} from "../api/file";
import {isBaiduPath} from "./baidu-path";
import {parseStoredData} from "./stored-data";

export const VIRTUAL_PREFIX = "sydoc://";
export const NOTEBOOK_PREFIX = "sydoc://nb/";

// 是否虚拟文档树路径
export function isVirtualPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(VIRTUAL_PREFIX);
}

// 是否笔记本挂载根
export function isNotebookRoot(p: string): boolean {
    return typeof p === "string" && p.startsWith(NOTEBOOK_PREFIX);
}

// 从虚拟路径提取 ID(笔记本 id 或文档 id)
export function virtualId(p: string): string {
    if (isNotebookRoot(p)) return p.slice(NOTEBOOK_PREFIX.length).replace(/\/+$/, "");
    return p.slice(VIRTUAL_PREFIX.length).replace(/\/+$/, "");
}

// 文档信息(box + .sy path + hpath),展开文档节点时查询
interface DocInfo {
    box: string;
    path: string; // .sy 相对路径,如 /20260906113500-abc/xxx.sy
    hpath: string;
}
const docInfoCache = new Map<string, DocInfo | null>();

// 查询文档归属(SQL;失败/不存在返回 null,缓存避免重复查询)
export async function getDocInfo(docId: string): Promise<DocInfo | null> {
    if (docInfoCache.has(docId)) return docInfoCache.get(docId)!;
    let info: DocInfo | null = null;
    try {
        const id = docId.replace(/'/g, "''");
        const rows = await querySQL(
            `SELECT box, path, hpath FROM blocks WHERE id = '${id}' AND type = 'd' LIMIT 1`);
        if (Array.isArray(rows) && rows[0] && rows[0].box && rows[0].path) {
            info = {box: String(rows[0].box), path: String(rows[0].path), hpath: String(rows[0].hpath || "")};
        }
    } catch {
        info = null;
    }
    if (docInfoCache.size > 2000) docInfoCache.clear();
    docInfoCache.set(docId, info);
    return info;
}

// 清空文档信息缓存(文档结构变化后重查)
export function clearDocInfoCache(): void {
    docInfoCache.clear();
}

// ===== 文档标题(docId → 人类可读标题) =====
// 标签面板等处以 sydoc://<id> 为键的条目,显示名用文档标题而不是裸 ID;
// 与文档图标一样走"先按缓存画、后台补齐后重绘一次"的模式。
const docTitleCache = new Map<string, string>();

export function cachedDocTitle(docId: string): string | undefined {
    return docTitleCache.get(docId);
}

export async function getDocTitle(docId: string): Promise<string> {
    if (docTitleCache.has(docId)) return docTitleCache.get(docId)!;
    const info = await getDocInfo(docId);
    // 文档已删除/查询失败时回退 docId(仍可点击尝试打开)
    const title = info?.hpath ? info.hpath.split("/").pop() || docId : docId;
    docTitleCache.set(docId, title);
    return title;
}

const pendingTitles = new Set<string>();

// 批量确保文档标题已缓存(并发去重),取到后 onChange 一次(用于同步渲染后补绘)
export function ensureDocTitles(docIds: string[], onChange: () => void): void {
    const todo = Array.from(new Set(docIds.filter(id => id && !docTitleCache.has(id) && !pendingTitles.has(id))));
    if (todo.length === 0) return;
    todo.forEach(id => pendingTitles.add(id));
    void (async () => {
        for (const id of todo) {
            try {
                await getDocTitle(id);
            } finally {
                pendingTitles.delete(id);
            }
        }
        onChange();
    })();
}

// 从 listDocsByPath 返回项构造虚拟目录条目
// item: {name(标题), path(/xxx/yyy.sy), icon(自定义图标), subFileCount(子文档数), ...}
function toEntry(item: any): DirEntry {
    const syPath: string = String(item.path || "");
    const docId = syPath.split("/").pop()?.replace(/\.sy$/i, "") || "";
    return {
        name: String(item.name || docId),
        isDir: true, // 文档可含子文档,按目录渲染(无子文档时点开展示"空目录")
        size: 0,
        updated: "",
        path: VIRTUAL_PREFIX + docId,
        // 与思源文档树一致的图标渲染所需:自定义图标 + 子文档数(子文档数>0 用"文件夹"默认图标)
        icon: String(item.icon || ""),
        subFileCount: Number.isFinite(item?.subFileCount) ? Number(item.subFileCount) : undefined,
    };
}

// 列出虚拟路径下的条目(文档树一层)
export async function virtualListDir(vPath: string): Promise<DirEntry[]> {
    if (isNotebookRoot(vPath)) {
        const nbId = virtualId(vPath);
        const docs = await listDocsByPath(nbId, "/");
        return docs.map(toEntry);
    }
    // 文档节点:先查归属(box + .sy path)再列子文档
    const docId = virtualId(vPath);
    const info = await getDocInfo(docId);
    if (!info) throw new Error(`文档不存在或已删除: ${docId}`);
    const docs = await listDocsByPath(info.box, info.path);
    return docs.map(toEntry);
}


// === 真实目录下的虚拟条目挂载 ===
// 把思源笔记本 / 文档(sydoc://)或百度网盘目录(bdpan://)挂到文件树的真实目录下,
// 渲染为该目录下的虚拟条目,与真实文件并存。
// 挂载只是元数据(不写文件系统),持久化到插件存储 sy-mounts.json。

// 挂载记录:parent = 挂载到的真实目录;vPath = 虚拟路径(sydoc:// 或 bdpan://);name = 显示名
export interface SyMount {
    parent: string;
    vPath: string;
    name: string;
}

// 可挂载的虚拟路径:sydoc://(思源文档树)或 bdpan://(百度网盘)
function isMountablePath(p: string): boolean {
    return isVirtualPath(p) || isBaiduPath(p);
}

let mountList: SyMount[] = [];
let mountSaver: ((data: string) => Promise<void>) | null = null;

// 目录键归一化:统一分隔符/大小写/结尾分隔符,用于挂载父目录匹配
export function normDirKey(p: string): string {
    const fwd = (p || "").replace(/\\/g, "/");
    if (fwd === "/" || fwd === "") return "/";
    return fwd.replace(/\/+$/, "").toLowerCase();
}

// 加载挂载记录并设置持久化回调(插件 onLayoutReady 时调用)
export async function initMountStore(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    mountSaver = (data: string) => plugin.saveData(STORAGE_SY_MOUNTS, data);
    mountList = [];
    try {
        const raw = await plugin.loadData(STORAGE_SY_MOUNTS);
        // 首次使用文件不存在时 loadData 返回空串,必须安全解析
        const parsed = parseStoredData(raw);
        if (Array.isArray(parsed)) {
            mountList = parsed
                .filter((m: any) => m && typeof m.parent === "string" && typeof m.vPath === "string" && isMountablePath(m.vPath))
                .map((m: any) => ({parent: String(m.parent), vPath: String(m.vPath), name: String(m.name || "")}));
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载挂载记录失败:", e);
        mountList = [];
    }
}

// 全部挂载记录(只读副本)
export function getMountList(): SyMount[] {
    return mountList.slice();
}

// 列出挂载到某真实目录下的文档/笔记本
export function getMountsUnder(dir: string): SyMount[] {
    if (mountList.length === 0) return [];
    const key = normDirKey(dir);
    return mountList.filter(m => normDirKey(m.parent) === key);
}

async function persistMounts(): Promise<void> {
    if (!mountSaver) return;
    try {
        await mountSaver(JSON.stringify(mountList));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存挂载记录失败:", e);
    }
}

// 挂载虚拟条目到真实目录(同目录同路径只保留一条,显示名更新为最新)
export async function addMount(parent: string, vPath: string, name: string): Promise<void> {
    if (!isMountablePath(vPath)) return;
    const key = normDirKey(parent);
    mountList = mountList.filter(m => !(normDirKey(m.parent) === key && m.vPath === vPath));
    mountList.push({parent, vPath, name: name || virtualId(vPath)});
    await persistMounts();
}

// 取消挂载;返回是否确有记录被移除
export async function removeMount(parent: string, vPath: string): Promise<boolean> {
    const key = normDirKey(parent);
    const before = mountList.length;
    mountList = mountList.filter(m => !(normDirKey(m.parent) === key && m.vPath === vPath));
    if (mountList.length !== before) await persistMounts();
    return mountList.length !== before;
}

// 迁移到虚拟文档树后,清掉旧的思源文档挂载记录(只删 sydoc://,百度网盘 bdpan:// 保留)
export async function dropSyDocMounts(): Promise<number> {
    const before = mountList.length;
    mountList = mountList.filter(m => !m.vPath.startsWith(VIRTUAL_PREFIX));
    const removed = before - mountList.length;
    if (removed > 0) await persistMounts();
    return removed;
}
