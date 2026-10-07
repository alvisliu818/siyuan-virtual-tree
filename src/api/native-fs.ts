import {getNativeRequire} from "../utils/native-require";
import {DirEntry} from "../types";
import {joinPath} from "../utils/path";
import {decodeAuto} from "../utils/encoding";

// 工作空间外文件的原生后端:直接走 Node.js 的 fs
// 思源内核 /api/file/* 只能访问工作空间内的路径(/data/...),想浏览 E:\HOME\BaiduSyncdisk
// 这类工作空间外目录必须用原生 fs。仅在思源桌面端(Electron + Node 集成)可用。

let cachedFs: any = null;
let fsFailed = false;

// 获取 fs 模块,不可用时抛出可读错误
function getFs(): any {
    if (cachedFs) return cachedFs;
    if (fsFailed) throw new Error("当前环境不支持访问工作空间外的文件(需要思源桌面端)");
    const req = getNativeRequire();
    if (!req) {
        fsFailed = true;
        throw new Error("当前环境不支持访问工作空间外的文件(Node 集成不可用)");
    }
    try {
        cachedFs = req("fs");
    } catch (e) {
        fsFailed = true;
        throw new Error(`无法加载 fs 模块: ${e}`);
    }
    if (!cachedFs) {
        fsFailed = true;
        throw new Error("当前环境不支持访问工作空间外的文件(无法加载 fs)");
    }
    return cachedFs;
}

// 检测原生 fs 是否可用(不抛异常)
export function isNativeFsAvailable(): boolean {
    try {
        getFs();
        return true;
    } catch {
        return false;
    }
}

// 路径不存在 / 无权限等错误的统一包装
function wrapError(op: string, path: string, e: any): Error {
    const msg = e?.message || String(e);
    const code = e?.code;
    if (code === "ENOENT") return new Error(`${op}失败:路径不存在 ${path}`);
    if (code === "EACCES" || code === "EPERM") return new Error(`${op}失败:没有权限 ${path}`);
    if (code === "EEXIST") return new Error(`${op}失败:目标已存在 ${path}`);
    return new Error(`${op}失败: ${path} (${msg})`);
}

// 列出目录内容,结构对齐思源内核 readDir 的 DirEntry
export async function nativeReadDir(path: string): Promise<DirEntry[]> {
    const f = getFs();
    try {
        const names: string[] = await f.promises.readdir(path);
        // 逐个 stat 拿 isDir/size/mtime;单个失败不影响其他条目
        const entries: DirEntry[] = [];
        await Promise.all(names.map(async (name) => {
            const full = joinPath(path, name);
            try {
                const st = await f.promises.stat(full);
                entries.push({
                    name,
                    size: st.isDirectory() ? 0 : Number(st.size || 0),
                    isDir: st.isDirectory(),
                    updated: st.mtime ? new Date(st.mtime).toISOString() : "",
                });
            } catch {
                // stat 失败(如权限/快捷方式损坏)也列出来,按文件处理
                entries.push({name, size: 0, isDir: false, updated: ""});
            }
        }));
        return entries;
    } catch (e) {
        throw wrapError("读取目录", path, e);
    }
}

// 读取文本文件(自动检测编码:UTF-8 优先,失败回退 GBK;保存时统一写回 UTF-8)
export async function nativeReadTextFile(path: string): Promise<string> {
    const f = getFs();
    try {
        const buf = await f.promises.readFile(path);
        return decodeAuto(new Uint8Array(buf));
    } catch (e) {
        throw wrapError("读取文件", path, e);
    }
}

// 读取二进制文件
export async function nativeReadBinaryFile(path: string): Promise<ArrayBuffer> {
    const f = getFs();
    try {
        const buf = await f.promises.readFile(path);
        // Node Buffer → ArrayBuffer(避免把 Buffer 的池化内存整块暴露出去)
        const out = new Uint8Array(buf.length);
        out.set(buf);
        return out.buffer;
    } catch (e) {
        throw wrapError("读取文件", path, e);
    }
}

// 把文件/文件夹复制到系统临时目录(工作空间外),返回临时副本路径。
// 用途:思源导入接口拒绝工作空间子路径(/data 下文件),需先复制到外部再导入。
// 返回 {tempPath, cleanup}:cleanup 在导入完成后调用以删除临时副本。
export async function nativeCopyToTemp(src: string): Promise<{tempPath: string; cleanup: () => Promise<void>}> {
    getFs(); // 确保原生环境可用(不可用会抛出可读错误)
    const req = getNativeRequire();
    if (!req) throw new Error("当前环境不支持访问工作空间外的文件(Node 集成不可用)");
    const f = cachedFs;
    const osMod = req("os");
    const tmpBase = await f.promises.mkdtemp(await f.promises.join(osMod.tmpdir(), "syfe-import-"));
    const name = src.split(/[\\/]+/).filter(Boolean).pop() || "import.md";
    const tempPath = await f.promises.join(tmpBase, name);
    // fs.cp 递归复制(Node 16.7+);文件+文件夹统一处理
    await f.promises.cp(src, tempPath, {recursive: true});
    const cleanup = async () => {
        try {
            await f.promises.rm(tmpBase, {recursive: true, force: true});
        } catch {
            // 清理失败交给系统临时目录机制,不影响主流程
        }
    };
    return {tempPath, cleanup};
}

