// 双链(wikilink)核心工具层:
//   - 文件名索引:递归全部挂载根收集所有文件(含图片/音视频/office,双链可指向
//     任何文件),建立 文件名 → 路径 两级映射(含扩展名 / 去扩展名),TTL 缓存
//   - [[短链]] 解析:[[名字]] 按索引全库解析;含路径分隔符的仍按相对/绝对路径解析
//   - 行内链接检测:一行文本 + 光标列 → 命中的链接(Monaco/CM6 点击跳转共用)
//   - 编辑器内打开链接:解析 → 定位(行/锚点/时间)→ openFileTab 按扩展名分发
//   - wikilink 构建:插入与「复制 wikilink」菜单用,短名唯一时生成 [[名]]
//
// 与 backlink.ts 的分层:这里放「链接语义」(正则/解析/索引/构建),backlink.ts
// 放「扫描与查询」(思源 SQL + 文件扫描 + 缓存);依赖方向 backlink → wikilink,
// 不回环。openFileTab 只在点击时调用(与 backlink-panel ↔ markdown-tab 同款
// 运行时循环引用,webpack 下安全)。
import {showMessage} from "siyuan";
import {readDir} from "../api/file";
import {DirEntry} from "../types";
import {basename, dirname, extname, isSiyuanPath, joinPath, pathDepth} from "./path";
import {isRemotePath} from "./path";
import {getRoots, MountItem} from "../mount-tree";
import {parseFileRef, stripFileRef, setPendingRef, FileRef} from "./file-ref";
import {fileUrlToPath} from "./system-path";
import {openFileTab} from "../tabs/editor-tab";
import {getIndexFilter} from "./config";
import {isPathIndexable} from "./index-filter";

// ===== 1. 引用提取正则(backlink 扫描与行内检测共用,唯一定义在这里)=====

