// 最近使用:持久化到插件的 recents.json(存于 data/storage/petal/<plugin>/)
// 两类条目:
//  - file:插件打开的文件(编辑器/图片/Office/Markdown),path 为文件绝对路径
//  - doc :思源笔记文档,记录文档 rootID 与标题,点击用 siyuan://blocks/<id> 打开
// 用于侧边栏「最近使用」面板;file 部分同时供斜杆命令文件选择器「最近打开」分组使用。
// 用法同 tags/tag-store:loadData 异步、saveData 异步;内存缓存避免每次 await。
import type {Plugin} from "siyuan";

const STORAGE_KEY = "recents.json";
// 每类条目各自保留的上限(文件 30、文档 30)
const MAX_PER_KIND = 30;

// 最近列表变化事件(侧边栏「最近使用」面板监听后重绘;新增/移除/清空都会派发)
export const RECENTS_CHANGED_EVENT = "syfe:recents-changed";

export interface RecentFileEntry {
    kind: "file";
    path: string;
    ts: number;
}

export interface RecentDocEntry {
    kind: "doc";
    id: string;      // 文档 rootID(用 siyuan://blocks/<id> 打开)
    title: string;   // 文档标题
    hpath?: string;  // 人类可读路径(如 /目录/文档)
    ts: number;
}

export type RecentEntry = RecentFileEntry | RecentDocEntry;

// 内存缓存:最近使用条目(最新在前)
let cached: RecentEntry[] = [];
let loaded = false;

function emitRecentsChanged(): void {
    window.dispatchEvent(new CustomEvent(RECENTS_CHANGED_EVENT));
}

// 条目唯一键(同路径文件与同 id 文档分别去重)
function keyOf(e: RecentEntry): string {
    return e.kind === "file" ? `file:${e.path}` : `doc:${e.id}`;
}

// 落盘(防抖合并:打开文件是高频操作,而思源会同步整个 data/ 目录,
// 每次写 storage/petal 都会触发内核自动同步;短时间内多次变化只写一次)
let persistTimer: number | undefined;
let persistPlugin: Plugin | undefined;
const PERSIST_DELAY = 3000;

async function persist(plugin: Plugin): Promise<void> {
    persistPlugin = plugin;
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
        persistTimer = undefined;
        void doPersist();
    }, PERSIST_DELAY);
}

async function doPersist(): Promise<void> {
    if (!persistPlugin) return;
    try {
        await persistPlugin.saveData(STORAGE_KEY, {entries: cached});
    } catch (e) {
        console.error("[siyuan-file-editor] 保存最近使用失败:", e);
    }
}

// 立即落盘(插件卸载时调用,避免防抖窗口内的数据丢失)
export async function flushRecents(): Promise<void> {
    if (persistTimer) {
        window.clearTimeout(persistTimer);
        persistTimer = undefined;
    }
    await doPersist();
}

function isValidEntry(e: any): e is RecentEntry {
    if (!e || typeof e !== "object") return false;
    if (e.kind === "file") return typeof e.path === "string" && !!e.path;
    if (e.kind === "doc") return typeof e.id === "string" && !!e.id;
    return false;
}

// 去重后置于最前,并按类别各自截断到上限(避免某一类挤掉另一类)
function pushFront(entry: RecentEntry): void {
    const key = keyOf(entry);
    const idx = cached.findIndex(e => keyOf(e) === key);
    if (idx >= 0) cached.splice(idx, 1);
    cached.unshift(entry);
    const counts: Record<string, number> = {file: 0, doc: 0};
    cached = cached.filter(e => {
        counts[e.kind] = (counts[e.kind] || 0) + 1;
        return counts[e.kind] <= MAX_PER_KIND;
    });
}

// 加载最近使用(兼容旧格式 {files: string[]})
export async function loadRecents(plugin: Plugin): Promise<RecentEntry[]> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        if (data && Array.isArray(data.entries)) {
            cached = (data.entries as any[]).filter(isValidEntry);
        } else if (data && Array.isArray(data.files)) {
            // 旧格式迁移:纯文件路径数组,按原顺序(最新在前)补时间戳
            const now = Date.now();
            cached = (data.files as any[])
                .filter((p: any) => typeof p === "string" && p)
                .map((p: string, i: number) => ({kind: "file" as const, path: p, ts: now - i}));
        } else {
            cached = [];
        }
    } catch {
        cached = [];
    }
    loaded = true;
    return cached;
}

// 获取全部条目(按时间倒序;无 ts 的旧数据按存储顺序)
export function getRecentEntries(): RecentEntry[] {
    if (!loaded) return [];
    return cached
        .map((e, i) => ({e, i}))
        .sort((a, b) => (b.e.ts || 0) - (a.e.ts || 0) || a.i - b.i)
        .map(x => x.e);
}

// 获取最近打开的文件路径(供斜杆命令文件选择器使用)
export function getRecents(): string[] {
    if (!loaded) return [];
    return cached.filter((e): e is RecentFileEntry => e.kind === "file").map(e => e.path);
}

// 记录文件为最近使用
export async function addRecent(plugin: Plugin, path: string): Promise<void> {
    if (!path) return;
    pushFront({kind: "file", path, ts: Date.now()});
    await persist(plugin);
    emitRecentsChanged();
}

// 记录思源笔记文档为最近使用
export async function addRecentDoc(
    plugin: Plugin,
    id: string,
    title: string,
    hpath?: string,
): Promise<void> {
    if (!id) return;
    pushFront({kind: "doc", id, title: title || id, hpath, ts: Date.now()});
    await persist(plugin);
    emitRecentsChanged();
}

// 移除单条
export async function removeRecent(plugin: Plugin, entry: RecentEntry): Promise<void> {
    const key = keyOf(entry);
    const idx = cached.findIndex(e => keyOf(e) === key);
    if (idx < 0) return;
    cached.splice(idx, 1);
    await persist(plugin);
    emitRecentsChanged();
}

// 清空最近使用(文件与文档全部清除)
export async function clearRecents(plugin: Plugin): Promise<void> {
    cached = [];
    await persist(plugin);
    emitRecentsChanged();
}
