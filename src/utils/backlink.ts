// 双链(backlink)数据层:
// 给定任意文件,查找引用它的位置(入链),两类来源:
// 1. 思源笔记文档(内核 SQL 查询 blocks 表,匹配 assets/ 等文件引用)
// 2. 文件树挂载根下的文本文件(Markdown/代码等 —— 默认全部文本文件,设置可回退
//    仅 Markdown;相对链接 ![..](../img.png)、<img src=..>、[[wikilink]] 等)
// 以及出链(findOutlinks):给定文件,列出它指向的所有位置。
// 链接可以带位置(?line=N 行号 / #锚点 标题 / ?t= 音视频时间),位置不参与匹配,
// 但会记进条目(targetLine/targetAnchor/targetTime),面板与行号槽据此上色定位。
// wikilink 短链([[名字]])的解析依赖 wikilink.ts 的文件名索引。
import {readTextFile, readDir, querySQL} from "../api/file";
import {basename, dirname, isSiyuanPath} from "./path";
import {TEXT_EXTENSIONS} from "../constants";
import {isBacklinkScanAllTextEnabled} from "./config";
import {
    MD_LINK_RE, WIKILINK_RE, ATTR_RE,
    collectScanRoots, walkFiles, isDataRootPath,
    getLinkIndex, clearWikilinkIndex, lookupInIndex,
    normPath,
} from "./wikilink";
import type {LinkIndex} from "./wikilink";
import {headingLineOfAnchor, parseFileRef} from "./file-ref";
import {blockTitle} from "./blocks";

// 反向链接条目
export interface BacklinkItem {
    kind: "siyuan-doc" | "md-file"; // 引用来源类型
    sourcePath: string;             // md-file: 引用文件绝对路径;siyuan-doc: 文档 root_id
                                    // (出链条目 = 目标文件路径;未解析短链为 "")
    title: string;                  // 显示名:md 文件名 / 思源文档标题
    docPath?: string;               // siyuan-doc: 文档 hpath(如 /课程/Linux/day02)
    lineNo?: number;                // md-file: 引用所在行号(引用来源文件里的行)
    snippet?: string;               // 引用上下文(单行截断)
    blockId?: string;               // siyuan-doc: 块 ID(siyuan://blocks/ 跳转定位)
    // ===== 链接指向目标文件的位置(可选)=====
    targetLine?: number;            // 链接指向的行号(?line=N;锚点会先解析成标题行)
    targetAnchor?: string;          // 链接指向的标题锚点(#slug 原文)
    targetTime?: number;            // 音视频时间点(?t= / #t=,秒)
    unresolvedName?: string;        // 出链:无法解析的 wikilink 短名(灰显,不可跳转)
}

// ===== 通用工具 =====

