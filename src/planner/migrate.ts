// 从「虚拟文档树」插件迁移 planner 数据。
//
// 背景:planner 最早是虚拟文档树里的一个模块，数据存在
// `data/storage/petal/siyuan-virtual-tree/planner.json`。独立成插件后存储目录变成
// `.../siyuan-planner/`，插件私有存储是**按插件名隔离**的 —— 新插件的 loadData 读不到
// 旧那一份，用户之前建的习惯、任务会凭空消失。
//
// 所以首次启动（本插件还没有任何数据）时主动去把旧文件读回来一次。
// 读写都包了 try/catch：读不到就当没有旧数据，静默跳过，绝不因为迁移失败拖垮启动。
import {hasAnyData, IPlannerPlugin, replaceAll, sanitizeForImport} from "./store";
import {LEGACY_PLUGIN_NAME, STORAGE_KEY} from "./constants";

/** 思源内核接口需要带 API token（用户开启鉴权时） */
function authHeaders(): Record<string, string> {
    // 3.8.x 的 token 在 config.api.token(旧版在 config.system.conf.api.token,两处都试)
    const cfg = (window as any)?.siyuan?.config;
    const token = cfg?.api?.token || cfg?.system?.conf?.api?.token || "";
    return token ? {Authorization: `Token ${token}`} : {};
}

/**
 * 读取工作空间内某个文件的文本。
 * 用内核的 /api/file/getFile —— 它是前端唯一能读 data/ 下任意文件的通道，
 * 插件的 loadData 只能读自己那一份。
 */
async function readWorkspaceFile(path: string): Promise<string> {
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders()},
        body: JSON.stringify({path}),
    });
    if (!resp.ok) throw new Error(`读取失败 ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    return new TextDecoder("utf-8").decode(buf);
}

/**
 * 尝试导入旧数据。
 * 返回 true 表示真的导入了内容（调用方据此给用户提示）;
 * 旧文件不存在 / 损坏 / 已无内容，一律返回 false，不做任何改动。
 */
export async function tryImportLegacy(plugin: IPlannerPlugin): Promise<boolean> {
    try {
        const rel = `data/storage/petal/${LEGACY_PLUGIN_NAME}/${STORAGE_KEY}`;
        const text = await readWorkspaceFile(rel);
        if (!text || !text.trim()) return false;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return false;
        // 交给 store 的清洗逻辑：坏字段退回默认，保证迁进来的是可信结构
        if (hasAnyData()) return false;
        const clean = sanitizeForImport(parsed);
        if (!hasDataIn(clean)) return false;
        replaceAll(plugin, clean);
        return true;
    } catch {
        // 旧插件没装过、文件不存在、JSON 损坏 —— 都当作"没有旧数据"
        return false;
    }
}

/** 清洗后的数据里是否真的有东西（空壳文件不值得迁移，否则会覆盖掉默认 Inbox 清单） */
function hasDataIn(d: any): boolean {
    return !!(d && (
        (Array.isArray(d.habits) && d.habits.length)
        || (Array.isArray(d.tasks) && d.tasks.length)
        || (Array.isArray(d.goals) && d.goals.length)
        || (Array.isArray(d.countdowns) && d.countdowns.length)
        || (Array.isArray(d.sessions) && d.sessions.length)
        || (d.checkins && Object.keys(d.checkins).length)
    ));
}
