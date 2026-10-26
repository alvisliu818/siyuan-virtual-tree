// 虚拟文档树「行内显示模式」:挂载的图片/表格行,右键可切换「显示标题 / 显示缩放预览」,
// 按块记忆,存插件数据(block-display.json),按工作空间隔离。
// 读走内存缓存(渲染是同步的),写防抖落盘;默认模式(preview)不落盘,文件里只存非默认项。
interface PluginLike {
    loadData(key: string): Promise<any>;
    saveData(key: string, data: any): Promise<void>;
}

const MODE_STORE_KEY = "block-display.json";

let modes: Record<string, string> | null = null;
let pluginRef: PluginLike | null = null;
let modeSaveTimer: ReturnType<typeof setTimeout> | null = null;

// 面板初始化时载入一次;此后读取全部走内存
export async function loadBlockDisplayModes(plugin: PluginLike): Promise<void> {
    pluginRef = plugin;
    try {
        const d = await plugin.loadData(MODE_STORE_KEY);
        modes = d && typeof d === "object" ? {...d} : {};
    } catch {
        modes = {};
    }
}

// 块的行内显示模式:preview = 缩放预览(默认);text = 只显示标题文字
export function blockDisplayMode(blockId: string): "text" | "preview" {
    return modes && modes[blockId] === "text" ? "text" : "preview";
}

// 切换显示模式
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
