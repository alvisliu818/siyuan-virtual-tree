/** 内置渲染器：MySQL / SQL。提供「美化」「表结构」「执行」三种模式。 */
import { getDataSource, getSettings, MODE_PRETTY, MODE_RUN, MODE_SCHEMA, RENDERER_MYSQL } from "../settings";
import type { CodeRenderer, RenderContext, RenderMode } from "../types";
import { isReadonlyStatement, runQuery } from "../datasource";
import { parseCreateTables } from "../sql/ddl";
import { formatSql } from "../sql/format";
import { highlightSqlInplace, highlightSqlLines, isBlankSql } from "../sql/tokenizer";
import { t } from "../i18n";
import {
    buildResultTable,
    button,
    codeBlockHtml,
    copyText,
    downloadText,
    escapeHtml,
    h,
    message,
    toCsv,
} from "../ui";

/** 记住上次选中的数据源，切换面板时不重置 */
let lastDataSourceId = "";

/** 把文本写回代码块并触发思源保存（等价于用户手动编辑） */
function writeBackToBlock(block: HTMLElement, text: string): boolean {
    const host = block.querySelector(":scope > .hljs") as HTMLElement | null;
    if (!host) return false;
    host.textContent = text;
    host.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
}

function emptyHint(text: string): HTMLElement {
    return h("div", "cr-empty", text);
}

function toolbar(...children: HTMLElement[]): HTMLElement {
    const bar = h("div", "cr-bar");
    children.forEach((c) => bar.appendChild(c));
    return bar;
}

async function withCopyFeedback(btn: HTMLButtonElement, text: string): Promise<void> {
    const ok = await copyText(text);
    const original = btn.textContent;
    btn.textContent = ok ? t("copied") : t("copy");
    setTimeout(() => {
        btn.textContent = original;
    }, 1200);
}

/* ------------------------------ 模式一：美化 ------------------------------ */

const prettyMode: RenderMode = {
    id: MODE_PRETTY,
    name: () => t("modePretty"),
    // 就地渲染：接管代码块自身的高亮（思源自带 hljs 语言表里没有 mysql，原生是灰色纯文本）
    inplace: (code) => {
        if (isBlankSql(code)) return null;
        return highlightSqlInplace(code);
    },
    render(ctx: RenderContext): HTMLElement {
        const root = h("div", "cr-mode cr-pretty");
        if (isBlankSql(ctx.code)) {
            root.appendChild(emptyHint(t("emptyCode")));
            return root;
        }

        const formatted = formatSql(ctx.code);
        const lines = highlightSqlLines(formatted);

        const copyBtn = button(t("copySql"), "b3-button b3-button--text cr-mini-btn");
        copyBtn.onclick = () => void withCopyFeedback(copyBtn, formatted);

        const fmtBtn = button(t("format"), "b3-button b3-button--text cr-mini-btn");
        fmtBtn.title = "将格式化结果写回代码块";
        fmtBtn.onclick = () => {
            if (writeBackToBlock(ctx.blockElement, formatted)) {
                const original = fmtBtn.textContent;
                fmtBtn.textContent = t("formatted");
                setTimeout(() => {
                    fmtBtn.textContent = original;
                }, 1200);
                ctx.refresh();
            }
        };

        root.appendChild(toolbar(copyBtn, fmtBtn));

        const code = h("div", "cr-code-host");
        code.innerHTML = codeBlockHtml(lines);
        root.appendChild(code);
        return root;
    },
};

/* ---------------------------- 模式二：表结构 ---------------------------- */

