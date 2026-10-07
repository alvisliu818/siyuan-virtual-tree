// 思源块查询:虚拟文档树挂载「思源块」后要按 parent_id 递归展开子块。
// 数据来源:内核 SQL(blocks 表)。块的标题取 content(去掉 markdown 标记后截断)。
import {querySQL} from "../api/file";

export interface BlockNode {
    id: string;
    content: string;
    type: string;
}

// 单引号转义,防注入(块 id 来自菜单/存储,仍按不可信处理)
function esc(s: string): string {
    return String(s || "").replace(/'/g, "''");
}

// 列出某个块的直接子块(按文档顺序 sort 升序;无 sort 列时退回不排序)
export async function listChildBlocks(parentId: string): Promise<BlockNode[]> {
    const id = esc(parentId);
    let rows: any[] = [];
    try {
        rows = await querySQL(
            `SELECT id, content, type FROM blocks WHERE parent_id = '${id}' ORDER BY sort ASC`);
    } catch {
        // 某些版本/场景没有 sort 列,退回无序查询
        try {
            rows = await querySQL(`SELECT id, content, type FROM blocks WHERE parent_id = '${id}'`);
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