// Markdown 链接 ![](x) / [](x)。url 支持两种形态:
//   (url) —— url 不含空白/尖括号;(url 里可以带 ?line= ?t= 等位置参数)
//   (<url>) —— url 含空格时用尖括号包裹(内含空白也整段捕获)
export const MD_LINK_RE = /(!?)\[[^\]\n]*\]\(\s*(?:<([^()<>\n]*)>|([^()<>\s]+))(?:\s+"[^"]*")?\s*\)/g;
// Obsidian/思源 wikilink [[path|alias]] / ![[path]] / [[path#锚点]]
export const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// HTML 标签属性 src= / href=
export const ATTR_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g;

// ===== 2. 扫描根与目录跳过(backlink 扫描与索引构建共用)=====

// 默认忽略清单(node_modules/.git/思源 data 系统目录等)已移到可配置的
// utils/index-filter.ts::DEFAULT_INDEX_BLACKLIST,由 getIndexFilter() 在
// walkFiles 里统一生效(支持用户自定义正则白/黑名单)。
// 结构性跳过仍硬编码在 walkFiles:隐藏目录、.sy 块文件、深度/数量配额。

// 收集参与链接扫描的文件根:
//   1) 虚拟文档树的挂载根(mount-tree 内存配置,启动时 initMountTree 已加载;
//      含嵌套挂载的 children,只取 kind=file 的真实路径 —— 文档/块挂载不参与文件扫描)
//   2) 旧「文件」面板的树根(仍开着的存量用户;.syfe-tree__root)
// 多个根去重;远程根(百度网盘 / Git 仓库)不参与文件扫描(扫描走内核/本地 readDir)。
export function collectScanRoots(): string[] {
    const roots = new Set<string>();
    const walkMounts = (items: MountItem[]) => {
        for (const it of items) {
            if (it.kind === "file" && it.path && !isRemotePath(it.path)) roots.add(it.path);
            if (it.children && it.children.length > 0) walkMounts(it.children);
        }
    };
    walkMounts(mountRootsSnapshot());
    document.querySelectorAll<HTMLElement>(".syfe-tree__root[data-path]").forEach(el => {
        const p = el.dataset.path;
        if (p && !p.startsWith("sydoc://") && !isRemotePath(p)) roots.add(p);
    });
    return Array.from(roots);
}

export interface WalkOptions {
    /** 允许的扩展名(含点小写);省略 = 全部文件 */
    exts?: Set<string>;
    /** 文件大小上限(字节);省略 = 不限 */
    maxBytes?: number;
    /** 单根收集文件上限(达到即止)——挂载了盘根/超大目录时防止扫描走不完 */
    maxFiles?: number;
    /** 单根目录访问上限(防超宽目录树) */
    maxDirs?: number;
}

// 递归收集目录下的文件(含全部扩展名)。过滤顺序:
//   1) 结构性跳过:隐藏目录、.sy 块文件(不可打开也不可作双链节点)
//   2) 可配置白/黑名单(getIndexFilter,支持正则;目录命中黑名单跳过整棵子树)
//   3) WalkOptions 的扩展名/大小/数量配额
// out 由调用方传入以便跨根累加。isDataRoot 仅为兼容旧调用(思源 data 系统
// 目录已改由默认黑名单的 (^|/)data/(plugins|...) 规则接管)。
export async function walkFiles(
    dir: string,
    out: {path: string; size: number; updated: string}[],
    opts: WalkOptions,
    _isDataRoot = false,
    depth = 0,
    ctx?: {dirs: number},
): Promise<void> {
    if (depth > 24) return; // 防异常数据导致的无限深递归
    if (opts.maxFiles !== undefined && out.length >= opts.maxFiles) return;
    if (ctx) {
        if (opts.maxDirs !== undefined && ctx.dirs >= opts.maxDirs) return;
        ctx.dirs++;
    }
    let entries: DirEntry[];
    try {
        entries = await readDir(dir);
    } catch {
        return;
    }
    if (!Array.isArray(entries)) return;
    const filter = getIndexFilter();
    for (const entry of entries) {
        if (opts.maxFiles !== undefined && out.length >= opts.maxFiles) return;
        const full = joinPath(dir, entry.name);
        if (entry.isDir) {
            if (entry.name.startsWith(".")) continue;
            // 目录只过黑名单:白名单不能挡目录,否则永远走不进目标目录
            if (!isPathIndexable(full, true, filter)) continue;
            await walkFiles(full, out, opts, false, depth + 1, ctx);
        } else {
            if (extname(entry.name) === ".sy") continue;
            if (!isPathIndexable(full, false, filter)) continue;
            if (opts.exts && !opts.exts.has(extname(entry.name))) continue;
            if (opts.maxBytes && entry.size > opts.maxBytes) continue;
            out.push({path: full, size: entry.size, updated: entry.updated || ""});
        }
    }
}

// /data 根判定(与 backlink.ts 同规则)
export function isDataRootPath(root: string): boolean {
    return isSiyuanPath(root) && root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === "/data";
}

// ===== 3. 文件名索引 =====

export interface LinkIndex {
    byName: Map<string, string[]>;   // 文件名(含扩展名,小写)→ 路径列表
    byStem: Map<string, string[]>;   // 去扩展名(小写)→ 路径列表
    builtAt: number;                 // 构建时间(TTL 失效用)
    truncated: boolean;              // 超出上限被截断
    emptyRoots?: boolean;            // 构建时挂载根为空(多为时序:见 getLinkIndex),不可缓存
}

// 文件数上限(防异常超大库把索引构建拖成几分钟)
const INDEX_FILE_LIMIT = 20000;
const INDEX_TTL = 5 * 60 * 1000;

// 索引状态挂 window 注册表:webpack 分块会把本模块求值两份(project_memory
// 「Monaco 单例」同款教训),模块级缓存各自为政会出现「面板能查、补全为空」。
interface WikiIndexState { cache: LinkIndex | null; promise: Promise<LinkIndex> | null }
function wikiStateOf(): WikiIndexState {
    const w = window as any;
    if (!w.__syfeWikilinkIndex) w.__syfeWikilinkIndex = {cache: null, promise: null};
    return w.__syfeWikilinkIndex;
}

// 挂载根读取:优先走 index.ts 注册的 window getter(__syfeMountTreeGetRoots)。
// mount-tree 模块同样可能被复制 —— 副本的 getRoots() 恒空(loaded=false),
// 只有跑过 initMountTree 的那份才有数据。
function mountRootsSnapshot(): MountItem[] {
    const getter = (window as any).__syfeMountTreeGetRoots;
    if (typeof getter === "function") {
        try {
            const r = getter();
            if (Array.isArray(r)) return r;
        } catch {
            // 落回本地模块状态
        }
    }
    return getRoots();
}

export function clearWikilinkIndex(): void {
    const st = wikiStateOf();
    st.cache = null;
    st.promise = null;
}

// 取文件名索引(TTL 缓存;force=true 强制重建)。并发调用共享同一次构建。
export async function getLinkIndex(force = false): Promise<LinkIndex> {
    const st = wikiStateOf();
    if (force) clearWikilinkIndex();
    if (st.cache && Date.now() - st.cache.builtAt < INDEX_TTL) return st.cache;
    if (!st.promise) {
        st.promise = buildLinkIndex().then(idx => {
            if (idx.emptyRoots) {
                // 挂载根为空多半是时序:布局恢复页签比 initMountTree 先跑(实测),
                // 此时建出的空索引若按 TTL 缓存,会把整个周期内的短链解析全部毒化。
                // 不缓存,下次调用重建(0 根的构建开销为零)。
                st.promise = null;
                return idx;
            }
            st.cache = idx;
            return idx;
        }).catch(() => {
            // 构建失败:允许下次重试
            st.promise = null;
            return emptyIndex();
        });
    }
    return st.promise;
}

function emptyIndex(): LinkIndex {
    return {byName: new Map(), byStem: new Map(), builtAt: Date.now(), truncated: false};
}

async function buildLinkIndex(): Promise<LinkIndex> {
    const roots = collectScanRoots();
    if (roots.length === 0) {
        const idx = emptyIndex();
        idx.emptyRoots = true;
        return idx;
    }
    const byName = new Map<string, string[]>();
    const byStem = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, path: string) => {
        if (!key) return;
        const list = map.get(key);
        if (list) list.push(path);
        else map.set(key, [path]);
    };
    let fileCount = 0;
    let truncated = false;
    for (const root of roots) {
        if (fileCount >= INDEX_FILE_LIMIT) {
            truncated = true;
            break;
        }
        const files: {path: string; size: number; updated: string}[] = [];
        // 每根配额:超大挂载(盘根/同步盘全库)不至于把索引构建拖死
        await walkFiles(root, files, {maxFiles: 5000, maxDirs: 8000}, isDataRootPath(root));
        for (const f of files) {
            if (fileCount >= INDEX_FILE_LIMIT) {
                truncated = true;
                break;
            }
            const name = basename(f.path);
            push(byName, name.toLowerCase(), f.path);
            const stem = stemOf(name);
            if (stem) push(byStem, stem.toLowerCase(), f.path);
            fileCount++;
        }
    }
    return {byName, byStem, builtAt: Date.now(), truncated};
}

