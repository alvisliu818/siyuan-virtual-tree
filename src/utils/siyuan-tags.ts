// 思源**原生标签**(blocks 表 type='t' 的标签块),与思源自带的「标签」面板同一套数据。
// 与插件自己的路径标签(src/tags/tag-store.ts)是两套东西:原生标签存在思源文档里,
// 会出现在思源的标签面板 / 标签页签 / 反向链接里,跨设备同步。
//
// 标签块在 blocks 表里 content 形如 "#标签名#",type='t'。
// 思源没有"给块加标签"的专用 API,加标签就是**插入一个标签块**。
import {querySQL} from "../api/file";

function authHeaders(): Record<string, string> {
    const w = window as any;
    const token = w?.siyuan?.config?.system?.conf?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
}

async function post<T = any>(url: string, data: any): Promise<T> {
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

function esc(s: string): string {
    return String(s || "").replace(/'/g, "''");
}

// "#标签名#" / "#标签名" → "标签名"
export function normalizeTag(raw: string): string {
    return String(raw || "").trim().replace(/^#+/, "").replace(/#+$/, "").trim();
}

// 查询某文档(块)已有的原生标签
export async function listDocTags(rootId: string): Promise<string[]> {
    const rows = await querySQL(
        `SELECT content FROM blocks WHERE type = 't' AND root_id = '${esc(rootId)}' ORDER BY created ASC`);
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
        const t = normalizeTag(r?.content || "");
        if (t && !seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}

// 工作区里出现过的全部原生标签(给输入框做建议)
export async function listAllTags(): Promise<string[]> {
    try {
        const rows = await querySQL("SELECT DISTINCT content FROM blocks WHERE type = 't' ORDER BY updated DESC LIMIT 500");
        if (!Array.isArray(rows)) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of rows) {
            const t = normalizeTag(r?.content || "");
            if (t && !seen.has(t)) {
                seen.add(t);
                out.push(t);
            }
        }
        return out;
    } catch {
        return [];
    }
}

// 取文档最后一个顶层块(标签块插在它之后 = 文末)
async function lastTopBlockId(rootId: string): Promise<string> {
    const rows = await querySQL(
        `SELECT id FROM blocks WHERE root_id = '${esc(rootId)}' AND parent_id = '${esc(rootId)}' ORDER BY sort DESC LIMIT 1`);
    return Array.isArray(rows) && rows[0] && rows[0].id ? String(rows[0].id) : "";
}

// 给文档加一个原生标签;已存在则直接返回 true(幂等)
export async function addDocTag(rootId: string, tag: string): Promise<void> {
    const name = normalizeTag(tag);
    if (!name) throw new Error("标签名不能为空");
    const current = await listDocTags(rootId);
    if (current.includes(name)) return;
    const lastId = await lastTopBlockId(rootId);
    if (!lastId) throw new Error("文档为空,无法添加标签");
    await post("/api/block/insertBlock", {
        dataType: "markdown",
        data: `#${name}#`,
        previousID: lastId,
    });
}

// 移除文档上的某个原生标签
export async function removeDocTag(rootId: string, tag: string): Promise<void> {
    const name = normalizeTag(tag);
    if (!name) return;
    // 标签块 content 形如 "#标签名#",按 root_id 精确定位,避免误删同名标签块
    const rows = await querySQL(
        `SELECT id, content FROM blocks WHERE type = 't' AND root_id = '${esc(rootId)}' AND content IN ('#${esc(name)}#', '#${esc(name)}')`);
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
        if (normalizeTag(r.content) !== name) continue;
        await post("/api/block/removeBlock", {id: String(r.id)});
    }
}
