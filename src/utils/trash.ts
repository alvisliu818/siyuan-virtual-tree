// 回收站:删除文件的两种可恢复通道
//
// 两种模式(设置面板「删除方式」,无"直接删除"选项 —— 删除必须可恢复):
//   plugin   移入插件回收站:物理移动到 <工作空间>/.siyuan/virtual-tree-trash/ 下,
//            **按原路径镜像**保留目录结构(data/ 内文件镜像其相对路径,外部文件镜像
//            其绝对路径),index.json 记录原始路径与删除时间,可一键恢复;
//   system   移入操作系统回收站:Windows 走 PowerShell(VirtualBasic FileIO),
//            macOS 走 Finder,Linux 走 gio trash。
//
// 环境不支持回收站(浏览器端无 Node 集成)时**中止删除并报错**,文件保持原样 ——
// 绝不静默转成永久删除。唯一例外是百度网盘:数据在云端,走网盘删除接口,
// 由网盘自己的回收站兜底。
//
// 为什么插件回收站放 <工作空间>/.siyuan/ 而不是 data/ 内:
//   1) data/ 会被思源同步/搜索/文件树感知,回收站内容不该出现在这些地方;
//   2) 内核 /api/file/* 只能访问 data/ 内,放外面恰好强制我们全走原生 fs,
//      与"外部文件也能进回收站"的实现统一;
//   3) 插件目录(data/plugins/…)部署时会被清空重建,绝不能当存储用。

import {getNativeRequire} from "./native-require";
import {getWorkspacePath, toSystemPath} from "./system-path";
import {isSiyuanPath, basename} from "./path";
import {isBaiduPath} from "./baidu-path";
import {removeFile} from "../api/file";
import {revealInSystemExplorer} from "./external-app";

export type TrashMode = "plugin" | "system";

// 当前删除模式(设置面板写入;深层模块拿不到 plugin 实例,走内存缓存)
let currentMode: TrashMode = "plugin";

export function setTrashMode(mode: TrashMode): void {
    currentMode = mode === "system" ? "system" : "plugin";
}

export function getTrashMode(): TrashMode {
    return currentMode;
}

// ===== 底层能力探测 =====

function getFs(): any {
    const req = getNativeRequire();
    if (!req) throw new Error("Node 集成不可用(需要思源桌面端)");
    return req("fs");
}

let cachedPath: any = null;

function getPathMod(): any {
    if (cachedPath) return cachedPath;
    const req = getNativeRequire();
    if (!req) throw new Error("Node 集成不可用(需要思源桌面端)");
    cachedPath = req("path");
    return cachedPath;
}

export function isNativeAvailable(): boolean {
    try {
        getFs();
        return true;
    } catch {
        return false;
    }
}

// ===== 插件回收站 =====

// 插件回收站物理根:<工作空间>/.siyuan/virtual-tree-trash
export function pluginTrashRoot(): string {
    const ws = getWorkspacePath();
    if (!ws) throw new Error("无法获取思源工作空间路径");
    return ws.replace(/[\\/]+$/, "") + "/.siyuan/virtual-tree-trash";
}

const INDEX_FILE = "index.json";

interface TrashEntry {
    id: string;
    origin: string;    // 插件内部路径(思源虚拟路径或系统绝对路径,与删除时一致)
    trashPath: string; // 回收站内的完整系统路径
    isDir: boolean;
    time: number;
}

interface TrashIndex {
    version: number;
    entries: TrashEntry[];
}

let indexCache: TrashIndex | null = null;

function loadIndex(): TrashIndex {
    if (indexCache) return indexCache;
    try {
        const f = getFs();
        const raw = f.readFileSync(pluginTrashRoot() + "/" + INDEX_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.entries)) {
            indexCache = {version: 1, entries: parsed.entries};
            return indexCache;
        }
    } catch {
        // 文件不存在/损坏:从空开始
    }
    indexCache = {version: 1, entries: []};
    return indexCache;
}

function saveIndex(): void {
    const f = getFs();
    const root = pluginTrashRoot();
    f.mkdirSync(root, {recursive: true});
    f.writeFileSync(root + "/" + INDEX_FILE, JSON.stringify(indexCache, null, 2), "utf-8");
}