// 去扩展名(点文件如 .gitignore 不生成 stem,避免 byStem 噪声)
function stemOf(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : "";
}

// 按名字查索引:先全名(含扩展名),再 stem(去扩展名)。
// 多个候选时取路径最浅者(离挂载根更近的通常是"主"文件),并标记歧义。
export function lookupInIndex(index: LinkIndex, name: string): {path: string; ambiguous: boolean} | null {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return null;
    let hits = index.byName.get(key);
    if (!hits || hits.length === 0) hits = index.byStem.get(key);
    if (!hits || hits.length === 0) return null;
    if (hits.length === 1) return {path: hits[0], ambiguous: false};
    const sorted = [...hits].sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
    return {path: sorted[0], ambiguous: true};
}

// ===== 4. 短链解析 =====

export interface ResolvedWikilink {
    /** 解析后的绝对路径(正斜杠) */
    path: string;
    /** 短名命中多个候选(取了最浅者);UI 可提示 */
    ambiguous?: boolean;
}

// 路径归一化:统一分隔符/去尾斜杠/忽略大小写,用于比较
export function normPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// 相对路径解析(与 backlink.ts resolveRef 的相对分支同规则):基于基准目录处理 ./ 与 ../
function resolveRelative(baseDir: string, ref: string): string | null {
    if (!baseDir) return null;
    const sep = baseDir.includes("\\") && !baseDir.startsWith("/") ? "\\" : "/";
    const parts = baseDir.split(/[\\/]+/).filter(Boolean);
    for (const seg of ref.split(/[\\/]+/)) {
        if (!seg || seg === ".") continue;
        if (seg === "..") {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    let result = parts.join(sep);
    if (baseDir.startsWith("/") && !result.startsWith("/")) result = "/" + result;
    return result;
}

// 解析一个引用地址为绝对路径。优先级:
//   file:// → 绝对路径 → 含 / 的相对路径(基于 fromDir)→ 裸名按索引短链解析
// 返回 null 表示解析不了(网络地址等在调用方先行分流)。
export async function resolveWikilink(raw: string, fromDir: string): Promise<ResolvedWikilink | null> {
    let core = String(raw || "").trim();
    if (!core) return null;
    // file:// 链接:转系统路径
    if (/^file:\/\//i.test(core)) {
        const p = fileUrlToPath(core);
        return p ? {path: p.replace(/\\/g, "/")} : null;
    }
    // 网络等协议:不是文件链接
    if (/^(https?:|data:|blob:|mailto:|tel:|siyuan:|javascript:)/i.test(core)) return null;
    try {
        const dec = decodeURIComponent(core);
        if (dec) core = dec;
    } catch {
        // 已是普通文本,保持原样
    }
    // Obsidian 风格尺寸后缀 =500x300
    core = core.replace(/\s*=\d+x\d+$/, "");
    if (!core) return null;
    // 系统绝对路径(Windows 盘符 / UNC / POSIX)原样
    if (/^[A-Za-z]:[\\/]/.test(core) || core.startsWith("\\\\") || core.startsWith("/")) {
        return {path: core.replace(/\\/g, "/")};
    }
    // 含路径分隔符:相对 fromDir
    if (/[\\/]/.test(core)) {
        const p = resolveRelative(fromDir, core);
        return p ? {path: p} : null;
    }
    // 裸名:[[名字]] —— 按索引短链解析
    const index = await getLinkIndex();
    const hit = lookupInIndex(index, core);
    return hit ? {path: hit.path, ambiguous: hit.ambiguous} : null;
}

// 文件是否真实存在(readDir 父目录比对;短链索引命中的天然存在,这里主要校验路径形态)
async function fileExists(path: string): Promise<boolean> {
    try {
        const entries = await readDir(dirname(path));
        if (!Array.isArray(entries)) return false;
        const name = basename(path);
        return entries.some(e => !e.isDir && e.name === name);
    } catch {
        return false;
    }
}

// ===== 5. 行内链接检测(Monaco / CM6 点击共用)=====

export interface InlineLinkHit {
    raw: string;        // 链接地址(未解析;wikilink 为 [[ ]] 内的路径部分,可含 #锚点)
    isWikilink: boolean;
    start: number;      // 0-based 起始列(含)
    end: number;        // 0-based 结束列(含)
}

const INLINE_WIKILINK_RE = /(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const INLINE_MD_LINK_RE = /(!?)\[[^\]\n]*\]\(\s*(?:<([^()<>\n]*)>|([^()<>\s]+))(?:\s+"[^"]*")?\s*\)/g;
const INLINE_ATTR_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g;

// 在一行文本里找光标列(0-based)所在链接。wikilink 优先(md 链接正则匹配不到
// [[x]],二者独立);命中行内图片 ![[x]] / ![x](y) 同样可点。
export function findLinkInLine(lineText: string, col: number): InlineLinkHit | null {
    const tryRe = (re: RegExp, extract: (m: RegExpExecArray) => string, isWiki: boolean): InlineLinkHit | null => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lineText)) !== null) {
            if (m[0].length === 0) {
                re.lastIndex++;
                continue;
            }
            const start = m.index;
            const end = m.index + m[0].length - 1;
            if (col >= start && col <= end) {
                const raw = extract(m);
                if (!raw) continue;
                // 非 wikilink 命中要有「路径感」(含点或斜杠)才算链接:
                // 代码里的 a[0](x) 这类索引+调用会被 md 链接正则误吞,裸 "x" 不是链接
                if (!isWiki && !/[\\/]/.test(raw) && !raw.includes(".")) continue;
                return {raw, isWikilink: isWiki, start, end};
            }
        }
        return null;
    };
    return tryRe(INLINE_WIKILINK_RE, m => m[2], true)
        || tryRe(INLINE_MD_LINK_RE, m => (m[2] !== undefined ? m[2] : m[3]), false)
        || tryRe(INLINE_ATTR_RE, m => m[1], false);
}

