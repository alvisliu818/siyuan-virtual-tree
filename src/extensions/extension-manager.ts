// 扩展管理器
// 统筹扩展的安装、卸载、加载、启用/禁用
// 协调各 loader(grammar/theme/snippet/lsp)的调用
// 支持两个来源: Open VSX Registry 和 VSCode Marketplace
import type {Plugin} from "siyuan";
import {InstalledExtension, LoadResult, ExtensionSource, SearchEntry} from "./types";
import {searchExtensions, downloadVsix, getExtensionMetadata} from "./openvsx-client";
import {
    searchMarketplaceExtensions,
    downloadMarketplaceVsix,
    getLatestVersion,
} from "./vscode-marketplace-client";
import {parseVsix} from "./vsix-loader";
import {
    loadInstalledExtensions,
    addInstalledExtension,
    removeInstalledExtension,
    toggleExtensionEnabled,
} from "./extension-store";
import {loadGrammars} from "./grammar-loader";
import {loadThemes, getLoadedThemes, applyExtensionTheme} from "./theme-loader";
import {loadSnippets} from "./snippet-loader";
import {loadLsp} from "./lsp-loader";
import {loadIconThemes} from "./icon-theme-loader";

// 安装扩展(根据来源从对应市场下载 → 解析 → 存储 → 加载)
export async function installExtension(
    plugin: Plugin,
    namespace: string,
    extensionName: string,
    source: ExtensionSource = "openvsx",
    version?: string,
): Promise<InstalledExtension> {
    let vsixBuffer: ArrayBuffer;
    let resolvedVersion: string;

    if (source === "vscode-marketplace") {
        // VSCode Marketplace 安装流程
        resolvedVersion = version || await getLatestVersion(namespace, extensionName);
        vsixBuffer = await downloadMarketplaceVsix(namespace, extensionName, resolvedVersion);
    } else {
        // Open VSX 安装流程
        const metadata = await getExtensionMetadata(namespace, extensionName);
        resolvedVersion = version || metadata.version;
        const downloadLink = metadata.files?.download;
        if (!downloadLink) throw new Error("扩展无下载链接");
        vsixBuffer = await downloadVsix(downloadLink);
    }

    // 解析 VSIX
    const ext = await parseVsix(vsixBuffer, namespace, extensionName, resolvedVersion);
    // 记录安装来源,便于重装时回到同一个市场
    ext.source = source;

    // 存储到已安装列表
    await addInstalledExtension(plugin, ext);

    // 立即加载
    if (ext.enabled) {
        await loadExtension(ext);
    }

    return ext;
}

// 通过搜索结果项安装(自动判断来源)
export async function installFromSearchEntry(
    plugin: Plugin,
    entry: SearchEntry,
): Promise<InstalledExtension> {
    const source = entry.source || "openvsx";
    return installExtension(plugin, entry.namespace, entry.name, source, entry.version);
}

// 加载单个扩展的所有贡献
export async function loadExtension(ext: InstalledExtension): Promise<LoadResult> {
    const result: LoadResult = {
        extensionId: ext.id,
        status: "loading",
        loadedGrammars: 0,
        loadedThemes: 0,
        loadedSnippets: 0,
        loadedLSP: 0,
        loadedIconThemes: 0,
    };
    try {
        result.loadedGrammars = await loadGrammars(ext);
        result.loadedThemes = loadThemes(ext);
        result.loadedSnippets = loadSnippets(ext);
        result.loadedIconThemes = loadIconThemes(ext);
        result.loadedLSP = await loadLsp(ext);
        result.status = "loaded";
    } catch (e: any) {
        result.status = "error";
        result.message = e?.message || String(e);
    }
    return result;
}

// 加载所有已安装的扩展(启动时调用)
export async function loadAllExtensions(plugin: Plugin): Promise<LoadResult[]> {
    const installed = await loadInstalledExtensions(plugin);
    const results: LoadResult[] = [];
    for (const ext of installed) {
        if (ext.enabled) {
            const result = await loadExtension(ext);
            results.push(result);
        }
    }
    return results;
}

// 卸载扩展
export async function uninstallExtension(
    plugin: Plugin,
    extensionId: string,
): Promise<void> {
    await removeInstalledExtension(plugin, extensionId);
    // 清理 Monaco 中已注册的资源(当前各 loader 的 remove 函数为空实现,
    // 完整清理需要 monaco 提供反注册 API,目前重启插件是最可靠的方式)
}

// 重新安装扩展(重新下载并解包,用于修复历史安装导致的文件缺失,如图标主题缺少 SVG)
export async function reinstallExtension(
    plugin: Plugin,
    extensionId: string,
): Promise<InstalledExtension> {
    const list = await loadInstalledExtensions(plugin);
    const ext = list.find(e => e.id === extensionId);
    if (!ext) {
        throw new Error(`未找到已安装扩展: ${extensionId}`);
    }
    // 先卸载(清理旧数据),再按原来源与版本重新下载解析
    await removeInstalledExtension(plugin, extensionId);
    return installExtension(plugin, ext.namespace, ext.name, ext.source || "openvsx", ext.version);
}

// 启用/禁用扩展
export async function toggleExtension(
    plugin: Plugin,
    extensionId: string,
): Promise<void> {
    await toggleExtensionEnabled(plugin, extensionId);
    // 禁用后需要重新加载才能生效(当前实现:提示用户重载插件)
}

// 搜索扩展(根据来源调用对应市场 API)
export async function search(
    query: string,
    size: number = 20,
    source: ExtensionSource = "openvsx",
) {
    if (source === "vscode-marketplace") {
        const result = await searchMarketplaceExtensions(query, size);
        // 标记来源
        result.extensions.forEach(e => (e.source = "vscode-marketplace"));
        return result;
    }
    const result = await searchExtensions(query, size);
    result.extensions.forEach(e => (e.source = "openvsx"));
    return result;
}

// 获取已安装扩展列表
export async function getInstalledExtensions(plugin: Plugin): Promise<InstalledExtension[]> {
    return loadInstalledExtensions(plugin);
}

// 获取已加载的主题列表
export function getAvailableThemes() {
    return getLoadedThemes();
}

// 切换到指定主题
export function switchTheme(themeName: string): boolean {
    return applyExtensionTheme(themeName);
}
