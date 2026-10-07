// 反向链接(backlink)数据层:
// 给定任意文件,查找引用它的位置,两类来源:
// 1. 思源笔记文档(内核 SQL 查询 blocks 表,匹配 assets/ 等文件引用)
// 2. 文件树挂载根下的 Markdown 文件(相对链接 ![..](../img.png)、<img src=..> 等)
import {readDir, readTextFile, querySQL} from "../api/file";
import {basename, dirname, joinPath, sepFor, isSiyuanPath} from "./path";
import {isBaiduPath} from "./baidu-path";

// 反向链接条目
export interface BacklinkItem {
    kind: "siyuan-doc" | "md-file"; // 引用来源类型
    sourcePath: string;             // md-file: 引用文件绝对路径;siyuan-doc: 文档 root_id
    title: string;                  // 显示名:md 文件名 / 思源文档标题
    docPath?: string;               // siyuan-doc: 文档 hpath(如 /课程/Linux/day02)
    lineNo?: number;                // md-file: 引用所在行号
    snippet?: string;               // 引用上下文(单行截断)
    blockId?: string;               // siyuan-doc: 块 ID(siyuan://blocks/ 跳转定位)
}

// ===== 通用工具 =====

// 路径归一化:统一分隔符/去尾斜杠/忽略大小写,用于比较
function normPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// 将引用地址解析为绝对路径;返回 null 表示不是文件引用(网络/内联等)
function resolveRef(baseDir: string, rawRef: string): string | null {
    if (!rawRef) return null;
    // file:// 链接:思源笔记引用外部文件的常见方式
    if (/^file:\/\//i.test(rawRef)) {
        let p = rawRef.replace(/^file:\/{2,3}/i, "");
        try {
            p = decodeURIComponent(p);
        } catch {
            // 保持原样
        }
        // file:///E:/HOME/... → E:/HOME/...;file:///home/... → /home/...
        if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) return p;
        return null;
    }
    // 协议与锚点地址不参与匹配
    if (/^(https?:|data:|blob:|mailto:|tel:|siyuan:|javascript:|#|\/\/)/i.test(rawRef)) return null;
    let ref = rawRef;
    try {
        ref = decodeURIComponent(ref);
    } catch {
        // 已是普通文本,保持原样
    }
    // 去掉 Obsidian 风格尺寸后缀 =500x300
    ref = ref.replace(/\s*=\d+x\d+$/, "");
    if (!ref) return null;
    // 思源虚拟路径(块内 assets/xxx 形式由调用方传入 /data 基准)
    if (isSiyuanPath(ref)) return ref;
    // 系统绝对路径(Windows 盘符 / UNC / POSIX)原样
    if (/^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith("\\\\") || ref.startsWith("/")) return ref;
    // 相对路径:基于基准目录解析 ./ 与 ../
    if (!baseDir) return null;
    const sep = sepFor(baseDir);
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

// 引用与目标文件是否匹配:
// 1. 精确:解析后的绝对路径相等
// 2. 后缀:引用是相对路径时,剥离前导 ../ 段后作为路径尾部匹配
//    (Obsidian/思源 wikilink 的 ../ 基准在文件被移动或跨库后会失效,后缀匹配兜底)
function refMatches(ref: ExtractedRef, target: string): boolean {
    if (normPath(ref.target) === target) return true;
    const raw = ref.raw || "";
    // 绝对路径引用只走精确匹配(后缀匹配过于宽松)
    if (!raw || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return false;
    let dec = raw;
    try {
        dec = decodeURIComponent(raw);
    } catch {
        // 保持原样
    }
    const segs = dec.split(/[\\/]+/).filter(s => s && s !== ".");
    let i = 0;
    while (i < segs.length && segs[i] === "..") i++;
    const tail = segs.slice(i).map(s => s.toLowerCase());
    if (tail.length < 2) return false; // 仅文件名的后缀匹配过于宽松
    return target.endsWith("/" + tail.join("/"));
}

// 引用提取结果
interface ExtractedRef {
    target: string; // 解析后的绝对路径(未归一化)
    raw: string;    // 原始引用路径(后缀匹配用)
    lineNo: number;
    line: string;   // 引用所在行文本
}

// Markdown 链接 ![](x) / [](x)
const MD_LINK_RE = /(!?)\[[^\]\n]*\]\(\s*<?([^)<>\s]+)(?:\s+"[^"]*")?\s*\)/g;
// Obsidian/思源 wikilink [[path|alias]] / ![[path]]
const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
// HTML 标签属性 src= / href=
const ATTR_RE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g;

// 从内容中提取全部文件引用
function extractRefs(baseDir: string, content: string): ExtractedRef[] {
    const refs: ExtractedRef[] = [];
    const take = (matchIndex: number, raw: string) => {
        const target = resolveRef(baseDir, raw);
        if (!target) return;
        // 行号与所在行文本
        const before = content.slice(0, matchIndex);
        const lineNo = before.split("\n").length;
        const lineStart = before.lastIndexOf("\n") + 1;
        const lineEnd = content.indexOf("\n", matchIndex);
        const lineText = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
        refs.push({target, raw, lineNo, line: lineText.length > 160 ? lineText.slice(0, 160) + "…" : lineText});
    };
    let m: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(content)) !== null) {
        take(m.index, m[2]);
    }
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(content)) !== null) {
        take(m.index, m[1].trim());
    }
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(content)) !== null) {
        take(m.index, m[1]);
    }
    return refs;
}

