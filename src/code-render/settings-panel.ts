/** 设置面板：规则管理 / 数据源管理 / 外观。直接铺在思源设置对话框里，不套中间 Dialog。 */
import { listRenderers, getRenderer } from "./registry";
import { bindPersist, getSettings, SETTINGS_NAME, uid, updateSettings } from "./settings";
import { testDataSource } from "./datasource";
import { restoreAll, closeAll } from "./inplace";
import { t } from "./i18n";
import { txt } from "./types";
import type { DataSource, RenderRule, Settings } from "./types";
import { button, h } from "./ui";

function field(label: string, control: HTMLElement): HTMLElement {
    const row = h("div", "cr-field");
    row.appendChild(h("label", "cr-field-label", label));
    row.appendChild(control);
    return row;
}

function textInput(value: string, placeholder = "", onCommit: (v: string) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "b3-text-field";
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("change", () => onCommit(input.value.trim()));
    return input;
}

function numberInput(value: number, onCommit: (v: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "b3-text-field";
    input.type = "number";
    input.min = "1";
    input.value = String(value);
    input.style.width = "120px";
    input.addEventListener("change", () => {
        const n = parseInt(input.value, 10);
        onCommit(Number.isFinite(n) && n > 0 ? n : 200);
    });
    return input;
}

function switchInput(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    const wrap = h("div", "cr-switch-wrap");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "b3-switch";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    wrap.appendChild(input);
    return wrap;
}

function selectInput(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "b3-select";
    for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
}

function patch(p: Partial<Settings>): void {
    updateSettings(p);
}

/* ------------------------------ 外观与行为 ------------------------------ */

function buildAppearance(): HTMLElement {
    const s = getSettings();
    const box = h("div", "cr-settings-block");

    const enableRow = h("div", "cr-row");
    enableRow.appendChild(h("span", "cr-row-label", t("enabled")));
    enableRow.appendChild(switchInput(s.enabled, (v) => {
        patch({ enabled: v });
        if (!v) { restoreAll(); closeAll(); }
    }));
    box.appendChild(enableRow);
    box.appendChild(h("div", "cr-hint", t("enabledDesc")));

    const autoRow = h("div", "cr-row");
    autoRow.appendChild(h("span", "cr-row-label", t("autoRender")));
    autoRow.appendChild(switchInput(s.autoRender, (v) => patch({ autoRender: v })));
    box.appendChild(autoRow);
    box.appendChild(h("div", "cr-hint", t("autoRenderDesc")));

    const btnRow = h("div", "cr-row");
    btnRow.appendChild(h("span", "cr-row-label", t("showToolbarButton")));
    btnRow.appendChild(switchInput(s.showToolbarButton, (v) => patch({ showToolbarButton: v })));
    box.appendChild(btnRow);
    box.appendChild(h("div", "cr-hint", t("showToolbarButtonDesc")));

    box.appendChild(
        field(
            t("renderTarget"),
            selectInput(
                [
                    { value: "both", label: t("targetBoth") },
                    { value: "inplace", label: t("targetInplace") },
                    { value: "panel", label: t("targetPanel") },
                ],
                s.renderTarget,
                (v) => patch({ renderTarget: v as Settings["renderTarget"] })
            )
        )
    );
    box.appendChild(h("div", "cr-hint", t("renderTargetDesc")));

    box.appendChild(
        field(
            t("maxRows"),
            numberInput(s.maxRows, (v) => patch({ maxRows: v }))
        )
    );

    box.appendChild(
        field(
            t("theme"),
            selectInput(
                [
                    { value: "auto", label: t("themeAuto") },
                    { value: "light", label: t("themeLight") },
                    { value: "dark", label: t("themeDark") },
                ],
                s.theme,
                (v) => patch({ theme: v as Settings["theme"] })
            )
        )
    );

    return box;
}

/* ------------------------------- 规则管理 ------------------------------- */

function buildRules(): HTMLElement {
    const box = h("div", "cr-settings-block");
    const list = h("div", "cr-rule-list");
    box.appendChild(list);

    const refresh = () => {
        list.replaceChildren();
        const rules = getSettings().rules;
        if (!rules.length) {
            list.appendChild(h("div", "cr-hint", t("noRule")));
        }
        for (const rule of rules) {
            list.appendChild(ruleRow(rule, refresh));
        }
    };

    const add = button(t("addRule"), "b3-button b3-button--outline cr-add-btn");
    add.onclick = () => {
        const rules = getSettings().rules.slice();
        const firstRenderer = listRenderers()[0];
        rules.push({
            id: uid(),
            lang: "",
            rendererId: firstRenderer?.id || "mysql",
            modeId: firstRenderer?.modes[0]?.id || "pretty",
            enabled: true,
            autoOpen: false,
        });
        patch({ rules });
        refresh();
    };
    box.appendChild(add);

    refresh();
    return box;
}

function ruleRow(rule: RenderRule, refresh: () => void): HTMLElement {
    const row = h("div", "cr-rule-row");

    const langInput = textInput(rule.lang, t("langPlaceholder"), (v) => {
        const rules = getSettings().rules.map((r) => (r.id === rule.id ? { ...r, lang: v.toLowerCase() } : r));
        patch({ rules });
    });
    langInput.style.width = "110px";
    row.appendChild(langInput);

    const renderers = listRenderers();
    const rendererSel = selectInput(
        renderers.map((r) => ({ value: r.id, label: txt(r.name) })),
        rule.rendererId,
        (v) => {
            const renderer = getRenderer(v);
            const rules = getSettings().rules.map((r) =>
                r.id === rule.id ? { ...r, rendererId: v, modeId: renderer?.modes[0]?.id || r.modeId } : r
            );
            patch({ rules });
            refresh();
        }
    );
    rendererSel.style.width = "150px";
    row.appendChild(rendererSel);

    const renderer = getRenderer(rule.rendererId);
    const modeSel = selectInput(
        (renderer?.modes || []).map((m) => ({ value: m.id, label: txt(m.name) })),
        rule.modeId,
        (v) => {
            const rules = getSettings().rules.map((r) => (r.id === rule.id ? { ...r, modeId: v } : r));
            patch({ rules });
        }
    );
    modeSel.style.width = "120px";
    row.appendChild(modeSel);

    const enableLabel = h("label", "cr-inline", t("enabled"));
    enableLabel.prepend(switchInput(rule.enabled, (v) => {
        const rules = getSettings().rules.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r));
        patch({ rules });
    }));
    row.appendChild(enableLabel);

    const autoLabel = h("label", "cr-inline", t("autoOpen"));
    autoLabel.prepend(switchInput(rule.autoOpen, (v) => {
        const rules = getSettings().rules.map((r) => (r.id === rule.id ? { ...r, autoOpen: v } : r));
        patch({ rules });
    }));
    row.appendChild(autoLabel);

    const del = button(t("delete"), "b3-button b3-button--text cr-del-btn");
    del.onclick = () => {
        patch({ rules: getSettings().rules.filter((r) => r.id !== rule.id) });
        refresh();
    };
    row.appendChild(del);

    return row;
}

