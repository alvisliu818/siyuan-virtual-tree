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
import {querySQL} from "./api/file";
import {soloImageInfo, SoloImage} from "./utils/blocks";

// 可挂载类型:
//   file     真实文件/文件夹(来自插件文件树的右键菜单,isDir 已知,无需再探测)
//   doc      思源文档(挂载后**自动带出其子文档**,逐级懒加载)
//   notebook 思源笔记本(挂载后列出其顶级文档)
//   block    思源块(挂载后按 parent_id 递归展开子块)
export type MountKind = "file" | "doc" | "notebook" | "block";

// 单图块的图片信息快照。挂载目标菜单是同步渲染的,缩略图数据必须在挂载这一刻
// 就可同步读取(存在挂载项上),不能等菜单打开时再异步查 —— 那是「首次打开空白、
// 第二次才有图」的根因。文档里图片后来改动了,由菜单预取(healBlockMountImages)修正。
export interface MountItemImage {
    src: string;    // 资源地址,如 assets/x.png
    alt: string;    // 提示文本
    title: string;  // 标题(可空)
}

// 树上的一个挂载节点
export interface MountItem {
    uid: string;                 // 唯一标识(挂载时生成)
    kind: MountKind;
    name: string;                // 显示名(挂载瞬间的快照)
    path?: string;               // kind=file:真实路径
    targetId?: string;           // kind=doc:docId;kind=block:blockId
    isDir?: boolean;             // kind=file:是否文件夹(挂载时已知,避免 readDir 猜不出)
    img?: MountItemImage;        // kind=block 且整段单图:图片信息快照(菜单缩略图用)
    children: MountItem[];       // 显式嵌套挂载(与"自动子项"不同,自动子项不落盘)
}

export const MOUNT_TREE_CHANGED_EVENT = "syfe:mount-tree-changed";
// 引用关系树内容变化(设置开关切换 / 文档增删改后重建完成)→ 面板重绘
export const SYFE_RELATION_TREE_CHANGED_EVENT = "syfe:relation-tree-changed";
export const STORAGE_VIRTUAL_TREE = "virtual-tree.json";

let roots: MountItem[] = [];
// 自动挂载层(引用子层级)的展示顺序:父文档 id → 该层 docId 有序数组。
// 与 roots 同存 virtual-tree.json —— 挂载配置持有全部顺序,关系配置不再有 customOrder。
let autoOrder: Record<string, string[]> = {};
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
        ...(raw.img && typeof raw.img.src === "string" && raw.img.src
            ? {img: {src: String(raw.img.src), alt: String(raw.img.alt || ""), title: String(raw.img.title || "")}}
            : {}),
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
        await saver({version: 1, roots, customOrder: autoOrder});
    } catch (e) {
        console.error("[siyuan-file-editor] 保存虚拟文档树失败:", e);
    }
}

