// 局域网同步文件:两台设备各跑一份思源 + 本插件互相同步选定的目录。
// 服务端仅桌面端(需要 Node http);**移动端作为客户端** —— 本地文件走思源内核 API
// (/data/... 内核路径),对端请求走 localHttp(桌面 Node 直连,移动端内核代理)。
//
// 协议(HTTP JSON,鉴权头 x-lansync-token):
//   GET  /api/lan-sync/ping                → {device, roots:[{id,name}]}  roots=本机全部任务的 localRoot
//   GET  /api/lan-sync/list?rootId=...     → {files: {rel: {size, mtimeMs}}}
//   GET  /api/lan-sync/read?rootId=&path=  → {data: base64}
//   POST /api/lan-sync/write               → {rootId, path, data(base64), mtimeMs}
//   POST /api/lan-sync/delete              → {rootId, path}
//
// 同步模型(与 library-sync 一致的三方比对,刻意不对称的安全边界):
//   基线 = 上次同步成功时两侧的 size/mtime 快照
//   本地删除 → 提交对端删除(本端是用户亲手删的)
//   对端删除 → 只报告,不删本地(不可逆操作宁可不自动做)
//   两侧都改 → 冲突,跳过并列出,绝不静默覆盖
//   无基线且两侧都有 → 冲突跳过(猜哪侧对赌注太大)
import type {Plugin} from "siyuan";
import {getNativeRequire} from "../utils/native-require";
import {isNativeFsAvailable} from "./native-fs";
import {toSystemPath, getWorkspacePath} from "../utils/system-path";
import {isKernelPath, joinPath} from "../utils/path";
import {isMobileFrontend} from "../utils/platform";
import {readDir, readBinaryFile, removeFile} from "./file";
import {localHttp} from "./search-service";
import {DirEntry} from "../types";
import {agentRootsAll, findAgentForRoot, forwardToAgent, handleAgentUpgrade} from "./lan-sync-agent";

// Plugin 泛型上没有 config 字段(插件实例才有),统一收窄
type PluginWithConfig = Plugin & {config: any};

// Node 模块取用(getNativeRequire 可能为 null,统一抛可读错误)
function reqNode(): any {
    const req = getNativeRequire();
    if (!req) throw new Error("Node 集成不可用(需要思源桌面端)");
    return req;
}

// 内核内部目录(回收站/快照等),任何后端都不同步
function isKernelInternalRel(rel: string): boolean {
    return rel.split("/").includes(".siyuan");
}

// 单文件传输上限:超限跳过(局域网 JSON base64 传输,体积敏感)
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// 目录递归扫描的文件数上限(防失控)
const MAX_SCAN_FILES = 20000;

export interface LanSyncTask {
    id: string;             // 本机唯一;服务端把每个任务的 localRoot 作为共享根按 id 暴露
    name: string;
    localRoot: string;      // 本端目录:桌面端可为内核路径 /data/... 或系统绝对路径;移动端**必须**是 /data/...
    remoteUrl: string;      // 对端 http://host:port(服务端 = 对端桌面端)
    remoteRootId: string;   // 对端共享根 id(ping 返回的 roots)
    remoteToken: string;    // 对端令牌(空 = 用本端令牌)
    direction: "both" | "push" | "pull";
    includeRules: string;   // 白名单正则,每行一条(相对路径,/ 分隔;空 = 全部包含)
    excludeRules: string;   // 黑名单正则,每行一条(命中即排除,优先于白名单)
    lastSyncTs?: number;
}

export interface LanSyncReport {
    pushed: string[];
    pulled: string[];
    deletedRemote: string[];
    remoteDeleted: string[];   // 对端已删除但本地保留,仅报告
    conflicts: string[];
    skipped: string[];         // 超限/读取失败等
}

export function emptyLanSyncReport(): LanSyncReport {
    return {pushed: [], pulled: [], deletedRemote: [], remoteDeleted: [], conflicts: [], skipped: []};
}

// ===== 任务存取(配置里的 lanSyncTasks JSON 串) =====

export function parseLanSyncTasks(raw: string | undefined): LanSyncTask[] {
    if (!raw) return [];
    try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data.filter((t: any) => t && typeof t.id === "string" && typeof t.localRoot === "string") as LanSyncTask[];
    } catch {
        return [];
    }
}

export function serializeLanSyncTasks(tasks: LanSyncTask[]): string {
    return JSON.stringify(tasks);
}

export async function saveLanSyncTasks(plugin: PluginWithConfig, tasks: LanSyncTask[]): Promise<void> {
    plugin.config.lanSyncTasks = serializeLanSyncTasks(tasks);
    const {saveConfig} = await import("../utils/config");
    await saveConfig(plugin, plugin.config);
}

// ===== 规则匹配(白/黑名单正则,每行一条,匹配相对路径) =====

function compileRules(text: string): RegExp[] {
    const out: RegExp[] = [];
    for (const line of String(text || "").split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
            out.push(new RegExp(t));
        } catch {
            // 无效正则忽略(设置面板保存时会校验并提示)
        }
    }
    return out;
}