// 剥掉引用末尾的位置后缀(?line= ?t= #锚点 / #t=),只留路径本体参与匹配。
// 带位置的链接此前整串进匹配,`demo.mp4?t=12.5` 对不上 `demo.mp4`,
// 这正是视频/行号/锚点反链全部查不到的根因。
function splitPosSuffix(raw: string): string {
    const s = String(raw || "");
    const cut = s.search(/[?#]/);
    return cut >= 0 ? s.slice(0, cut) : s;
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

// 引用与目标文件是否匹配:
// 1. 精确:解析后的绝对路径相等
// 2. 后缀:引用是相对路径时,剥离前导 ../ 段后作为路径尾部匹配
//    (Obsidian/思源 wikilink 的 ../ 基准在文件被移动或跨库后会失效,后缀匹配兜底)
// 3. 短链:裸名 wikilink([[名字]])按文件名索引解析后精确匹配
function refMatches(ref: ExtractedRef, target: string, index?: LinkIndex): boolean {
    if (ref.target && normPath(ref.target) === target) return true;
    // 裸名 wikilink:走索引短链解析(索引里只有真实文件,解析命中即存在)
    if (ref.wikiname) {
        if (!index) return false;
        const hit = lookupInIndex(index, ref.wikiname);
        return !!hit && normPath(hit.path) === target;
    }
    const raw = ref.rawPath || "";
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
    target: string;   // 解析后的绝对路径(未归一化;已剥位置后缀;裸名 wikilink 为 "")
    rawPath: string;  // 原始引用路径(剥 ?query/#锚点 后,后缀匹配用)
    wikiname?: string; // 裸名 wikilink 的名字(路径解析让位给索引短链)
    syBlockId?: string; // 思源外部块引用 [..](siyuan://blocks/<id>) 的块 ID
    lineNo: number;
    line: string;     // 引用所在行文本
    posLine?: number;   // 链接指向的行号(?line=N)
    posAnchor?: string; // 链接指向的标题锚点(#slug / [[x#锚点]])
    posTime?: number;   // 音视频时间点(?t= / #t=,秒)
}

// 思源外部块引用地址 → 块 ID(siyuan://blocks/20060102150405-1a2b3c4)
const SY_BLOCK_REF_RE = /^siyuan:\/\/blocks\/([0-9]{14}-[0-9a-z]+)$/i;

// 从内容中提取全部文件引用(MD 链接 / wikilink / HTML src-href)
function extractRefs(baseDir: string, content: string): ExtractedRef[] {
    const refs: ExtractedRef[] = [];
    const take = (matchIndex: number, raw: string, isWikilink = false) => {
        const core = splitPosSuffix(raw);
        let target: string | null = null;
        let wikiname: string | undefined;
        let syBlockId: string | undefined;
        const syMatch = SY_BLOCK_REF_RE.exec(core);
        if (syMatch) {
            // 思源外部块引用:按块 ID 建引用(路径语义不适用)
            syBlockId = syMatch[1];
        } else if (isWikilink && !/[\\/]/.test(core)) {
            // 裸名 wikilink:[[名字]] —— 不按相对路径硬解析,留给索引短链匹配
            wikiname = core;
        } else {
            target = resolveRef(baseDir, core);
            if (!target) return;
        }
        // 链接里的位置参数(?line= / #锚点 / ?t=):不影响匹配,记下来给 UI 定位
        const pos = parseFileRef(raw);
        // 行号与所在行文本
        const before = content.slice(0, matchIndex);
        const lineNo = before.split("\n").length;
        const lineStart = before.lastIndexOf("\n") + 1;
        const lineEnd = content.indexOf("\n", matchIndex);
        const lineText = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
        refs.push({
            target: target || "",
            rawPath: core,
            wikiname,
            syBlockId,
            lineNo,
            line: lineText.length > 160 ? lineText.slice(0, 160) + "…" : lineText,
            posLine: pos?.line,
            posAnchor: pos?.anchor,
            posTime: pos?.t,
        });
    };
    let m: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(content)) !== null) {
        take(m.index, m[2] !== undefined ? m[2] : m[3]);
    }
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(content)) !== null) {
        take(m.index, m[1].trim(), true);
    }
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(content)) !== null) {
        take(m.index, m[1]);
    }
    return refs;
}

// ===== 来源 1:思源笔记文档引用 =====

// 按谓词查询思源文档中的引用位置(A. 块内容 markdown 列 + B. 块属性 attributes 表):
// likeNames 为 LIKE 粗筛候选(明文 + 编码变体,已转义),match 决定提取出的引用是否命中目标;
// 同一块出现在多个来源时按块 ID 去重。
async function findSiyuanDocRefsWhere(
    likeNames: string[],
    match: (ref: ExtractedRef, index: LinkIndex) => boolean,
): Promise<BacklinkItem[]> {
    const items: BacklinkItem[] = [];
    const seen = new Set<string>(); // 同一块出现在多个来源时去重
    const index = await getLinkIndex();

    const pushItem = (blockId: string, rootId: string, hpath: string, snippet: string, ref?: ExtractedRef) => {
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
            targetLine: ref?.posLine,
            targetAnchor: ref?.posAnchor,
            targetTime: ref?.posTime,
        });
    };

    // 来源 A:块内容中的链接
    try {
        const rows = await querySQL(
            `SELECT id, root_id, hpath, markdown FROM blocks ` +
            `WHERE (${siyuanLikeClause("markdown", likeNames)}) LIMIT 512`);
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const md: string = row.markdown || "";
                // 块内引用以 assets/ 等形式存储,相对工作空间 data 根解析
                const refs = extractRefs("/data", md);
                const hit = refs.find(r => match(r, index));
                if (hit) {
                    const firstLine = md.split("\n").find((l: string) => l.trim()) || "";
                    pushItem(row.id, row.root_id, row.hpath || "", firstLine, hit);
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
            `WHERE (${siyuanLikeClause("a.value", likeNames)}) LIMIT 256`);
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const value: string = row.value || "";
                const refs = extractRefs("/data", value);
                const hit = refs.find(r => match(r, index));
                if (hit) {
                    pushItem(row.block_id, row.root_id, row.hpath || "", `${row.attr_name || "属性"}: ${value}`, hit);
                }
            }
        }
    } catch {
        // attributes 表不可用(旧版内核)时静默跳过
    }

    return items;
}