// ===== 来源 1:思源笔记文档引用 =====

// 查询思源文档中引用该文件的位置:
// A. 块内容(markdown 列):assets 链接 / file:// 外部链接 / wikilink 文本
// B. 块属性(attributes 表):如 custom-base-file 指向外部文件的 wikilink
// 按文件名 LIKE 粗筛,再解析验证(含 ../ 失效时的路径尾部匹配)
async function findSiyuanDocRefs(path: string): Promise<BacklinkItem[]> {
    const name = basename(path);
    // SQL 转义:LIKE 通配符与单引号
    const esc = name.replace(/[\\%_]/g, ch => "\\" + ch).replace(/'/g, "''");
    const target = normPath(path);
    const items: BacklinkItem[] = [];
    const seen = new Set<string>(); // 同一块出现在多个来源时去重

    const pushItem = (blockId: string, rootId: string, hpath: string, snippet: string) => {
        if (!blockId || seen.has(blockId)) return;
        seen.add(blockId);
        const title = hpath ? hpath.split("/").filter(Boolean).pop() || hpath : rootId;
        items.push({
            kind: "siyuan-doc",
            sourcePath: rootId,
            title,
            docPath: hpath,
            snippet: snippet.length > 160 ? snippet.slice(0, 160) + "…" : snippet,
            blockId,
        });
    };

    // 来源 A:块内容中的链接
    try {
        const rows = await querySQL(
            `SELECT id, root_id, hpath, markdown FROM blocks ` +
            `WHERE markdown LIKE '%${esc}%' ESCAPE '\\' LIMIT 512`);
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const md: string = row.markdown || "";
                // 块内引用以 assets/ 等形式存储,相对工作空间 data 根解析
                const refs = extractRefs("/data", md);
                if (refs.some(r => refMatches(r, target))) {
                    const firstLine = md.split("\n").find((l: string) => l.trim()) || "";
                    pushItem(row.id, row.root_id, row.hpath || "", firstLine);
                }
            }
        }
    } catch {
        // SQL 不可用(内核版本差异等)时静默跳过
    }

    // 来源 B:块/文档属性中的引用(如 custom-base-file)
    try {
        const rows = await querySQL(
            `SELECT a.block_id, a.name AS attr_name, a.value, b.root_id, b.hpath ` +
            `FROM attributes a JOIN blocks b ON b.id = a.block_id ` +
            `WHERE a.value LIKE '%${esc}%' ESCAPE '\\' LIMIT 256`);
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const value: string = row.value || "";
                const refs = extractRefs("/data", value);
                if (refs.some(r => refMatches(r, target))) {
                    pushItem(row.block_id, row.root_id, row.hpath || "", `${row.attr_name || "属性"}: ${value}`);
                }
            }
        }
    } catch {
        // attributes 表不可用(旧版内核)时静默跳过
    }

    return items;
}