/** 相对路径是否通过任务的规则(黑名单优先;白名单空 = 全部包含)。 */
export function relPathAllowed(task: {includeRules: string; excludeRules: string}, rel: string): boolean {
    const norm = rel.replace(/\\/g, "/");
    // 内核内部目录(.siyuan:回收站/快照/索引)绝不同步 —— 远端列表若含它们,
    // 不拦会把内核内部文件当"对端新文件"拉到本地 .siyuan,污染内核数据
    if (isKernelInternalRel(norm)) return false;
    for (const re of compileRules(task.excludeRules)) {
        if (re.test(norm)) return false;
    }
    const includes = compileRules(task.includeRules);
    if (includes.length === 0) return true;
    return includes.some(re => re.test(norm));
}

// ===== 服务端 =====

let server: any = null;
let serverPort = 0;
let serverToken = "";

export function lanSyncServerPort(): number {
    return serverPort;
}

// 内核路径(/data/...)转系统绝对路径;已是绝对路径原样返回
function resolveRootAbs(localRoot: string): string {
    return toSystemPath(localRoot, getWorkspacePath()) || localRoot;
}

// 本机共享根:全部任务的 localRoot(id → 系统绝对路径)。
function serverRoots(): Array<{id: string; name: string; abs: string}> {
    const plugin = (window as any).syfePlugin;
    if (!plugin) return [];
    const tasks = parseLanSyncTasks(plugin.config?.lanSyncTasks);
    return tasks.map(t => ({
        id: t.id,
        name: t.name || t.id,
        abs: resolveRootAbs(t.localRoot),
    }));
}

function json(res: any, code: number, data: any): void {
    const body = JSON.stringify(data);
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, x-lansync-token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(body);
}