// LIKE 粗筛候选串:明文 + 百分号编码变体。
// 插件自产链接是明文路径,但外部来源(Obsidian/浏览器复制)粘贴进思源后
// 存的是 %E8%AF%BE... 编码形式 —— 只按明文筛会把中文文件名的引用整个漏掉。
function siyuanLikeNames(name: string): string[] {
    const esc = (s: string) => s.replace(/[\\%_]/g, ch => "\\" + ch).replace(/'/g, "''");
    const out = [esc(name)];
    const enc = encodeURIComponent(name);
    if (enc !== name) out.push(esc(enc));
    return Array.from(new Set(out));
}

// LIKE 粗筛子句(多候选 OR)
function siyuanLikeClause(col: string, names: string[]): string {
    return names.map(n => `${col} LIKE '%${n}%' ESCAPE '\\'`).join(" OR ");
}

// 查询思源文档中引用该文件的位置(按文件名 LIKE 粗筛,再解析验证:
// 精确匹配 + ../ 失效时的路径尾部匹配 + wikilink 短链匹配)
async function findSiyuanDocRefs(path: string): Promise<BacklinkItem[]> {
    const name = basename(path);
    const target = normPath(path);
    return findSiyuanDocRefsWhere(siyuanLikeNames(name), (r, index) => refMatches(r, target, index));
}

// ===== 来源 2:挂载根下的文本文件引用 =====

// 扫描文件大小上限(单文件;超大文件读入+正则的代价不值)
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
// 回退模式的扩展名(设置关闭「扫描所有文本文件」时仅扫 Markdown)
const MD_ONLY_EXTS = new Set([".md", ".markdown"]);

// 内容引用缓存:filePath → {key(size:updated), refs},避免重复读取解析
const refCache = new Map<string, {key: string; refs: ExtractedRef[]}>();

// 遍历全部挂载根下文本文件的引用(读盘+refCache 共享层,各查询共用):
// handler 对每条 (ref, 所在文件) 调用。
async function forEachFileRef(handler: (ref: ExtractedRef, srcPath: string) => void): Promise<void> {
    const roots = collectScanRoots();
    if (roots.length === 0) return;
    const files: {path: string; size: number; updated: string}[] = [];
    const exts = isBacklinkScanAllTextEnabled() ? TEXT_EXTENSIONS : MD_ONLY_EXTS;
    for (const root of roots) {
        // 每根配额:超大挂载(盘根/同步盘全库)不至于把扫描拖死
        await walkFiles(root, files, {exts, maxBytes: MAX_SCAN_BYTES, maxFiles: 5000, maxDirs: 8000}, isDataRootPath(root));
    }
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
            for (const ref of entry.refs) handler(ref, f.path);
        }));
    }
}

// 对全部挂载根下的文本文件扫描引用,match 决定某条引用是否命中目标
// (normTarget 为归一化后的目标路径;srcPath 为引用所在文件,供调用方做自引用/范围过滤)
async function scanFileRefs(
    normTarget: string,
    match: (ref: ExtractedRef, srcPath: string, normTarget: string, index: LinkIndex) => boolean,
): Promise<BacklinkItem[]> {
    const index = await getLinkIndex();
    const items: BacklinkItem[] = [];
    await forEachFileRef((ref, f) => {
        if (match(ref, f, normTarget, index)) {
            items.push({
                kind: "md-file",
                sourcePath: f,
                title: basename(f),
                lineNo: ref.lineNo,
                snippet: ref.line,
                targetLine: ref.posLine,
                targetAnchor: ref.posAnchor,
                targetTime: ref.posTime,
            });
        }
    });
    return items;
}

// 查询文件树内引用该文件的所有文本文件
async function findFileRefs(path: string): Promise<BacklinkItem[]> {
    const target = normPath(path);
    return scanFileRefs(target, (ref, srcPath, t, index) =>
        // 跳过自引用(文件链接自身)
        normPath(srcPath) !== t && refMatches(ref, t, index));
}

// ===== 总入口 =====

