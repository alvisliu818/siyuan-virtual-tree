import {DirEntry} from "../types";
import {isKernelPath, joinPath, basename} from "../utils/path";
import {isBaiduPath} from "../utils/baidu-path";
import {isOneDrivePath} from "../utils/onedrive-path";
import {isOutlookPath} from "../utils/outlook-path";
import {isImapPath} from "../utils/imap-path";
import {imapListDir, imapReadFile} from "./imap-mail";
import {isWeblinkPath, isBmarksPath, linkMountReadDir, weblinkText} from "../utils/link-mount";
import {isActionPath, actionSpecOf} from "../utils/action-mount";
import {mailListDir, mailReadFile} from "./outlook-mail";
import {isGitRepoPath} from "../utils/git-repo-path";
import {decodeAuto} from "../utils/encoding";
import {
    bdCreateDir,
    bdDownloadFile,
    bdListDir,
    bdRemove,
    bdRename,
    bdUploadFile,
} from "./baidu-pan";
import {odCreateDir, odDownloadFile, odListDir, odRemove, odRename, odUploadFile} from "./onedrive";
import {
    gitCreateDir,
    gitDownloadFile,
    gitListDir,
    gitRemove,
    gitRename,
    gitUploadFile,
} from "./git-repo";
import {
    nativeCopyFile,
    nativeMkdir,
    nativeReadBinaryFile,
    nativeReadDir,
    nativeReadTextFile,
    nativeRemoveFile,
    nativeRenameFile,
    nativeWriteBinaryFile,
    nativeWriteFile,
} from "./native-fs";
import {isLibraryPath} from "../utils/library-path";
import {libraryListDir, libraryRemove, libraryRename, redirectLibraryPath} from "./library";

// 文件访问多后端:
// - 内核路径(工作空间根相对路径:/data/...、/conf/...、/ 等,见 isKernelPath) → 思源内核 /api/file/*
// - 系统绝对路径(如 E:\HOME\BaiduSyncdisk) → 原生 Node fs(工作空间外)
// - 百度网盘虚拟路径(bdpan://...) → 网盘网页接口(cookie 鉴权,见 api/baidu-pan.ts)
// - Git 仓库虚拟路径(github://...、gitee://...) → 官方 REST API(见 api/git-repo.ts)
// - 插件库路径(/data/storage/petal/<插件>/library/...) → 见下方 redirectLibraryPath
// 每个导出函数按路径类型分流,外部路径在非桌面端(无 Node 集成)会抛出可读错误。
//
// 插件库分流放在最前面,把库内路径**换成当前形态真正能访问的路径**后复用下面所有分支:
// 桌面端换成系统绝对路径(走原生 fs,原地写,保住 junction/符号链接);
// 移动端换成条目绑定的 github:// / gitee:// 路径(链接不会被思源同步到移动端)。
// 详见 api/library.ts 顶部说明。

// 内核 API 鉴权头(本地桌面端无需 token,此处防御性补充)
function authHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

// 通用 JSON POST,校验 code 字段
// 导出供其它模块复用(如文档菜单的导入 Markdown),避免各处重复写 fetch + 鉴权头
export async function postJSON<T = any>(url: string, data: any): Promise<T> {
    const resp = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders()},
        body: JSON.stringify(data),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.msg || `API error: ${url}`);
    return json.data as T;
}

// 读取文本文件内容(/api/file/getFile 返回原始二进制,必须用原生 fetch)
// 自动检测编码:UTF-8 优先,失败回退 GBK(保存时统一写回 UTF-8)
export async function readTextFile(path: string): Promise<string> {
    path = redirectLibraryPath(path);
    // 百度网盘路径走网盘接口下载
    if (isBaiduPath(path)) return decodeAuto(new Uint8Array(await bdDownloadFile(path)));
    if (isOneDrivePath(path)) return decodeAuto(new Uint8Array(await odDownloadFile(path)));
    if (isOutlookPath(path)) {
        const r = await mailReadFile(path);
        return typeof r === "string" ? r : decodeAuto(new Uint8Array(r));
    }
    if (isImapPath(path)) {
        try {
            const r = await imapReadFile(path);
            console.info("[syfe-imap] readTextFile ok, type=", typeof r, "len=", typeof r === "string" ? r.length : (r as ArrayBuffer).byteLength);
            return typeof r === "string" ? r : decodeAuto(new Uint8Array(r));
        } catch (e) {
            console.error("[syfe-imap] readTextFile failed:", (e as Error)?.stack || (e as Error)?.message || e);
            throw e;
        }
    }
    if (isWeblinkPath(path)) return weblinkText(path);
    if (isActionPath(path)) return JSON.stringify(actionSpecOf(path) || {}, null, 1);
    if (isGitRepoPath(path)) return decodeAuto(new Uint8Array(await gitDownloadFile(path)));
    // 工作空间外路径走原生 fs
    if (!isKernelPath(path)) return nativeReadTextFile(path);
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders()},
        body: JSON.stringify({path}),
    });
    if (!resp.ok) throw new Error(`读取文件失败: ${path} (${resp.status})`);
    return decodeAuto(new Uint8Array(await resp.arrayBuffer()));
}