// 把插件内部路径映射为回收站内的镜像路径:
//   /data/a/b.md        → <trash>/data/a/b.md(data 内镜像相对路径)
//   E:\HOME\X\a.md      → <trash>/external/E/HOME/X/a.md(绝对路径镜像,冒号丢弃)
//   /home/u/a.md        → <trash>/external/home/u/a.md
function mirrorPath(origin: string): string {
    const pth = getPathMod();
    let sys: string;
    if (isSiyuanPath(origin)) {
        // data 内:镜像去掉 "/data" 前缀的相对路径
        sys = toSystemPath(origin, getWorkspacePath());
        const ws = getWorkspacePath().replace(/[\\/]+$/, "");
        const dataRoot = ws + pth.sep + "data";
        if (sys.toLowerCase().startsWith(dataRoot.toLowerCase())) {
            return pluginTrashRoot() + "/data" + sys.slice(dataRoot.length).replace(/\\/g, "/");
        }
        // 拿不到工作空间等异常:按外部路径处理
    } else {
        sys = origin;
    }
    // 外部路径:统一正斜杠,丢掉盘符冒号与开头斜杠,挂到 external/ 下
    const flat = sys.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "");
    return pluginTrashRoot() + "/external/" + flat;
}

// 移动文件/目录:优先 rename(同盘瞬时),跨盘 EXDEV 降级 cp+rm
function moveRecursive(from: string, to: string): void {
    const f = getFs();
    try {
        f.renameSync(from, to);
        return;
    } catch (e: any) {
        if (e?.code !== "EXDEV") throw e;
    }
    f.cpSync(from, to, {recursive: true});
    f.rmSync(from, {recursive: true, force: true});
}

function isDirOnDisk(sysPath: string): boolean {
    try {
        return getFs().statSync(sysPath).isDirectory();
    } catch {
        return false;
    }
}

// 同名冲突:追加时间后缀,保证"路径尽量不变"且不覆盖已有回收站内容
function resolveCollision(target: string): string {
    const f = getFs();
    if (!f.existsSync(target)) return target;
    return target + " (回收站 " + new Date().toISOString().slice(11, 19).replace(/:/g, "") + ")";
}

// ===== 系统回收站 =====

// execFile 包装:非零退出码/stderr 都算失败
function runCmd(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        let cp: any;
        try {
            const req = getNativeRequire();
            if (!req) throw new Error("Node 集成不可用(需要思源桌面端)");
            cp = req("child_process");
        } catch (e) {
            reject(e);
            return;
        }
        cp.execFile(cmd, args, {windowsHide: true, timeout: 20000}, (err: Error | null, _so: string, se: string) => {
            if (err) reject(new Error(se?.trim() || err.message));
            else resolve();
        });
    });
}

