// 「代码编辑器」设置页:把注册表里全部 editor.* 设置项铺成控件。
//
// 这些控件改的就是 settings.json(与 VS Code 的"设置 UI 写 settings.json"一致),
// 所以面板和文件不会打架:面板改完写文件,文件在编辑器里改完保存也会回写面板。
//
// 面板结构由全局设置树(../settings/plugin-settings-dialog.ts)接管后:
// - 「代码编辑器」父页 = buildEditorAllPanel()(工具条 + 全部子组平铺)
// - 每个子分类 = buildEditorGroupPanel(name)(单组)
// 组 DOM 只构建一次并缓存,父页与子页共享同一份(切换时 DOM 移动,不重复构建)。
import {Menu, showMessage} from "siyuan";
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

// 组面板缓存:组 DOM 全生命周期只构建一次(行控件与监听同步保留)
const groupCache = new Map<string, HTMLElement>();

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

// ---------- 字体族"+"选择器 ----------

// 候选字体:常见等宽/编程字体 + 常见中文字体(用 canvas 宽度探测是否真的安装,
// 不依赖 Local Font Access API 权限 —— Electron 里 queryLocalFonts 默认被拒)。
const FONT_CANDIDATES: string[] = [
    "Consolas", "Cascadia Code", "Cascadia Mono", "Courier New", "Lucida Console",
    "JetBrains Mono", "Fira Code", "Fira Mono", "Source Code Pro", "IBM Plex Mono",
    "Roboto Mono", "Ubuntu Mono", "DejaVu Sans Mono", "Inconsolata", "Hack",
    "Victor Mono", "Iosevka", "Maple Mono", "LXGW WenKai Mono", "霞鹜文楷 等宽",
    "Sarasa Mono SC", "Sarasa Term SC", "更纱黑体 Mono", "Menlo", "Monaco",
    "SF Mono", "Andale Mono", "Liberation Mono", "Noto Sans Mono", "Noto Sans Mono CJK SC",
    "Microsoft YaHei Mono", "微软雅黑", "等线", "黑体", "宋体",
];

/** 用 canvas 测宽探测候选字体哪些真的装了(未安装时回退 monospace,宽度与基准一致) */
function detectInstalledFonts(): string[] {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 60;
        const ctx = canvas.getContext("2d");
        if (!ctx) return [];
        // 探测文本:等宽字形密集 + 中文字形,保证等宽字体之间、等宽与 CJK 字体之间有宽度差
        const probe = "mmmwwwiiilll1009一國體";
        const baseW = (() => {
            ctx.font = "48px monospace";
            return ctx.measureText(probe).width;
        })();
        return FONT_CANDIDATES.filter(name => {
            ctx.font = `48px "${name}", monospace`;
            const w = ctx.measureText(probe).width;
            return Math.abs(w - baseW) > 0.5;
        });
    } catch {
        return [];
    }
}

