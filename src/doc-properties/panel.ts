// 思源文档属性:侧边 dock 与文档标题下面板共用的渲染/编辑组件。
//
// 一份数据(getBlockAttrs)、一份渲染,两处挂载互相同步:任一处改完写内核后广播
// DOC_PROPERTIES_CHANGED_EVENT,另一处刷新;自己写的带 source uid,跳过以免重建
// DOM 打断正在输入的光标。
import {showMessage} from "siyuan";
import {
    BUILTIN_PROPS, PROP_TYPE_LABELS, PropEntry, customKey, isValidPropName, loadEntries,
    parseSchema, removeEntry, saveEntry, schemaFor, suggestNames, suggestValues,
    DOC_PROPERTIES_CHANGED_EVENT,
} from "./store";

let panelSeq = 0;

export interface DocPropertiesPanelHandle {
    element: HTMLElement;
    refresh(): void;
    dispose(): void;
}

export interface DocPropertiesPanelOptions {
    plugin: any;
    /** 每次刷新现读:焦点所在块优先,无焦点块时回退当前文档(块 id 同样适用于 getBlockAttrs) */
    getDocId: () => string | null;
    /** 外部宿主元素;不传则自己建一个 div */
    host?: HTMLElement;
    /** 面板标题(如「块属性」/「文档属性」),让使用者知道当前正在看谁的属性 */
    getLabel?: () => string;
}

function esc(s: unknown): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toDateTimeInput(v: string): string {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : "";
}

function controlHTML(e: PropEntry, listId: string): string {
    const v = esc(e.value);
    const attr = `data-key="${esc(e.key)}" data-type="${e.type}"`;
    switch (e.type) {
        case "checkbox":
            return `<input type="checkbox" class="syfe-dp__check" ${attr} ${e.value === "true" ? "checked" : ""}>`;
        case "number":
            return `<input type="number" class="b3-text-field syfe-dp__input" ${attr} value="${v}">`;
        case "date":
            return `<input type="date" class="b3-text-field syfe-dp__input" ${attr} value="${v}">`;
        case "datetime":
            return `<input type="datetime-local" class="b3-text-field syfe-dp__input" ${attr} value="${esc(toDateTimeInput(e.value))}">`;
        case "select":
            return `<input type="text" class="b3-text-field syfe-dp__input" ${attr} list="${listId}" value="${v}">
                <datalist id="${listId}">${e.options.map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist>`;
        default: // text / tags / link
            return `<input type="text" class="b3-text-field syfe-dp__input" ${attr} list="${listId}" value="${v}"
                placeholder="${e.type === "tags" ? "逗号分隔多个值" : ""}">
                <datalist id="${listId}"></datalist>`;
    }
}