// 把内存中的字节写入系统临时目录(网盘等远程文件落地用),返回临时路径与清理回调
export async function nativeWriteTempFile(
    name: string,
    data: ArrayBuffer | Uint8Array,
): Promise<{tempPath: string; cleanup: () => Promise<void>}> {
    getFs(); // 确保原生环境可用
    const req = getNativeRequire();
    if (!req) throw new Error("当前环境不支持访问工作空间外的文件(Node 集成不可用)");
    const f = cachedFs;
    const osMod = req("os");
    const tmpBase = await f.promises.mkdtemp(await f.promises.join(osMod.tmpdir(), "syfe-download-"));
    const safeName = (name || "download").replace(/[\\/:*?"<>|]/g, "_");
    const tempPath = await f.promises.join(tmpBase, safeName);
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
    await f.promises.writeFile(tempPath, bytes);
    const cleanup = async () => {
        try {
            await f.promises.rm(tmpBase, {recursive: true, force: true});
        } catch {
            // 清理失败交给系统临时目录机制,不影响主流程
        }
    };
    return {tempPath, cleanup};
}

// 确保父目录存在(写入前的兜底)
async function ensureParentDir(f: any, path: string): Promise<void> {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (idx <= 0) return;
    const parent = path.slice(0, idx);
    if (!parent || /^[A-Za-z]:$/.test(parent)) return;
    try {
        await f.promises.mkdir(parent, {recursive: true});
    } catch {
        // 父目录已存在或创建失败,交由后续写入报错
    }
}

// 写入文本文件
export async function nativeWriteFile(path: string, content: string): Promise<void> {
    const f = getFs();
    try {
        await ensureParentDir(f, path);
        await f.promises.writeFile(path, content, "utf8");
    } catch (e) {
        throw wrapError("写入文件", path, e);
    }
}

// 写入二进制文件
export async function nativeWriteBinaryFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const f = getFs();
    try {
        await ensureParentDir(f, path);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        await f.promises.writeFile(path, bytes);
    } catch (e) {
        throw wrapError("写入文件", path, e);
    }
}

// 创建目录
export async function nativeMkdir(path: string): Promise<void> {
    const f = getFs();
    try {
        await f.promises.mkdir(path, {recursive: true});
    } catch (e) {
        throw wrapError("创建目录", path, e);
    }
}

// 重命名/移动
export async function nativeRenameFile(path: string, newPath: string): Promise<void> {
    const f = getFs();
    try {
        await ensureParentDir(f, newPath);
        await f.promises.rename(path, newPath);
    } catch (e) {
        throw wrapError("重命名", path, e);
    }
}

// 删除文件或目录(目录递归删除)
export async function nativeRemoveFile(path: string): Promise<void> {
    const f = getFs();
    try {
        if (typeof f.promises.rm === "function") {
            await f.promises.rm(path, {recursive: true, force: true});
            return;
        }
        // 旧版 Node 降级:目录用 rmdir(recursive),文件用 unlink
        const st = await f.promises.stat(path);
        if (st.isDirectory()) {
            await f.promises.rmdir(path, {recursive: true});
        } else {
            await f.promises.unlink(path);
        }
    } catch (e) {
        throw wrapError("删除", path, e);
    }
}

// 递归复制目录(fs.promises.cp 不可用时的降级实现)
async function copyRecursive(f: any, src: string, dest: string): Promise<void> {
    const st = await f.promises.stat(src);
    if (st.isDirectory()) {
        await f.promises.mkdir(dest, {recursive: true});
        const names: string[] = await f.promises.readdir(src);
        for (const name of names) {
            await copyRecursive(f, joinPath(src, name), joinPath(dest, name));
        }
    } else {
        await f.promises.copyFile(src, dest);
    }
}

// 复制文件或目录
export async function nativeCopyFile(src: string, dest: string): Promise<void> {
    const f = getFs();
    try {
        await ensureParentDir(f, dest);
        if (typeof f.promises.cp === "function") {
            await f.promises.cp(src, dest, {recursive: true, force: true});
            return;
        }
        await copyRecursive(f, src, dest);
    } catch (e) {
        throw wrapError("复制", src, e);
    }
}

// 判断路径是否存在且为目录(切换根目录时校验用)
export async function nativeIsDirectory(path: string): Promise<boolean> {
    const f = getFs();
    try {
        const st = await f.promises.stat(path);
        return st.isDirectory();
    } catch {
        return false;
    }
}
