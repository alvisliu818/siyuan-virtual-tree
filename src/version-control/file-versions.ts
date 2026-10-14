// 文件版本控制存储
// 持久化:plugin.saveData/loadData("file-versions.json")(存到 data/storage/petal/<plugin>/)
//
// 为什么用独立的 saveData 文件而不是塞进 EditorConfig:
//   saveSettings 是整体覆写 this.config(见 index.ts 注释),版本历史这种列表型
//   大体积数据放配置里,一次设置保存就会被冲掉 —— 学 tags/tag-store.ts / open-with-store.ts
//   用独立文件 + 内存缓存。
//
// 快照时机:由 model-manager 的 saveModel 在落盘**前**调用 recordVersion,把
// 上次落盘的内容(lastSavedMap,即"修改前的磁盘内容")存为一条历史版本。
// 所有走 saveModel 的文本文件(markdown 页签、代码页签、关闭确认的保存)自动覆盖。

import type {Plugin} from "siyuan";

const STORAGE_KEY = "file-versions.json";
const DATA_VERSION = 1;

// 单条历史版本:修改前的完整内容
export interface FileVersion {
    time: number;    // 快照时间(ms 时间戳)
    size: number;    // 内容长度(字符数,粗略大小)
    content: string; // 修改前的完整内容
}

interface FileVersionsData {
    version: number;
    files: Record<string, FileVersion[]>;
}

// 内存缓存(最新在前);未加载完成时为空,recordVersion 照常入缓存,
// 加载完成后下一次快照起正常 —— 插件 onload 极早,实际不会有窗口期问题
let cached: FileVersionsData = {version: DATA_VERSION, files: {}};
let saver: ((data: FileVersionsData) => Promise<void>) | null = null;
// 每文件保留的历史条数;0 = 关闭版本控制(设置面板写入)
let keepCount = 10;
let persistTimer: number | undefined;

// 总体积兜底:所有历史内容加起来超过这个值就丢最老的,
// 防止大文件高频编辑把版本文件撑到几百 MB 拖垮思源同步
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;

// 防抖落盘:一次保存动作(可能含多次快照)只 persist 一次,避免拖慢 UI
function persist(): void {
    if (!saver) return;
    if (persistTimer !== undefined) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
        persistTimer = undefined;
        saver!(cached).catch(() => {
            // 保存失败时仍保留内存数据,避免本次会话丢失;不打断用户
        });
    }, 800);
}

// 当前全部历史的总字符数(算过一遍后顺手返回,避免再遍历一次)
function totalChars(): number {
    let total = 0;
    for (const list of Object.values(cached.files)) {
        for (const v of list) total += v.content.length;
    }
    return total;
}

// 插件 onload 时调用:接入持久化并加载历史数据
export async function initFileVersions(
    plugin: {loadData(key: string): Promise<any>; saveData(key: string, data: any): Promise<void>},
): Promise<void> {
    saver = (data) => plugin.saveData(STORAGE_KEY, data);
    try {
        const raw = await plugin.loadData(STORAGE_KEY);
        // 坑:文件从未保存过时 loadData 返回空串而不是 null,必须安全解析
        if (raw && typeof raw === "object" && raw.files && typeof raw.files === "object") {
            cached = {version: DATA_VERSION, files: raw.files};
        }
    } catch {
        // 首次使用/数据损坏:从空数据开始
    }
}

// 设置每文件保留的历史条数(0=关闭并清空已有历史);设置面板保存时调用
export function setVersionKeepCount(n: number): void {
    keepCount = Math.max(0, Math.floor(n) || 0);
    if (keepCount === 0 && Object.keys(cached.files).length > 0) {
        cached.files = {};
        persist();
    }
}

// 记录"修改前"的版本。oldContent = 本次保存前磁盘上的内容。
// 与上一条相同(连续重复保存,内容没变)不记录;keepCount=0 时忽略。
export function recordVersion(path: string, oldContent: string): void {
    if (keepCount <= 0) return;
    const list = cached.files[path] || [];
    if (list.length > 0 && list[0].content === oldContent) return;
    list.unshift({time: Date.now(), size: oldContent.length, content: oldContent});
    while (list.length > keepCount) list.pop();
    cached.files[path] = list;
    // 总体积兜底:超限后按时间从老到新丢,直到回到上限内
    let total = totalChars();
    if (total > MAX_TOTAL_CHARS) {
        // 收集(路径,索引,时间),老的先丢
        type Ent = {path: string; idx: number; time: number};
        const ents: Ent[] = [];
        for (const [p, l] of Object.entries(cached.files)) {
            l.forEach((v, i) => ents.push({path: p, idx: i, time: v.time}));
        }
        ents.sort((a, b) => a.time - b.time);
        for (const e of ents) {
            if (total <= MAX_TOTAL_CHARS) break;
            total -= cached.files[e.path][e.idx].content.length;
            cached.files[e.path].splice(e.idx, 1);
            if (cached.files[e.path].length === 0) delete cached.files[e.path];
        }
    }
    persist();
}

// 某文件的历史版本(最新在前);返回副本,调用方改不动缓存
export function getVersions(path: string): FileVersion[] {
    return (cached.files[path] || []).slice();
}

// 清空某文件的全部历史
export function clearVersions(path: string): void {
    if (cached.files[path]) {
        delete cached.files[path];
        persist();
    }
}

// 供类型检查:与 Plugin 的 loadData/saveData 兼容
export type FileVersionsPlugin = Pick<Plugin, "loadData" | "saveData">;
