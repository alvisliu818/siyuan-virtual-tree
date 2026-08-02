import {WORKSPACE_ROOT} from "../constants";

// 拼接路径,处理多余斜杠
export function joinPath(base: string, name: string): string {
    if (!base) return name;
    if (base.endsWith("/")) return base + name;
    return base + "/" + name;
}

// 取路径最后一段(文件名/目录名)
export function basename(path: string): string {
    const clean = path.replace(/\/+$/, "");
    const idx = clean.lastIndexOf("/");
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}

// 取父目录
export function dirname(path: string): string {
    const clean = path.replace(/\/+$/, "");
    const idx = clean.lastIndexOf("/");
    if (idx <= 0) return "/";
    return clean.slice(0, idx);
}

// 取扩展名(含点,小写)
export function extname(path: string): string {
    const b = basename(path);
    const idx = b.lastIndexOf(".");
    return idx > 0 ? b.slice(idx).toLowerCase() : "";
}

// 规范化路径,确保以 /data 开头
export function normalizePath(path: string): string {
    if (!path || path === "/" || path === "") return WORKSPACE_ROOT;
    if (path.startsWith("/data")) return path.replace(/\/+$/, "");
    if (path.startsWith("data/")) return "/" + path.replace(/\/+$/, "");
    if (path.startsWith("/")) return "/data" + path;
    return "/data/" + path;
}