// 读取二进制文件内容
export async function readBinaryFile(path: string): Promise<ArrayBuffer> {
    path = redirectLibraryPath(path);
    // 百度网盘路径走网盘接口下载
    if (isBaiduPath(path)) return bdDownloadFile(path);
    if (isOneDrivePath(path)) return odDownloadFile(path);
    if (isOutlookPath(path)) {
        const r = await mailReadFile(path);
        return typeof r === "string" ? new TextEncoder().encode(r).buffer : r;
    }
    if (isGitRepoPath(path)) return gitDownloadFile(path);
    // 工作空间外路径走原生 fs
    if (!isKernelPath(path)) return nativeReadBinaryFile(path);
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders()},
        body: JSON.stringify({path}),
    });
    if (!resp.ok) throw new Error(`读取文件失败: ${path} (${resp.status})`);
    return await resp.arrayBuffer();
}

// 写入文件内容(/api/file/putFile,multipart)
export async function writeFile(path: string, content: string): Promise<void> {
    if (isWeblinkPath(path) || isBmarksPath(path) || isActionPath(path) || isImapPath(path)) throw new Error("动作挂载为只读(点击条目执行;编辑请右键「编辑…」)");
    if (isWeblinkPath(path) || isBmarksPath(path)) throw new Error("链接/收藏挂载为只读");
    if (isOutlookPath(path)) throw new Error("邮箱挂载为只读,不支持修改邮件");
    path = redirectLibraryPath(path);
    // 百度网盘路径走 precreate/分片/create 上传(覆盖)
    if (isBaiduPath(path)) return bdUploadFile(path, new TextEncoder().encode(content));
    if (isOneDrivePath(path)) return odUploadFile(path, new TextEncoder().encode(content));
    if (isGitRepoPath(path)) return gitUploadFile(path, new TextEncoder().encode(content));
    if (!isKernelPath(path)) return nativeWriteFile(path, content);
    const fd = new FormData();
    fd.append("path", path);
    fd.append("modTime", Date.now().toString());
    fd.append("file", new Blob([content], {type: "application/octet-stream"}), "file");
    const resp = await fetch("/api/file/putFile", {
        method: "POST",
        headers: authHeaders(), // 不设 Content-Type,让浏览器自动添加 multipart boundary
        body: fd,
    });
    if (!resp.ok) throw new Error(`写入文件失败: ${path} (${resp.status})`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.msg || `写入文件失败: ${path}`);
}

// 写入二进制文件内容(/api/file/putFile,multipart)
// 用于 Office 文档(docx/xlsx/pptx)等二进制格式的保存
export async function writeBinaryFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (isWeblinkPath(path) || isBmarksPath(path) || isActionPath(path) || isImapPath(path)) throw new Error("动作挂载为只读");
    if (isWeblinkPath(path) || isBmarksPath(path)) throw new Error("链接/收藏挂载为只读");
    if (isOutlookPath(path)) throw new Error("邮箱挂载为只读,不支持修改邮件");
    path = redirectLibraryPath(path);
    // 百度网盘路径走 precreate/分片/create 上传(覆盖)
    if (isOneDrivePath(path)) return odUploadFile(path, data instanceof Uint8Array ? data : new Uint8Array(data));
    if (isBaiduPath(path)) {
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
        return bdUploadFile(path, bytes);
    }
    if (isGitRepoPath(path)) {
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
        return gitUploadFile(path, bytes);
    }
    if (!isKernelPath(path)) return nativeWriteBinaryFile(path, data);
    const fd = new FormData();
    fd.append("path", path);
    fd.append("modTime", Date.now().toString());
    // 统一转成以 ArrayBuffer 为底层的 Uint8Array,满足 BlobPart 的类型要求
    // (TS 5.7 起 Uint8Array 带 ArrayBufferLike 泛型参数,SharedArrayBuffer 不可赋给 BlobPart)
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
    fd.append("file", new Blob([bytes]), "file");
    const resp = await fetch("/api/file/putFile", {
        method: "POST",
        headers: authHeaders(), // 不设 Content-Type,让浏览器自动添加 multipart boundary
        body: fd,
    });
    if (!resp.ok) throw new Error(`写入文件失败: ${path} (${resp.status})`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.msg || `写入文件失败: ${path}`);
}

