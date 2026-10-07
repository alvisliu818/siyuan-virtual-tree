// 百度网盘虚拟路径(纯语法层,无 IO;云端路径解析依赖配置,见 api/baidu-pan.ts)
//
// 虚拟路径格式(与真实文件路径、sydoc:// 虚拟文档路径区分):
//   bdpan://<云端绝对路径>   网盘任意目录,如 bdpan:///apps/sync、bdpan:///docs
//   bdpan://sync[/<相对>]    同步空间别名(云端目录可在设置中调整,默认 /apps/sync),
//                            用别名而非具体云端路径,换同步目录不破坏已保存的挂载
// 网盘路径统一使用 "/" 分隔符,与 path.ts 的通用工具(dirname/basename/joinPath)兼容。
export const BDPAN_PREFIX = "bdpan://";
export const BDPAN_SYNC_ROOT = "bdpan://sync";

// 是否百度网盘虚拟路径
export function isBaiduPath(p: string): boolean {
    return typeof p === "string" && p.startsWith(BDPAN_PREFIX);
}

// 是否同步空间别名(根或其子路径)
export function isBaiduSyncPath(p: string): boolean {
    if (!isBaiduPath(p)) return false;
    const rest = baiduPathBody(p);
    return rest === "sync" || rest.startsWith("sync/");
}

// 取虚拟路径去掉前缀并去掉结尾斜杠后的主体:"bdpan:///a/" → "/a";"bdpan://sync/" → "sync"
export function baiduPathBody(vPath: string): string {
    return vPath.slice(BDPAN_PREFIX.length).replace(/\/+$/, "");
}

// 拼接虚拟子路径(vBase 为无结尾斜杠的虚拟路径)
export function baiduChildVPath(vBase: string, name: string): string {
    return vBase + "/" + name;
}

// 挂载根的显示名(纯字符串,不触发网络)
export function baiduRootLabel(vPath: string): string {
    if (isBaiduSyncPath(vPath)) return "[同步空间] 百度网盘";
    const body = baiduPathBody(vPath);
    return "[百度网盘] " + (body || "/");
}
