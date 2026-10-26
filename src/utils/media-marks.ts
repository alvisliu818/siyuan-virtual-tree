// 音视频时间戳标记(持久化到插件存储)
//
// 场景:看视频/听录音时给某个时间点打个点、写个标签(比如"3:12 关键结论"),
// 之后能一键跳回去,还能把「跳到这个时间点」的链接复制成 Markdown 粘进思源文档
// —— 在思源里点这个链接,插件会打开对应媒体文件并从这个时间点开始播放。
//
// 存储:data/storage/petal/<plugin>/media-marks.json
//   { "<文件绝对路径>": [ {t: 12.5, label: "关键结论"} ] }
// 按绝对路径存,与页签 data.path 的口径一致(正斜杠)。

import {IPluginForMediaTab} from "../tabs/media-tab";

const STORAGE_KEY = "media-marks.json";

export interface MediaMark {
    /** 时间点(秒) */
    t: number;
    /** 标签/备注(可为空) */
    label: string;
}

type MarkStore = Record<string, MediaMark[]>;

function normPath(p: string): string {
    return String(p || "").replace(/\\/g, "/");
}

// 读取全部(失败时退化为里空表,不让存储问题影响播放器)
export async function loadAllMarks(plugin: IPluginForMediaTab): Promise<MarkStore> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        return (data && typeof data === "object") ? (data as MarkStore) : {};
    } catch {
        return {};
    }
}

// 写回(静默失败:标记丢了也比播放不了强)
async function saveAllMarks(plugin: IPluginForMediaTab, store: MarkStore): Promise<void> {
    try {
        await plugin.saveData(STORAGE_KEY, store);
    } catch {
        // 忽略
    }
}

/** 取某个文件的标记(按时间点升序) */
export async function loadMarks(plugin: IPluginForMediaTab, path: string): Promise<MediaMark[]> {
    const store = await loadAllMarks(plugin);
    return (store[normPath(path)] || []).slice().sort((a, b) => a.t - b.t);
}

/** 覆盖写某个文件的标记(去空、去重、排序) */
export async function saveMarks(plugin: IPluginForMediaTab, path: string, marks: MediaMark[]): Promise<MediaMark[]> {
    const clean = (marks || [])
        .filter(m => isFinite(m.t) && m.t >= 0)
        .map(m => ({t: Number(m.t), label: String(m.label || "").trim()}))
        .sort((a, b) => a.t - b.t);
    const store = await loadAllMarks(plugin);
    const key = normPath(path);
    if (clean.length > 0) store[key] = clean;
    else delete store[key];
    await saveAllMarks(plugin, store);
    return clean;
}

/** 追加或更新一个标记(同一时间点覆盖标签) */
export async function upsertMark(plugin: IPluginForMediaTab, path: string, mark: MediaMark): Promise<MediaMark[]> {
    const list = await loadMarks(plugin, path);
    const hit = list.find(m => Math.abs(m.t - mark.t) < 0.05);
    if (hit) hit.label = mark.label;
    else list.push({t: mark.t, label: mark.label});
    return await saveMarks(plugin, path, list);
}

/** 删除一个标记 */
export async function removeMark(plugin: IPluginForMediaTab, path: string, t: number): Promise<MediaMark[]> {
    const list = await loadMarks(plugin, path);
    return await saveMarks(plugin, path, list.filter(m => Math.abs(m.t - t) >= 0.05));
}