// 创建目录(/api/file/putFile,isDir=true)
export async function mkdir(path: string): Promise<void> {
    if (isWeblinkPath(path) || isBmarksPath(path) || isActionPath(path) || isImapPath(path)) throw new Error("动作挂载为只读");
    if (isWeblinkPath(path) || isBmarksPath(path)) throw new Error("链接/收藏挂载为只读");
    if (isOutlookPath(path)) throw new Error("邮箱挂载为只读,不支持新建");
    path = redirectLibraryPath(path);
    // 百度网盘路径走网盘建目录接口
    if (isBaiduPath(path)) return bdCreateDir(path);
    if (isOneDrivePath(path)) return odCreateDir(path);
    if (isGitRepoPath(path)) return gitCreateDir(path);
    if (!isKernelPath(path)) return nativeMkdir(path);
    const fd = new FormData();
    fd.append("path", path);
    fd.append("isDir", "true");
    fd.append("modTime", Date.now().toString());
    fd.append("file", new Blob([], {type: "application/octet-stream"}), "file");
    const resp = await fetch("/api/file/putFile", {
        method: "POST",
        headers: authHeaders(),
        body: fd,
    });
    if (!resp.ok) throw new Error(`创建目录失败: ${path} (${resp.status})`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.msg || `创建目录失败: ${path}`);
}

// 列出目录内容(/api/file/readDir)
// 兼容多种响应格式:data 可能是 {entries:[...]},也可能是数组,也可能是 null
export async function readDir(path: string): Promise<DirEntry[]> {
    // 百度网盘路径走网盘列目录接口(条目自带 bdpan:// 子路径)
    if (isBaiduPath(path)) return bdListDir(path);
    if (isOneDrivePath(path)) return odListDir(path);
    if (isImapPath(path)) return imapListDir(path);
    if (isOutlookPath(path)) return mailListDir(path);
    if (isBmarksPath(path)) return linkMountReadDir(path);
    if (isGitRepoPath(path)) return gitListDir(path);
    // 插件库:桌面端读真实链接,移动端按注册表合成(条目自带 github:// 子路径)
    if (isLibraryPath(path)) return libraryListDir(path);
    if (!isKernelPath(path)) return nativeReadDir(path);
    const data = await postJSON<any>("/api/file/readDir", {path});
    // 情况1:data 本身是数组
    if (Array.isArray(data)) return data;
    // 情况2:data.entries 是数组(注意:若 data 是数组,data.entries 会是 Array.prototype.entries 函数)
    if (data && Array.isArray(data.entries)) return data.entries;
    // 情况3:其他情况返回空数组
    console.warn("[siyuan-file-editor] readDir unexpected response:", path, typeof data, data);
    return [];
}

// 重命名/移动文件(/api/file/renameFile)
export async function renameFile(path: string, newPath: string): Promise<void> {
    if (isWeblinkPath(path) || isBmarksPath(path) || isActionPath(path) || isImapPath(path) || isWeblinkPath(newPath) || isBmarksPath(newPath)) throw new Error("动作挂载为只读(改名用右键「重命名」改显示名)");
    if (isWeblinkPath(path) || isBmarksPath(path) || isWeblinkPath(newPath) || isBmarksPath(newPath)) throw new Error("链接/收藏挂载为只读");
    if (isOutlookPath(path) || isOutlookPath(newPath)) throw new Error("邮箱挂载为只读,不支持改名");
    // 插件库条目改名要同步注册表,否则「取消同步」按名字找不到条目
    if (isLibraryPath(path) || isLibraryPath(newPath)) return libraryRename(path, newPath);
    // 百度网盘路径走网盘改名接口(仅同目录改名)
    if (isBaiduPath(path)) return bdRename(path, newPath);
    if (isOneDrivePath(path)) return odRename(path, newPath);
    if (isGitRepoPath(path)) return gitRename(path, newPath);
    if (!isKernelPath(path)) return nativeRenameFile(path, newPath);
    await postJSON("/api/file/renameFile", {path, newPath});
}

