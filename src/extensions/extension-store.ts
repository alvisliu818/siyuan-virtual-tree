// 扩展存储管理
// 使用思源插件的 saveData/loadData 持久化已安装扩展列表
// 由于扩展文件可能较大,仅存储元数据 + contributes + 关键文件内容
import type {Plugin} from "siyuan";
import {InstalledExtension} from "./types";

const STORAGE_KEY = "installed-extensions";

// 加载已安装的扩展列表
export async function loadInstalledExtensions(plugin: Plugin): Promise<InstalledExtension[]> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        let list: InstalledExtension[] = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.extensions)) list = data.extensions;
        // 兜底:历史安装(或外部脚本写入)的数据可能缺 icon 字段,
        // 若 package.json 声明了图标且文件在 files 里(SVG 以字符串存储),即时生成 data URI
        for (const ext of list) {
            if (!ext.icon) resolveExtensionIcon(ext);
        }
        return list;
    } catch {
        return [];
    }
}

// 从扩展 package.json 的 icon 字段解析图标 data URI(仅处理已存储在 files 里的图标,
// 通常是 SVG;二进制 PNG 因以字符串读取会损坏,此处跳过,需在安装时由 vsix-loader 提取)
function resolveExtensionIcon(ext: InstalledExtension): void {
    try {
        const pkgRaw = ext.files?.["package.json"];
        if (!pkgRaw) return;
        const pkg = JSON.parse(pkgRaw);
        const iconPath = pkg.icon;
        if (!iconPath || typeof iconPath !== "string") return;
        const rel = iconPath.replace(/^\.\//, "").replace(/^\//, "");
        const content = ext.files?.[rel];
        if (content === undefined) return;
        const ext2 = rel.split(".").pop()?.toLowerCase() || "png";
        if (ext2 === "svg") {
            // SVG 存为字符串,直接做 data URI
            const cleaned = content.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
            ext.icon = `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
        } else if (ext2 === "png" && /^[A-Za-z0-9+/=\s]+$/.test(content)) {
            // 极少数情况下 PNG 被以 base64 文本存储
            ext.icon = `data:image/png;base64,${content.replace(/\s/g, "")}`;
        }
    } catch {
        // 忽略,保持无图标
    }
}

// 保存已安装的扩展列表
export async function saveInstalledExtensions(
    plugin: Plugin,
    extensions: InstalledExtension[],
): Promise<void> {
    await plugin.saveData(STORAGE_KEY, extensions);
}

// 添加已安装扩展(去重:相同 ID 替换旧版本)
export async function addInstalledExtension(
    plugin: Plugin,
    ext: InstalledExtension,
): Promise<InstalledExtension[]> {
    const list = await loadInstalledExtensions(plugin);
    const idx = list.findIndex(e => e.id === ext.id);
    if (idx >= 0) {
        list[idx] = ext; // 更新
    } else {
        list.push(ext);
    }
    await saveInstalledExtensions(plugin, list);
    return list;
}

// 移除已安装扩展
export async function removeInstalledExtension(
    plugin: Plugin,
    extensionId: string,
): Promise<InstalledExtension[]> {
    const list = await loadInstalledExtensions(plugin);
    const filtered = list.filter(e => e.id !== extensionId);
    await saveInstalledExtensions(plugin, filtered);
    return filtered;
}

// 切换扩展启用/禁用状态
export async function toggleExtensionEnabled(
    plugin: Plugin,
    extensionId: string,
): Promise<InstalledExtension[]> {
    const list = await loadInstalledExtensions(plugin);
    const ext = list.find(e => e.id === extensionId);
    if (ext) {
        ext.enabled = !ext.enabled;
        await saveInstalledExtensions(plugin, list);
    }
    return list;
}

// 检查扩展是否已安装
export async function isExtensionInstalled(
    plugin: Plugin,
    extensionId: string,
): Promise<boolean> {
    const list = await loadInstalledExtensions(plugin);
    return list.some(e => e.id === extensionId);
}