// ===== 6. 编辑器内打开链接 =====

// openFileTab 所需的最小插件结构(避免引入 tabs 层的完整类型)
interface IOpenLinkPlugin {
    app: any;
    name: string;
}

// 编辑器里点击链接的统一入口:
//   - http(s)/siyuan:// 等协议 → 系统默认方式
//   - 纯锚点 #标题 → 定位当前文件(重新打开并跳转)
//   - 文件路径 / [[短链]] → 解析 → 存在性校验 → 位置入队 → openFileTab 分发
export async function openLinkFromEditor(plugin: IOpenLinkPlugin, fromPath: string, rawUrl: string): Promise<void> {
    const raw = String(rawUrl || "").trim();
    if (!raw) return;
    // 思源外部块引用:协议跳转(Electron 里 window.open 对自定义协议不可靠,
    // 与 navigateBacklink 同款 <a> 点击,由思源主进程接管并定位到块)
    if (/^siyuan:\/\/blocks\//i.test(raw)) {
        const a = document.createElement("a");
        a.href = raw;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
    }
    // 网络/协议链接:维持系统打开
    if (/^(https?:|mailto:|tel:|siyuan:|javascript:|data:|blob:)/i.test(raw)) {
        window.open(raw, "_blank");
        return;
    }
    const ref: FileRef | null = parseFileRef(raw);
    let core = (ref ? stripFileRef(raw) : raw).trim();
    if (!core) return;
    // 纯锚点:本文件内定位
    if (core.startsWith("#") || (!core && ref?.anchor)) {
        const anchor = ref?.anchor || core.slice(1);
        if (anchor) {
            setPendingRef(fromPath, {path: fromPath, anchor});
            openFileTab(plugin as any, fromPath);
        }
        return;
    }
    const resolved = await resolveWikilink(core, dirname(fromPath));
    if (!resolved || !resolved.path) {
        showMessage(`无法解析链接:${core}`, 3500, "error");
        return;
    }
    // 路径形态的链接目标可能已被移动/删除(短链命中的必然在索引里)
    if (!resolved.ambiguous && !await fileExists(resolved.path)) {
        showMessage(`链接目标不存在:${resolved.path}`, 3500, "error");
        return;
    }
    if (ref) setPendingRef(resolved.path, ref);
    openFileTab(plugin as any, resolved.path);
    if (resolved.ambiguous) {
        showMessage(`「${core}」匹配到多个文件,已打开 ${resolved.path}`, 3500, "info");
    }
}

