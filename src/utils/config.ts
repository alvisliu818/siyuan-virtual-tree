import {EditorConfig, DEFAULT_CONFIG} from "../types";
import {STORAGE_CONFIG} from "../constants";
import type {Plugin} from "siyuan";

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
            return merged;
        }
    } catch {
        // 忽略读取失败
    }
    return {...DEFAULT_CONFIG};
}

// 保存配置
export async function saveConfig(plugin: Plugin, config: EditorConfig): Promise<void> {
    try {
        await plugin.saveData(STORAGE_CONFIG, JSON.stringify(config));
    } catch (e) {
        console.error("[siyuan-file-editor] 保存配置失败:", e);
    }
}