function readBody(req: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_FILE_BYTES * 4 / 3 + 1024 * 1024) {
                reject(new Error("请求体过大"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// 递归收集 {rel: {size, mtimeMs}};跳过符号链接;上限 MAX_SCAN_FILES
function walkFiles(f: any, pathMod: any, abs: string, rel: string, out: Record<string, {size: number; mtimeMs: number}>): void {
    if (Object.keys(out).length >= MAX_SCAN_FILES) return;
    let entries: any[];
    try {
        entries = f.readdirSync(abs, {withFileTypes: true});
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const childAbs = pathMod.join(abs, e.name);
        const childRel = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) {
            walkFiles(f, pathMod, childAbs, childRel, out);
            if (Object.keys(out).length >= MAX_SCAN_FILES) return;
        } else if (e.isFile()) {
            try {
                const st = f.statSync(childAbs);
                out[childRel] = {size: st.size, mtimeMs: st.mtimeMs};
            } catch { /* 单文件失败忽略 */ }
        }
    }
}

function ensureParentDirs(f: any, pathMod: any, absFile: string): void {
    const dir = pathMod.dirname(absFile);
    f.mkdirSync(dir, {recursive: true});
}

async function handleRequest(plugin: Plugin, req: any, res: any): Promise<void> {
    const url = String(req.url || "");
    const pathname = url.split("?")[0];
    const query = new URLSearchParams(url.split("?")[1] || "");
    const token = String(req.headers["x-lansync-token"] || "");
    if (!serverToken || token !== serverToken) {
        json(res, 401, {error: "令牌不匹配"});
        return;
    }
    const roots = serverRoots();
    const findRoot = (id: string) => {
        const t = roots.find(r => r.id === id);
        return t ? t.abs : null;
    };

    // 设备隧道:rootId 命中某个 agent 注册的根时,请求整条转发给该 agent 执行
    // (移动端没有 Node,用内核 API 在隧道另一端执行,结果形状与本地实现一致)
    const tryAgentRoute = async (op: string, rootId: string, args: Record<string, unknown>): Promise<boolean> => {
        const agent = findAgentForRoot(rootId);
        if (!agent) return false;
        try {
            const result = await forwardToAgent(agent, {op, rootId, ...args});
            json(res, 200, result);
        } catch (e) {
            json(res, 502, {error: `设备隧道失败: ${(e as Error)?.message || e}`});
        }
        return true;
    };

    if (req.method === "OPTIONS") {
        json(res, 200, {ok: true});
        return;
    }

    if (pathname === "/api/lan-sync/ping" && req.method === "GET") {
        json(res, 200, {
            device: "SiYuan",
            // 本地任务根 + 各 agent 设备上报的根(移动端经隧道接入)
            roots: [...roots.map(r => ({id: r.id, name: r.name})), ...agentRootsAll()],
        });
        return;
    }
    if (pathname === "/api/lan-sync/list" && req.method === "GET") {
        if (await tryAgentRoute("list", query.get("rootId") || "", {})) return;
        const abs = findRoot(query.get("rootId") || "");
        if (!abs) {
            json(res, 404, {error: "共享根不存在(对端可能没有同名任务)"});
            return;
        }
        const nreq = reqNode();
        const f = nreq("fs");
        const pathMod = nreq("path");
        const files: Record<string, {size: number; mtimeMs: number}> = {};
        walkFiles(f, pathMod, abs, "", files);
        json(res, 200, {files});
        return;
    }
    if (pathname === "/api/lan-sync/read" && req.method === "GET") {
        if (await tryAgentRoute("read", query.get("rootId") || "", {rel: query.get("path") || ""})) return;
        const abs = findRoot(query.get("rootId") || "");
        const rel = query.get("path") || "";
        if (!abs || !rel || rel.includes("..")) {
            json(res, 400, {error: "参数无效"});
            return;
        }
        try {
            const nreq = reqNode();
            const f = nreq("fs");
            const pathMod = nreq("path");
            const full = pathMod.join(abs, rel);
            const st = f.statSync(full);
            if (st.size > MAX_FILE_BYTES) {
                json(res, 413, {error: `文件超过 ${MAX_FILE_BYTES} 字节上限`});
                return;
            }
            const data = f.readFileSync(full);
            const st2 = f.statSync(full);
            json(res, 200, {data: data.toString("base64"), mtimeMs: st2.mtimeMs, size: st2.size});
        } catch (e) {
            json(res, 500, {error: String((e as Error)?.message || e)});
        }
        return;
    }
    if (pathname === "/api/lan-sync/write" && req.method === "POST") {
        try {
            const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            if (await tryAgentRoute("write", String(body.rootId || ""), {
                rel: String(body.path || ""),
                dataBase64: String(body.data || ""),
                mtimeMs: Number(body.mtimeMs) || 0,
            })) return;
            const abs = findRoot(String(body.rootId || ""));
            const rel = String(body.path || "");
            if (!abs || !rel || rel.includes("..")) {
                json(res, 400, {error: "参数无效"});
                return;
            }
            const nreq = reqNode();
            const f = nreq("fs");
            const pathMod = nreq("path");
            const full = pathMod.join(abs, rel);
            ensureParentDirs(f, pathMod, full);
            const buf = Buffer.from(String(body.data || ""), "base64");
            f.writeFileSync(full, buf);
            // 对齐对端的 mtime,后续三方比对的基线才有稳定参照
            const mtimeMs = Number(body.mtimeMs);
            if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
                try {
                    f.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
                } catch { /* utimes 失败不影响写入 */ }
            }
            const st = f.statSync(full);
            json(res, 200, {ok: true, size: st.size, mtimeMs: st.mtimeMs});
        } catch (e) {
            json(res, 500, {error: String((e as Error)?.message || e)});
        }
        return;
    }
    if (pathname === "/api/lan-sync/delete" && req.method === "POST") {
        try {
            const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            if (await tryAgentRoute("delete", String(body.rootId || ""), {rel: String(body.path || "")})) return;
            const abs = findRoot(String(body.rootId || ""));
            const rel = String(body.path || "");
            if (!abs || !rel || rel.includes("..")) {
                json(res, 400, {error: "参数无效"});
                return;
            }
            const nreq = reqNode();
            const f = nreq("fs");
            const pathMod = nreq("path");
            const full = pathMod.join(abs, rel);
            f.unlinkSync(full);
            json(res, 200, {ok: true});
        } catch (e) {
            json(res, 500, {error: String((e as Error)?.message || e)});
        }
        return;
    }
    json(res, 404, {error: "未知端点"});
}

// 启动服务端(幂等:已运行先停再起)。失败抛错(端口占用等),调用方提示。
export async function startLanSyncServer(plugin: PluginWithConfig): Promise<void> {
    if (!isNativeFsAvailable()) {
        throw new Error("局域网同步需要思源桌面端");
    }
    stopLanSyncServer();
    const nreq = reqNode();
    const http = nreq("http");
    const port = Number(plugin.config?.lanSyncPort) || 39099;
    // 令牌:空则自动生成一次并落盘
    let token = String(plugin.config?.lanSyncToken || "");
    if (!token) {
        token = "lst" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        plugin.config.lanSyncToken = token;
        const {saveConfig} = await import("../utils/config");
        await saveConfig(plugin, plugin.config);
    }
    serverToken = token;
    server = http.createServer((req: any, res: any) => {
        void handleRequest(plugin, req, res).catch(e => {
            try {
                json(res, 500, {error: String((e as Error)?.message || e)});
            } catch { /* 响应已发出 */ }
        });
    });
    // 设备隧道:agent(移动端等跑不了服务端的端)经 WebSocket 升级接入
    server.on("upgrade", (req: any, socket: any) => {
        handleAgentUpgrade(req, socket, serverToken);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", (e: any) => reject(new Error(`端口 ${port} 监听失败: ${e?.message || e}`)));
        server.listen(port, "0.0.0.0", () => resolve());
    });
    serverPort = port;
}

export function stopLanSyncServer(): void {
    if (server) {
        try {
            server.close();
        } catch { /* 忽略 */ }
        server = null;
    }
    serverPort = 0;
    serverToken = "";
}

export function isLanSyncServerRunning(): boolean {
    return server !== null && serverPort > 0;
}

// ===== 客户端(对端 HTTP 调用) =====

function remoteHeaders(task: LanSyncTask): Record<string, string> {
    return {"x-lansync-token": task.remoteToken || (window as any).syfePlugin?.config?.lanSyncToken || ""};
}

function remoteUrl(task: LanSyncTask, pathQuery: string): string {
    const base = (task.remoteUrl || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) return "http://" + base + pathQuery;
    return base + pathQuery;
}

// 客户端请求走 localHttp:桌面端 Node http 直连;移动端/浏览器端经思源内核代理
// (/api/network/proxy 或旧版 /api/fetch/proxy),绕过跨域与 mixed-content 限制。
// 大文件同步耗时,超时放宽到 120s。
async function remoteJson(task: LanSyncTask, pathQuery: string, method: "GET" | "POST", body?: string): Promise<any> {
    const headers = remoteHeaders(task);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await localHttp(remoteUrl(task, pathQuery), method, headers, body ?? null, 120000);
    const text = new TextDecoder("utf-8").decode(new Uint8Array(resp.bytes));
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        // 非 JSON 响应按空处理,下面的 status 检查给出错误
    }
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(data?.error || `请求失败: HTTP ${resp.status}`);
    }
    return data;
}