// ===== 7. wikilink 构建 =====

function relPathBetween(fromDir: string, target: string): string {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const fromParts = norm(fromDir).split("/").filter(Boolean);
    const toParts = norm(target).split("/").filter(Boolean);
    if (!fromParts.length || !toParts.length) return norm(target);
    // Windows 盘符不同:相对路径无意义,退化为绝对路径
    const driveRe = /^[A-Za-z]:$/;
    if (driveRe.test(fromParts[0]) && driveRe.test(toParts[0]) &&
        fromParts[0].toLowerCase() !== toParts[0].toLowerCase()) {
        return norm(target);
    }
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i].toLowerCase() === toParts[i].toLowerCase()) i++;
    const ups = fromParts.length - i;
    const rel = [...Array(ups).fill(".."), ...toParts.slice(i)].join("/");
    return rel || ".";
}

// 生成指向 targetPath 的双链文本:
//   - 文件名(含扩展名)在索引里唯一 → [[名]]
//   - 去扩展名唯一 → [[stem]]
//   - 否则 → [[相对路径]](解析端按路径处理;不落 [[名]] 歧义坑)
export async function buildWikilink(targetPath: string, fromPath: string): Promise<string> {
    const target = String(targetPath || "").replace(/\\/g, "/");
    const name = basename(target);
    if (!name) return "";
    const index = await getLinkIndex();
    const normTarget = normPath(target);
    // 不排除 fromPath 自身:短链的价值在于「从任何位置都能解析」,全局唯一即用短名
    const byName = index.byName.get(name.toLowerCase()) || [];
    const stem = stemOf(name);
    const byStem = stem ? (index.byStem.get(stem.toLowerCase()) || []) : [];
    if (byName.length === 1 && normPath(byName[0]) === normTarget) return `[[${name}]]`;
    if (byStem.length === 1 && normPath(byStem[0]) === normTarget) return `[[${stem}]]`;
    return `[[${relPathBetween(dirname(fromPath), target)}]]`;
}