// 锚点 → 行号:目标文件是 Markdown 时读一次内容,把所有 targetAnchor 解析成标题行。
// 只对文本目标做(视频等二进制不读);解析不到的保持只有锚点(面板仍显示,行号槽不上标记)。
async function resolveAnchorLines(path: string, items: BacklinkItem[]): Promise<void> {
    if (!/\.(md|markdown)$/i.test(path)) return;
    if (!items.some(it => it.targetAnchor && !it.targetLine)) return;
    let content: string;
    try {
        content = await readTextFile(path);
    } catch {
        return;
    }
    for (const it of items) {
        if (!it.targetAnchor || it.targetLine) continue;
        const line = headingLineOfAnchor(content, it.targetAnchor);
        if (line) it.targetLine = line;
    }
}

// 查找引用指定文件的所有位置(思源文档 + 挂载根文本文件)
export async function findBacklinks(path: string): Promise<BacklinkItem[]> {
    const [docRefs, fileRefs] = await Promise.all([
        findSiyuanDocRefs(path),
        findFileRefs(path),
    ]);
    // 思源文档引用在前
    const items = [...docRefs, ...fileRefs];
    await resolveAnchorLines(path, items);
    return items;
}

// ===== 结果缓存 =====
// 全量扫描(读全部挂载根的文件 + 两次 SQL)开销大,而行号槽标记与引用面板需要同一份数据,
// 这里按「目标路径 + 挂载根集合」缓存最终结果;引用面板的刷新按钮 / syfe:backlink-refresh
// 事件强制绕过(refCache 本身按 size:mtime 失效,单文件改动后重扫也不至于全冷)。
const backlinkCache = new Map<string, {key: string; items: BacklinkItem[]}>();
// 出链结果单独缓存(同一 key 策略)
const outlinkCache = new Map<string, {key: string; items: BacklinkItem[]}>();
// 块引用(文件→siyuan://blocks)结果缓存
const blockRefCache = new Map<string, BacklinkItem[]>();

export function clearBacklinkCache(clearIndex = false): void {
    backlinkCache.clear();
    outlinkCache.clear();
    blockRefCache.clear();
    if (clearIndex) clearWikilinkIndex();
}

export async function findBacklinksCached(path: string, opts?: {force?: boolean}): Promise<BacklinkItem[]> {
    const norm = normPath(path);
    const key = collectScanRoots().join("|");
    const hit = backlinkCache.get(norm);
    if (!opts?.force && hit && hit.key === key) return hit.items;
    const items = await findBacklinks(path);
    backlinkCache.set(norm, {key, items});
    if (backlinkCache.size > 40) {
        const first = backlinkCache.keys().next();
        if (!first.done) backlinkCache.delete(first.value);
    }
    return items;
}

// ===== 出链 =====

// 批量校验文件是否存在(按父目录分组,每目录一次 readDir)
async function filterExisting(paths: string[]): Promise<Set<string>> {
    const byDir = new Map<string, string[]>();
    for (const p of paths) {
        const dir = dirname(p);
        const list = byDir.get(dir);
        if (list) list.push(p);
        else byDir.set(dir, [p]);
    }
    const exists = new Set<string>();
    await Promise.all(Array.from(byDir.entries()).map(async ([dir, list]) => {
        let entries;
        try {
            entries = await readDir(dir);
        } catch {
            entries = null;
        }
        if (!Array.isArray(entries)) return;
        const names = new Set(entries.filter((e: any) => !e.isDir).map((e: any) => e.name));
        for (const p of list) {
            if (names.has(basename(p))) exists.add(p);
        }
    }));
    return exists;
}

// 出链锚点解析:条目各自指向不同文件,按目标分组读文件换算锚点行
async function resolveAnchorLinesMulti(items: BacklinkItem[]): Promise<void> {
    const need = items.filter(it =>
        it.targetAnchor && !it.targetLine && it.sourcePath && /\.(md|markdown)$/i.test(it.sourcePath));
    if (need.length === 0) return;
    const byFile = new Map<string, BacklinkItem[]>();
    for (const it of need) {
        const k = normPath(it.sourcePath);
        const list = byFile.get(k);
        if (list) list.push(it);
        else byFile.set(k, [it]);
    }
    await Promise.all(Array.from(byFile.values()).map(async (list) => {
        let content: string;
        try {
            content = await readTextFile(list[0].sourcePath);
        } catch {
            return;
        }
        for (const it of list) {
            const line = headingLineOfAnchor(content, it.targetAnchor!);
            if (line) it.targetLine = line;
        }
    }));
}

