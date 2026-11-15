// 局域网同步文件(仅桌面端):两台设备各跑一份思源 + 本插件,互为服务端/客户端,
// 把选定的目录按白/黑名单正则双向同步。
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

// Plugin 泛型上没有 config 字段(插件实例才有),统一收窄
type PluginWithConfig = Plugin & {config: any};

// Node 模块取用(getNativeRequire 可能为 null,统一抛可读错误)
function reqNode(): any {
    const req = getNativeRequire();
    if (!req) throw new Error("Node 集成不可用(需要思源桌面端)");
    return req;
}

// 单文件传输上限:超限跳过(局域网 JSON base64 传输,体积敏感)
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// 目录递归扫描的文件数上限(防失控)
const MAX_SCAN_FILES = 20000;

export interface LanSyncTask {
    id: string;             // 本机唯一;服务端把每个任务的 localRoot 作为共享根按 id 暴露
    name: string;
    localRoot: string;      // 本端目录(内核路径 /data/... 或系统绝对路径)
    remoteUrl: string;      // 对端 http://host:port
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
export function relPathAllowed(task: LanSyncTask, rel: string): boolean {
    const norm = rel.replace(/\\/g, "/");
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

    if (req.method === "OPTIONS") {
        json(res, 200, {ok: true});
        return;
    }

    if (pathname === "/api/lan-sync/ping" && req.method === "GET") {
        json(res, 200, {
            device: "SiYuan",
            roots: roots.map(r => ({id: r.id, name: r.name})),
        });
        return;
    }
    if (pathname === "/api/lan-sync/list" && req.method === "GET") {
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
    const base = (task.remoteUrl || "").replace(/\/+$/, "");
    return base + pathQuery;
}

export interface LanPingResult {
    device: string;
    roots: Array<{id: string; name: string}>;
}

export async function lanPing(task: LanSyncTask): Promise<LanPingResult> {
    const resp = await fetch(remoteUrl(task, "/api/lan-sync/ping"), {headers: remoteHeaders(task)});
    if (!resp.ok) throw new Error(`ping 失败: HTTP ${resp.status}`);
    return await resp.json() as LanPingResult;
}

async function lanList(task: LanSyncTask): Promise<Record<string, {size: number; mtimeMs: number}>> {
    const resp = await fetch(remoteUrl(task, `/api/lan-sync/list?rootId=${encodeURIComponent(task.remoteRootId)}`), {headers: remoteHeaders(task)});
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || `list 失败: HTTP ${resp.status}`);
    return data.files || {};
}

async function lanRead(task: LanSyncTask, rel: string): Promise<{data: string; mtimeMs: number; size: number}> {
    const resp = await fetch(remoteUrl(task, `/api/lan-sync/read?rootId=${encodeURIComponent(task.remoteRootId)}&path=${encodeURIComponent(rel)}`), {headers: remoteHeaders(task)});
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.error || `read 失败: HTTP ${resp.status}`);
    return body;
}

async function lanWrite(task: LanSyncTask, rel: string, dataBase64: string, mtimeMs: number): Promise<void> {
    const resp = await fetch(remoteUrl(task, "/api/lan-sync/write"), {
        method: "POST",
        headers: {...remoteHeaders(task), "Content-Type": "application/json"},
        body: JSON.stringify({rootId: task.remoteRootId, path: rel, data: dataBase64, mtimeMs}),
    });
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.error || `write 失败: HTTP ${resp.status}`);
}

async function lanDelete(task: LanSyncTask, rel: string): Promise<void> {
    const resp = await fetch(remoteUrl(task, "/api/lan-sync/delete"), {
        method: "POST",
        headers: {...remoteHeaders(task), "Content-Type": "application/json"},
        body: JSON.stringify({rootId: task.remoteRootId, path: rel}),
    });
    const body = await resp.json();
    if (!resp.ok) throw new Error(body?.error || `delete 失败: HTTP ${resp.status}`);
}

// ===== 本地扫描与写入(原生 fs,支持 /data/... 内核路径) =====

function scanLocalDir(absRoot: string): Record<string, {size: number; mtimeMs: number}> {
    const nreq = reqNode();
    const f = nreq("fs");
    const pathMod = nreq("path");
    const files: Record<string, {size: number; mtimeMs: number}> = {};
    walkFiles(f, pathMod, absRoot, "", files);
    return files;
}

function localReadBase64(absRoot: string, rel: string): {data: string; mtimeMs: number; size: number} {
    const nreq = reqNode();
    const f = nreq("fs");
    const pathMod = nreq("path");
    const full = pathMod.join(absRoot, rel);
    const st = f.statSync(full);
    const buf = f.readFileSync(full);
    return {data: buf.toString("base64"), mtimeMs: st.mtimeMs, size: st.size};
}