// 初始化(插件 onLayoutReady 时调用);dispatch=false 供"重读不改"场景使用
export async function initMountTree(plugin: Plugin, dispatch = true): Promise<void> {
    saver = (data: any) => plugin.saveData(STORAGE_VIRTUAL_TREE, data);
    roots = [];
    try {
        const raw = await plugin.loadData(STORAGE_VIRTUAL_TREE);
        // 首次使用时文件不存在,loadData 返回空串;必须走安全解析,否则 JSON.parse("") 会抛
        const parsed = parseStoredData(raw);
        const list = parsed && Array.isArray(parsed.roots) ? parsed.roots : (Array.isArray(parsed) ? parsed : []);
        roots = list.map(sanitizeItem).filter(Boolean) as MountItem[];
        // 自动挂载层顺序(旧文件没有该字段 → 空表;非法条目丢弃)
        autoOrder = {};
        const rawOrder = (parsed && typeof parsed === "object") ? (parsed as {customOrder?: unknown}).customOrder : null;
        if (rawOrder && typeof rawOrder === "object") {
            for (const [k, v] of Object.entries(rawOrder)) {
                if (Array.isArray(v)) autoOrder[k] = v.filter((x): x is string => typeof x === "string");
            }
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载虚拟文档树失败:", e);
        roots = [];
    }
    loaded = true;
    if (dispatch) dispatchChanged();
}

// 从存储重读挂载树(其他前端窗口写入本插件存储后,由 onDataChanged 调用)。
// 内容无变化时不派发事件(避免面板无谓重绘),返回是否有变化。
export async function reloadMountTreeIfChanged(plugin: Plugin): Promise<boolean> {
    const before = JSON.stringify({roots, autoOrder});
    await initMountTree(plugin, false);
    if (JSON.stringify({roots, autoOrder}) === before) return false;
    dispatchChanged();
    return true;
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
    // 单图块快照:挂载目标菜单是同步渲染的,缩略图数据必须在挂载这一刻就查好落盘,
    // 不能等菜单打开时再异步补(那是「首次打开空白、第二次才有图」的根因)。
    // 查询失败不阻塞挂载:无快照时菜单退回块 id 文本,下次开菜单由预取补写。
    // 单图块名称置空:目标标签尾巴退回块 id,不把图片标题/提示文本并排写进标签。
    let name = input.name || input.path || input.targetId || "";
    let img: MountItemImage | undefined;
    if (input.kind === "block" && input.targetId) {
        try {
            const rs = await querySQL(`SELECT markdown FROM blocks WHERE id = '${input.targetId.replace(/'/g, "''")}'`);
            const solo = soloImageInfo(String((rs && rs[0] ? rs[0].markdown : "") || ""));
            if (solo) {
                img = {src: solo.src, alt: solo.alt, title: solo.title};
                name = "";
            }
        } catch {
            // 查询失败:无快照,菜单退块 id;预取会在下次打开菜单时补
        }
    }
    const key = dedupKey(input);
    const item: MountItem = {
        uid: newUid(),
        kind: input.kind,
        name,
        ...(input.path ? {path: input.path} : {}),
        ...(input.targetId ? {targetId: input.targetId} : {}),
        ...(input.isDir !== undefined ? {isDir: input.isDir} : {}),
        ...(img ? {img} : {}),
        children: [],
    };
    if (parentUid) {
        const parent = findMountItem(parentUid);
        if (!parent) return null; // 父节点已不存在(可能刚被取消挂载)
        const dup = parent.children.find(c => dedupKey(c) === key);
        if (dup) {
            dup.name = item.name;
            dup.isDir = item.isDir;
            if (item.img) dup.img = item.img;
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
            if (item.img) dup.img = item.img;
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

// 拖拽排序:把 srcUid 移动到同一父节点下 dstUid 的**之前/之后**。
//
// 只处理兄弟之间重排:嵌套到别的挂载项属于"改变层级"(语义完全不同,还要判
// 子孙回环),不做。返回是否真的改变了顺序,调用方据此决定要不要重绘/提示。
export async function reorderMountItem(
    srcUid: string,
    dstUid: string,
    position: "before" | "after",
): Promise<boolean> {
    if (!loaded) return false;
    if (!srcUid || !dstUid || srcUid === dstUid) return false;
    if (!findMountItem(srcUid) || !findMountItem(dstUid)) return false;
    // 注意 getParentUid 对"未找到"也返回 null,所以上面先做存在性校验
    const parentUid = getParentUid(srcUid);
    if (parentUid !== getParentUid(dstUid)) return false; // 不同父 → 不是兄弟
    const list = parentUid ? (findMountItem(parentUid)?.children || null) : roots;
    if (!list) return false;
    const from = list.findIndex(it => it.uid === srcUid);
    const to = list.findIndex(it => it.uid === dstUid);
    if (from < 0 || to < 0) return false;
    // 先算好插槽再动数组:slot = 目标在旧数组里的插入点;移除自己之后,
    // 位于自己之后的元素下标会左移一位,插入点要减 1
    const slot = position === "before" ? to : to + 1;
    const insert = from < slot ? slot - 1 : slot;
    if (insert === from) return false; // 已经在那个位置,不必落盘
    const [moved] = list.splice(from, 1);
    list.splice(insert, 0, moved);
    await persist();
    dispatchChanged();
    return true;
}

// 自动挂载层顺序(供渲染排序;键 = 父文档 id)
export function getAutoOrder(parentDocId: string): string[] {
    return autoOrder[parentDocId] || [];
}

// 自动挂载行拖拽排序:siblingIds 为当前展示顺序(全量),重排后整层落盘。
// 注意:只持久化、不派发 changed 事件 —— 顺序变化由调用方直接重绘,
// 否则会触发引用关系整树重建,拖一次卡一下。
export async function reorderAutoChildren(
    parentDocId: string,
    siblingIds: string[],
    srcDocId: string,
    dstDocId: string,
    position: "before" | "after",
): Promise<boolean> {
    if (!parentDocId || srcDocId === dstDocId) return false;
    if (!siblingIds.includes(srcDocId) || !siblingIds.includes(dstDocId)) return false;
    const from = siblingIds.indexOf(srcDocId);
    const to = siblingIds.indexOf(dstDocId);
    const slot = position === "before" ? to : to + 1;
    const insert = from < slot ? slot - 1 : slot;
    if (insert === from) return false; // 已经在那个位置,不必落盘
    const list = siblingIds.slice();
    const [moved] = list.splice(from, 1);
    list.splice(insert, 0, moved);
    autoOrder = {...autoOrder, [parentDocId]: list};
    await persist();
    return true;
}

// 注:按用户要求**不提供"一键清空整棵树"**;取消挂载请用 removeMountItem(逐条移除)。
// 可作为挂载目标的节点(供右键子菜单列出:顶层 + 所有挂载项,带面包屑)
export interface MountTarget {
    uid: string | null;   // null = 顶层
    label: string;        // "顶层" 或 "父 / 子"
    kind?: MountKind;     // 挂载项类型(菜单渲染图片缩略图用;顶层无)
    targetId?: string;    // kind=doc/notebook/block 的目标块 id
    img?: MountItemImage; // kind=block 且单图:挂载时的图片快照(菜单首开即显缩略图)
}

export function listMountTargets(): MountTarget[] {
    const out: MountTarget[] = [{uid: null, label: "顶层"}];
    const walk = (list: MountItem[], trail: string[]) => {
        for (const it of list) {
            // 块挂载项名称可能为空(图片块挂载时有意置空):目标列表尾巴用块 id 兜底,
            // 缩略图由菜单读挂载项快照(components/mount-menu.ts),标签里不写图片文字
            const tail = it.name || (it.kind === "block" ? (it.targetId || "") : "");
            const t = [...trail, tail];
            out.push({uid: it.uid, label: t.join(" / "), kind: it.kind, targetId: it.targetId, img: it.img});
            walk(it.children || [], t);
        }
    };
    walk(getRoots(), []);
    return out;
}

// 挂载目标菜单的预取修正:把最新查到的单图信息写回挂载项快照 ——
// 覆盖两类场景:① 旧版本挂载项没有快照(首次打开菜单无图,补上后永久有);
// ② 文档里图片后来改过 / 不再是整段单图(快照过期)。有变化才落盘;
// 不派发 changed 事件:面板行预览自己现查 markdown,不依赖快照,无需整树重绘。
export async function healBlockMountImages(latest: Map<string, SoloImage | null>): Promise<boolean> {
    if (!loaded || latest.size === 0) return false;
    let changed = false;
    const walk = (list: MountItem[]): void => {
        for (const it of list) {
            if (it.kind === "block" && it.targetId && latest.has(it.targetId)) {
                const img = latest.get(it.targetId)!;
                if (img) {
                    if (!it.img || it.img.src !== img.src || it.img.alt !== img.alt || it.img.title !== img.title) {
                        it.img = {src: img.src, alt: img.alt, title: img.title};
                        changed = true;
                    }
                    // 老数据把单图块名存成「(空块)」或图片标题/提示文字:统一清空,
                    // 目标标签退回块 id,避免「缩略图 + 文字」并排出现
                    if (it.name === "(空块)"
                        || (img.title && it.name === img.title)
                        || (img.alt && it.name === img.alt)) {
                        it.name = "";
                        changed = true;
                    }
                } else if (it.img) {
                    delete it.img;   // 块不再是整段单图(改成文字/多图等)
                    changed = true;
                }
            }
            if (it.children && it.children.length) walk(it.children);
        }
    };
    walk(roots);
    if (changed) await persist();
    return changed;
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
