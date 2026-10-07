// 自定义「打开方式」的存储
//
// 为什么不放进 EditorConfig:
//   saveSettings() 是**整体覆写** this.config 的(见 index.ts),列表类数据放进去
//   必须四处同步(types / DEFAULT_CONFIG / syncSettingUI / saveSettings),漏一处
//   就把用户配的打开方式清空了。这里学 tags/tag-store.ts:独立的 saveData 文件 +
//   内存缓存 + 变更事件,菜单渲染时同步读缓存不必 await。
//
// 放在独立的 open-with.json 而不是复用 tags.json,是因为两者生命周期无关:
// 删标签不该影响打开方式,反之亦然。
import type {Plugin} from "siyuan";
import {
    OpenWithData, OpenWithItem, DEFAULT_OPEN_WITH_DATA, OPEN_WITH_VERSION,
} from "../types";

const STORAGE_KEY = "open-with.json";

// 数据变化事件(菜单下次打开时自然读到新值,这里主要用于设置面板自己刷新)
export const OPEN_WITH_CHANGED_EVENT = "syfe:open-with-changed";

function dispatchChanged(): void {
    try {
        window.dispatchEvent(new CustomEvent(OPEN_WITH_CHANGED_EVENT));
    } catch {
        // 非浏览器环境(单测)忽略
    }
}

// 内存缓存:菜单构建是同步流程(getOpenWithItems 拿不到 await 的位置),
// 所以必须能从内存直接读,不能每次都 loadData。
let cached: OpenWithData = {...DEFAULT_OPEN_WITH_DATA, items: DEFAULT_OPEN_WITH_DATA.items.slice()};
let loaded = false;

/** 单条数据的形状校验 —— 存档可能被手改过,不能让脏字段进到 spawn 里 */
function sanitizeItem(raw: any): OpenWithItem | null {
    if (!raw || typeof raw !== "object") return null;
    const command = String(raw.command ?? "").trim();
    // 命令为空 = 这条配置没有意义(用户可能刚新建还没填),直接丢弃
    if (!command) return null;
    const label = String(raw.label ?? "").trim() || command;
    const kind = raw.kind === "file" || raw.kind === "dir" || raw.kind === "both"
        ? raw.kind
        : "both";
    const item: OpenWithItem = {
        id: String(raw.id || newOpenWithId()),
        label,
        command,
        kind,
    };
    if (Array.isArray(raw.args)) {
        item.args = raw.args.map((a: any) => String(a));
    }
    // 扩展名统一小写并补点:"PY" 与 ".py" 都归一成 ".py",
    // 否则用户填 "py" 就会匹配不到 .py 文件。
    if (Array.isArray(raw.extensions) && raw.extensions.length > 0) {
        item.extensions = raw.extensions
            .map((e: any) => String(e).trim().toLowerCase())
            .filter(Boolean)
            .map((e: string) => (e.startsWith(".") ? e : "." + e));
    }
    if (raw.builtin) item.builtin = true;
    if (raw.icon) item.icon = String(raw.icon);
    return item;
}

export async function loadOpenWithData(plugin: Plugin): Promise<OpenWithData> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        if (data && Array.isArray(data.items)) {
            const items = data.items.map(sanitizeItem).filter(Boolean) as OpenWithItem[];
            cached = {version: data.version || OPEN_WITH_VERSION, items};
        } else {
            cached = {...DEFAULT_OPEN_WITH_DATA, items: DEFAULT_OPEN_WITH_DATA.items.slice()};
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载打开方式失败:", e);
        cached = {...DEFAULT_OPEN_WITH_DATA, items: DEFAULT_OPEN_WITH_DATA.items.slice()};
    }
    loaded = true;
    return cached;
}

export async function saveOpenWithData(plugin: Plugin, data?: OpenWithData): Promise<void> {
    const d = data || cached;
    cached = d;
    try {
        await plugin.saveData(STORAGE_KEY, d);
    } catch (e) {
        console.error("[siyuan-file-editor] 保存打开方式失败:", e);
    }
}

/** 取全部配置(未加载时返回默认,菜单构建不能等) */
export function getOpenWithItems(): OpenWithItem[] {
    return loaded ? cached.items.slice() : DEFAULT_OPEN_WITH_DATA.items.slice();
}

export function newOpenWithId(): string {
    return "ow" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function addOpenWith(plugin: Plugin, item: Omit<OpenWithItem, "id"> & {id?: string}): Promise<OpenWithItem> {
    const it: OpenWithItem = {
        id: item.id || newOpenWithId(),
        label: item.label,
        command: item.command,
        kind: item.kind,
        ...(item.args && item.args.length ? {args: item.args} : {}),
        ...(item.extensions && item.extensions.length ? {extensions: item.extensions} : {}),
        ...(item.icon ? {icon: item.icon} : {}),
    };
    const data = {version: OPEN_WITH_VERSION, items: cached.items.concat([it])};
    await saveOpenWithData(plugin, data);
    dispatchChanged();
    return it;
}

export async function updateOpenWith(plugin: Plugin, id: string, patch: Partial<OpenWithItem>): Promise<void> {
    const item = cached.items.find(x => x.id === id);
    if (!item) return;
    if (patch.label !== undefined) item.label = patch.label;
    if (patch.command !== undefined) item.command = patch.command;
    if (patch.kind !== undefined) item.kind = patch.kind;
    if (patch.args !== undefined) {
        item.args = patch.args.length ? patch.args.slice() : undefined;
    }
    if (patch.extensions !== undefined) {
        item.extensions = patch.extensions.length ? patch.extensions.slice() : undefined;
    }
    if (patch.icon !== undefined) item.icon = patch.icon;
    await saveOpenWithData(plugin, cached);
    dispatchChanged();
}

/**
 * 删除一条打开方式。
 * builtin 项**不允许删** —— 它们是「打开方式」这个功能在某些机器上的
 * 唯一出口(比如只装了 VS Code 的机器,删了就得重新手写一遍)。
 * 要停用某一项,让用户把 command 改成一个不存在的名字即可。
 */
export async function removeOpenWith(plugin: Plugin, id: string): Promise<void> {
    const item = cached.items.find(x => x.id === id);
    if (!item || item.builtin) return;
    cached = {version: OPEN_WITH_VERSION, items: cached.items.filter(x => x.id !== id)};
    await saveOpenWithData(plugin, cached);
    dispatchChanged();
}

/** 恢复出厂设置(丢掉用户的自定义项) */
export async function resetOpenWith(plugin: Plugin): Promise<void> {
    cached = {...DEFAULT_OPEN_WITH_DATA, items: DEFAULT_OPEN_WITH_DATA.items.slice()};
    await saveOpenWithData(plugin, cached);
    dispatchChanged();
}

/**
 * 判断某条配置是否适用于给定的目标。
 * 过滤规则:kind(文件/文件夹) + extensions(扩展名白名单)。
 */
export function openWithMatches(item: OpenWithItem, isDir: boolean, ext: string): boolean {
    if (item.kind === "file" && isDir) return false;
    if (item.kind === "dir" && !isDir) return false;
    if (item.extensions && item.extensions.length) {
        // 文件夹不受扩展名限制 —— 用户配的"扩展名"本来是针对文件的
        if (isDir) return false;
        if (!item.extensions.includes(ext)) return false;
    }
    return true;
}