export interface LanPingResult {
    device: string;
    roots: Array<{id: string; name: string}>;
}

export async function lanPing(task: LanSyncTask): Promise<LanPingResult> {
    return await remoteJson(task, "/api/lan-sync/ping", "GET") as LanPingResult;
}

async function lanList(task: LanSyncTask): Promise<Record<string, {size: number; mtimeMs: number}>> {
    const data = await remoteJson(task, `/api/lan-sync/list?rootId=${encodeURIComponent(task.remoteRootId)}`, "GET");
    return data?.files || {};
}

async function lanRead(task: LanSyncTask, rel: string): Promise<{data: string; mtimeMs: number; size: number}> {
    return await remoteJson(task, `/api/lan-sync/read?rootId=${encodeURIComponent(task.remoteRootId)}&path=${encodeURIComponent(rel)}`, "GET");
}

async function lanWrite(task: LanSyncTask, rel: string, dataBase64: string, mtimeMs: number): Promise<{size: number; mtimeMs: number}> {
    const body = await remoteJson(task, "/api/lan-sync/write", "POST", JSON.stringify({rootId: task.remoteRootId, path: rel, data: dataBase64, mtimeMs}));
    // 服务端 utimes 后回读的真实值;agent 隧道同形状
    return {size: Number(body?.size) || 0, mtimeMs: Number(body?.mtimeMs) || 0};
}

async function lanDelete(task: LanSyncTask, rel: string): Promise<void> {
    await remoteJson(task, "/api/lan-sync/delete", "POST", JSON.stringify({rootId: task.remoteRootId, path: rel}));
}

// ===== 本地文件访问(双后端) =====
//
// 桌面端 → 原生 fs(任意路径,/data/... 先转系统绝对路径);
// 移动端/无 Node 环境 → 思源内核 API(**必须** /data/... 内核路径):
//   扫描 = /api/file/readDir 递归(updated 是秒级时间戳 → ×1000)
//   读   = /api/file/getFile
//   写   = /api/file/putFile(multipart,modTime 参数实测会把文件 mtime 设成传入值,
//          与桌面端 utimesSync 行为对齐 —— pull 后的基线两侧语义一致)

export interface FileMeta {
    size: number;
    mtimeMs: number;
}

interface SyncFs {
    scan(root: string): Promise<Record<string, FileMeta>>;
    read(root: string, rel: string): Promise<{dataBase64: string; size: number}>;
    write(root: string, rel: string, dataBase64: string, mtimeMs: number): Promise<void>;
    /** 单文件状态(pull 后取真实 mtime 记基线;拿不到返回 null) */
    stat(root: string, rel: string): Promise<FileMeta | null>;
}

function metaOf(rel: string, e: {size: number; mtimeMs: number}): FileMeta | null {
    if (isKernelInternalRel(rel)) return null; // 内核内部目录不同步
    return e;
}

const nativeSyncFs: SyncFs = {
    async scan(root: string): Promise<Record<string, FileMeta>> {
        const nreq = reqNode();
        const f = nreq("fs");
        const pathMod = nreq("path");
        const files: Record<string, {size: number; mtimeMs: number}> = {};
        walkFiles(f, pathMod, root, "", files);
        const out: Record<string, FileMeta> = {};
        for (const [rel, meta] of Object.entries(files)) {
            const m = metaOf(rel, meta);
            if (m) out[rel] = m;
        }
        return out;
    },
    async read(root: string, rel: string): Promise<{dataBase64: string; size: number}> {
        const nreq = reqNode();
        const f = nreq("fs");
        const pathMod = nreq("path");
        const full = pathMod.join(root, rel);
        const st = f.statSync(full);
        const buf = f.readFileSync(full);
        return {dataBase64: buf.toString("base64"), size: st.size};
    },
    async write(root: string, rel: string, dataBase64: string, mtimeMs: number): Promise<void> {
        const nreq = reqNode();
        const f = nreq("fs");
        const pathMod = nreq("path");
        const full = pathMod.join(root, rel);
        ensureParentDirs(f, pathMod, full);
        f.writeFileSync(full, Buffer.from(dataBase64, "base64"));
        if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
            try {
                f.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
            } catch { /* 忽略 */ }
        }
    },
    async stat(root: string, rel: string): Promise<FileMeta | null> {
        try {
            const nreq = reqNode();
            const f = nreq("fs");
            const pathMod = nreq("path");
            const st = f.statSync(pathMod.join(root, rel));
            return {size: st.size, mtimeMs: st.mtimeMs};
        } catch {
            return null;
        }
    },
};

