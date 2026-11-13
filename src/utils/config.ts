import {EditorConfig, DEFAULT_CONFIG} from "../types";
import {STORAGE_CONFIG} from "../constants";
import type {Plugin} from "siyuan";
import {compileFilter, IndexFilter} from "./index-filter";

// 内存里的配置缓存:供**无 plugin 参数**的深层模块读取设置
// (如 components/file-tree.ts 的导入流程,拿不到 plugin 实例)
let configCache: EditorConfig | null = null;

export function isImportMdSourceAssetEnabled(): boolean {
    return configCache?.importMdSourceAsset === true;
}

// 双链扫描是否把所有文本文件当链接源(默认开;关=仅 Markdown,回退旧性能)
export function isBacklinkScanAllTextEnabled(): boolean {
    return configCache?.filesBacklinkScanAllText !== false;
}

// 插件库「取消同步」时对已绑定 Git 远端的处理方式
export function getLibraryUnlinkMode(): "push" | "keep" | "deleteRemote" {
    return configCache?.libraryUnlinkMode || DEFAULT_CONFIG.libraryUnlinkMode;
}

// 索引白/黑名单(按规则文本缓存编译结果;保存设置后 saveConfig 更新 configCache,
// 文本一变自动重编译,无需手动失效)
let indexFilterCache: {white: string; black: string; rules: IndexFilter} | null = null;

export function getIndexFilter(): IndexFilter {
    const white = configCache?.indexWhitelist ?? DEFAULT_CONFIG.indexWhitelist;
    const black = configCache?.indexBlacklist ?? DEFAULT_CONFIG.indexBlacklist;
    if (!indexFilterCache || indexFilterCache.white !== white || indexFilterCache.black !== black) {
        indexFilterCache = {white, black, rules: compileFilter(white, black)};
    }
    return indexFilterCache.rules;
}

// 双链扫描独立白/黑名单(缓存模式同 getIndexFilter)
let backlinkScanFilterCache: {white: string; black: string; rules: IndexFilter} | null = null;

export function getBacklinkScanFilter(): IndexFilter {
    const white = configCache?.backlinkScanWhitelist ?? DEFAULT_CONFIG.backlinkScanWhitelist;
    const black = configCache?.backlinkScanBlacklist ?? DEFAULT_CONFIG.backlinkScanBlacklist;
    if (!backlinkScanFilterCache || backlinkScanFilterCache.white !== white || backlinkScanFilterCache.black !== black) {
        backlinkScanFilterCache = {white, black, rules: compileFilter(white, black)};
    }
    return backlinkScanFilterCache.rules;
}

// 加载配置(合并默认值)
export async function loadConfig(plugin: Plugin): Promise<EditorConfig> {
    try {
        const data = await plugin.loadData(STORAGE_CONFIG);
        if (data) {
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            const merged: EditorConfig = {...DEFAULT_CONFIG, ...parsed};
            // 兼容旧配置:旧版"所见即所得"(wysiwyg)已并入"实时预览"(live)
            if ((merged.markdownDefaultMode as string) === "wysiwyg") {
                merged.markdownDefaultMode = "live";
            }
            // 内嵌双链面板与侧边 dock 的入链/出链重合:老配置升级时默认隐藏一次
            if (!merged.backlinkPanelHiddenMigrated) {
                merged.backlinkPanelHidden = true;
                merged.backlinkPanelHiddenMigrated = true;
            }
            configCache = merged;
            return merged;
        }
    } catch {
        // 忽略读取失败
    }
    const fallback = {...DEFAULT_CONFIG};
    configCache = fallback;
    return fallback;
}

// 保存配置
export async function saveConfig(plugin: Plugin, config: EditorConfig): Promise<void> {
    configCache = config;
    try {
        await plugin.saveData(STORAGE_CONFIG, JSON.stringify(config));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存配置失败:", e);
    }
}
