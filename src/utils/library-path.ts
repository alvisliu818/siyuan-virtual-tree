// 插件库路径(纯语法层,无 IO;注册表与链接操作见 api/library.ts)
//
// 库根 = /data/storage/petal/<插件名>/library。选这个位置是排除法的结果:
//   - data/plugins/<插件名>/  插件更新与卸载都会清空(bazaar/install.go 的 os.RemoveAll),不能用
//   - data/public/            内核以**无鉴权** HTTP 直接对外服务,不能用
//   - 点号开头的目录/文件      思源同步引擎 dejavu 一律跳过,移动端拿不到
//   - data/storage/petal/<插件名>/  在同步范围内,且更新与卸载都保留 ✓
//
// 库内条目是指向外部真实路径的**正向链接**(目录 junction / 文件符号链接 / 硬链接),
// 不搬移用户数据:库内路径与外部路径是同一份数据,改哪边都一样。
// dejavu 只索引普通文件(ignore.go 的 !info.Mode().IsRegular()),目录 junction 与符号链接
// 整棵被跳过 —— 正好避免思源同步与 Git 远程同步重复搬运同一份内容。
// 但 library.json 是普通文件,会被同步:移动端由此知道库里有哪些条目、各自绑定哪个 Git 远端,
// 文件内容则走 Git 传输(移动端没有 Node,链接在那边也不存在)。
import {PLUGIN_NAME} from "../constants";

export const LIBRARY_ROOT = `/data/storage/petal/${PLUGIN_NAME}/library`;

function norm(p: string): string {
    return (p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isLibraryPath(p: string): boolean {
    if (typeof p !== "string" || !p) return false;
    const n = norm(p);
    return n === LIBRARY_ROOT || n.startsWith(LIBRARY_ROOT + "/");
}

export function isLibraryRoot(p: string): boolean {
    return typeof p === "string" && norm(p) === LIBRARY_ROOT;
}

// 库内条目名(库根下第一层目录/文件名);库根自身或库外路径返回 ""
export function libraryEntryNameOf(p: string): string {
    if (!isLibraryPath(p)) return "";
    const rest = norm(p).slice(LIBRARY_ROOT.length).replace(/^\/+/, "");
    if (!rest) return "";
    return rest.split("/")[0];
}

// 条目根路径(库根 + 条目名)
export function libraryEntryPath(name: string): string {
    return `${LIBRARY_ROOT}/${name}`;
}

// 条目内相对路径(拼 Git 远端路径用);条目根返回 ""
export function libraryRelPath(p: string): string {
    const name = libraryEntryNameOf(p);
    if (!name) return "";
    const rest = norm(p).slice(LIBRARY_ROOT.length + 1 + name.length);
    return rest.replace(/^\/+/, "");
}

// 是否库内条目根(「取消同步」只在这一层出现;条目内部是外部真实文件,按普通文件处理)
export function isLibraryEntryRoot(p: string): boolean {
    if (!isLibraryPath(p)) return false;
    const name = libraryEntryNameOf(p);
    return !!name && norm(p) === libraryEntryPath(name);
}