const schemaMode: RenderMode = {
    id: MODE_SCHEMA,
    name: () => t("modeSchema"),
    render(ctx: RenderContext): HTMLElement {
        const root = h("div", "cr-mode cr-schema");
        const tables = parseCreateTables(ctx.code);
        if (!tables.length) {
            root.appendChild(emptyHint(t("schemaEmpty")));
            return root;
        }

        for (const table of tables) {
            const card = h("div", "cr-tablecard");

            const head = h("div", "cr-tc-head");
            const title = h("div", "cr-tc-title");
            title.appendChild(h("span", "cr-tc-name", table.name));
            if (table.comment) title.appendChild(h("span", "cr-tc-comment", table.comment));
            head.appendChild(title);

            const meta: string[] = [];
            if (table.engine) meta.push("ENGINE=" + table.engine);
            if (table.charset) meta.push("CHARSET=" + table.charset);
            if (table.collation) meta.push("COLLATE=" + table.collation);
            if (table.autoIncrement) meta.push("AUTO_INCREMENT=" + table.autoIncrement);
            if (meta.length) head.appendChild(h("div", "cr-tc-meta", meta.join(" · ")));
            card.appendChild(head);

            if (table.columns.length) {
                const wrap = h("div", "cr-table-wrap");
                const tbl = h("table", "cr-table cr-schema-table");
                const thead = h("thead");
                const trh = h("tr");
                [t("field"), t("type"), t("nullable"), t("default"), t("comment")].forEach((x) =>
                    trh.appendChild(h("th", undefined, x))
                );
                thead.appendChild(trh);
                tbl.appendChild(thead);

                const tbody = h("tbody");
                for (const col of table.columns) {
                    const tr = h("tr");
                    const tdName = h("td", "cr-td-name");
                    tdName.appendChild(h("code", undefined, col.name));
                    if (col.primary) tdName.appendChild(h("span", "cr-badge cr-badge--pk", "PK"));
                    if (col.autoInc) tdName.appendChild(h("span", "cr-badge cr-badge--ai", "AI"));
                    if (!col.nullable && !col.primary) tdName.appendChild(h("span", "cr-badge cr-badge--nn", "NN"));
                    tr.appendChild(tdName);

                    const tdType = h("td", "cr-td-type");
                    tdType.textContent = col.type;
                    tdType.title = col.extra.length ? col.type + " " + col.extra.join(" ") : col.type;
                    tr.appendChild(tdType);

                    tr.appendChild(h("td", col.nullable ? "cr-yes" : "cr-no", col.nullable ? "YES" : "NO"));
                    tr.appendChild(h("td", "cr-td-def", col.defaultValue || "—"));
                    tr.appendChild(h("td", "cr-td-cmt", col.comment || "—"));
                    tbody.appendChild(tr);
                }
                tbl.appendChild(tbody);
                wrap.appendChild(tbl);
                card.appendChild(wrap);
            }

            if (table.indexes.length) {
                const idxBox = h("div", "cr-idx-box");
                idxBox.appendChild(h("div", "cr-idx-title", t("indexes")));
                for (const idx of table.indexes) {
                    const row = h("div", "cr-idx");
                    row.appendChild(h("span", `cr-badge cr-badge--${idx.kind.toLowerCase()}`, idx.kind));
                    row.appendChild(h("span", "cr-idx-name", idx.name || "(auto)"));
                    row.appendChild(h("span", "cr-idx-cols", `(${idx.columns.join(", ")})`));
                    if (idx.reference) {
                        row.appendChild(
                            h("span", "cr-idx-ref", `→ ${idx.reference.table}(${idx.reference.columns.join(", ")})`)
                        );
                    }
                    idxBox.appendChild(row);
                }
                card.appendChild(idxBox);
            }

            root.appendChild(card);
        }

        return root;
    },
};

/* ----------------------------- 模式三：执行 ----------------------------- */

const runMode: RenderMode = {
    id: MODE_RUN,
    name: () => t("modeRun"),
    render(ctx: RenderContext): HTMLElement {
        const root = h("div", "cr-mode cr-run");
        const settings = getSettings();

        if (!settings.dataSources.length) {
            root.appendChild(emptyHint(t("noDataSourceSelected")));
            return root;
        }

        const bar = h("div", "cr-bar");

        const select = document.createElement("select");
        select.className = "b3-select cr-select";
        for (const ds of settings.dataSources) {
            const opt = document.createElement("option");
            opt.value = ds.id;
            opt.textContent = ds.name + (ds.readOnly ? " · 只读" : "");
            select.appendChild(opt);
        }
        const preferred = settings.dataSources.some((d) => d.id === lastDataSourceId)
            ? lastDataSourceId
            : settings.defaultDataSourceId || settings.dataSources[0].id;
        select.value = preferred;
        lastDataSourceId = preferred;
        select.onchange = () => {
            lastDataSourceId = select.value;
        };
        bar.appendChild(select);

        const runBtn = button(t("run"), "b3-button b3-button--text cr-mini-btn cr-run-btn");
        bar.appendChild(runBtn);

        const status = h("span", "cr-run-status");
        bar.appendChild(status);
        root.appendChild(bar);

        const body = h("div", "cr-body");
        if (isBlankSql(ctx.code)) body.appendChild(emptyHint(t("emptyCode")));
        root.appendChild(body);

        let busy = false;

        const doRun = async () => {
            if (busy) return;
            const ds = getDataSource(select.value);
            if (!ds) {
                body.replaceChildren(emptyHint(t("noDataSourceSelected")));
                return;
            }
            const sql = ctx.code.trim();
            if (!sql) {
                body.replaceChildren(emptyHint(t("emptyCode")));
                return;
            }

            // 非只读语句二次确认，避免误删数据
            if (!isReadonlyStatement(sql)) {
                const text = t("runConfirmText", { name: ds.name });
                // eslint-disable-next-line no-alert
                if (!window.confirm(`${t("runConfirmTitle")}\n${text}\n${t("runHint")}`)) return;
            }

            busy = true;
            runBtn.disabled = true;
            runBtn.textContent = t("running");
            status.textContent = "";
            body.replaceChildren(h("div", "cr-empty", t("running")));

            try {
                const result = await runQuery(ds, sql, getSettings().maxRows);
                if (ctx.signal.aborted) return;
                const exportCsv = () => {
                    downloadText("query-result.csv", toCsv(result.columns, result.rows));
                };
                body.replaceChildren(buildResultTable(result, exportCsv));
            } catch (err) {
                if (ctx.signal.aborted) return;
                body.replaceChildren(message(`${t("errTitle")}: ${(err as Error)?.message || err}`, "error"));
            } finally {
                busy = false;
                runBtn.disabled = false;
                runBtn.textContent = t("run");
            }
        };

        runBtn.onclick = () => void doRun();
        return root;
    },
};

/* ------------------------------- 渲染器 ------------------------------- */

export const mysqlRenderer: CodeRenderer = {
    id: RENDERER_MYSQL,
    name: () => t("rendererMysqlName"),
    description: "SQL 高亮美化、DDL 表结构、SQL 执行结果",
    modes: [prettyMode, schemaMode, runMode],
};

export { escapeHtml };
