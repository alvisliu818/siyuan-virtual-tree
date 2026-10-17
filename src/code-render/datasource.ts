/**
 * 数据源执行：思源内置 SQLite（/api/query/sql）与自定义 HTTP 代理（外部 MySQL）。
 */
import { fetchPost } from "siyuan";
import type { DataSource, QueryResult } from "./types";

const READONLY_PREFIX = /^\s*(select|show|describe|desc|explain|with|pragma|analyze)\b/i;

export class QueryError extends Error {}

export function isReadonlyStatement(sql: string): boolean {
    return READONLY_PREFIX.test(sql);
}

function toColumnRows(data: unknown, maxRows: number): { columns: string[]; rows: unknown[][]; truncated: boolean } {
    if (!Array.isArray(data)) return { columns: [], rows: [], truncated: false };

    // 形式一：{columns: [], rows: [[]]}
    const first = data[0];
    if (first && !Array.isArray(first) && typeof first === "object" && Array.isArray((first as any).columns)) {
        const columns = ((first as any).columns as unknown[]).map(String);
        const rows = ((first as any).rows as unknown[][]) || [];
        const truncated = rows.length > maxRows;
        return { columns, rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
    }

    // 形式二：对象数组 [{a:1,b:2}]
    if (data.length && first && typeof first === "object" && !Array.isArray(first)) {
        const columns: string[] = [];
        for (const item of data as Record<string, unknown>[]) {
            for (const key of Object.keys(item)) {
                if (!columns.includes(key)) columns.push(key);
            }
        }
        const truncated = data.length > maxRows;
        const list = (truncated ? data.slice(0, maxRows) : data) as Record<string, unknown>[];
        const rows = list.map((item) => columns.map((c) => item[c]));
        return { columns, rows, truncated };
    }

    // 形式三：二维数组（无列名）
    if (data.length && Array.isArray(first)) {
        const rows = (data as unknown[][]).slice(0, maxRows);
        const columns = rows[0]?.map((_, i) => `col_${i + 1}`) || [];
        return { columns, rows, truncated: data.length > maxRows };
    }

    return { columns: [], rows: [], truncated: false };
}

/** 在指定数据源上执行 SQL */
export async function runQuery(ds: DataSource, sql: string, maxRows: number): Promise<QueryResult> {
    const stmt = sql.trim().replace(/;\s*$/, "");
    if (!stmt) throw new QueryError("SQL 为空");
    if (ds.readOnly && !isReadonlyStatement(stmt)) {
        throw new QueryError("该数据源已设为只读，仅允许执行 SELECT / SHOW / DESCRIBE / EXPLAIN");
    }

    const started = performance.now();
    let columns: string[] = [];
    let rows: unknown[][] = [];
    let truncated = false;
    let affectedRows: number | undefined;

    if (ds.type === "siyuan-sqlite") {
        const res = await fetchPost("/api/query/sql", {
            stmt,
            mode: ds.readOnly ? "readonly" : "",
        });
        if (!res || res.code !== 0) {
            throw new QueryError(res?.msg || "查询失败");
        }
        const parsed = toColumnRows(res.data, maxRows);
        columns = parsed.columns;
        rows = parsed.rows;
        truncated = parsed.truncated;
        if (!columns.length && Array.isArray(res.data) && res.data.length === 0) {
            affectedRows = 0;
        }
    } else {
        if (!ds.url) throw new QueryError("HTTP 数据源缺少代理地址");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (ds.token) headers["Authorization"] = "Bearer " + ds.token;
        const resp = await fetch(ds.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ sql: stmt, maxRows }),
        });
        if (!resp.ok) throw new QueryError(`HTTP ${resp.status} ${resp.statusText}`);
        const json = await resp.json().catch(() => {
            throw new QueryError("代理返回的不是合法 JSON");
        });
        if (json && typeof json === "object" && "error" in json) {
            throw new QueryError(String((json as any).error));
        }
        const payload = json && typeof json === "object" && "data" in json ? (json as any).data : json;
        const parsed = toColumnRows(payload, maxRows);
        columns = parsed.columns;
        rows = parsed.rows;
        truncated = parsed.truncated;
        if (json && typeof json === "object" && typeof (json as any).affectedRows === "number") {
            affectedRows = (json as any).affectedRows;
        }
    }

    return {
        columns,
        rows,
        affectedRows,
        elapsedMs: Math.round(performance.now() - started),
        truncated,
    };
}

/** 测试数据源连通性 */
export async function testDataSource(ds: DataSource): Promise<string> {
    if (ds.type === "siyuan-sqlite") {
        const res = await fetchPost("/api/query/sql", { stmt: "SELECT 1 AS ok", mode: "readonly" });
        if (!res || res.code !== 0) throw new QueryError(res?.msg || "连接失败");
        return "OK";
    }
    if (!ds.url) throw new QueryError("缺少代理地址");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ds.token) headers["Authorization"] = "Bearer " + ds.token;
    const resp = await fetch(ds.url, { method: "POST", headers, body: JSON.stringify({ sql: "SELECT 1 AS ok", maxRows: 1 }) });
    if (!resp.ok) throw new QueryError(`HTTP ${resp.status}`);
    return "OK";
}
