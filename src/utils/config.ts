import {EditorConfig, DEFAULT_CONFIG} from "../types";
import {STORAGE_CONFIG} from "../constants";
import type {Plugin} from "siyuan";

// 加载配置(合并默认值)
export async function loadConfig(plugin: Plugin): Promise<EditorConfig> {
    try {
        const data = await plugin.loadData(STORAGE_CONFIG);
        if (data) {
            const parsed = typeof data === "string" ? JSON.parse(data) : data;
            return {...DEFAULT_CONFIG, ...parsed};
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
