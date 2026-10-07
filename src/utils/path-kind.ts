// 判断一个路径是文件还是文件夹
//
// 为什么需要:思源虚拟路径(/data/xxx)不带扩展名,单看路径分不出是目录还是文件。
// 判错的后果很具体 —— 早先 openFileTab 没有目录分支,点击新标签页里固定的
// 文件夹时把路径当文件开了编辑器 Tab,内容是内核返回的
// {"code":409,"msg":"path is a directory"}。
import {getNativeRequire} from "./native-require";
import {isSiyuanPath} from "./path";
import {getWorkspacePath, toSystemPath} from "./system-path";

/**
 * 路径是否是文件夹。
 *
 * 三级判定,越往后越可靠但越慢:
 *   1. 已渲染的文件树项 —— 节点上有 data-is-dir,直接读,零成本
 *   2. 原生 fs.statSync —— 转成系统路径后 stat,覆盖没渲染/未展开的节点
 *   3. 都不行 → 按 false 处理(当文件),宁可开错也不能什么都不响应
 *
 * 纯同步:调用方(如 openFileTab)本身是同步的,改成异步要动一大片调用链。
 */
export function isDirectory(path: string): boolean {
    if (!path) return false;

    // 1. 文件树上已经有这个节点的话,直接读它的标记
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const li = document.querySelector<HTMLElement>(
        `.syfe-tree__item[data-path="${escaped}"]`,
    );
    if (li?.dataset.isDir === "true") return true;
    if (li?.dataset.isDir === "false") return false;

    // 2. 原生 fs
    const req = getNativeRequire();
    if (!req) return false;
    try {
        const fs = req("fs") as typeof import("fs");
        const sysPath = isSiyuanPath(path)
            ? toSystemPath(path, getWorkspacePath())
            : path;
        return fs.statSync(sysPath).isDirectory();
    } catch {
        // 3. 路径不存在或没权限 —— 当作文件
        return false;
    }
}