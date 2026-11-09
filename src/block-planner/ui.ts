// 思源块绑定:可搜索选择器 + 块旁徽标 + 任务/习惯状态双向同步。
//
// 徽标挂在块「外面」(block.after),与 code-block-run 同款:块内自定义 DOM 会被
// Lute 序列化进 .sy 正文。用 data-block-id 认领 + 位置检查 + 孤儿清理自愈。
import {openPlannerTab} from "../planner/tab";
import {PLANNER_CHANGED_EVENT} from "../planner/store";
import {
    BIND_LABELS, BIND_VIEWS, Binding, BindInfo, allCandidates, describe,
    isItemDone, loadAllBindings, saveBindings, setItemDone, syncableBindings,
} from "./store";

const BADGE_CLASS = "syfe-bp-badges";

let g_plugin: any = null;
let g_bindings = new Map<string, Binding[]>();
let g_observer: MutationObserver | null = null;
let g_scanTimer: number | undefined;
let g_suppressUntil = 0;
let g_picker: HTMLElement | null = null;
const hosts = new Map<string, HTMLElement>();
const lastSync = new Map<string, number>();
// 刚写过的绑定:内核属性写入到 SQL 可见有延迟,这段时间内以本地版本为准
const locallyWritten = new Map<string, {list: Binding[]; at: number}>();

function esc(s: unknown): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function suppress(ms = 1200): void {
    g_suppressUntil = Date.now() + ms;
}

export function bindingsOf(blockId: string): Binding[] {
    return (g_bindings.get(blockId) || []).slice();
}

/** 本地立即生效(内核属性写入到 SQL 可见可能有延迟),随后再 refreshBindings 校正。 */
export function setLocalBindings(blockId: string, list: Binding[]): void {
    if (list.length) g_bindings.set(blockId, list);
    else g_bindings.delete(blockId);
    locallyWritten.set(blockId, {list, at: Date.now()});
    scanBadges();
}

// ===== 可搜索选择器 =====

export function closeBindPicker(): void {
    g_picker?.remove();
    g_picker = null;
}

export function openBindPicker(onPick: (b: Binding) => void): void {
    closeBindPicker();
    const mask = document.createElement("div");
    mask.className = "syfe-bp-picker-mask";
    mask.innerHTML = `<div class="syfe-bp-picker">
        <div class="syfe-bp-picker__head">绑定习惯与目标项目</div>
        <input class="b3-text-field syfe-bp-picker__input" placeholder="搜索习惯 / 目标 / 任务 / 倒数日" />
        <div class="syfe-bp-picker__list"></div>
        <div class="syfe-bp-picker__tip">↑↓ 选择 · 回车绑定 · Esc 关闭</div>
    </div>`;
    document.body.appendChild(mask);
    g_picker = mask;
    const input = mask.querySelector(".syfe-bp-picker__input") as HTMLInputElement;
    const listEl = mask.querySelector(".syfe-bp-picker__list") as HTMLElement;
    const all = allCandidates();
    let shown: BindInfo[] = [];
    let focus = 0;

    const render = () => {
        const q = input.value.trim().toLowerCase();
        shown = all.filter(i => !q || i.name.toLowerCase().includes(q)
            || BIND_LABELS[i.type].toLowerCase().includes(q)).slice(0, 100);
        if (focus >= shown.length) focus = 0;
        listEl.innerHTML = shown.length
            ? shown.map((i, idx) => `<div class="syfe-bp-picker__item${idx === focus ? " is-active" : ""}" data-i="${idx}">
                <span class="syfe-bp-picker__type">${BIND_LABELS[i.type]}</span>
                <span class="syfe-bp-picker__icon">${esc(i.icon)}</span>
                <span class="syfe-bp-picker__name">${esc(i.name)}</span>
                <span class="syfe-bp-picker__state">${esc(i.state)}</span>
            </div>`).join("")
            : `<div class="syfe-bp-picker__empty">没有匹配的项目</div>`;
    };
    const pick = (idx: number) => {
        const item = shown[idx];
        if (!item) return;
        closeBindPicker();
        onPick({type: item.type, id: item.id});
    };
    input.addEventListener("input", () => { focus = 0; render(); });
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); closeBindPicker(); }
        else if (ev.key === "ArrowDown") { ev.preventDefault(); focus = Math.min(focus + 1, shown.length - 1); render(); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); focus = Math.max(focus - 1, 0); render(); }
        else if (ev.key === "Enter") { ev.preventDefault(); pick(focus); }
    });
    listEl.addEventListener("click", (ev) => {
        const el = (ev.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
        if (el) pick(Number(el.dataset.i));
    });
    mask.addEventListener("mousedown", (ev) => {
        if (ev.target === mask) closeBindPicker();
    });
    render();
    input.focus();
}