// 给定文件,列出它指向的所有位置(出链)。
// 路径/短链均解析;路径形态解析后不存在的丢弃(与入链的「目标必在扫描结果里」一致);
// 解析失败的 wikilink 短名保留(unresolvedName 灰显,提示用户改链)。
export async function findOutlinks(path: string): Promise<BacklinkItem[]> {
    let content: string;
    try {
        content = await readTextFile(path);
    } catch {
        return [];
    }
    const refs = extractRefs(dirname(path), content);
    if (refs.length === 0) return [];
    const index = await getLinkIndex();
    const normSelf = normPath(path);
    const items: BacklinkItem[] = [];
    const resolvedPaths: string[] = [];
    const pending: {ref: ExtractedRef; target: string}[] = [];
    const syRefs: ExtractedRef[] = [];
    for (const ref of refs) {
        // 思源外部块引用:块信息走 SQL(内容作标题),不走文件存在性校验
        if (ref.syBlockId) {
            syRefs.push(ref);
            continue;
        }
        let target = ref.target;
        if (!target && ref.wikiname && index) {
            const hit = lookupInIndex(index, ref.wikiname);
            if (hit) target = hit.path;
        }
        if (!target) {
            // 解析失败:wikilink 保留名字灰显;路径形态解析失败的直接跳过(噪声太大)
            if (ref.wikiname) {
                items.push({
                    kind: "md-file",
                    sourcePath: "",
                    title: ref.wikiname,
                    lineNo: ref.lineNo,
                    snippet: ref.line,
                    targetLine: ref.posLine,
                    targetAnchor: ref.posAnchor,
                    targetTime: ref.posTime,
                    unresolvedName: ref.wikiname,
                });
            }
            continue;
        }
        if (normPath(target) === normSelf) continue; // 自引用不算出链
        pending.push({ref, target});
        resolvedPaths.push(target);
    }
    if (pending.length > 0) {
        const exists = await filterExisting(resolvedPaths);
        for (const {ref, target} of pending) {
            if (!exists.has(target)) continue;
            items.push({
                kind: "md-file",
                sourcePath: target,
                title: basename(target),
                lineNo: ref.lineNo,
                snippet: ref.line,
                targetLine: ref.posLine,
                targetAnchor: ref.posAnchor,
                targetTime: ref.posTime,
            });
        }
    }
    if (syRefs.length > 0) {
        const briefs = await getBlockBriefs(syRefs.map(r => r.syBlockId!));
        for (const ref of syRefs) {
            const brief = briefs.get(ref.syBlockId!);
            items.push({
                kind: "siyuan-doc",
                sourcePath: brief?.rootId || "",
                title: brief?.title || `块 ${ref.syBlockId}`,
                docPath: brief?.hpath || "",
                blockId: ref.syBlockId,
                lineNo: ref.lineNo,
                snippet: ref.line,
            });
        }
    }
    await resolveAnchorLinesMulti(items);
    return items;
}

export async function findOutlinksCached(path: string, opts?: {force?: boolean}): Promise<BacklinkItem[]> {
    const norm = normPath(path);
    const key = collectScanRoots().join("|");
    const hit = outlinkCache.get(norm);
    if (!opts?.force && hit && hit.key === key) return hit.items;
    const items = await findOutlinks(path);
    outlinkCache.set(norm, {key, items});
    if (outlinkCache.size > 40) {
        const first = outlinkCache.keys().next();
        if (!first.done) outlinkCache.delete(first.value);
    }
    return items;
}

// ===== 思源块的外部引用(文件 → siyuan://blocks/<id>)=====

export interface BlockBrief {
    id: string;
    rootId: string;
    title: string;
    hpath: string;
}

