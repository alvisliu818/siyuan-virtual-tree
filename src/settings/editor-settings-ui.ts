// 设置面板里的「代码编辑器」分组:把注册表里全部 editor.* 设置项铺成控件。
//
// 这些控件改的就是 settings.json(与 VS Code 的"设置 UI 写 settings.json"一致),
// 所以面板和文件不会打架:面板改完写文件,文件在编辑器里改完保存也会回写面板。
import {showMessage} from "siyuan";
import {
    EDITOR_DEFS,
    GROUP_ORDER,
    SettingDef,
    normalizeValue,
    parseNumberList,
} from "./setting-defs";
import {
    applyEditorOptions,
    flushUserSettings,
    getResolved,
    getSettingsPath,
    openSettingsJsonFile,
    registerSettingsChangedHandler,
    removeUserValue,
    setUserValue,
} from "./user-settings";

// 每个控件的"从设置回读"函数,供外部(settings.json 保存后)统一刷新
const syncFns: Array<() => void> = [];
let registered = false;

function h(tag: string, className?: string, text?: string): HTMLElement {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/** 值 → 控件显示字符串 */
function toControlText(d: SettingDef, value: any): string {
    if (d.kind === "numberArray") return Array.isArray(value) ? value.join(",") : "";
    if (value === undefined || value === null) return "";
    return String(value);
}

/** 控件字符串 → 值 */
function fromControlText(d: SettingDef, text: string): any {
    if (d.kind === "numberArray") return parseNumberList(text);
    return normalizeValue(d, text);
}

// ---------- 单个设置项 ----------

function buildRow(d: SettingDef): {row: HTMLElement; sync: () => void} {
    const row = h("div", "syfe-es__row");
    row.dataset.key = d.key;

    const head = h("div", "syfe-es__head");
    const title = h("div", "syfe-es__title");
    title.appendChild(h("span", "syfe-es__titletext", d.title));
    title.appendChild(h("code", "syfe-es__key", d.key));
    head.appendChild(title);

    let control: HTMLElement;
    let read: () => void;
    let sync: () => void;

    if (d.kind === "boolean") {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "b3-switch";
        control = input;
        read = () => setUserValue(d.key, input.checked);
        sync = () => { input.checked = getResolved(d.key) !== false; };
        input.addEventListener("change", () => {
            read();
            afterChange(d);
        });
    } else if (d.kind === "enum") {
        const sel = document.createElement("select");
        sel.className = "b3-select";
        (d.enum || []).forEach(v => {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = d.enumLabels?.[v] || v;
            sel.appendChild(opt);
        });
        control = sel;
        read = () => setUserValue(d.key, sel.value);
        sync = () => { sel.value = toControlText(d, getResolved(d.key)); };
        sel.addEventListener("change", () => {
            read();
            afterChange(d);
        });
    } else {
        const input = document.createElement("input");
        input.className = "b3-text-field";
        if (d.kind === "number") {
            input.type = "number";
            if (typeof d.min === "number") input.min = String(d.min);
            if (typeof d.max === "number") input.max = String(d.max);
        } else {
            input.type = "text";
            if (d.placeholder) input.placeholder = d.placeholder;
        }
        control = input;
        read = () => setUserValue(d.key, fromControlText(d, input.value));
        sync = () => { input.value = toControlText(d, getResolved(d.key)); };
        input.addEventListener("change", () => {
            read();
            afterChange(d);
        });
    }

    head.appendChild(control);
    row.appendChild(head);
    row.appendChild(h("div", "syfe-es__desc", d.description));
    syncFns.push(sync);
    sync();
    return {row, sync};
}

/** 改完一项之后:立即对所有已打开的编辑器生效 */
function afterChange(d: SettingDef): void {
    applyEditorOptions();
    // 只有影响布局/字体的项需要提醒重排,Monaco 的 updateOptions 自己会 layout
    void d;
}

// ---------- 整块 ----------

export function buildEditorSettingsBlock(): HTMLElement {
    syncFns.length = 0;
    if (!registered) {
        registered = true;
        registerSettingsChangedHandler(() => refreshEditorSettingsUi());
    }

    const root = h("div", "syfe-es");

    // 工具条:搜索 / 打开 settings.json / 恢复默认
    const bar = h("div", "syfe-es__bar");
    const search = document.createElement("input");
    search.className = "b3-text-field syfe-es__search";
    search.type = "text";
    search.placeholder = "搜索设置(键名或中文名)…";
    bar.appendChild(search);

    const openBtn = document.createElement("button");
    openBtn.className = "b3-button b3-button--outline";
    openBtn.textContent = "打开 settings.json";
    openBtn.addEventListener("click", () => {
        void openSettingsJsonFile();
    });
    bar.appendChild(openBtn);

    const resetBtn = document.createElement("button");
    resetBtn.className = "b3-button b3-button--outline";
    resetBtn.textContent = "恢复默认";
    resetBtn.addEventListener("click", () => {
        EDITOR_DEFS.forEach(d => removeUserValue(d.key));
        void flushUserSettings().then(() => {
            applyEditorOptions();
            refreshEditorSettingsUi();
            showMessage("代码编辑器设置已恢复默认", 2500, "info");
        });
    });
    bar.appendChild(resetBtn);
    root.appendChild(bar);

    root.appendChild(
        h(
            "div",
            "syfe-es__hint",
            `这里改的就是 settings.json(${getSettingsPath() || "插件存储目录"}),` +
            `两者始终一致;也可以直接打开该文件按 VS Code 的习惯手写。`,
        ),
    );

    // 左树 + 右内容(VS Code 式):分组行一次性全部构建,切换分类只切 display——
    // syncFns 因此只收集一次,不会随切换重复增长
    const main = h("div", "syfe-es__main");
    const nav = h("div", "syfe-es__nav");
    const body = h("div", "syfe-es__body");

    const groups: Array<{name: string; el: HTMLElement; rows: HTMLElement[]; navItem: HTMLElement}> = [];
    const byGroup = new Map<string, SettingDef[]>();
    EDITOR_DEFS.forEach(d => {
        const list = byGroup.get(d.group) || [];
        list.push(d);
        byGroup.set(d.group, list);
    });
    const ordered = [...GROUP_ORDER.filter(g => byGroup.has(g)), ...[...byGroup.keys()].filter(g => GROUP_ORDER.indexOf(g) < 0)];

    let active = "";
    try {
        active = localStorage.getItem("syfe-es-category") || "";
    } catch {
        // localStorage 不可用时落到第一组
    }
    if (ordered.indexOf(active) < 0) active = ordered[0] || "";

    const select = (name: string) => {
        active = name;
        try {
            localStorage.setItem("syfe-es-category", name);
        } catch {
            // 忽略
        }
        if (search.value) search.value = "";
        groups.forEach(g => {
            const on = g.name === name;
            g.el.style.display = on ? "" : "none";
            g.navItem.classList.toggle("syfe-es__navitem--active", on);
        });
        body.scrollTop = 0;
    };

    for (const name of ordered) {
        const defs = byGroup.get(name) || [];
        const group = h("div", "syfe-es__group");
        group.appendChild(h("div", "syfe-es__grouptitle", name));
        const rows: HTMLElement[] = [];
        for (const d of defs) {
            const {row} = buildRow(d);
            group.appendChild(row);
            rows.push(row);
        }
        const navItem = h("div", "syfe-es__navitem", `${name} (${defs.length})`);
        navItem.title = name;
        navItem.addEventListener("click", () => select(name));
        nav.appendChild(navItem);
        groups.push({name, el: group, rows, navItem});
        body.appendChild(group);
    }
    main.appendChild(nav);
    main.appendChild(body);
    root.appendChild(main);
    select(active);

    // 搜索过滤:跨分组平铺(命中的组都显示,组内只留命中行),左侧树取消高亮;
    // 清空搜索回到当前选中分类
    search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        if (!q) {
            select(active);
            return;
        }
        groups.forEach(g => {
            g.navItem.classList.remove("syfe-es__navitem--active");
            let visible = 0;
            g.rows.forEach(row => {
                const def = EDITOR_DEFS.find(d => d.key === row.dataset.key);
                const hay = `${row.dataset.key} ${def?.title || ""} ${def?.description || ""} ${g.name}`.toLowerCase();
                const hit = hay.indexOf(q) >= 0;
                row.style.display = hit ? "" : "none";
                if (hit) visible++;
            });
            g.el.style.display = visible ? "" : "none";
        });
    });

    return root;
}

/** 设置被外部(settings.json)改动后,把面板控件回读到最新值 */
export function refreshEditorSettingsUi(): void {
    syncFns.forEach(fn => {
        try {
            fn();
        } catch {
            // 单个控件回读失败不影响其它
        }
    });
}
