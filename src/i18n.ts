import type { IObject } from "siyuan";

/**
 * 全局 i18n 字典。由插件 onload 时调用 initI18n 注入。
 * 仅在模块内持有引用，避免到处传递 plugin 实例。
 */
let dict: Record<string, string> = {};

export function initI18n(i18n: IObject): void {
  dict = i18n as Record<string, string>;
}

/**
 * 取翻译文本。
 * @param key     i18n 字段名
 * @param fallback 找不到时回退文本（默认回退到 key 本身）
 */
export function t(key: string, fallback?: string): string {
  return dict[key] ?? fallback ?? key;
}