// 删除文件或目录(/api/file/removeFile)
export async function removeFile(path: string, path2?: string): Promise<void> {
    if (isWeblinkPath(path) || isBmarksPath(path) || isActionPath(path) || isImapPath(path)) throw new Error("动作挂载为只读(移除请右键「取消挂载」)");
    if (isWeblinkPath(path) || isBmarksPath(path)) throw new Error("链接/收藏挂载为只读");
    if (isOutlookPath(path)) throw new Error("邮箱挂载为只读,不支持删除邮件(请到邮箱客户端操作)");
    // 插件库条目根只摘链接(外部数据不动),条目内部按普通文件删除
    if (isLibraryPath(path)) return libraryRemove(path);
    // 百度网盘路径走网盘删除接口(目录递归删除,进回收站)
    if (isBaiduPath(path)) return bdRemove(path);
    if (isOneDrivePath(path)) return odRemove(path);
    if (isGitRepoPath(path)) return gitRemove(path);
    if (!isKernelPath(path)) return nativeRemoveFile(path);
    await postJSON("/api/file/removeFile", {path});
}

// 复制文件(/api/file/copyFile)
export async function copyFile(src: string, dest: string): Promise<void> {
    src = redirectLibraryPath(src);
    dest = redirectLibraryPath(dest);
    // 百度网盘路径暂不支持复制(读端下载 + 写端分片上传的代价较高)
    if (isBaiduPath(src) || isBaiduPath(dest)) {
        throw new Error("百度网盘目录暂不支持复制,请使用官方客户端");
    }
    if (isGitRepoPath(src) || isGitRepoPath(dest)) {
        throw new Error("Git 仓库暂不支持复制,请在仓库网页端操作");
    }
    if (!isKernelPath(src)) return nativeCopyFile(src, dest);
    // 内核 /api/file/copyFile 仅限 assets/ 路径,任意工作空间文件用读写原语复制
    await writeBinaryFile(dest, await readBinaryFile(src));
}

// ===== 移动/复制(文件+文件夹,内核/原生双后端,支持跨后端) =====
// 内核 renameFile 支持目录但要求目标不存在;copyFile 不支持目录(内核直接拒绝)。
// 因此:同后端移动走 rename;目录复制与跨后端走递归 copyTree;跨后端移动 = 复制+删源。
// 目标已存在的覆盖确认由 UI 层负责(先 removeFile 目标再调用这里)。

function normGuardPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function assertLocalBackend(p: string): void {
    if (isBaiduPath(p)) throw new Error("百度网盘目录暂不支持移动/复制,请使用官方客户端");
    if (isGitRepoPath(p)) throw new Error("Git 仓库暂不支持移动/复制,请在仓库网页端操作");
}

function assertDestValid(src: string, dest: string, isDir: boolean): void {
    const s = normGuardPath(src);
    const d = normGuardPath(dest);
    if (d === s) throw new Error("目标位置与源相同");
    if (isDir && d.startsWith(s + "/")) throw new Error("不能把文件夹移动/复制到它自己的子目录里");
}

// 递归复制目录:逐层 readDir + mkdir;文件按后端组合选原语
// (内核→内核用 copyFile 保住文档寻址语义,其余二进制读写,跨后端通用)
async function copyTree(src: string, dest: string): Promise<void> {
    await mkdir(dest);
    const entries = await readDir(src);
    for (const e of entries) {
        const s = joinPath(src, e.name);
        const d = joinPath(dest, e.name);
        if (e.isDir) {
            await copyTree(s, d);
        } else if (isKernelPath(s) && isKernelPath(d)) {
            await copyFile(s, d);
        } else {
            await writeBinaryFile(d, await readBinaryFile(s));
        }
    }
}

