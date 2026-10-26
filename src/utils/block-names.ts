// 虚拟文档树「本地块命名」与「行内显示模式」:均为挂载块的本地显示偏好,按插件数据
// (block-names.json / block-display.json)持久化,按工作空间隔离。
// - 命名:设置关闭「块命名写入文档」时,命名的结果只存这里,不回写思源文档,仅虚拟树上显示
// - 显示模式:图片/表格行右键切换「显示标题 / 显示缩放预览」,按块记忆
// 读走内存缓存(渲染是同步的),写防抖落盘。
interface PluginLike {
    loadData(key: string): Promise<any>;
    saveData(key: string, data: any): Promise<void>;
}

const STORE_KEY = "block-names.json";
const MODE_STORE_KEY = "block-display.json";

let cache: Record<string, string> | null = null;
let modes: Record<string, string> | null = null;
let pluginRef: PluginLike | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let modeSaveTimer: ReturnType<typeof setTimeout> | null = null;

const loadJson = async (plugin: PluginLike, key: string): Promise<Record<string, string>> => {
    try {
        const d = await plugin.loadData(key);
        return d && typeof d === "object" ? {...d} : {};
    } catch {
        return {};
    }
};

// 面板初始化时载入一次;此后读取全部走内存
export async function loadBlockNames(plugin: PluginLike): Promise<void> {
    pluginRef = plugin;
    const [names, modeData] = await Promise.all([
        loadJson(plugin, STORE_KEY),
        loadJson(plugin, MODE_STORE_KEY),
    ]);
    cache = names;
    modes = modeData;
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

// 块的行内显示模式:preview = 缩放预览(默认);text = 只显示标题文字
export function blockDisplayMode(blockId: string): "text" | "preview" {
    return modes && modes[blockId] === "text" ? "text" : "preview";
}

// 切换显示模式;默认值(preview)不落盘,文件里只存非默认项
export function setBlockDisplayMode(blockId: string, mode: "text" | "preview"): void {
    if (!pluginRef) return;
    modes = modes || {};
    if (mode === "preview") delete modes[blockId];
    else modes[blockId] = mode;
    if (modeSaveTimer) clearTimeout(modeSaveTimer);
    modeSaveTimer = setTimeout(() => {
        modeSaveTimer = null;
        void pluginRef!.saveData(MODE_STORE_KEY, modes).catch(() => {
            // 落盘失败不阻塞:内存里已是新模式,下次切换会再试
        });
    }, 300);
}
