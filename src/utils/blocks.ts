// 思源块查询:虚拟文档树挂载「思源块」后要按 parent_id 递归展开子块。
// 数据来源:内核 SQL(blocks 表)。块的标题取 content(去掉 markdown 标记后截断)。
import {querySQL} from "../api/file";

export interface BlockNode {
    id: string;
    content: string;
    type: string;
    subtype: string;    // 细分类型:标题 h1-h6、列表 u/o/t(块标图标与渲染细化用)
    markdown: string;   // 原始 Markdown(图片/表格等非文字块的行内预览用)
    name: string;       // 块命名(blocks.name,表格块在树上的标题显示用)
}

// 单引号转义,防注入(块 id 来自菜单/存储,仍按不可信处理)
function esc(s: string): string {
    return String(s || "").replace(/'/g, "''");
}

// 列出某个块的直接子块(按文档顺序 sort 升序;无 sort 列时退回不排序)
export async function listChildBlocks(parentId: string): Promise<BlockNode[]> {
    const id = esc(parentId);
    const cols = "id, content, type, subtype, markdown, name";
    let rows: any[] = [];
    try {
        rows = await querySQL(
            `SELECT ${cols} FROM blocks WHERE parent_id = '${id}' ORDER BY sort ASC`);
    } catch {
        // 某些版本/场景没有 sort 列,退回无序查询
        try {
            rows = await querySQL(`SELECT ${cols} FROM blocks WHERE parent_id = '${id}'`);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(rows)) return [];
    return rows
        .filter(r => r && r.id)
        .map(r => ({
            id: String(r.id),
            content: String(r.content == null ? "" : r.content),
            type: String(r.type || "p"),
            subtype: String(r.subtype || ""),
            markdown: String(r.markdown == null ? "" : r.markdown),
            name: String(r.name == null ? "" : r.name),
        }));
}

// 查询单个块(取 content 与所属文档 rootID,用于显示标题与打开定位)
export async function getBlock(blockId: string): Promise<{content: string; type: string; rootId: string} | null> {
    const id = esc(blockId);
    try {
        const rows = await querySQL(
            `SELECT content, type, root_id FROM blocks WHERE id = '${id}' LIMIT 1`);
        if (Array.isArray(rows) && rows[0]) {
            return {
                content: String(rows[0].content == null ? "" : rows[0].content),
                type: String(rows[0].type || "p"),
                rootId: String(rows[0].root_id || ""),
            };
        }
    } catch {
        // 查询失败视为不存在
    }
    return null;
}

// content → 可读标题:去图片/链接/强调标记、去首尾空白、单行化、超长截断
export function blockTitle(content: string, type = "p"): string {
    let s = String(content || "");
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]");   // 图片
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");         // 链接保留文字
    s = s.replace(/`([^`]*)`/g, "$1");                     // 行内代码
    s = s.replace(/[*_~]{1,3}/g, "");                     // 强调/删除线
    s = s.replace(/<[^>]+>/g, "");                        // 内联 HTML 标签
    s = s.replace(/\s+/g, " ").trim();
    if (!s) return type === "d" ? "(空文档)" : "(空块)";
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

// blocks.type/subtype → 思源块标(gutter)图标,与思源前端映射保持一致。
// 参考思源源码 app/src/protyle/gutter.ts 的类型→图标表:
// 标题按层级 H1-H6,列表按有序/无序/任务细分,其余一一对应。
export function blockGutterIcon(type: string, subtype = ""): string {
    switch (type) {
        case "d": return "iconFile";             // NodeDocument
        case "p": return "iconParagraph";        // NodeParagraph
        case "h": {                              // NodeHeading:h1-h6 → iconH1..iconH6
            const m = /^h[1-6]$/.test(subtype) ? subtype.toUpperCase() : "";
            return m ? "icon" + m : "iconHeadings";
        }
        case "t": return "iconTable";            // NodeTable
        case "c": return "iconCode";             // NodeCodeBlock
        case "l":                                // NodeList:u/o/t
            return subtype === "t" ? "iconCheck" : (subtype === "o" ? "iconOrderedList" : "iconList");
        case "li": return "iconListItem";        // NodeListItem
        case "b": return "iconQuote";            // NodeBlockquote
        case "s": return "iconSuper";            // NodeSuperBlock
        case "math": return "iconMath";          // NodeMathBlock
        case "html": return "iconHTML5";         // NodeHTMLBlock
        case "av": return "iconDatabase";        // NodeAttributeView
        case "query_embed": return "iconSQL";    // NodeBlockQueryEmbed
        case "i": case "iframe": return "iconGlobe";   // NodeIFrame
        case "w": case "widget": return "iconBoth";    // NodeWidget
        case "video": return "iconVideo";
        case "audio": return "iconRecord";
        default: return "iconParagraph";
    }
}

// 段落 markdown 是否为「整段只有一张图」;命中返回地址/提示文本(alt)/标题(title)。
// 思源图片语法:`![提示文本](assets/x.png "标题")`,提示文本与标题都可缺省。
export interface SoloImage {
    src: string;    // 资源地址,如 assets/x.png
    alt: string;    // 提示文本(markdown alt)
    title: string;  // 标题(markdown title,可缺省)
}
const SOLO_IMG_RE = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)\s*$/;

export function soloImageInfo(markdown: string): SoloImage | null {
    const m = SOLO_IMG_RE.exec(String(markdown || ""));
    if (!m) return null;
    const unesc = (s: string) => s.replace(/\\(["\\])/g, "$1");
    return {alt: unesc(m[1] || ""), src: m[2], title: m[3] ? unesc(m[3]) : ""};
}

export function soloImageSrc(markdown: string): string | null {
    return soloImageInfo(markdown)?.src || null;
}

// 把图片 markdown 的标题(title)替换为 newTitle(空串 = 移除标题);提示文本与地址原样保留。
// 返回 null 表示不是单图段落(内容已变化,调用方放弃写入)。
export function imageMarkdownWithTitle(markdown: string, newTitle: string): string | null {
    const m = SOLO_IMG_RE.exec(String(markdown || ""));
    if (!m) return null;
    const esc = newTitle.replace(/["\\]/g, "\\$&");
    return `![${m[1]}](<${m[2]}>${esc ? ` "${esc}"` : ""})`;
}