// (( 块引用补全的候选搜索(与思源 (( 同语义:内容 LIKE,短内容优先)。
// 供 CM6/Monaco 补全源共用;空查询返回空(思源 (( 后也要求输入)。
export async function searchBlocksForRef(query: string, limit = 24): Promise<BlockBrief[]> {
    const q = String(query || "").trim();
    if (!q) return [];
    const esc = q.replace(/'/g, "''").replace(/[\\%_]/g, ch => "\\" + ch);
    try {
        const rows = await querySQL(
            `SELECT id, root_id, content, hpath, type FROM blocks ` +
            `WHERE content LIKE '%${esc}%' ORDER BY length(content) LIMIT ${limit}`);
        return (Array.isArray(rows) ? rows : []).map(row => ({
            id: String(row.id || ""),
            rootId: String(row.root_id || ""),
            title: blockTitle(String(row.content || ""), String(row.type || "p")).slice(0, 60) || String(row.id || ""),
            hpath: String(row.hpath || ""),
        })).filter(b => b.id);
    } catch {
        return [];
    }
}

// 批量取块简报(SQL;坏 ID/内核不可用静默跳过)
async function getBlockBriefs(ids: string[]): Promise<Map<string, BlockBrief>> {
    const out = new Map<string, BlockBrief>();
    const unique = [...new Set(ids)].filter(Boolean).slice(0, 64);
    if (unique.length === 0) return out;
    try {
        const list = unique.map(id => `'${id.replace(/'/g, "''")}'`).join(",");
        const rows = await querySQL(
            `SELECT id, root_id, content, hpath, type FROM blocks WHERE id IN (${list})`);
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const content = String(row.content || "");
                out.set(String(row.id || ""), {
                    id: String(row.id || ""),
                    rootId: String(row.root_id || ""),
                    title: blockTitle(content, String(row.type || "p")).slice(0, 60) || content.slice(0, 60),
                    hpath: String(row.hpath || ""),
                });
            }
        }
    } catch {
        // SQL 不可用:静默,条目以块 ID 兜底显示
    }
    return out;
}