// ===== 块旁徽标 =====

function renderBadges(block: HTMLElement, id: string, list: Binding[]): void {
    let host = hosts.get(id);
    if (host && (!host.isConnected || host.previousElementSibling !== block)) {
        host.remove();
        hosts.delete(id);
        host = undefined;
    }
    if (!host) {
        host = document.createElement("div");
        host.className = BADGE_CLASS;
        host.dataset.blockId = id;
        host.setAttribute("contenteditable", "false");
        block.insertAdjacentElement("afterend", host);
        hosts.set(id, host);
    }
    host.innerHTML = describe(list).map((i, idx) =>
        `<span class="syfe-bp-badge${i.done ? " is-done" : ""}${i.missing ? " is-missing" : ""}"
            data-type="${i.type}" data-id="${esc(i.id)}"
            title="${BIND_LABELS[i.type]} · ${esc(i.name)} · 点击打开对应面板">
            <span class="syfe-bp-badge__icon">${esc(i.icon)}</span>
            <span class="syfe-bp-badge__name">${esc(i.name)}</span>
            <span class="syfe-bp-badge__state">${esc(i.state)}</span>
            <button class="syfe-bp-badge__del" data-del="${idx}" title="解绑">×</button>
        </span>`).join("");
}

export function scanBadges(): void {
    for (const [id, host] of hosts) {
        if (!g_bindings.has(id)) { host.remove(); hosts.delete(id); }
    }
    for (const [id, list] of g_bindings) {
        const block = document.querySelector(
            `.protyle-wysiwyg [data-node-id="${id}"]`) as HTMLElement | null;
        if (!block) {
            const h = hosts.get(id);
            if (h) { h.remove(); hosts.delete(id); }
            continue;
        }
        renderBadges(block, id, list);
    }
    syncBlocksFromPlanner();
}

export async function refreshBindings(): Promise<void> {
    const fresh = await loadAllBindings();
    const now = Date.now();
    for (const [id, rec] of locallyWritten) {
        if (now - rec.at < 3000) fresh.set(id, rec.list);
        else locallyWritten.delete(id);
    }
    g_bindings = fresh;
    scanBadges();
}

// ===== 状态双向同步 =====

function taskDoneOfBlock(block: HTMLElement): boolean {
    const t = block.getAttribute("data-task");
    if (t !== null) return t.trim() !== "" && t !== " ";
    return block.classList.contains("protyle-task--done");
}

function clickTaskToggle(block: HTMLElement): void {
    const action = block.querySelector(":scope > .protyle-action--task") as HTMLElement | null;
    if (!action) return;
    suppress();
    action.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, view: window}));
}

/** planner 状态 → 块勾选(监听 planner 变更事件 / 扫描时对齐)。 */
function syncBlocksFromPlanner(): void {
    if (Date.now() < g_suppressUntil) return;
    for (const [id, list] of g_bindings) {
        const syncable = syncableBindings(list);
        if (!syncable.length) continue;
        const block = document.querySelector(
            `.protyle-wysiwyg [data-node-id="${id}"]`) as HTMLElement | null;
        if (!block || block.getAttribute("data-subtype") !== "t") continue;
        const want = syncable.every(isItemDone);
        if (want !== taskDoneOfBlock(block)) clickTaskToggle(block);
    }
}

