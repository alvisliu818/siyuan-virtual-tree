// 虚拟文档树「本地块命名」:设置关闭「块命名写入文档」时,给挂载的图片/表格命名的
// 结果只存在插件数据(block-names.json)里,不回写思源文档,仅虚拟树上显示。
// 读走内存缓存(渲染是同步的),写防抖落盘;插件数据按工作空间隔离。
interface PluginLike {
    loadData(key: string): Promise<any>;
    saveData(key: string, data: any): Promise<void>;
}

const STORE_KEY = "block-names.json";

let cache: Record<string, string> | null = null;
let pluginRef: PluginLike | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// 面板初始化时载入一次;此后读取全部走内存
export async function loadBlockNames(plugin: PluginLike): Promise<void> {
    pluginRef = plugin;
    try {
        const d = await plugin.loadData(STORE_KEY);
        cache = d && typeof d === "object" ? {...d} : {};
    } catch {
        cache = {};
    }
}

// 块的本地命名;没有返回空串
export function localBlockName(blockId: string): string {
    return (cache && cache[blockId]) || "";
}

// 写入/清除(空串清除)本地命名,防抖落盘
export function setLocalBlockName(blockId: string, name: string): void {
    if (!pluginRef) return;
    cache = cache || {};
    if (name) cache[blockId] = name;
    else delete cache[blockId];
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void pluginRef!.saveData(STORE_KEY, cache).catch(() => {
            // 落盘失败不阻塞界面:内存里仍是新值,下次命名会再试
        });
    }, 300);
}