/** 把选中的字体名追加到字体族输入框(带空格的名字自动加引号,逗号分隔) */
function appendFontFamily(input: HTMLInputElement, font: string): void {
    const token = /\s/.test(font) ? `'${font}'` : font;
    const cur = input.value.trim();
    // 已存在(不区分引号)就不重复追加
    const exists = cur.split(",").some(part => part.trim().replace(/^['"]|['"]$/g, "") === font);
    if (exists) {
        showMessage(`字体族里已有 ${font}`, 2000, "info");
        return;
    }
    input.value = cur ? `${cur.replace(/,\s*$/, "")}, ${token}` : token;
    input.dispatchEvent(new Event("change"));
}

/** 弹出字体列表菜单(仅列出探测到的已安装字体) */
function openFontPicker(input: HTMLInputElement, btn: HTMLElement): void {
    const installed = detectInstalledFonts();
    // 第三个参 independent=true:独立菜单。共用全局菜单时,首次弹出后全局菜单的
    // data-name 残留为同 id → 再次构造 isOpen=true → addItem/open 全部被跳过,菜单永不弹出
    const menu = new Menu("syfe-font-picker", () => undefined, true);
    if (installed.length === 0) {
        menu.addItem({iconHTML: "", label: "未检测到候选字体", click: () => undefined});
    } else {
        for (const font of installed) {
            menu.addItem({
                iconHTML: "",
                label: font,
                click: () => appendFontFamily(input, font),
            });
        }
    }
    const rect = btn.getBoundingClientRect();
    menu.open({x: rect.left, y: rect.bottom + 4});
}

// ---------- 单个设置项 ----------

function buildRow(d: SettingDef): {row: HTMLElement; sync: () => void} {
    const row = h("div", "syfe-es__row");
    row.dataset.key = d.key;
    // 全局设置搜索的匹配文本(键名+标题+说明+分组)
    row.dataset.tags = `${d.key} ${d.title} ${d.description} ${d.group}`.toLowerCase();

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
        if (d.fontPicker) {
            // 字体族:输入框尾部加"+"按钮,弹出系统已安装字体列表选中追加
            const wrap = h("div", "b3-form__group");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "4px";
            wrap.style.flex = "1";
            input.style.flex = "1";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "b3-button b3-button--text";
            btn.title = "从系统字体列表添加";
            btn.style.padding = "0 6px";
            btn.style.fontSize = "16px";
            btn.style.lineHeight = "1";
            btn.textContent = "+";
            btn.addEventListener("click", () => openFontPicker(input, btn));
            wrap.appendChild(input);
            wrap.appendChild(btn);
            control = wrap;
        } else {
            control = input;
        }
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

// ---------- 组与页 ----------

/** 编辑器子分类清单(组名 + 项数),供全局设置树生成二级树节点 */
export function getEditorSubgroups(): Array<{name: string; count: number}> {
    const byGroup = new Map<string, number>();
    EDITOR_DEFS.forEach(d => byGroup.set(d.group, (byGroup.get(d.group) || 0) + 1));
    const names = [...byGroup.keys()];
    const ordered = [...GROUP_ORDER.filter(g => byGroup.has(g)), ...names.filter(g => GROUP_ORDER.indexOf(g) < 0)];
    return ordered.map(name => ({name, count: byGroup.get(name) || 0}));
}

/** 构建单个子分类面板(缓存共享;每次调用都返回同一份 DOM) */
export function buildEditorGroupPanel(name: string): HTMLElement {
    let group = groupCache.get(name);
    if (group) return group;
    ensureRegistered();
    group = h("div", "syfe-es__group");
    group.dataset.group = name;
    group.appendChild(h("div", "syfe-es__grouptitle", name));
    for (const d of EDITOR_DEFS) {
        if (d.group !== name) continue;
        group.appendChild(buildRow(d).row);
    }
    groupCache.set(name, group);
    return group;
}

function ensureRegistered(): void {
    if (registered) return;
    registered = true;
    registerSettingsChangedHandler(() => refreshEditorSettingsUi());
}

/** 「代码编辑器」父页:工具条(搜索/打开 settings.json/恢复默认) + 全部子组平铺 */
export function buildEditorAllPanel(): HTMLElement {
    ensureRegistered();
    const root = h("div", "syfe-es");

    // 工具条:搜索 / 打开 settings.json / 恢复默认
    const bar = h("div", "syfe-es__bar");
    const search = document.createElement("input");
    search.className = "b3-text-field syfe-es__search";
    search.type = "text";
    search.placeholder = "搜索编辑器设置(键名或中文名)…";
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

    // 全部子组平铺(组 DOM 来自缓存,与子页共享)
    const body = h("div", "syfe-es__body syfe-es__body--all");
    const rowsOf = new Map<HTMLElement, Array<HTMLElement>>();
    for (const {name} of getEditorSubgroups()) {
        const group = buildEditorGroupPanel(name);
        rowsOf.set(group, Array.from(group.querySelectorAll<HTMLElement>(".syfe-es__row")));
        body.appendChild(group);
    }
    root.appendChild(body);

    // 父页内搜索过滤:跨组平铺(命中的组显示,组内只留命中行),清空恢复
    search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        for (const [group, rows] of rowsOf) {
            const groupName = group.dataset.group || "";
            let visible = 0;
            rows.forEach(row => {
                const def = EDITOR_DEFS.find(d => d.key === row.dataset.key);
                const hay = `${row.dataset.key} ${def?.title || ""} ${def?.description || ""} ${groupName}`.toLowerCase();
                const hit = !q || hay.indexOf(q) >= 0;
                row.style.display = hit ? "" : "none";
                if (hit) visible++;
            });
            group.style.display = visible ? "" : "none";
        }
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
