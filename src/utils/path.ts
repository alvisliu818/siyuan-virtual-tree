// 思源虚拟路径根(放在这里由 constants.ts 引用,避免 path.ts → constants.ts 的循环依赖)
export const SIYUAN_ROOT = "/data";

// 路径工具:同时支持思源虚拟路径(/data/...)与系统绝对路径(如 E:\HOME\BaiduSyncdisk)
// 历史实现只按 "/" 切分,遇到 Windows 反斜杠路径会得到错误结果,这里统一按两种分隔符处理。

// 推断路径应使用的分隔符:含反斜杠(或 Windows 盘符)视为 Windows,否则用正斜杠
export function sepFor(path: string): string {
    if (!path) return "/";
    // Windows 盘符 C:\... 或 UNC \\...
    if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) return "\\";
    return path.includes("\\") ? "\\" : "/";
}

// 拼接路径,自动沿用 base 的分隔符风格,处理多余斜杠
export function joinPath(base: string, name: string): string {
    if (!base) return name;
    if (base.endsWith("/") || base.endsWith("\\")) return base + name;
    const sep = sepFor(base);
    return base + sep + name;
}

// 取路径最后一段(文件名/目录名)
export function basename(path: string): string {
    const clean = path.replace(/[\\/]+$/, "");
    const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}

// 取父目录
export function dirname(path: string): string {
    const clean = path.replace(/[\\/]+$/, "");
    const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    if (idx < 0) return "";
    // 根目录:C:\HOME → C:\ ;/home → /
    if (idx === 0) return clean.charAt(0);
    const parent = clean.slice(0, idx);
    // 盘符根:E: → E:\(盘符后必须带分隔符,否则不是合法绝对路径)
    if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
    return parent;
}

// 取扩展名(含点,小写)
export function extname(path: string): string {
    const b = basename(path);
    const idx = b.lastIndexOf(".");
    return idx > 0 ? b.slice(idx).toLowerCase() : "";
}

// 是否为思源虚拟路径(/data 或 /data/...)
export function isSiyuanPath(path: string): boolean {
    if (!path) return false;
    const p = path.replace(/\\/g, "/");
    return p === "/data" || p.startsWith("/data/");
}

// 是否为工作空间外的系统绝对路径(Windows 盘符 / UNC / POSIX 绝对路径)
export function isExternalPath(path: string): boolean {
    if (!path) return false;
    if (isSiyuanPath(path)) return false;
    // Windows 盘符:E:\HOME 或 E:/HOME
    if (/^[A-Za-z]:[\\/]/.test(path)) return true;
    // UNC:\\server\share
    if (/^\\\\/.test(path)) return true;
    // POSIX 绝对路径(非 /data)
    if (path.startsWith("/") || path.startsWith("\\")) return true;
    return false;
}

// 路径深度(分隔符段数),用于展开顺序排序;同时支持 / 与 \ 两种分隔符
export function pathDepth(path: string): number {
    if (!path) return 0;
    const norm = path.replace(/\\/g, "/");
    return norm.split("/").filter(Boolean).length;
}

// 规范化路径:思源相对路径补 /data 前缀;系统绝对路径原样保留(仅去掉结尾分隔符)
export function normalizePath(path: string): string {
    if (!path || path === "/" || path === "") return SIYUAN_ROOT;
    // 系统绝对路径(E:\HOME\BaiduSyncdisk 等)不做转换,仅去掉多余结尾分隔符
    if (isExternalPath(path)) {
        const trimmed = path.replace(/[\\/]+$/, "");
        // 盘符根 E:\ 与根 / 不能去掉分隔符,否则不再是绝对路径
        if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "") return path;
        return trimmed;
    }
    if (path.startsWith("/data")) return path.replace(/\/+$/, "");
    if (path.startsWith("data/")) return "/" + path.replace(/\/+$/, "");
    if (path.startsWith("/")) return "/data" + path;
    return "/data/" + path;
}
