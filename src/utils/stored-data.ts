// 插件存储(plugin.loadData)结果的安全解析。
//
// 坑:文件**从未保存过**时,思源的 loadData 返回**空字符串**而不是 null,
// 此时 `typeof raw === "string" ? JSON.parse(raw) : raw` 会抛
// "SyntaxError: Unexpected end of JSON input";文件内容损坏时同样抛错。
// 这两种情况都应视为"没有数据",由调用方走默认值,而不是让初始化流程炸掉。
export function parseStoredData(raw: any): any {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") return raw;   // 已经是对象(旧格式直接存对象)
    const text = raw.trim();
    if (!text) return null;                    // 空文件 = 从未保存过
    try {
        return JSON.parse(text);
    } catch {
        // 内容损坏:按没有数据处理
        return null;
    }
}
