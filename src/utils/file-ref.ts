// 带位置的文件链接(文件「双链」的位置部分)
//
// 需求:思源正文里点一个链接,就能打开**文件的对应位置** ——
//   - 文本文件 / Markdown:定位到某个标题(#锚点)或某一行(?line=N)
//   - 音视频:跳到某个时间点并播放(?t=12.5)
// 反过来,Tab 里也要能把「当前位置」复制成可直接粘进思源的 Markdown 链接。
//
// 链接形态(全部基于 file:// 原始路径,与 utils/system-path.ts 的约定一致:
// 思源从 v3.1.21 起不支持 percent-编码的 file:// 链接,所以路径段保持原样):
//   file:///E:/notes/foo.md#一级标题
//   file:///E:/notes/foo.md?line=42
//   file:///E:/notes/demo.mp4?t=12.5
// 锚点用标题文本的 slug(见 slugifyHeading),回放时按同一规则反查标题元素;
// 行号与时间用 query 参数,避免和 Markdown 自己的锚点语义打架。

import {basename} from "./path";
import {toFileLink, fileUrlToPath, urlNeedsAngleBracket} from "./system-path";

export interface FileRef {
    /** 文件绝对路径(正斜杠) */
    path: string;
    /** 标题锚点(Markdown 标题 slug) */
    anchor?: string;
    /** 行号(1-based;源码模式/纯文本) */
    line?: number;
    /** 音视频时间点(秒) */
    t?: number;
    /** 链接显示文字(缺省用文件名) */
    label?: string;
}

// 标题 → 锚点 slug。
// 只做「稳定且可逆到能反查」的归一化:剥掉 markdown 强调符号、链接语法、
// 空白转连字符、去掉 ASCII 标点。保留 CJK(中文标题是主力场景),
// 所以刻意不用 \p{L}(esbuild 在 es6 target 下会拒绝 unicode property escapes)。
export function slugifyHeading(text: string): string {
    const s = String(text || "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")   // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 文字
        .replace(/[`*_~]/g, "")                  // 强调/代码符号
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        // 去掉 ASCII 标点与空白类字符(保留字母数字、连字符、下划线、CJK 等)
        .replace(/[\x00-\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f]/g, "");
    return s;
}

/**
 * 在 Markdown 源码里反查标题锚点对应的行号(1-based)。
 * 锚点是 slugifyHeading 生成的 slug,这里按同一规则对每条标题重新计算后比对;
 * 跳过围栏代码块里的伪标题。找不到返回 null。
 */
export function headingLineOfAnchor(text: string, anchor: string): number | null {
    if (!text || !anchor) return null;
    const want = slugifyHeading(anchor);
    const lines = text.split("\n");
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fm = /^\s{0,3}(```|~~~)/.exec(line);
        if (fm) {
            fence = fence === null ? fm[1] : (fence === fm[1] ? null : fence);
            continue;
        }
        if (fence !== null) continue;
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (!m) continue;
        if (slugifyHeading(m[2]) === want) return i + 1;
    }
    return null;
}

/** 秒 → 链接里的紧凑写法(12.5 → "12.5") */
function fmtTime(sec: number): string {
    const v = Math.max(0, Number(sec) || 0);
    // 整数秒不带小数点,小数保留 1~3 位
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}

/** "12.5" / "1:02" / "1:02:03" → 秒 */
function parseTime(raw: string): number | undefined {
    const s = String(raw || "").trim();
    if (!s) return undefined;
    if (s.includes(":")) {
        const parts = s.split(":").map(p => Number(p));
        if (parts.some(p => !isFinite(p))) return undefined;
        let sec = 0;
        for (const p of parts) sec = sec * 60 + p;
        return sec;
    }
    const v = Number(s);
    return isFinite(v) ? v : undefined;
}

/**
 * 生成带位置的 file:// 链接。
 * 拿不到工作空间(思源虚拟路径无法还原)时退化为裸路径,至少保证片段可用。
 */