export function createDocPropertiesPanel(opts: DocPropertiesPanelOptions): DocPropertiesPanelHandle {
    const uid = ++panelSeq;
    const element = opts.host || document.createElement("div");
    element.classList.add("syfe-dp");
    const nameListId = `syfe-dp-names-${uid}`;
    let docId: string | null = null;
    let entries: PropEntry[] = [];
    let pending: string[] = [];     // 已新增但还没写过值的属性(空值内核不落库)
    let disposed = false;
    let loadSeq = 0;
    const timers = new Map<string, number>();

    const schemas = () => parseSchema(opts.plugin.config?.docPropertiesSchema || "");

    const emit = () => window.dispatchEvent(new CustomEvent(DOC_PROPERTIES_CHANGED_EVENT, {
        detail: {source: uid},
    }));

    function rowHTML(e: PropEntry, i: number): string {
        const listId = `syfe-dp-val-${uid}-${i}`;
        if (e.readonly) {
            return `<div class="syfe-dp__row syfe-dp__row--ro">
                <span class="syfe-dp__name" title="${esc(e.key)}">${esc(e.name)}</span>
                <span class="syfe-dp__type" title="内核属性,只读">只读</span>
                <span class="syfe-dp__ctrl"><span class="syfe-dp__ro" title="${esc(e.value)}">${esc(e.value) || "—"}</span></span>
                <span class="syfe-dp__del syfe-dp__del--none"></span>
            </div>`;
        }
        return `<div class="syfe-dp__row">
            <span class="syfe-dp__name" title="${esc(e.name)}">${esc(e.name)}</span>
            <span class="syfe-dp__type" title="类型在「设置 → 文档属性」里按名称配置">${PROP_TYPE_LABELS[e.type]}</span>
            <span class="syfe-dp__ctrl">${controlHTML(e, listId)}</span>
            ${e.builtin
                ? `<span class="syfe-dp__del syfe-dp__del--none"></span>`
                : `<button class="syfe-dp__del" data-act="del" data-key="${esc(e.key)}" title="删除属性">×</button>`}
        </div>`;
    }

    function render(): void {
        const label = opts.getLabel?.() || "文档属性";
        element.innerHTML = `
            <div class="syfe-dp__head" title="${esc(docId || "")}">
                <span class="syfe-dp__title${label === "块属性" ? " is-block" : ""}">${esc(label)}</span>
                <span class="syfe-dp__count">${entries.length}</span>
                <span class="fn__flex-1"></span>
                <button class="syfe-dp__icon" data-act="refresh" title="重新读取">⟳</button>
            </div>
            <div class="syfe-dp__list">${entries.length
                ? entries.map(rowHTML).join("")
                : `<div class="syfe-dp__empty">暂无属性,在下方添加</div>`}</div>
            <div class="syfe-dp__add">
                <input class="b3-text-field syfe-dp__addinput" list="${nameListId}"
                       placeholder="+ 添加属性(输入名称后回车)" />
                <datalist id="${nameListId}"></datalist>
            </div>`;
    }

    /** 异步补候选:属性名(全库 + schema)与每行的值(按类型),并行查询。 */
    async function fillSuggestions(seq: number): Promise<void> {
        const names = await suggestNames(schemas(), entries.filter(e => !e.readonly).map(e => e.name));
        if (disposed || seq !== loadSeq) return;
        const nameDl = element.querySelector(`#${nameListId}`);
        if (nameDl) nameDl.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join("");
        await Promise.all(entries.map(async (e, i) => {
            if (e.readonly || e.type === "select") return;   // 只读行无需候选;下拉选项已在 render 里填好
            const vals = await suggestValues(e);
            if (disposed || seq !== loadSeq) return;
            const dl = element.querySelector(`#syfe-dp-val-${uid}-${i}`);
            if (dl) dl.innerHTML = vals.map(v => `<option value="${esc(v)}"></option>`).join("");
        }));
    }

    async function refresh(): Promise<void> {
        if (disposed) return;
        const seq = ++loadSeq;
        docId = opts.getDocId();
        if (!docId) {
            entries = [];
            render();
            return;
        }
        try {
            const list = await loadEntries(docId, schemas());
            if (disposed || seq !== loadSeq) return;
            const defs = schemas();
            for (const n of pending) {
                if (list.some(e => e.key === customKey(n))) continue;
                const s = schemaFor(defs, n);
                list.push({key: customKey(n), name: n, type: s?.type || "text",
                    value: "", options: s?.options || [], builtin: false});
            }
            entries = list;
            render();
            void fillSuggestions(seq);
        } catch (err) {
            if (disposed || seq !== loadSeq) return;
            element.innerHTML = `<div class="syfe-dp__empty">读取文档属性失败:${esc(String(err))}</div>`;
        }
    }

    function scheduleSave(key: string, value: string): void {
        window.clearTimeout(timers.get(key));
        timers.set(key, window.setTimeout(async () => {
            timers.delete(key);
            if (!docId || disposed) return;
            try {
                await saveEntry(docId, key, value);
                pending = pending.filter(n => customKey(n) !== key);
                emit();
            } catch (err) {
                console.warn("[syfe-dp] 保存属性失败:", err);
            }
        }, 350));
    }

    const onValueChange = (ev: Event) => {
        const el = (ev.target as HTMLElement).closest("[data-key]") as HTMLInputElement | null;
        if (!el || !el.matches("input")) return;
        const key = el.dataset.key || "";
        if (!key) return;
        const value = el.dataset.type === "checkbox" ? String(el.checked) : el.value;
        scheduleSave(key, value);
    };

    const onClick = (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const btn = target.closest("[data-act]") as HTMLElement | null;
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "refresh") {
            void refresh();
        } else if (act === "del" && btn.dataset.key && docId) {
            const key = btn.dataset.key;
            void (async () => {
                try {
                    await removeEntry(docId!, key);
                    pending = pending.filter(n => customKey(n) !== key);
                    emit();
                    void refresh();
                } catch (err) {
                    console.warn("[syfe-dp] 删除属性失败:", err);
                }
            })();
        }
    };

    const onKeydown = (ev: KeyboardEvent) => {
        if (ev.key !== "Enter") return;
        const input = ev.target as HTMLInputElement;
        if (!input.classList?.contains("syfe-dp__addinput")) return;
        ev.preventDefault();
        const raw = input.value.trim();
        if (!raw) return;
        const builtin = BUILTIN_PROPS.find(b => b.name === raw);
        if (builtin) {
            const row = Array.from(element.querySelectorAll(".syfe-dp__row")).find(
                r => r.querySelector("[data-key]")?.getAttribute("data-key") === builtin.key);
            (row?.querySelector("input") as HTMLInputElement | null)?.focus();
            return;
        }
        const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
        if (!isValidPropName(clean)) {
            showMessage("属性名只能用小写英文字母、数字和连字符,且以字母开头(思源内核限制)", 4000, "error");
            return;
        }
        if (entries.some(e => e.key === customKey(clean))) return;
        const s = schemaFor(schemas(), clean);
        entries.push({key: customKey(clean), name: clean, type: s?.type || "text",
            value: "", options: s?.options || [], builtin: false});
        pending.push(clean);
        render();
        void fillSuggestions(loadSeq);
        (element.querySelector(".syfe-dp__row:last-child input") as HTMLInputElement | null)?.focus();
    };

    const onExternal = (ev: Event) => {
        if ((ev as CustomEvent).detail?.source === uid) return;
        void refresh();
    };

    element.addEventListener("input", onValueChange);
    element.addEventListener("change", onValueChange);
    element.addEventListener("click", onClick);
    element.addEventListener("keydown", onKeydown);
    window.addEventListener(DOC_PROPERTIES_CHANGED_EVENT, onExternal);
    void refresh();

    return {
        element,
        refresh: () => void refresh(),
        dispose() {
            disposed = true;
            for (const t of timers.values()) window.clearTimeout(t);
            timers.clear();
            element.removeEventListener("input", onValueChange);
            element.removeEventListener("change", onValueChange);
            element.removeEventListener("click", onClick);
            element.removeEventListener("keydown", onKeydown);
            window.removeEventListener(DOC_PROPERTIES_CHANGED_EVENT, onExternal);
        },
    };
}
