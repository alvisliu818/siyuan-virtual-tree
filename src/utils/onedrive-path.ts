// OneDrive 虚拟路径(纯语法层,无 IO;云端路径解析依赖配置,见 api/onedrive.ts)
//
// 虚拟路径格式(与 bdpan://、github:// 等远程方案一致):
//   onedrive:///<云端绝对路径>   如 onedrive:///Documents、onedrive:///docs/notes.md
//   onedrive:///                 驱动器根
// 路径统一使用 "/" 分隔符,与 path.ts 的通用工具(dirname/basename/joinPath)兼容。
// OneDrive 无"同步空间别名"概念(整个驱动器就是一个命名空间),比 bdpan:// 简单。
export const OD_PREFIX = "onedrive://";

// 是否 OneDrive 虚拟路径
export function isOneDrivePath(p: string): boolean {
    return typeof p === "string" && p.startsWith(OD_PREFIX);
}

// 取虚拟路径去掉前缀并去掉结尾斜杠后的云端路径:"onedrive:///a/" → "/a";"onedrive://" → ""
export function oneDrivePathBody(vPath: string): string {
    return vPath.slice(OD_PREFIX.length).replace(/\/+$/, "");
}

// 拼接虚拟子路径(vBase 为无结尾斜杠的虚拟路径)
export function oneDriveChildVPath(vBase: string, name: string): string {
    return vBase + "/" + name;
}

// 挂载根的显示名(纯字符串,不触发网络)
export function oneDriveRootLabel(vPath: string): string {
    const body = oneDrivePathBody(vPath);
    return "[OneDrive] " + (body ? body : "/");
}