// PowerShell 单引号字面量转义(内部 ' 写成 '')
function psQuote(s: string): string {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

async function systemTrashWin(sysPath: string, isDir: boolean): Promise<void> {
    const fn = isDir ? "DeleteDirectory" : "DeleteFile";
    const script =
        `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${fn}(${psQuote(sysPath)},` +
        `'OnlyErrorDialogs','SendToRecycleBin')`;
    await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function systemTrashMac(sysPath: string): Promise<void> {
    await runCmd("osascript", [
        "-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(sysPath)}`,
    ]);
}

async function systemTrashLinux(sysPath: string): Promise<void> {
    await runCmd("gio", ["trash", sysPath]);
}

// ===== 对外入口 =====

export interface DeleteResult {
    mode: TrashMode;   // 实际执行的模式(可能因环境降级)
    note?: string;     // 附加说明(展示给用户)
}

// 统一删除入口:按当前模式把文件移入回收站。
// 网盘路径不走本地回收站(数据在云端,由网盘自己的回收站兜底)。
// 环境不支持回收站时抛错中止 —— 文件保持原样,绝不静默永久删除。
export async function deleteToTrash(path: string, isDir: boolean): Promise<DeleteResult> {
    if (isBaiduPath(path)) {
        await removeFile(path);
        return {mode: "plugin", note: "网盘文件已删除,可在百度网盘回收站找回"};
    }

    if (!isNativeAvailable()) {
        throw new Error("当前环境不支持回收站(需思源桌面端),删除已取消,文件保持原样");
    }

    const mode: TrashMode = currentMode;

    if (mode === "system") {
        const sysPath = isSiyuanPath(path) ? toSystemPath(path, getWorkspacePath()) : path;
        try {
            // Electron 渲染进程(nodeIntegration)暴露 window.process
            const platform: string = (window as any).process?.platform || "win32";
            if (platform === "darwin") {
                await systemTrashMac(sysPath);
            } else if (platform === "linux") {
                await systemTrashLinux(sysPath);
            } else {
                await systemTrashWin(sysPath, isDir);
            }
            return {mode: "system", note: "已移入系统回收站"};
        } catch (e) {
            // 系统回收站失败:中止删除并上抛,绝不静默转直删
            throw new Error(`移入系统回收站失败: ${e}(文件保持原样)`);
        }
    }

    // plugin 模式
    const sysPath = isSiyuanPath(path) ? toSystemPath(path, getWorkspacePath()) : path;
    if (!isSiyuanPath(path) && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path)) {
        throw new Error(`无法识别的路径: ${path}`);
    }
    const f = getFs();
    if (!f.existsSync(sysPath)) {
        throw new Error(`文件不存在: ${sysPath}`);
    }
    const target = resolveCollision(mirrorPath(path));
    const pth = getPathMod();
    // 镜像父目录逐层建好
    f.mkdirSync(pth.dirname(target), {recursive: true});
    moveRecursive(sysPath, target);

    const idx = loadIndex();
    idx.entries.unshift({
        id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        origin: path,
        trashPath: target,
        isDir: isDir || isDirOnDisk(target),
        time: Date.now(),
    });
    // index 上限:只保留最近 500 条(回收站内孤儿文件由"清空"处理)
    if (idx.entries.length > 500) idx.entries.length = 500;
    saveIndex();
    return {mode: "plugin", note: "已移入插件回收站(可在回收站中恢复)"};
}

// ===== 回收站管理(对话框用) =====

export interface TrashListItem {
    id: string;
    origin: string;
    isDir: boolean;
    time: number;
}

// 列出仍在磁盘上的回收站条目(index 里记录但文件已被手动清理的跳过)
export function listTrashItems(): TrashListItem[] {
    const f = getFs();
    const idx = loadIndex();
    const out: TrashListItem[] = [];
    for (const e of idx.entries) {
        try {
            if (!f.existsSync(e.trashPath)) continue;
        } catch {
            continue;
        }
        out.push({id: e.id, origin: e.origin, isDir: e.isDir, time: e.time});
    }
    return out;
}

// 恢复:移回原位;原位已存在同名时不覆盖,恢复为「xxx (恢复 yyyy-MM-dd HHmmss)」
export function restoreFromTrash(id: string): {origin: string; restoredAs: string} {
    const f = getFs();
    const pth = getPathMod();
    const idx = loadIndex();
    const i = idx.entries.findIndex(e => e.id === id);
    if (i < 0) throw new Error("记录不存在或已被恢复");
    const e = idx.entries[i];
    if (!f.existsSync(e.trashPath)) throw new Error("回收站内的文件已不存在(可能被手动清理)");

    const originSys = isSiyuanPath(e.origin) ? toSystemPath(e.origin, getWorkspacePath()) : e.origin;
    let dest = originSys;
    if (f.existsSync(dest)) {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        dest = pth.join(pth.dirname(originSys), pth.basename(originSys) + " (恢复 " + stamp + ")");
    }
    f.mkdirSync(pth.dirname(dest), {recursive: true});
    moveRecursive(e.trashPath, dest);

    idx.entries.splice(i, 1);
    saveIndex();
    return {origin: e.origin, restoredAs: dest};
}

// 彻底删除单条(真正从磁盘删除回收站内的副本)
export function purgeTrashItem(id: string): void {
    const f = getFs();
    const idx = loadIndex();
    const i = idx.entries.findIndex(e => e.id === id);
    if (i < 0) return;
    try {
        f.rmSync(idx.entries[i].trashPath, {recursive: true, force: true});
    } finally {
        idx.entries.splice(i, 1);
        saveIndex();
    }
}

// 清空插件回收站:删除整个回收站目录内容并重置 index
export function emptyPluginTrash(): void {
    const f = getFs();
    const root = pluginTrashRoot();
    if (f.existsSync(root)) {
        f.rmSync(root, {recursive: true, force: true});
    }
    indexCache = {version: 1, entries: []};
    saveIndex();
}

// 在系统文件管理器中打开回收站目录(找起来直观)
export function revealPluginTrash(): void {
    const f = getFs();
    const root = pluginTrashRoot();
    f.mkdirSync(root, {recursive: true});
    // 回收站根一定是文件夹;revealInSystemExplorer 对文件夹直接走资源管理器打开
    void revealInSystemExplorer(root, true);
}

// 供显示用:条目名(原路径的最后一段)
export function trashItemName(origin: string): string {
    return basename(origin);
}