function localWriteBase64(absRoot: string, rel: string, dataBase64: string, mtimeMs: number): void {
    const nreq = reqNode();
    const f = nreq("fs");
    const pathMod = nreq("path");
    const full = pathMod.join(absRoot, rel);
    ensureParentDirs(f, pathMod, full);
    f.writeFileSync(full, Buffer.from(dataBase64, "base64"));
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        try {
            f.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
        } catch { /* 忽略 */ }
    }
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

export async function runLanSyncTask(plugin: PluginWithConfig, task: LanSyncTask, preview = false, onProgress?: LanSyncProgress): Promise<LanSyncReport> {
    if (!isNativeFsAvailable()) throw new Error("局域网同步需要思源桌面端");
    const report = emptyLanSyncReport();
    const ws = getWorkspacePath();
    const localRootAbs = resolveRootAbs(task.localRoot);
    const pushable = task.direction !== "pull";
    const pullable = task.direction !== "push";

    onProgress?.("连接对端...");
    const ping = await lanPing(task);
    if (!ping.roots.some(r => r.id === task.remoteRootId)) {
        throw new Error(`对端没有共享根「${task.remoteRootId}」(对端需建同名 id 的任务)`);
    }

    onProgress?.("扫描本地与对端...");
    const allLocal = scanLocalDir(localRootAbs);
    const allRemote = await lanList(task);
    // 任务规则只作用于**同步范围**(双方都按同一套规则过滤,范围不一致的一侧条目按"另一侧不存在"处理)
    const local: Record<string, {size: number; mtimeMs: number}> = {};
    for (const [rel, st] of Object.entries(allLocal)) {
        if (relPathAllowed(task, rel)) local[rel] = st;
    }
    const remote: Record<string, {size: number; mtimeMs: number}> = {};
    for (const [rel, st] of Object.entries(allRemote)) {
        if (relPathAllowed(task, rel)) remote[rel] = st;
    }

    onProgress?.("比对差异...");
    const baselineAll = await loadBaseline(plugin);
    const baseline: Record<string, BaselineEntry> = baselineAll[task.id] || {};
    const newBaseline: Record<string, BaselineEntry> = {};
    const rels = Array.from(new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline)]));

    for (const rel of rels) {
        const l = local[rel];
        const r = remote[rel];
        const b = baseline[rel];
        if (l && !r) {
            if (b) {
                // 本地删除 → 提交对端删除
                if (pushable && !preview) {
                    try {
                        await lanDelete(task, rel);
                        report.deletedRemote.push(rel);
                    } catch (e) {
                        report.skipped.push(`${rel}(删除对端失败: ${(e as Error)?.message || e})`);
                        newBaseline[rel] = b;
                    }
                } else if (pushable && preview) {
                    report.deletedRemote.push(rel);
                    newBaseline[rel] = b;
                } else {
                    newBaseline[rel] = b;
                }
            } else if (pushable) {
                // 本地新文件 → 推送
                if (l.size > MAX_FILE_BYTES) {
                    report.skipped.push(`${rel}(超过 50MB 上限)`);
                    continue;
                }
                if (!preview) {
                    try {
                        const buf = localReadBase64(localRootAbs, rel);
                        await lanWrite(task, rel, buf.data, buf.mtimeMs);
                        report.pushed.push(rel);
                        newBaseline[rel] = {size: l.size, localMtime: l.mtimeMs, remoteSize: l.size, remoteMtime: buf.mtimeMs};
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
                // 对端删除 → 只报告,不删本地
                report.remoteDeleted.push(rel);
                newBaseline[rel] = b;
            } else if (pullable) {
                // 对端新文件 → 拉取
                if (r.size > MAX_FILE_BYTES) {
                    report.skipped.push(`${rel}(超过 50MB 上限)`);
                    continue;
                }
                if (!preview) {
                    try {
                        const buf = await lanRead(task, rel);
                        localWriteBase64(localRootAbs, rel, buf.data, buf.mtimeMs);
                        report.pulled.push(rel);
                        newBaseline[rel] = {size: r.size, localMtime: buf.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
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
            if (l.size > MAX_FILE_BYTES) {
                report.skipped.push(`${rel}(超过 50MB 上限)`);
                continue;
            }
            if (!preview) {
                try {
                    const buf = localReadBase64(localRootAbs, rel);
                    await lanWrite(task, rel, buf.data, buf.mtimeMs);
                    report.pushed.push(rel);
                    newBaseline[rel] = {size: l.size, localMtime: l.mtimeMs, remoteSize: l.size, remoteMtime: buf.mtimeMs};
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
            if (r.size > MAX_FILE_BYTES) {
                report.skipped.push(`${rel}(超过 50MB 上限)`);
                continue;
            }
            if (!preview) {
                try {
                    const buf = await lanRead(task, rel);
                    localWriteBase64(localRootAbs, rel, buf.data, buf.mtimeMs);
                    report.pulled.push(rel);
                    newBaseline[rel] = {size: r.size, localMtime: buf.mtimeMs, remoteSize: r.size, remoteMtime: r.mtimeMs};
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
        baselineAll[task.id] = newBaseline;
        await saveBaseline(plugin, baselineAll);
    }
    return report;
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