// 复制文件/文件夹到 destDir(保持同名),返回目标路径
export async function copyEntry(src: string, destDir: string, isDir: boolean): Promise<string> {
    src = redirectLibraryPath(src);
    destDir = redirectLibraryPath(destDir);
    assertLocalBackend(src);
    assertLocalBackend(destDir);
    const dest = joinPath(destDir, basename(src));
    assertDestValid(src, dest, isDir);
    if (!isDir && isKernelPath(src) && isKernelPath(dest)) {
        await copyFile(src, dest);
    } else if (!isKernelPath(src) && !isKernelPath(dest)) {
        await nativeCopyFile(src, dest);
    } else {
        await copyTree(src, dest);
    }
    return dest;
}

// 移动文件/文件夹到 destDir(保持同名),返回目标路径
export async function moveEntry(src: string, destDir: string, isDir: boolean): Promise<string> {
    src = redirectLibraryPath(src);
    destDir = redirectLibraryPath(destDir);
    assertLocalBackend(src);
    assertLocalBackend(destDir);
    const dest = joinPath(destDir, basename(src));
    assertDestValid(src, dest, isDir);
    if (isKernelPath(src) && isKernelPath(dest)) {
        await postJSON("/api/file/renameFile", {path: src, newPath: dest});
    } else if (!isKernelPath(src) && !isKernelPath(dest)) {
        await nativeRenameFile(src, dest);
    } else {
        await copyTree(src, dest);
        await removeFile(src);
    }
    return dest;
}

// 执行思源内核 SQL 查询(/api/query/sql)
export async function querySQL(stmt: string): Promise<any[]> {
    return await postJSON<any[]>("/api/query/sql", {stmt});
}

// 列出所有笔记本(/api/notebook/lsNotebooks)
export async function lsNotebooks(): Promise<any[]> {
    const data = await postJSON<{notebooks: any[]}>("/api/notebook/lsNotebooks", {});
    return (data && Array.isArray(data.notebooks)) ? data.notebooks : [];
}

// 按路径列出笔记本下的子文档(/api/filetree/listDocsByPath)
// path 为 .sy 相对路径(如 /20260906113500-abc/xxx.sy),根传 "/"
export async function listDocsByPath(notebook: string, path: string): Promise<any[]> {
    const data = await postJSON<{files: any[]}>("/api/filetree/listDocsByPath", {notebook, path});
    return (data && Array.isArray(data.files)) ? data.files : [];
}

// 导入本地 Markdown 文件/文件夹到思源笔记本(/api/import/importStdMd)
// localPath 必须是内核可访问的系统绝对路径,且不能是工作空间子路径(内核限制)
// toPath:"/"=笔记本根;"/<docId>.sy"=导入为该文档的子文档
// skipRoot:文件夹导入时跳过根文件夹层级(思源右键导入不传,即保留文件夹名层级)
export async function importStdMd(notebook: string, localPath: string, toPath: string, skipRoot = false): Promise<void> {
    await postJSON("/api/import/importStdMd", {notebook, localPath, toPath, skipRoot});
}

// 上传本地文件为思源资源(/api/asset/upload),返回资源相对路径(如 assets/xxx.md)
// 供"导入 md 时把源文件作为资源插入文档"用
export async function uploadAsset(fileName: string, data: ArrayBuffer | Blob): Promise<string> {
    const form = new FormData();
    const blob = (data instanceof Blob) ? data : new Blob([data]);
    form.append("file[]", blob, fileName);
    // FormData 不能手动设 Content-Type(要带 boundary),故不用 postJSON
    const resp = await fetch("/api/asset/upload", {
        method: "POST",
        headers: {...authHeaders()},
        body: form,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: /api/asset/upload`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.msg || "上传资源失败");
    const url = json?.data?.succFiles?.[0]?.url || "";
    if (!url) throw new Error("上传资源失败:内核未返回资源路径");
    return String(url);
}

// 在文档最前面插入一个块(用 markdown 源码)。
// 用于把"源文件资源链接"做成引述块顶到文档头部。
export async function insertBlockAtDocTop(docId: string, markdown: string): Promise<void> {
    const rows = await querySQL(`SELECT id FROM blocks WHERE parent_id = '${docId.replace(/'/g, "''")}' ORDER BY sort ASC LIMIT 1`);
    const payload: Record<string, any> = {dataType: "markdown", data: markdown, parentID: docId};
    const firstId = Array.isArray(rows) && rows[0] && rows[0].id ? String(rows[0].id) : "";
    if (firstId) {
        // 文档非空:插到第一个子块之前
        payload.nextID = firstId;
    }
    await postJSON("/api/block/insertBlock", payload);
}