// ArrayBuffer/Uint8Array ⇄ base64(浏览器环境,分块防栈溢出)
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
    }
    return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    // 显式以 ArrayBuffer 为底(TS 5.7 的 BlobPart 类型要求,见 api/file.ts writeBinaryFile 同款处理)
    const buf = new ArrayBuffer(bin.length);
    const out = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// 内核路径 → 移动端安全写:逐级建父目录(putFile isDir 幂等,已存在报错也忽略)
async function kernelEnsureDirs(root: string, rel: string): Promise<void> {
    const segs = rel.split("/").slice(0, -1).filter(Boolean);
    let cur = root.replace(/\/+$/, "");
    for (const seg of segs) {
        cur = cur + "/" + seg;
        try {
            const fd = new FormData();
            fd.append("path", cur);
            fd.append("isDir", "true");
            const w = window as any;
            const token = w?.siyuan?.config?.api?.token || w?.siyuan?.config?.system?.conf?.api?.token;
            const resp = await fetch("/api/file/putFile", {
                method: "POST",
                headers: token ? {Authorization: `Token ${token}`} : {},
                body: fd,
            });
            // 已存在等非零 code 一律忽略
            void resp;
        } catch {
            // 忽略,真正写入时失败会抛错
        }
    }
}

// agent 设备隧道执行器:把隧道请求落到本机内核 API。rootId 形如 "agent:<deviceId>:<taskId>",
// 去前缀后按本机任务解析(本机任务通过 agent 注册为共享根)。结果形状与 server 各端点一致,
// 对发起同步的客户端透明。
export async function executeAgentOp(op: string, rootId: string, args: any): Promise<any> {
    const plugin = (window as any).syfePlugin;
    const taskId = String(rootId).replace(/^agent:[^:]*:/, "");
    const task = parseLanSyncTasks(plugin?.config?.lanSyncTasks).find(t => t.id === taskId);
    if (!task) throw new Error(`本机没有可共享的任务「${taskId}」(agent 只暴露本机同步任务)`);
    if (op === "list") {
        return {files: await kernelSyncFs.scan(task.localRoot)};
    }
    const rel = String(args?.rel || "");
    if (!rel || rel.includes("..")) throw new Error("参数无效");
    if (op === "read") {
        const buf = await kernelSyncFs.read(task.localRoot, rel);
        const st = await kernelSyncFs.stat(task.localRoot, rel);
        return {data: buf.dataBase64, size: buf.size, mtimeMs: st?.mtimeMs || 0};
    }
    if (op === "write") {
        await kernelSyncFs.write(task.localRoot, rel, String(args.dataBase64 || ""), Number(args.mtimeMs) || 0);
        const st = await kernelSyncFs.stat(task.localRoot, rel);
        return {ok: true, size: st?.size || 0, mtimeMs: st?.mtimeMs || 0};
    }
    if (op === "delete") {
        await removeFile(joinPath(task.localRoot, rel));
        return {ok: true};
    }
    throw new Error(`未知操作: ${op}`);
}

// 本机任务 → agent 共享根(rootId 加 agent 前缀;deviceId 在 agent 启动时生成并持久化)
export function agentOwnRoots(deviceId: string): Array<{id: string; name: string}> {
    const plugin = (window as any).syfePlugin;
    return parseLanSyncTasks(plugin?.config?.lanSyncTasks).map(t => ({
        id: `agent:${deviceId}:${t.id}`,
        name: t.name || t.id,
    }));
}

const kernelSyncFs: SyncFs = {    async scan(root: string): Promise<Record<string, FileMeta>> {
        const out: Record<string, FileMeta> = {};
        let count = 0;
        const walk = async (dir: string, rel: string): Promise<void> => {
            if (count >= MAX_SCAN_FILES) return;
            let entries: DirEntry[];
            try {
                entries = (await readDir(dir)) as DirEntry[];
            } catch {
                return;
            }
            for (const e of entries || []) {
                if ((e as any).isSymlink) continue;
                const childRel = rel ? rel + "/" + e.name : e.name;
                if (isKernelInternalRel(childRel)) continue;
                if (e.isDir) {
                    await walk(joinPath(dir, e.name), childRel);
                    if (count >= MAX_SCAN_FILES) return;
                } else {
                    count++;
                    const updated = Number((e as any).updated);
                    out[childRel] = {
                        size: Number(e.size) || 0,
                        mtimeMs: Number.isFinite(updated) && updated > 0 ? updated * 1000 : 0,
                    };
                }
            }
        };
        await walk(root, "");
        return out;
    },
    async read(root: string, rel: string): Promise<{dataBase64: string; size: number}> {
        const buf = new Uint8Array(await readBinaryFile(joinPath(root, rel)));
        return {dataBase64: bytesToBase64(buf), size: buf.length};
    },
    async write(root: string, rel: string, dataBase64: string, mtimeMs: number): Promise<void> {
        await kernelEnsureDirs(root, rel);
        const fd = new FormData();
        fd.append("path", joinPath(root, rel));
        fd.append("modTime", String(Math.round(Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : Date.now())));
        fd.append("file", new Blob([base64ToBytes(dataBase64)]), "file");
        const w = window as any;
        const token = w?.siyuan?.config?.api?.token || w?.siyuan?.config?.system?.conf?.api?.token;
        const resp = await fetch("/api/file/putFile", {
            method: "POST",
            headers: token ? {Authorization: `Token ${token}`} : {}, // 不设 Content-Type,让浏览器自动加 boundary
            body: fd,
        });
        if (!resp.ok) throw new Error(`写入文件失败: ${rel} (HTTP ${resp.status})`);
        const json = await resp.json();
        if (json.code !== 0) throw new Error(json.msg || `写入文件失败: ${rel}`);
    },
    async stat(root: string, rel: string): Promise<FileMeta | null> {
        try {
            const parent = rel.includes("/") ? joinPath(root, rel.slice(0, rel.lastIndexOf("/"))) : root;
            const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
            const entries = (await readDir(parent)) as DirEntry[];
            const hit = (entries || []).find(e => e.name === name && !e.isDir);
            if (!hit) return null;
            const updated = Number((hit as any).updated);
            return {
                size: Number(hit.size) || 0,
                mtimeMs: Number.isFinite(updated) && updated > 0 ? updated * 1000 : 0,
            };
        } catch {
            return null;
        }
    },
};