/** 块勾选 → planner(任务完成 / 习惯打卡),带同块 800ms 防抖。 */
function syncFromBlocks(blocks: Set<HTMLElement>): void {
    if (Date.now() < g_suppressUntil) return;
    for (const block of blocks) {
        const id = block.getAttribute("data-node-id") || "";
        const list = g_bindings.get(id);
        if (!list) continue;
        const syncable = syncableBindings(list);
        if (!syncable.length) continue;
        const now = Date.now();
        if (now - (lastSync.get(id) || 0) < 800) continue;
        lastSync.set(id, now);
        const done = taskDoneOfBlock(block);
        suppress();
        for (const b of syncable) setItemDone(g_plugin, b, done);
        scanBadges();
    }
}

const onBadgeClick = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement;
    const badge = target.closest(".syfe-bp-badge") as HTMLElement | null;
    if (!badge) return;
    const host = badge.closest(`.${BADGE_CLASS}`) as HTMLElement | null;
    const blockId = host?.dataset.blockId || "";
    if (!blockId || !g_plugin) return;
    if (target.closest("[data-del]")) {
        ev.preventDefault();
        ev.stopPropagation();
        const idx = Number((target.closest("[data-del]") as HTMLElement).dataset.del);
        void (async () => {
            const list = bindingsOf(blockId);
            list.splice(idx, 1);
            await saveBindings(blockId, list);
            setLocalBindings(blockId, list);
            void refreshBindings();
        })();
        return;
    }
    const type = badge.dataset.type as keyof typeof BIND_VIEWS;
    if (BIND_VIEWS[type]) {
        ev.preventDefault();
        ev.stopPropagation();
        openPlannerTab(g_plugin, {view: BIND_VIEWS[type]});
    }
};

const onPlannerChanged = () => {
    if (Date.now() < g_suppressUntil) return;
    scanBadges();
};

function scheduleScan(): void {
    window.clearTimeout(g_scanTimer);
    g_scanTimer = window.setTimeout(() => void refreshBindings(), 150);
}

export function initBlockPlannerUI(plugin: any): void {
    g_plugin = plugin;
    document.addEventListener("click", onBadgeClick, true);
    window.addEventListener(PLANNER_CHANGED_EVENT, onPlannerChanged);
    g_observer = new MutationObserver((muts) => {
        let needScan = false;
        const changed = new Set<HTMLElement>();
        for (const m of muts) {
            if (m.type === "childList") {
                for (const n of Array.from(m.addedNodes)) {
                    if (!(n instanceof HTMLElement)) continue;
                    if (n.classList.contains(BADGE_CLASS) || n.classList.contains("syfe-bp-picker-mask")) continue;
                    if (n.matches("[data-node-id]") || n.querySelector("[data-node-id]")) needScan = true;
                }
            } else if (m.type === "attributes" && m.target instanceof HTMLElement) {
                const el = m.target as HTMLElement;
                if (el.getAttribute("data-subtype") === "t" && el.getAttribute("data-node-id")) changed.add(el);
            }
        }
        if (needScan) scheduleScan();
        if (changed.size) syncFromBlocks(changed);
    });
    g_observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["data-task", "class"],
    });
    void refreshBindings();
}

export function destroyBlockPlannerUI(): void {
    document.removeEventListener("click", onBadgeClick, true);
    window.removeEventListener(PLANNER_CHANGED_EVENT, onPlannerChanged);
    g_observer?.disconnect();
    g_observer = null;
    window.clearTimeout(g_scanTimer);
    for (const h of hosts.values()) h.remove();
    hosts.clear();
    closeBindPicker();
    lastSync.clear();
    locallyWritten.clear();
    g_bindings.clear();
    g_plugin = null;
}
