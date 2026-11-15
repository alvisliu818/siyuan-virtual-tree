// OneDrive 云同步(EasySync 模式:云中转,无本地服务器,移动端天然支持)。
//
// 复用 LAN 同步的通用三方引擎(runThreeWaySync):同一套基线/删除语义/冲突策略,
// 这里只提供 OneDrive 远端实现(Graph API):
//   list  = 递归 odListDir(children 分页,lastModifiedDateTime → mtimeMs)
//   read  = odDownloadFile → base64
//   write = odUploadFileMeta(PUT /content,响应体即 driveItem 元数据)→ 返回云端真实 size/mtime
//   remove= odRemove
// 移动端:引擎不依赖 Node —— 本地走内核 API(pickSyncFs),云端走 odGraph(直连优先/
// 内核代理兜底),两端行为一致;本端目录移动端须为 /data/... 内核路径。
import type {Plugin} from "siyuan";
import {odListDir, odDownloadFile, odRemove, odCreateDir, odUploadFileMeta} from "./onedrive";
import {
    runThreeWaySync,
    pickSyncFs,
    bytesToBase64,
    base64ToBytes,
    syncMaxFileBytes,
    LanSyncReport,
    LanSyncProgress,
    RemoteFs,
    FileMeta,
} from "./lan-sync";
import {basename, dirname, joinPath} from "../utils/path";
import {OD_PREFIX} from "../utils/onedrive-path";

// Plugin 泛型上没有 config 字段(插件实例才有),统一收窄
type PluginWithConfig = Plugin & {config: any};

// ===== 任务存取(配置里的 odSyncTasks JSON 串) =====

export interface OdSyncTask {
    id: string;
    name: string;
    localRoot: string;      // 本端目录:桌面端内核路径/绝对路径均可;移动端必须 /data/...
    remotePath: string;     // OneDrive 目录(onedrive:// 虚拟路径,如 onedrive://docs/backup)
    direction: "both" | "push" | "pull";
    includeRules: string;
    excludeRules: string;
    lastSyncTs?: number;
}

export function parseOdSyncTasks(raw: string | undefined): OdSyncTask[] {
    if (!raw) return [];
    try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data.filter((t: any) => t && typeof t.id === "string" && typeof t.localRoot === "string") as OdSyncTask[];
    } catch {
        return [];
    }
}

export function serializeOdSyncTasks(tasks: OdSyncTask[]): string {
    return JSON.stringify(tasks);
}

export async function saveOdSyncTasks(plugin: PluginWithConfig, tasks: OdSyncTask[]): Promise<void> {
    plugin.config.odSyncTasks = serializeOdSyncTasks(tasks);
    const {saveConfig} = await import("../utils/config");
    await saveConfig(plugin, plugin.config);
}

function newTaskId(): string {
    return "od" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ===== OneDrive 远端实现(RemoteFs) =====

// 逐级确保云端父目录存在(已存在等冲突错误忽略,真正失败在写入时报)
async function odEnsureDirs(vDir: string): Promise<void> {
    const relSegs = vDir.slice(OD_PREFIX.length).split("/").filter(Boolean);
    let cur = OD_PREFIX;
    for (const seg of relSegs) {
        cur = cur + seg;
        try {
            await odCreateDir(cur);
        } catch {
            // 已存在(nameAlreadyExists 409 等)忽略
        }
        cur = cur.replace(/\/+$/, "") + "/";
    }
}

// 规范化远端根:onedrive:// 前缀 + 无尾斜杠
function normOdRoot(remotePath: string): string {
    let p = (remotePath || "").trim();
    if (!p.startsWith("onedrive://")) p = "onedrive://" + p.replace(/^\/+/, "");
    return p.replace(/\/+$/, "") || OD_PREFIX;
}

function odRemoteFs(remotePath: string): RemoteFs {
    const root = normOdRoot(remotePath);
    // rel ← 虚拟路径:去掉根前缀与分隔斜杠
    const relOf = (vPath: string): string => {
        const prefix = root === OD_PREFIX ? OD_PREFIX : root + "/";
        return vPath.startsWith(prefix) ? vPath.slice(prefix.length) : "";
    };
    const vPathOf = (rel: string): string => joinPath(root, rel);
    return {
        async list(): Promise<Record<string, FileMeta>> {
            const out: Record<string, FileMeta> = {};
            const walk = async (vDir: string, rel: string): Promise<void> => {
                let entries;
                try {
                    entries = await odListDir(vDir);
                } catch (e) {
                    // 远端目录尚未创建(首次同步常态):按空远端处理,后续写入会逐级建目录;
                    // 其他错误(网络/令牌)照常抛出
                    if (String((e as Error)?.message || e).includes("404")) return;
                    throw e;
                }
                for (const e of entries || []) {
                    if (e.isDir) {
                        await walk(e.path || joinPath(vDir, e.name), rel ? rel + "/" + e.name : e.name);
                    } else {
                        const relChild = rel ? rel + "/" + e.name : e.name;
                        if (!relChild) continue;
                        const updated = Date.parse(String(e.updated || ""));
                        out[relChild] = {
                            size: Number(e.size) || 0,
                            mtimeMs: Number.isFinite(updated) && updated > 0 ? updated : 0,
                        };
                    }
                }
            };
            await walk(root, "");
            return out;
        },
        async read(rel: string): Promise<{dataBase64: string; size: number; mtimeMs: number}> {
            const buf = new Uint8Array(await odDownloadFile(vPathOf(rel)));
            return {dataBase64: bytesToBase64(buf), size: buf.length, mtimeMs: 0};
        },
        async write(rel: string, dataBase64: string, mtimeMs: number): Promise<{size: number; mtimeMs: number}> {
            const vPath = vPathOf(rel);
            await odEnsureDirs(dirname(vPath));
            const meta = await odUploadFileMeta(vPath, base64ToBytes(dataBase64));
            void mtimeMs; // PUT /content 不能设云端 mtime;基线记云端响应的真实时间即可
            return meta;
        },
        async remove(rel: string): Promise<void> {
            await odRemove(vPathOf(rel));
        },
    };
}

// ===== 同步执行 =====

export async function runOdSyncTask(plugin: PluginWithConfig, task: OdSyncTask, preview = false, onProgress?: LanSyncProgress): Promise<LanSyncReport> {
    if (!task.remotePath || normOdRoot(task.remotePath) === OD_PREFIX) {
        throw new Error("请先配置 OneDrive 远端目录(onedrive:// 路径)");
    }
    const {fs: localFs, root: localRoot} = pickSyncFs(task);
    void syncMaxFileBytes; // 引擎内部按平台取上限
    return await runThreeWaySync(plugin, {
        taskId: task.id,
        localRoot,
        localFs,
        remote: odRemoteFs(task.remotePath),
        direction: task.direction,
        rules: task,
        preview,
        onProgress,
    });
}

export async function previewOdSyncTask(plugin: PluginWithConfig, task: OdSyncTask, onProgress?: LanSyncProgress): Promise<LanSyncReport> {
    return await runOdSyncTask(plugin, task, true, onProgress);
}