// ===== 思源文档树操作(对齐思源文档树右键菜单的原生能力) =====
// 供虚拟文档树/标签面板的「原生」文档菜单使用,操作结果与在思源文档树里操作完全一致。

// 新建文档(/api/filetree/createDocWithMd),返回新文档 id。
// path 为新文档的人类可读路径(如 /Parent/未命名文档);给定 parentID 时挂到该文档下,path 只需 "/标题"。
export async function createDocWithMd(notebook: string, path: string, markdown: string, parentID?: string): Promise<string> {
    const payload: Record<string, any> = {notebook, path, markdown};
    if (parentID) payload.parentID = parentID;
    return await postJSON<string>("/api/filetree/createDocWithMd", payload);
}

// 强制内核把挂起的文件树事务与 SQL 索引队列立即落库(/api/sqlite/flushTransaction)。
// 为什么需要:内核 createDocWithMd 返回时只保证了 .sy 文件与 blocktrees 内存索引,
// blocks SQL 表走独立的异步刷写队列(秒级),这期间按 id 查 blocks 会查空。
export async function flushTransaction(): Promise<void> {
    try {
        await postJSON("/api/sqlite/flushTransaction", {});
    } catch {
        // 老版本内核没有该 API 或临时失败:静默忽略,调用方按查询结果自行兜底
    }
}

// 重命名文档(/api/filetree/renameDocByID,内核自动解析 notebook/path)
export async function renameDocByID(id: string, title: string): Promise<void> {
    await postJSON("/api/filetree/renameDocByID", {id, title});
}

// 删除文档(/api/filetree/removeDocByID)
export async function removeDocByID(id: string): Promise<void> {
    await postJSON("/api/filetree/removeDocByID", {id});
}

// 移动文档(/api/filetree/moveDocsByID,与思源原生文档树拖拽/页签移动同款接口):
// toID 为笔记本 id → 移到该笔记本顶层;为文档 id → 作为该文档的子文档。
// 移入自身子树等非法目标由内核校验并返回非 0 code(postJSON 抛错)。
export async function moveDocsByID(fromIDs: string[], toID: string): Promise<void> {
    await postJSON("/api/filetree/moveDocsByID", {fromIDs, toID});
}

// 复制副本(仅文档自身内容,/api/filetree/duplicateDoc)
export async function duplicateDoc(id: string): Promise<void> {
    await postJSON("/api/filetree/duplicateDoc", {id});
}

// 复制文档树(连同全部子文档,/api/filetree/duplicateDocTree)
export async function duplicateDocTree(id: string): Promise<void> {
    await postJSON("/api/filetree/duplicateDocTree", {id});
}

// 重命名笔记本(/api/notebook/renameNotebook)
export async function renameNotebook(notebook: string, name: string): Promise<void> {
    await postJSON("/api/notebook/renameNotebook", {notebook, name});
}

// 读取块属性(/api/attr/getBlockAttrs),文档自定义图标在 attrs.icon
export async function getBlockAttrs(id: string): Promise<Record<string, string>> {
    return await postJSON<Record<string, string>>("/api/attr/getBlockAttrs", {id});
}

// 写块属性(/api/attr/setBlockAttrs)。注意 alias 为逗号分隔的多值(内核 file_test.go:
// Alias: "Algebra,Math,Geometry"),追加别名须读旧值拼接,不能整字段覆盖。
export async function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
    await postJSON("/api/attr/setBlockAttrs", {id, attrs});
}

// 导出文档 Markdown(/api/export/exportMdContent → {hPath, content})
export async function exportMdContent(id: string): Promise<{hPath: string; content: string}> {
    return await postJSON<{hPath: string; content: string}>("/api/export/exportMdContent", {id});
}

// 块引用文本(/api/block/getRefText),复制块引用/Markdown 链接用
export async function getRefText(id: string): Promise<string> {
    return await postJSON<string>("/api/block/getRefText", {id});
}

// 文档人类可读路径(/api/filetree/getHPathByID),复制 HPath 用
export async function getHPathByID(id: string): Promise<string> {
    return await postJSON<string>("/api/filetree/getHPathByID", {id});
}