// ===== 来源 2:Markdown 文件引用 =====

// 扫描时跳过的目录(噪声/超大)
const SKIP_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", ".Trash", "$RECYCLE.BIN", "System Volume Information",
]);
// /data 根下额外跳过的思源系统目录
const SIYUAN_SKIP_DIRS = new Set([
    "plugins", "widgets", "themes", "icons", "snippets", "remnants", "history", "temp", "push", "storage", "conf",
]);

interface MdFileInfo {
    path: string;
    size: number;
    updated: string;
}

// 递归收集 Markdown 文件
async function collectMdFiles(dir: string, out: MdFileInfo[], isDataRoot: boolean): Promise<void> {
    let entries;
    try {
        entries = await readDir(dir);
    } catch {
        return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
        if (entry.isDir) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
            if (isDataRoot && SIYUAN_SKIP_DIRS.has(entry.name)) continue;
            await collectMdFiles(joinPath(dir, entry.name), out, false);
        } else if (/\.(md|markdown)$/i.test(entry.name) && entry.size <= 2 * 1024 * 1024) {
            out.push({path: joinPath(dir, entry.name), size: entry.size, updated: entry.updated});
        }
    }
}

// 内容引用缓存:mdPath → {key(size:updated), refs},避免重复读取解析
const refCache = new Map<string, {key: string; refs: ExtractedRef[]}>();

// 收集文件树挂载根(多个树去重;虚拟文档树/百度网盘根不参与文件扫描)
function collectScanRoots(): string[] {
    const roots = new Set<string>();
    document.querySelectorAll<HTMLElement>(".syfe-tree__root[data-path]").forEach(el => {
        const p = el.dataset.path;
        if (p && !p.startsWith("sydoc://") && !isBaiduPath(p)) roots.add(p);
    });
    return Array.from(roots);
}

// 查询文件树内引用该文件的所有 Markdown 文件
async function findMdFileRefs(path: string): Promise<BacklinkItem[]> {
    const roots = collectScanRoots();
    if (roots.length === 0) return [];
    const target = normPath(path);
    const files: MdFileInfo[] = [];
    for (const root of roots) {
        await collectMdFiles(root, files, isSiyuanPath(root) && normPath(root) === "/data");
    }
    const items: BacklinkItem[] = [];
    // 分批并发读取,避免大目录一次发出过多请求
    const BATCH = 16;
    for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        await Promise.all(batch.map(async (f) => {
            const key = `${f.size}:${f.updated}`;
            let entry = refCache.get(f.path);
            if (!entry || entry.key !== key) {
                try {
                    const content = await readTextFile(f.path);
                    entry = {key, refs: extractRefs(dirname(f.path), content)};
                } catch {
                    entry = {key, refs: []};
                }
                if (refCache.size > 5000) refCache.clear();
                refCache.set(f.path, entry);
            }
            // 跳过自引用(文件链接自身)
            if (normPath(f.path) === target) return;
            for (const ref of entry.refs) {
                if (refMatches(ref, target)) {
                    items.push({
                        kind: "md-file",
                        sourcePath: f.path,
                        title: basename(f.path),
                        lineNo: ref.lineNo,
                        snippet: ref.line,
                    });
                }
            }
        }));
    }
    return items;
}

// ===== 总入口 =====

// 查找引用指定文件的所有位置(思源文档 + Markdown 文件)
export async function findBacklinks(path: string): Promise<BacklinkItem[]> {
    const [docRefs, fileRefs] = await Promise.all([
        findSiyuanDocRefs(path),
        findMdFileRefs(path),
    ]);
    // 思源文档引用在前
    return [...docRefs, ...fileRefs];
}