// 选后端:桌面端优先原生(任意路径);移动端强制内核后端且要求 /data/... 内核路径
// (OneDrive 同步等外部引擎复用)
export function pickSyncFs(task: {localRoot: string}): {fs: SyncFs; root: string} {
    if (isNativeFsAvailable() && !isMobileFrontend()) {
        return {fs: nativeSyncFs, root: resolveRootAbs(task.localRoot)};
    }
    if (isKernelPath(task.localRoot)) {
        return {fs: kernelSyncFs, root: task.localRoot};
    }
    throw new Error("移动端同步目录必须是工作空间内的内核路径(以 /data/ 开头)");
}

// ===== 基线快照(跨窗口共享,存插件存储) =====

interface BaselineEntry {
    size: number;
    localMtime: number;
    remoteSize: number;
    remoteMtime: number;
}

type BaselineStore = Record<string, Record<string, BaselineEntry>>; // taskId → rel → entry
const BASELINE_KEY = "lan-sync-baseline.json";

async function loadBaseline(plugin: Plugin): Promise<BaselineStore> {
    try {
        const data = await plugin.loadData(BASELINE_KEY);
        return data && typeof data === "object" ? data as BaselineStore : {};
    } catch {
        return {};
    }
}

async function saveBaseline(plugin: Plugin, store: BaselineStore): Promise<void> {
    try {
        await plugin.saveData(BASELINE_KEY, store);
    } catch (e) {
        console.error("[siyuan-file-editor] 保存局域网同步基线失败:", e);
    }
}

// ===== 同步执行 =====

export interface LanSyncProgress {
    (msg: string): void;
}

// 预览差异:不做任何写入,只算报告
export async function previewLanSyncTask(plugin: PluginWithConfig, task: LanSyncTask, onProgress?: LanSyncProgress): Promise<LanSyncReport> {
    return runLanSyncTask(plugin, task, true, onProgress);
}

// ===== 通用三方同步引擎(LAN 与 OneDrive 同步共用) =====
//
// 远端访问抽象:LAN(HTTP 对端/agent 隧道)与 OneDrive(Graph API)各提供一个实现,
// 三方比对/删除语义/冲突策略完全共用。
export interface RemoteFs {
    /** 递归文件清单 {rel: {size, mtimeMs}} */
    list(): Promise<Record<string, FileMeta>>;
    read(rel: string): Promise<{dataBase64: string; size: number; mtimeMs: number}>;
    /** 写入;返回远端**真实** size/mtime(OneDrive 是服务端时间,LAN 是 utimes 后的值) */
    write(rel: string, dataBase64: string, mtimeMs: number): Promise<{size: number; mtimeMs: number}>;
    remove(rel: string): Promise<void>;
}

export interface ThreeWaySyncOptions {
    taskId: string;             // 基线 store 的 key(LAN 任务与 OneDrive 任务共存,各自全局唯一 id)
    localRoot: string;
    localFs: SyncFs;
    remote: RemoteFs;
    direction: "both" | "push" | "pull";
    rules: {includeRules: string; excludeRules: string};
    preview?: boolean;
    onProgress?: LanSyncProgress;
}

// 单文件传输上限:桌面 50MB / 移动端 20MB(移动端 base64 中转的内存峰值约 3×文件大小)
export function syncMaxFileBytes(): number {
    return isMobileFrontend() ? 20 * 1024 * 1024 : MAX_FILE_BYTES;
}