export function buildFileRefUrl(ref: FileRef): string {
    const base = toFileLink(ref.path) || ref.path;
    if (!base) return "";
    const q: string[] = [];
    if (ref.line && ref.line > 0) q.push("line=" + ref.line);
    if (ref.t !== undefined && isFinite(ref.t)) q.push("t=" + fmtTime(ref.t));
    let url = base;
    if (q.length > 0) url += (url.indexOf("?") >= 0 ? "&" : "?") + q.join("&");
    if (ref.anchor) url += "#" + ref.anchor;
    return url;
}

/** 生成 [label](url) 形式的 Markdown 链接(含空格/括号的 url 自动用 <...> 包裹) */
export function buildFileRefMd(ref: FileRef): string {
    const url = buildFileRefUrl(ref);
    if (!url) return "";
    const label = (ref.label || basename(ref.path) || ref.path).replace(/[[\]\\]/g, "\\$1");
    return urlNeedsAngleBracket(url) ? `[${label}](<${url}>)` : `[${label}](${url})`;
}

/**
 * 解析链接里蕴含的位置。
 * 接受 file:// 链接、带 query/hash 的裸路径,也接受纯路径(此时只有 path)。
 * URL 里的锚点可能是别的工具写的原文(非 slug),这里原样返回交给调用方匹配。
 */
export function parseFileRef(raw: string): FileRef | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    let anchor = "";
    let query = "";
    let core = s;

    const hi = core.indexOf("#");
    if (hi >= 0) {
        anchor = core.slice(hi + 1);
        core = core.slice(0, hi);
    }
    const qi = core.indexOf("?");
    if (qi >= 0) {
        query = core.slice(qi + 1);
        core = core.slice(0, qi);
    }
    const path = (fileUrlToPath(core) || core).replace(/\\/g, "/");
    if (!path) return null;

    const ref: FileRef = {path};
    if (anchor) {
        // 锚点可能是 percent-编码(别的工具生成),尝试解码一次
        let a = anchor;
        if (/%[0-9a-fA-F]{2}/.test(a)) {
            try { a = decodeURIComponent(a); } catch { /* 保持原样 */ }
        }
        ref.anchor = a;
    }
    if (query) {
        const params = new URLSearchParams(query);
        const line = Number(params.get("line"));
        if (isFinite(line) && line > 0) ref.line = Math.floor(line);
        const t = parseTime(params.get("t") || "");
        if (t !== undefined) ref.t = t;
        // 兼容 #t=12.5 这种常见的媒体时间锚点写法
        const anchorT = /^(?:t=)?([\d.:]+)$/.exec(anchor || "");
        if (t === undefined && anchorT) {
            const av = parseTime(anchorT[1]);
            if (av !== undefined) ref.t = av;
        }
    }
    return (ref.anchor || ref.line || ref.t !== undefined) ? ref : null;
}

/** 剥掉位置片段,只留文件路径(给 openFileTab 用) */
export function stripFileRef(raw: string): string {
    const s = String(raw || "").trim();
    const cut = s.search(/[?#]/);
    const core = cut >= 0 ? s.slice(0, cut) : s;
    return (fileUrlToPath(core) || core).replace(/\\/g, "/");
}

// ===== 待消费的位置(打开文件时一次性生效)=====
// 只有位置信息才进队列:路径本身由页签 data 携带,不必重复。
const pending = new Map<string, FileRef>();

function keyOf(path: string): string {
    return String(path || "").replace(/\\/g, "/");
}

/** 登记待生效的位置(下一次打开/复用该文件的页签时消费) */
export function setPendingRef(path: string, ref: FileRef): void {
    const k = keyOf(path);
    if (!k) return;
    pending.set(k, {...ref, path: k});
}

/** 只看不删:打开入口要先判断是复用页签还是新建页签 */
export function peekPendingRef(path: string): FileRef | null {
    return pending.get(keyOf(path)) || null;
}

/** 取出并删除 */
export function consumePendingRef(path: string): FileRef | null {
    const k = keyOf(path);
    const ref = pending.get(k);
    if (ref) pending.delete(k);
    return ref || null;
}
