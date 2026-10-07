// 虚拟文档树:用户自己组织的一棵树,初始为空,可挂载任意条目。
// 可挂载类型:
//   file  真实文件/文件夹(来自插件文件树的右键菜单,isDir 已知,无需再探测)
//   doc   思源文档(挂载后**自动带出其子文档**,逐级懒加载)
//   block 思源块(挂载后按 parent_id 递归展开子块)
// 支持**嵌套**:挂载项可挂在其它挂载项下(菜单里选「顶层」或某个已有挂载点)。
// 持久化:plugin.saveData/loadData("virtual-tree.json");变化派发 syfe:mount-tree-changed。
import type {Plugin} from "siyuan";
import {parseStoredData} from "./utils/stored-data";
import {VIRTUAL_PREFIX, NOTEBOOK_PREFIX, virtualId} from "./utils/virtual-tree";

// 可挂载类型:
//   file     真实文件/文件夹(来自插件文件树的右键菜单,isDir 已知,无需再探测)
//   doc      思源文档(挂载后**自动带出其子文档**,逐级懒加载)
//   notebook 思源笔记本(挂载后列出其顶级文档)
//   block    思源块(挂载后按 parent_id 递归展开子块)
export type MountKind = "file" | "doc" | "notebook" | "block";

// 树上的一个挂载节点
export interface MountItem {
    uid: string;                 // 唯一标识(挂载时生成)
    kind: MountKind;
    name: string;                // 显示名(挂载瞬间的快照)
    path?: string;               // kind=file:真实路径
    targetId?: string;           // kind=doc:docId;kind=block:blockId
    isDir?: boolean;             // kind=file:是否文件夹(挂载时已知,避免 readDir 猜不出)
    children: MountItem[];       // 显式嵌套挂载(与"自动子项"不同,自动子项不落盘)
}

export const MOUNT_TREE_CHANGED_EVENT = "syfe:mount-tree-changed";
// 引用关系树内容变化(设置开关切换 / 文档增删改后重建完成)→ 面板重绘
export const SYFE_RELATION_TREE_CHANGED_EVENT = "syfe:relation-tree-changed";
export const STORAGE_VIRTUAL_TREE = "virtual-tree.json";

let roots: MountItem[] = [];
let saver: ((data: any) => Promise<any>) | null = null;
let loaded = false;