// 删除语义(EasySync automatic-handling-policy 对齐,刻意不对称的安全边界):
//   本地已删、远端还在(基线证明上次两侧都有) → 提交远端删除(用户亲手删的,可传播)
//   远端已删、本地还在 → **绝不自动删本地**;只报告保留观察;若本地相对基线已改
//     (用户在远端删除后继续编辑了本地)→ 推送本地新版本重建远端,否则本地编辑永远出不去
//   无基线一侧独有 → 当作该侧新文件(首次同步语义)
export async function runThreeWaySync(plugin: PluginWithConfig, opts: ThreeWaySyncOptions): Promise<LanSyncReport> {
    const report = emptyLanSyncReport();
    const {taskId, localRoot, localFs, remote, direction, rules, preview = false, onProgress} = opts;
    const cap = syncMaxFileBytes();
    const pushable = direction !== "pull";
    const pullable = direction !== "push";

    onProgress?.("扫描本地与远端...");
    const allLocal = await localFs.scan(localRoot);
    const allRemote = await remote.list();
    // 任务规则只作用于**同步范围**(双方都按同一套规则过滤,范围不一致的一侧条目按"另一侧不存在"处理)
    const local: Record<string, FileMeta> = {};
    for (const [rel, st] of Object.entries(allLocal)) {
        if (relPathAllowed(rules, rel)) local[rel] = st;
    }
    const remoteMap: Record<string, FileMeta> = {};
    for (const [rel, st] of Object.entries(allRemote)) {
        if (relPathAllowed(rules, rel)) remoteMap[rel] = st;
    }

    onProgress?.("比对差异...");
    const baselineAll = await loadBaseline(plugin);
    const baseline: Record<string, BaselineEntry> = baselineAll[taskId] || {};
    const newBaseline: Record<string, BaselineEntry> = {};
    const rels = Array.from(new Set([...Object.keys(local), ...Object.keys(remoteMap), ...Object.keys(baseline)]));

    // 推送(本地读→远端写→按远端真实 mtime/size 记基线)
    const doPush = async (rel: string, meta: FileMeta): Promise<void> => {
        const buf = await localFs.read(localRoot, rel);
        const wr = await remote.write(rel, buf.dataBase64, meta.mtimeMs);
        report.pushed.push(rel);
        newBaseline[rel] = {
            size: meta.size,
            localMtime: meta.mtimeMs,
            remoteSize: wr?.size && wr.size > 0 ? wr.size : meta.size,
            remoteMtime: wr?.mtimeMs && wr.mtimeMs > 0 ? wr.mtimeMs : meta.mtimeMs,
        };
    };
    // 拉取(远端读→本地写 modTime 对齐→**stat 回读校验落地**,size 不符视为失败不记基线)
    const doPull = async (rel: string, rmeta: FileMeta): Promise<void> => {
        const buf = await remote.read(rel);
        await localFs.write(localRoot, rel, buf.dataBase64, buf.mtimeMs || rmeta.mtimeMs);
        const st = await localFs.stat(localRoot, rel);
        if (!st || (rmeta.size > 0 && st.size !== rmeta.size)) {
            throw new Error(`写入后校验失败(期望 ${rmeta.size} 字节,实际 ${st ? st.size : "无"})`);
        }
        report.pulled.push(rel);
        newBaseline[rel] = {size: rmeta.size, localMtime: st.mtimeMs, remoteSize: rmeta.size, remoteMtime: rmeta.mtimeMs};
    };

    for (const rel of rels) {
        const l = local[rel];
        const r = remoteMap[rel];
        const b = baseline[rel];
        if (l && !r) {
            if (b) {
                // 远端已删、本地还在:本地已改 → 推送重建远端;未改 → 只报告保留基线
                const localChanged = l.size !== b.size || l.mtimeMs !== b.localMtime;
                if (localChanged && pushable) {
                    if (l.size > cap) {
                        report.skipped.push(`${rel}(超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB)`);
                        newBaseline[rel] = b;
                        continue;
                    }
                    if (!preview) {
                        try {
                            await doPush(rel, l);
                        } catch (e) {
                            report.skipped.push(`${rel}(推送失败: ${(e as Error)?.message || e})`);
                            newBaseline[rel] = b;
                        }
                    } else {
                        report.pushed.push(rel);
                        newBaseline[rel] = b;
                    }
                } else {
                    report.remoteDeleted.push(rel);
                    newBaseline[rel] = b;
                }
            } else if (pushable) {
                // 本地新文件 → 推送
                if (l.size > cap) {
                    report.skipped.push(`${rel}(超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB)`);
                    continue;
                }
                if (!preview) {
                    try {
                        await doPush(rel, l);
                    } catch (e) {
                        report.skipped.push(`${rel}(推送失败: ${(e as Error)?.message || e})`);
                    }
                } else {
                    report.pushed.push(rel);
                }
            } else {
                // pull-only:本地多出来的文件不动,保持现状
                newBaseline[rel] = {size: l.size, localMtime: l.mtimeMs, remoteSize: 0, remoteMtime: 0};
            }
            continue;
        }
        if (!l && r) {
            if (b) {
                // 本地已删、远端还在 → 提交远端删除(基线不再保留该条目,删除定案)
                if (pushable) {
                    if (!preview) {
                        try {
                            await remote.remove(rel);
                            report.deletedRemote.push(rel);
                        } catch (e) {
                            report.skipped.push(`${rel}(删除远端失败: ${(e as Error)?.message || e})`);
                            newBaseline[rel] = b;
                        }
                    } else {
                        report.deletedRemote.push(rel);
                        newBaseline[rel] = b;
                    }
                } else {
                    // pull-only 不允许传播删除:报告方向限制,保留基线
                    report.skipped.push(`${rel}(本地已删除,但方向为仅拉取,无法提交远端删除)`);
                    newBaseline[rel] = b;
                }
            } else if (pullable) {
                // 远端新文件 → 拉取
                if (r.size > cap) {
                    report.skipped.push(`${rel}(超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB)`);
                    continue;
                }
                if (!preview) {
                    try {
                        await doPull(rel, r);
                    } catch (e) {
                        report.skipped.push(`${rel}(拉取失败: ${(e as Error)?.message || e})`);
                    }
                } else {
                    report.pulled.push(rel);
                }
            } else {
                newBaseline[rel] = {size: 0, localMtime: 0, remoteSize: r.size, remoteMtime: r.mtimeMs};
            }
            continue;
        }
        // 两侧都有:与基线三方比对
        const localChanged = !b || l.size !== b.size || l.mtimeMs !== b.localMtime;
        const remoteChanged = !b || r.size !== b.remoteSize || r.mtimeMs !== b.remoteMtime;
        if (!localChanged && !remoteChanged) {
            newBaseline[rel] = b!;
            continue;
        }
        if (localChanged && !remoteChanged && pushable) {
            if (l.size > cap) {
                report.skipped.push(`${rel}(超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB)`);
                continue;
            }
            if (!preview) {
                try {
                    await doPush(rel, l);
                } catch (e) {
                    report.skipped.push(`${rel}(推送失败: ${(e as Error)?.message || e})`);
                    newBaseline[rel] = b || {size: l.size, localMtime: l.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
                }
            } else {
                report.pushed.push(rel);
                newBaseline[rel] = b || {size: l.size, localMtime: l.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
            }
            continue;
        }
        if (!localChanged && remoteChanged && pullable) {
            if (r.size > cap) {
                report.skipped.push(`${rel}(超过上限 ${(cap / 1024 / 1024).toFixed(0)}MB)`);
                continue;
            }
            if (!preview) {
                try {
                    await doPull(rel, r);
                } catch (e) {
                    report.skipped.push(`${rel}(拉取失败: ${(e as Error)?.message || e})`);
                    newBaseline[rel] = b || {size: l.size, localMtime: l.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
                }
            } else {
                report.pulled.push(rel);
                newBaseline[rel] = b || {size: l.size, localMtime: l.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
            }
            continue;
        }
        // 两侧都改(或改的一侧不允许该方向)→ 冲突跳过
        report.conflicts.push(rel);
        newBaseline[rel] = b || {size: l!.size, localMtime: l!.mtimeMs, remoteSize: r!.size, remoteMtime: r!.mtimeMs};
    }

    if (!preview) {
        baselineAll[taskId] = newBaseline;
        await saveBaseline(plugin, baselineAll);
    }
    return report;
}

// LAN 远端实现:HTTP 对端直连/内核代理/agent 隧道请求(写入返回远端 utimes 后的真实值)
function lanRemoteFs(task: LanSyncTask): RemoteFs {
    return {
        list: () => lanList(task),
        read: async (rel) => {
            const rd = await lanRead(task, rel);
            return {dataBase64: rd.data, size: rd.size, mtimeMs: rd.mtimeMs};
        },
        write: async (rel, dataBase64, mtimeMs) => await lanWrite(task, rel, dataBase64, mtimeMs),
        remove: (rel) => lanDelete(task, rel),
    };
}

export async function runLanSyncTask(plugin: PluginWithConfig, task: LanSyncTask, preview = false, onProgress?: LanSyncProgress): Promise<LanSyncReport> {
    const {fs: localFs, root: localRoot} = pickSyncFs(task);

    onProgress?.("连接对端...");
    const ping = await lanPing(task);
    if (!ping.roots.some(r => r.id === task.remoteRootId)) {
        throw new Error(`对端没有共享根「${task.remoteRootId}」(对端需建同名 id 的任务)`);
    }

    return await runThreeWaySync(plugin, {
        taskId: task.id,
        localRoot,
        localFs,
        remote: lanRemoteFs(task),
        direction: task.direction,
        rules: task,
        preview,
        onProgress,
    });
}

// 报告 → 可展示文本(空类别不显示)
export function formatLanSyncReport(report: LanSyncReport): string {
    const lines: string[] = [];
    const push = (label: string, list: string[]) => {
        if (list.length === 0) return;
        lines.push(`${label}(${list.length}):`);
        for (const it of list.slice(0, 50)) lines.push("  " + it);
        if (list.length > 50) lines.push(`  … 共 ${list.length} 条`);
    };
    push("推送对端", report.pushed);
    push("拉取本地", report.pulled);
    push("已提交对端删除", report.deletedRemote);
    push("对端已删除(本地保留)", report.remoteDeleted);
    push("冲突跳过", report.conflicts);
    push("其他跳过", report.skipped);
    if (lines.length === 0) lines.push("两侧已一致,无需同步");
    return lines.join("\n");
}
