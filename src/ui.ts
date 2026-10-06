/** 通用 UI 片段：元素创建、结果表格、复制、CSV 导出。 */
import { escapeHtml } from "./dom";
import { t } from "./i18n";
import type { QueryResult } from "./types";

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

export function button(label: string, className = "b3-button b3-button--outline"): HTMLButtonElement {
    const b = h("button", className, label);
    b.type = "button";
    return b;
}

export function fmtCell(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "object") {
        try {
            return JSON.stringify(v);
        } catch {
            return String(v);
        }
    }
    return String(v);
}

export function cellToNode(v: unknown): HTMLElement {
    const span = h("span", "cr-cell");
    if (v === null || v === undefined) {
        span.classList.add("cr-null");
        span.textContent = "NULL";
    } else {
        const text = fmtCell(v);
        span.textContent = text;
        if (typeof v === "number") span.classList.add("cr-num-cell");
        if (text.length > 120) span.title = text;
    }
    return span;
}

function csvEscape(v: unknown): string {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
    const head = columns.map(csvEscape).join(",");
    const body = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    // BOM 让 Excel 正确识别 UTF-8
    return "\ufeff" + head + (body ? "\r\n" + body : "");
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 1000);
}

export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 回退到 execCommand */
    }
    try {
        const ta = h("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

export function message(text: string, kind: "info" | "error" = "info"): HTMLElement {
    return h("div", `cr-msg cr-msg--${kind}`, text);
}

/** 结果统计条 + 表格 */
export function buildResultTable(result: QueryResult, onExport?: () => void): HTMLElement {
    const wrap = h("div", "cr-result");

    const bar = h("div", "cr-result-bar");
    const rows = result.rows.length;
    const cols = result.columns.length;
    const stat =
        typeof result.affectedRows === "number" && rows === 0
            ? `${result.affectedRows} ${t("rows")} · ${result.elapsedMs}ms`
            : `${rows} ${t("rows")} × ${cols} ${t("cols")} · ${result.elapsedMs}ms`;
    bar.appendChild(h("span", "cr-stat", stat));
    if (result.truncated) {
        bar.appendChild(h("span", "cr-warn", t("truncated", { n: rows })));
    }
    if (onExport && rows > 0) {
        const exp = button(t("exportCsv"), "b3-button b3-button--text cr-mini-btn");
        exp.onclick = onExport;
        bar.appendChild(exp);
    }
    wrap.appendChild(bar);

    if (!rows) {
        wrap.appendChild(h("div", "cr-empty", typeof result.affectedRows === "number" ? "OK" : t("emptyCode")));
        return wrap;
    }

    const scroller = h("div", "cr-table-wrap");
    const table = h("table", "cr-table");
    const thead = h("thead");
    const trh = h("tr");
    result.columns.forEach((c, i) => {
        const th = h("th", undefined, c || `col_${i + 1}`);
        th.title = c || `col_${i + 1}`;
        trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = h("tbody");
    for (const row of result.rows) {
        const tr = h("tr");
        row.forEach((v) => {
            const td = h("td");
            td.appendChild(cellToNode(v));
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    return wrap;
}

export function codeBlockHtml(lines: string[]): string {
    const body = lines
        .map(
            (line, i) =>
                `<div class="cr-line"><span class="cr-ln">${i + 1}</span><span class="cr-lcode">${
                    line || "&nbsp;"
                }</span></div>`
        )
        .join("");
    return `<div class="cr-code">${body}</div>`;
}

export { escapeHtml };