// 引用某思源块/文档的所有文本文件(外部引用格式 siyuan://blocks/<id>)。
// asDoc=true 时文档级语义:引用块 ID 等于目标,或引用块所在文档(root)等于目标。
export async function findFileBlockRefs(targetId: string, asDoc: boolean): Promise<BacklinkItem[]> {
    const id = targetId.replace(/'/g, "''");
    const key = `${asDoc ? "doc" : "blk"}:${id}|${collectScanRoots().join("|")}`;
    const hit = blockRefCache.get(key);
    if (hit) return hit;
    const hitRefs: {ref: ExtractedRef; srcPath: string}[] = [];
    await forEachFileRef((ref, srcPath) => {
        if (ref.syBlockId) hitRefs.push({ref, srcPath});
    });
    const items: BacklinkItem[] = [];    if (hitRefs.length > 0) {
        const briefs = await getBlockBriefs(hitRefs.map(h => h.ref.syBlockId!));
        const seen = new Set<string>();
        for (const {ref, srcPath} of hitRefs) {
            const blockId = ref.syBlockId!;
            const brief = briefs.get(blockId);
            const matched = asDoc
                ? (blockId === targetId || brief?.rootId === targetId)
                : blockId === targetId;
            if (!matched) continue;
            const dedupe = `${srcPath}|${ref.lineNo}|${blockId}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            items.push({
                kind: "md-file",
                sourcePath: srcPath,
                title: basename(srcPath),
                lineNo: ref.lineNo,
                snippet: ref.line,
                blockId,
            });
        }
    }
    blockRefCache.set(key, items);
    if (blockRefCache.size > 64) {
        const first = blockRefCache.keys().next();
        if (!first.done) blockRefCache.delete(first.value);
    }
    return items;
}

// ===== 文件夹反链 =====

// 引用是否落在目录内:解析后的绝对路径位于 dirPath 之下
// (裸名 wikilink 先按索引解析成路径再判前缀)
function refInDir(ref: ExtractedRef, dirPath: string, index?: LinkIndex): boolean {
    if (ref.wikiname && index) {
        const hit = lookupInIndex(index, ref.wikiname);
        if (!hit) return false;
        return normPath(hit.path).startsWith(normPath(dirPath) + "/");
    }
    return normPath(ref.target).startsWith(normPath(dirPath) + "/");
}

// 查询思源文档中引用该目录内文件的位置(文件夹名 LIKE 粗筛,解析后按目录前缀精确验证)
async function findSiyuanDocRefsForDir(dirPath: string): Promise<BacklinkItem[]> {
    const name = basename(dirPath);
    if (!name) return [];
    return findSiyuanDocRefsWhere(siyuanLikeNames(name), (r, index) => refInDir(r, dirPath, index));
}

// 查找引用指定文件夹内文件的所有位置(思源文档 + 文本文件)。
// 扫描排除文件夹自身的文件:内部互链不算文件夹的外部反链。
export async function findDirBacklinks(dirPath: string): Promise<BacklinkItem[]> {
    const dirNorm = normPath(dirPath) + "/";
    const [docRefs, fileRefs] = await Promise.all([
        findSiyuanDocRefsForDir(dirPath),
        scanFileRefs(dirNorm, (ref, srcPath) =>
            !normPath(srcPath).startsWith(dirNorm) && refInDir(ref, dirPath)),
    ]);
    // 思源文档引用在前
    return [...docRefs, ...fileRefs];
}

// ===== 来源 3:思源原生反链(refs 表) =====

// 查询引用指定块/文档/笔记本的块(思源原生反链语义):
// - 传文档 id:直接引用该文档(def_block_id)或引用了文档内任意块(def_block_root_id)
// - 传块 id:引用该块本身
// - 传笔记本 id 时需同时传 box:引用了该笔记本内任意块
export async function findSiyuanRefBacklinks(targetId: string, box?: string): Promise<BacklinkItem[]> {
    const id = targetId.replace(/'/g, "''");
    // root_id 取引用目标所在文档的 root;引用锚文本优先(refs.content),回退引用块内容
    const COLS = "r.block_id, r.content AS ref_content, b.hpath, b.content AS block_content, ";
    const rows = box
        ? await querySQL(
            `SELECT ${COLS}d.root_id FROM refs r ` +
            `JOIN blocks d ON d.id = r.def_block_root_id ` +
            `LEFT JOIN blocks b ON b.id = r.block_id ` +
            `WHERE d.box = '${id}' LIMIT 512`)
        : await querySQL(
            `SELECT ${COLS}r.def_block_root_id AS root_id FROM refs r ` +
            `LEFT JOIN blocks b ON b.id = r.block_id ` +
            `WHERE r.def_block_id = '${id}' OR r.def_block_root_id = '${id}' LIMIT 512`);
    const items: BacklinkItem[] = [];
    const seen = new Set<string>();
    if (Array.isArray(rows)) {
        for (const row of rows) {
            const blockId: string = row.block_id || "";
            const rootId: string = row.root_id || "";
            if (!blockId || !rootId || seen.has(blockId)) continue;
            seen.add(blockId);
            const hpath: string = row.hpath || "";
            const title = hpath ? hpath.split("/").filter(Boolean).pop() || hpath : rootId;
            const snippet: string = String(row.ref_content || row.block_content || "");
            items.push({
                kind: "siyuan-doc",
                sourcePath: rootId,
                title,
                docPath: hpath,
                snippet: snippet.length > 160 ? snippet.slice(0, 160) + "…" : snippet,
                blockId,
            });
        }
    }
    return items;
}

// ===== 位置徽章(面板 / 弹窗 / 行号悬浮窗共用的小 UI 工具)=====
// 放数据层是因为三个 UI 都要用,而它们互相引用会绕出循环依赖。
// 颜色约定:行号链接(--line,蓝)= 主色;锚点链接(--anchor,紫)= 固定紫,与行号区分。

function blEscapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 秒 → h:mm:ss / mm:ss(时间点徽章显示用)
export function formatBacklinkTime(sec: number): string {
    const total = Math.floor(Math.max(0, Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 生成链接位置徽章 HTML:行号(蓝)/ 锚点(紫,解析到行时附行号)/ 时间点(蓝)
export function backlinkPosBadgeHTML(item: BacklinkItem): string {
    if (item.targetLine && item.targetAnchor) {
        return `<span class="syfe-blpos syfe-blpos--anchor" title="锚点 #${blEscapeHTML(item.targetAnchor)} → 第 ${item.targetLine} 行">#${blEscapeHTML(item.targetAnchor)} · L${item.targetLine}</span>`;
    }
    if (item.targetLine) {
        return `<span class="syfe-blpos syfe-blpos--line" title="链接指向第 ${item.targetLine} 行">→ L${item.targetLine}</span>`;
    }
    if (item.targetAnchor) {
        return `<span class="syfe-blpos syfe-blpos--anchor" title="锚点 #${blEscapeHTML(item.targetAnchor)}(标题未解析到行)">#${blEscapeHTML(item.targetAnchor)}</span>`;
    }
    if (item.targetTime !== undefined) {
        return `<span class="syfe-blpos syfe-blpos--line" title="链接指向时间点 ${formatBacklinkTime(item.targetTime)}">→ ${formatBacklinkTime(item.targetTime)}</span>`;
    }
    return "";
}
