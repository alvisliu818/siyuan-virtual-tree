// 新标签页的「固定」与「收藏」数据:持久化到插件的 start-page.json
// (存于 data/storage/petal/<plugin>/),用法同 recent-files.ts / tags/tag-store.ts:
// loadData 异步、saveData 异步,内存缓存避免每次 await。
//
// 两组数据彼此独立:
//  - pinned  :固定区,钉在页顶的常驻区(少量、始终可见、最先)
//  - favorites:收藏区,页内一个普通分组列表
// 条目可以是插件打开的文件(kind=file,path)或思源笔记文档(kind=doc,id)。
import type {Plugin} from "siyuan";
import {basename} from "./utils/path";

const STORAGE_KEY = "start-page.json";
// 每组各自保留的上限
const MAX_PER_GROUP = 50;

// 数据变化事件(新标签页监听后重绘)
export const START_PAGE_CHANGED_EVENT = "syfe:start-page-changed";

export interface StartPageItem {
    kind: "file" | "doc";
    path?: string;   // kind=file:插件内路径(/data/... 或系统绝对路径)
    id?: string;     // kind=doc :思源文档 rootID(用 siyuan://blocks/<id> 打开)
    title: string;   // 显示名(文件为文件名,文档为标题)
    hpath?: string;  // kind=doc 的人类可读路径(如 /目录/文档)
    ts: number;      // 加入时间(用于组内排序)
}

export type StartGroup = "pinned" | "favorites";

interface StartPageStore {
    version: number;
    pinned: StartPageItem[];
    favorites: StartPageItem[];
}

let cached: StartPageStore = {version: 1, pinned: [], favorites: []};
let loaded = false;

function emitChanged(): void {
    window.dispatchEvent(new CustomEvent(START_PAGE_CHANGED_EVENT));
}

// 条目唯一键(同路径文件与同 id 文档分别去重)
export function keyOfItem(item: StartPageItem): string {
    return item.kind === "doc" ? `doc:${item.id}` : `file:${item.path}`;
}

// 落盘(失败仅记录,不阻断调用方)
async function persist(plugin: Plugin): Promise<void> {
    try {
        await plugin.saveData(STORAGE_KEY, cached);
    } catch (e) {
        console.error("[siyuan-file-editor] 保存新标签页数据失败:", e);
    }
}

function isValidItem(e: any): e is StartPageItem {
    if (!e || typeof e !== "object") return false;
    if (e.kind === "doc") return typeof e.id === "string" && !!e.id;
    if (e.kind === "file") return typeof e.path === "string" && !!e.path;
    return false;
}

// 载入(容错:文件缺失/损坏时按空数据处理)
export async function loadStartPage(plugin: Plugin): Promise<void> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        const pinned = data && Array.isArray(data.pinned) ? (data.pinned as any[]).filter(isValidItem) : [];
        const favorites = data && Array.isArray(data.favorites) ? (data.favorites as any[]).filter(isValidItem) : [];
        cached = {version: 1, pinned, favorites};
    } catch {
        cached = {version: 1, pinned: [], favorites: []};
    }
    loaded = true;
}

function groupOf(g: StartGroup): StartPageItem[] {
    return loaded ? cached[g] : [];
}

// 取某组条目(按加入时间倒序)
export function getGroup(g: StartGroup): StartPageItem[] {
    return groupOf(g).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export function getPinned(): StartPageItem[] {
    return getGroup("pinned");
}

export function getFavorites(): StartPageItem[] {
    return getGroup("favorites");
}

// 是否已固定 / 已收藏(按唯一键匹配)
export function inGroup(g: StartGroup, item: StartPageItem): boolean {
    const key = keyOfItem(item);
    return groupOf(g).some(i => keyOfItem(i) === key);
}

export function isPinned(item: StartPageItem): boolean {
    return inGroup("pinned", item);
}

export function isFavorite(item: StartPageItem): boolean {
    return inGroup("favorites", item);
}

// 加入某组(已存在则不重复加入,也不改变时间),超过上限时截断最早的
export async function addToGroup(plugin: Plugin, g: StartGroup, item: StartPageItem): Promise<void> {
    const key = keyOfItem(item);
    const list = cached[g];
    if (!list.some(i => keyOfItem(i) === key)) {
        list.unshift({...item, ts: item.ts || Date.now()});
        while (list.length > MAX_PER_GROUP) list.pop();
    }
    await persist(plugin);
    emitChanged();
}

// 从某组移除
export async function removeFromGroup(plugin: Plugin, g: StartGroup, item: StartPageItem): Promise<void> {
    const key = keyOfItem(item);
    const idx = cached[g].findIndex(i => keyOfItem(i) === key);
    if (idx < 0) return;
    cached[g].splice(idx, 1);
    await persist(plugin);
    emitChanged();
}

// 在某组中切换(返回切换后是否在该组内)
export async function toggleInGroup(plugin: Plugin, g: StartGroup, item: StartPageItem): Promise<boolean> {
    if (inGroup(g, item)) {
        await removeFromGroup(plugin, g, item);
        return false;
    }
    await addToGroup(plugin, g, item);
    return true;
}

// === 便捷构造:最近使用条目 / 路径 / 思源文档 ===

// 由文件路径构造条目(文件树右键、最近使用列表用)
export function itemFromPath(path: string): StartPageItem {
    return {kind: "file", path, title: basename(path), ts: Date.now()};
}

// 由思源文档构造条目
export function itemFromDoc(id: string, title: string, hpath?: string): StartPageItem {
    return {kind: "doc", id, title: title || id, hpath, ts: Date.now()};
}