function newUid(): string {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 挂载项是否是合法的(缺关键字段的丢弃,防止手改 JSON 面板崩)
function sanitizeItem(raw: any): MountItem | null {
    if (!raw || typeof raw !== "object") return null;
    const kind = raw.kind as MountKind;
    if (kind !== "file" && kind !== "doc" && kind !== "notebook" && kind !== "block") return null;
    if (kind === "file" && typeof raw.path !== "string") return null;
    if (kind !== "file" && typeof raw.targetId !== "string") return null;
    return {
        uid: typeof raw.uid === "string" && raw.uid ? raw.uid : newUid(),
        kind,
        name: String(raw.name || raw.path || raw.targetId || ""),
        ...(typeof raw.path === "string" ? {path: raw.path} : {}),
        ...(typeof raw.targetId === "string" ? {targetId: raw.targetId} : {}),
        ...(raw.isDir !== undefined ? {isDir: !!raw.isDir} : {}),
        children: Array.isArray(raw.children)
            ? raw.children.map(sanitizeItem).filter(Boolean) as MountItem[]
            : [],
    };
}

function dispatchChanged(): void {
    try {
        window.dispatchEvent(new CustomEvent(MOUNT_TREE_CHANGED_EVENT));
    } catch {
        // 非浏览器环境忽略
    }
}

async function persist(): Promise<void> {
    if (!saver) return;
    try {
        await saver({version: 1, roots});
    } catch (e) {
        console.error("[siyuan-file-editor] 保存虚拟文档树失败:", e);
    }
}

// 初始化(插件 onLayoutReady 时调用)
export async function initMountTree(plugin: Plugin): Promise<void> {
    saver = (data: any) => plugin.saveData(STORAGE_VIRTUAL_TREE, data);
    roots = [];
    try {
        const raw = await plugin.loadData(STORAGE_VIRTUAL_TREE);
        // 首次使用时文件不存在,loadData 返回空串;必须走安全解析,否则 JSON.parse("") 会抛
        const parsed = parseStoredData(raw);
        const list = parsed && Array.isArray(parsed.roots) ? parsed.roots : (Array.isArray(parsed) ? parsed : []);
        roots = list.map(sanitizeItem).filter(Boolean) as MountItem[];
    } catch (e) {
        console.error("[siyuan-file-editor] 加载虚拟文档树失败:", e);
        roots = [];
    }
    loaded = true;
    dispatchChanged();
}

// 顶层挂载项(只读副本)
export function getRoots(): MountItem[] {
    return loaded ? roots.slice() : [];
}

export function isMountTreeEmpty(): boolean {
    return getRoots().length === 0;
}

// 深度优先查找某 uid 的挂载项
export function findMountItem(uid: string): MountItem | null {
    const walk = (list: MountItem[]): MountItem | null => {
        for (const it of list) {
            if (it.uid === uid) return it;
            const hit = walk(it.children || []);
            if (hit) return hit;
        }
        return null;
    };
    return walk(getRoots());
}

// 查找某挂载项的父 uid(顶层返回 null;未找到返回 undefined 以便与"父为 null"区分)
function findParentUid(uid: string, list: MountItem[], parent: string | null): string | null | undefined {
    for (const it of list) {
        if (it.uid === uid) return parent;
        const hit = findParentUid(uid, it.children || [], it.uid);
        if (hit !== undefined) return hit;
    }
    return undefined;
}

export function getParentUid(uid: string): string | null {
    const r = findParentUid(uid, getRoots(), null);
    return r === undefined ? null : r;
}

// 去重键:同类同目标在同一父节点下只保留一条
function dedupKey(it: {kind: MountKind; path?: string; targetId?: string}): string {
    return it.kind === "file" ? `file:${it.path}` : `${it.kind}:${it.targetId}`;
}

// 挂载到指定父节点(不传 parentUid = 顶层);同位置重复挂载视为更新显示名
export async function addMountItem(
    plugin: Plugin,
    input: {kind: MountKind; name: string; path?: string; targetId?: string; isDir?: boolean},
    parentUid?: string | null,
): Promise<MountItem | null> {
    if (!loaded) await initMountTree(plugin);
    const key = dedupKey(input);
    const item: MountItem = {
        uid: newUid(),
        kind: input.kind,
        name: input.name || input.path || input.targetId || "",
        ...(input.path ? {path: input.path} : {}),
        ...(input.targetId ? {targetId: input.targetId} : {}),
        ...(input.isDir !== undefined ? {isDir: input.isDir} : {}),
        children: [],
    };
    if (parentUid) {
        const parent = findMountItem(parentUid);
        if (!parent) return null; // 父节点已不存在(可能刚被取消挂载)
        const dup = parent.children.find(c => dedupKey(c) === key);
        if (dup) {
            dup.name = item.name;
            dup.isDir = item.isDir;
            await persist();
            dispatchChanged();
            return dup;
        }
        parent.children.push(item);
    } else {
        const dup = roots.find(c => dedupKey(c) === key);
        if (dup) {
            dup.name = item.name;
            dup.isDir = item.isDir;
            await persist();
            dispatchChanged();
            return dup;
        }
        roots.push(item);
    }
    await persist();
    dispatchChanged();
    return item;
}

// 取消挂载(连同其嵌套子树一起移除);返回是否确有记录被移除
export async function removeMountItem(plugin: Plugin, uid: string): Promise<boolean> {
    if (!loaded) await initMountTree(plugin);
    const strip = (list: MountItem[]): boolean => {
        const idx = list.findIndex(c => c.uid === uid);
        if (idx >= 0) {
            list.splice(idx, 1);
            return true;
        }
        return list.some(c => strip(c.children || []));
    };
    const removed = strip(roots);
    if (removed) {
        await persist();
        dispatchChanged();
    }
    return removed;
}

// 注:按用户要求**不提供"一键清空整棵树"**;取消挂载请用 removeMountItem(逐条移除)。
// 可作为挂载目标的节点(供右键子菜单列出:顶层 + 所有挂载项,带面包屑)
export interface MountTarget {
    uid: string | null;   // null = 顶层
    label: string;        // "顶层" 或 "父 / 子"
}

export function listMountTargets(): MountTarget[] {
    const out: MountTarget[] = [{uid: null, label: "顶层"}];
    const walk = (list: MountItem[], trail: string[]) => {
        for (const it of list) {
            const t = [...trail, it.name];
            out.push({uid: it.uid, label: t.join(" / ")});
            walk(it.children || [], t);
        }
    };
    walk(getRoots(), []);
    return out;
}

// 面板用:某挂载项下是否已挂载了同类同目标(菜单打勾用)
export function hasMounted(parentUid: string | null, kind: MountKind, path?: string, targetId?: string): boolean {
    const probe = {kind, path, targetId};
    const key = dedupKey(probe);
    const list = parentUid ? (findMountItem(parentUid)?.children || []) : getRoots();
    return list.some(c => dedupKey(c) === key);
}

// 空态提示文案(含转义,供面板直接插入 innerHTML)
export function mountTreeEmptyHint(): string {
    return escapeHTML(
        "还没有挂载任何内容。\n" +
        "· 在本面板空白处右键,选择「挂载思源文档/笔记本…」或「挂载文件/文件夹…」;\n" +
        "· 或在插件文件树里右键文件/文件夹,在思源文档树、正文块上右键,选择「挂载到虚拟文档树」。",
    );
}

// ===== 旧数据迁移:文件树里的思源文档树(sy-mounts.json 的 sydoc:// 条目)→ 虚拟文档树 =====
// 旧版把思源文档/笔记本挂到文件树的真实目录下(渲染成 sydoc:// 虚拟条目)。
// 该能力已迁到本面板,这里把已有条目搬过来,避免用户重新挂一遍。
// 同一目标(笔记本/文档)已存在则跳过;bdpan://(百度网盘)条目不动。
export async function migrateSyDocMounts(
    plugin: Plugin,
    legacy: Array<{parent?: string; vPath?: string; name?: string}>,
): Promise<number> {
    if (!loaded) await initMountTree(plugin);
    let moved = 0;
    for (const m of legacy) {
        const vPath = String(m?.vPath || "");
        if (!vPath.startsWith(VIRTUAL_PREFIX)) continue;   // 只搬思源文档/笔记本
        const id = virtualId(vPath);
        if (!id) continue;
        const isNb = vPath.startsWith(NOTEBOOK_PREFIX);
        const payload = {
            kind: (isNb ? "notebook" : "doc") as MountKind,
            name: String(m?.name || id),
            targetId: id,
        };
        // 顶层已挂过同目标就跳过(不重复添加)
        if (hasMounted(null, payload.kind, undefined, payload.targetId)) continue;
        await addMountItem(plugin, payload, null);
        moved++;
    }
    if (moved > 0) {
        console.log(`[siyuan-file-editor] 已把 ${moved} 个思源文档挂载迁移到虚拟文档树`);
    }
    return moved;
}
