import {DirEntry} from "../types";
import {isSiyuanPath} from "../utils/path";
import {decodeAuto} from "../utils/encoding";
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

// 文件访问双后端:
// - 思源虚拟路径(/data/...) → 思源内核 /api/file/*(工作空间内)
// - 系统绝对路径(如 E:\HOME\BaiduSyncdisk) → 原生 Node fs(工作空间外)
// 每个导出函数按路径类型分流,外部路径在非桌面端(无 Node 集成)会抛出可读错误。

// 内核 API 鉴权头(本地桌面端无需 token,此处防御性补充)
function authHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

// 通用 JSON POST,校验 code 字段
async function postJSON<T = any>(url: string, data: any): Promise<T> {
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
    // 工作空间外路径走原生 fs
    if (!isSiyuanPath(path)) return nativeReadTextFile(path);
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
    // 工作空间外路径走原生 fs
    if (!isSiyuanPath(path)) return nativeReadBinaryFile(path);
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
    if (!isSiyuanPath(path)) return nativeWriteFile(path, content);
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
    if (!isSiyuanPath(path)) return nativeWriteBinaryFile(path, data);
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
    if (!isSiyuanPath(path)) return nativeMkdir(path);
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
    if (!isSiyuanPath(path)) return nativeReadDir(path);
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
    if (!isSiyuanPath(path)) return nativeRenameFile(path, newPath);
    await postJSON("/api/file/renameFile", {path, newPath});
}

// 删除文件或目录(/api/file/removeFile)
export async function removeFile(path: string): Promise<void> {
    if (!isSiyuanPath(path)) return nativeRemoveFile(path);
    await postJSON("/api/file/removeFile", {path});
}

// 复制文件(/api/file/copyFile)
export async function copyFile(src: string, dest: string): Promise<void> {
    if (!isSiyuanPath(src)) return nativeCopyFile(src, dest);
    await postJSON("/api/file/copyFile", {src, dest});
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
