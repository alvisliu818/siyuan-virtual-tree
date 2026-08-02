import {DirEntry} from "../types";

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
export async function readTextFile(path: string): Promise<string> {
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json", ...authHeaders()},
        body: JSON.stringify({path}),
    });
    if (!resp.ok) throw new Error(`读取文件失败: ${path} (${resp.status})`);
    return await resp.text();
}

// 读取二进制文件内容
export async function readBinaryFile(path: string): Promise<ArrayBuffer> {
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

// 创建目录(/api/file/putFile,isDir=true)
export async function mkdir(path: string): Promise<void> {
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
    await postJSON("/api/file/renameFile", {path, newPath});
}

// 删除文件或目录(/api/file/removeFile)
export async function removeFile(path: string): Promise<void> {
    await postJSON("/api/file/removeFile", {path});
}

// 复制文件(/api/file/copyFile)
export async function copyFile(src: string, dest: string): Promise<void> {
    await postJSON("/api/file/copyFile", {src, dest});
}