/* ------------------------------ 数据源管理 ------------------------------ */

function buildDataSources(): HTMLElement {
    const box = h("div", "cr-settings-block");
    const list = h("div", "cr-ds-list");
    box.appendChild(list);

    const refresh = () => {
        list.replaceChildren();
        const items = getSettings().dataSources;
        if (!items.length) list.appendChild(h("div", "cr-hint", t("noDataSource")));
        for (const ds of items) list.appendChild(dataSourceRow(ds, refresh));
    };

    const add = button(t("addDataSource"), "b3-button b3-button--outline cr-add-btn");
    add.onclick = () => {
        const items = getSettings().dataSources.slice();
        const ds: DataSource = {
            id: uid("ds"),
            name: "MySQL",
            type: "http",
            url: "http://127.0.0.1:8080/query",
            token: "",
            readOnly: true,
        };
        items.push(ds);
        patch({ dataSources: items, defaultDataSourceId: getSettings().defaultDataSourceId || ds.id });
        refresh();
    };
    box.appendChild(add);

    refresh();
    return box;
}

function dataSourceRow(ds: DataSource, refresh: () => void): HTMLElement {
    const row = h("div", "cr-ds-row");

    const update = (p: Partial<DataSource>) => {
        patch({ dataSources: getSettings().dataSources.map((d) => (d.id === ds.id ? { ...d, ...p } : d)) });
    };

    const nameInput = textInput(ds.name, "", (v) => update({ name: v }));
    nameInput.style.width = "130px";
    row.appendChild(nameInput);

    const typeSel = selectInput(
        [
            { value: "siyuan-sqlite", label: t("siyuanSqlite") },
            { value: "http", label: t("httpProxy") },
        ],
        ds.type,
        (v) => {
            update({ type: v as DataSource["type"] });
            refresh();
        }
    );
    typeSel.style.width = "180px";
    row.appendChild(typeSel);

    if (ds.type === "http") {
        const urlInput = textInput(ds.url || "", "http://127.0.0.1:8080/query", (v) => update({ url: v }));
        urlInput.style.flex = "1";
        urlInput.style.minWidth = "180px";
        row.appendChild(urlInput);

        const tokenInput = textInput(ds.token || "", "token(可选)", (v) => update({ token: v }));
        tokenInput.style.width = "120px";
        row.appendChild(tokenInput);
    }

    const roLabel = h("label", "cr-inline", "只读");
    roLabel.prepend(switchInput(ds.readOnly, (v) => update({ readOnly: v })));
    row.appendChild(roLabel);

    const defLabel = h("label", "cr-inline", t("dsDefault"));
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "cr-default-ds";
    radio.className = "b3-radio";
    radio.checked = getSettings().defaultDataSourceId === ds.id;
    radio.addEventListener("change", () => {
        if (radio.checked) patch({ defaultDataSourceId: ds.id });
    });
    defLabel.prepend(radio);
    row.appendChild(defLabel);

    if (ds.type === "http") {
        const test = button(t("test"), "b3-button b3-button--text cr-mini-btn");
        test.onclick = async () => {
            test.disabled = true;
            const old = test.textContent;
            test.textContent = "…";
            try {
                await testDataSource(getSettings().dataSources.find((d) => d.id === ds.id) || ds);
                test.textContent = "OK";
            } catch (e) {
                test.textContent = "✕";
                test.title = (e as Error).message;
            } finally {
                test.disabled = false;
                setTimeout(() => {
                    test.textContent = old;
                }, 1500);
            }
        };
        row.appendChild(test);
    }

    const del = button(t("delete"), "b3-button b3-button--text cr-del-btn");
    del.onclick = () => {
        patch({
            dataSources: getSettings().dataSources.filter((d) => d.id !== ds.id),
            defaultDataSourceId:
                getSettings().defaultDataSourceId === ds.id ? "" : getSettings().defaultDataSourceId,
        });
        refresh();
    };
    row.appendChild(del);

    return row;
}

/* -------------------------------- 入口 -------------------------------- */

/** 代码块渲染设置的三个块(外观/规则/数据源)定义,供全局设置面板装配成单页 */
export function buildCodeRenderPages(deps: {
    saveData: (file: string, data: unknown) => Promise<unknown> | void;
    rescan: () => void;
}): Array<{id: string; label: string; desc: string; buildEl: () => HTMLElement}> {
    // 存对象（思源会自行 JSON.stringify）；loadData 返回原始字符串，读取侧再 parse。
    // persist 绑定在构建块定义时执行一次(全局面板首次 open 装配时触发)。
    bindPersist((s) => {
        void Promise.resolve(deps.saveData(SETTINGS_NAME, s)).catch(() => undefined);
        deps.rescan();
    });

    return [
        {id: "codeRenderAppearance", label: t("groupAppearance"), desc: t("groupRulesDesc"), buildEl: buildAppearance},
        {id: "codeRenderRules", label: t("groupRules"), desc: t("groupRulesDesc"), buildEl: buildRules},
        {id: "codeRenderSources", label: t("groupDataSource"), desc: t("groupDataSourceDesc"), buildEl: buildDataSources},
    ];
}
