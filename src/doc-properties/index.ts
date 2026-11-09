// 思源文档属性面板:模块入口(侧边 dock + 文档标题下插入 + 全局当前文档同步)。
//
// 插入位置经实机确认:.protyle-title 在 .protyle-top 内、.protyle-wysiwyg 外
// (titleInsideWysiwyg=false),所以插在它后面既贴近 Obsidian 属性面板的位置,
// 又不会被 protyle 序列化进文档正文。
import {DOC_PROPERTIES_DOCK_TYPE} from "../constants";
import {DOC_PROPERTIES_CHANGED_EVENT} from "./store";
import {createDocPropertiesPanel, DocPropertiesPanelHandle} from "./panel";

let g_plugin: any = null;
let g_currentDocId = "";
let g_registered = false;
let g_scanTimer: number | undefined;
let g_focusTimer: number | undefined;
const g_initialTimers: number[] = [];
const inlinePanels = new Map<HTMLElement, {host: HTMLElement; panel: DocPropertiesPanelHandle; docId: string}>();
let dockPanel: DocPropertiesPanelHandle | null = null;

export function getCurrentDocId(): string {
    return g_currentDocId;
}

function activeDocIdFromDOM(): string {
    const wnd = document.querySelector(".layout__wnd--active") || document;
    const el = (wnd.querySelector(".protyle-title[data-node-id]")
        || document.querySelector(".protyle-title[data-node-id]")) as HTMLElement | null;
    return el?.getAttribute("data-node-id") || "";
}

export function setCurrentDocId(id: string): void {
    if (!id || id === g_currentDocId) return;
    g_currentDocId = id;
    window.dispatchEvent(new CustomEvent(DOC_PROPERTIES_CHANGED_EVENT, {detail: {docChanged: true}}));
}

function scheduleScan(): void {
    window.clearTimeout(g_scanTimer);
    g_scanTimer = window.setTimeout(scanInline, 120);
}

function clearInline(): void {
    for (const rec of inlinePanels.values()) {
        rec.panel.dispose();
        rec.host.remove();
    }
    inlinePanels.clear();
}

function scanInline(): void {
    if (!g_plugin) return;
    if (g_plugin.config?.docPropertiesShowInDoc !== true) {
        clearInline();
        return;
    }
    const seen = new Set<HTMLElement>();
    document.querySelectorAll<HTMLElement>(".protyle").forEach(protyleEl => {
        const title = protyleEl.querySelector<HTMLElement>(".protyle-title[data-node-id]");
        const docId = title?.getAttribute("data-node-id") || "";
        if (!title || !docId) return;
        seen.add(protyleEl);
        const old = inlinePanels.get(protyleEl);
        if (old && old.docId === docId && old.host.isConnected
            && old.host.previousElementSibling === title) return;
        if (old) {
            old.panel.dispose();
            old.host.remove();
            inlinePanels.delete(protyleEl);
        }
        const host = document.createElement("div");
        host.className = "syfe-dp-inline";
        title.insertAdjacentElement("afterend", host);
        const panel = createDocPropertiesPanel({
            plugin: g_plugin, host, getDocId: () => docId,
        });
        inlinePanels.set(protyleEl, {host, panel, docId});
    });
    for (const [protyleEl, rec] of inlinePanels) {
        if (seen.has(protyleEl)) continue;
        rec.panel.dispose();
        rec.host.remove();
        inlinePanels.delete(protyleEl);
    }
}

const onProtyleEvent = (e: any) => {
    const id = e?.detail?.protyle?.block?.rootID || activeDocIdFromDOM();
    if (id) setCurrentDocId(id);
    scheduleScan();
};

// 点击分屏/页签时补一次当前文档(switch-protyle 不一定覆盖所有切换路径)
const onFocusClick = () => {
    window.clearTimeout(g_focusTimer);
    g_focusTimer = window.setTimeout(() => {
        const id = activeDocIdFromDOM();
        if (id) setCurrentDocId(id);
        scheduleScan();
    }, 200);
};

export function initDocProperties(plugin: any): void {
    if (g_registered) return;
    g_registered = true;
    g_plugin = plugin;
    g_currentDocId = activeDocIdFromDOM();
    plugin.eventBus.on("loaded-protyle-static", onProtyleEvent);
    plugin.eventBus.on("loaded-protyle-dynamic", onProtyleEvent);
    plugin.eventBus.on("switch-protyle", onProtyleEvent);
    document.addEventListener("click", onFocusClick, true);
    // 布局恢复的文档晚于 onload:600ms / 2000ms 双补扫(同 code-render 的惯例)
    g_initialTimers.push(window.setTimeout(() => {
        setCurrentDocId(activeDocIdFromDOM());
        scanInline();
    }, 600));
    g_initialTimers.push(window.setTimeout(() => {
        setCurrentDocId(activeDocIdFromDOM());
        scanInline();
    }, 2000));
    scanInline();
}

/** 设置保存后调用:显隐重扫 + 通知所有面板按新 schema 重绘。 */
export function notifyDocPropertiesConfigChanged(plugin?: any): void {
    if (plugin) g_plugin = plugin;
    scanInline();
    window.dispatchEvent(new CustomEvent(DOC_PROPERTIES_CHANGED_EVENT, {detail: {configChanged: true}}));
}

export function destroyDocProperties(): void {
    if (!g_registered) return;
    g_registered = false;
    if (g_plugin?.eventBus?.off) {
        g_plugin.eventBus.off("loaded-protyle-static", onProtyleEvent);
        g_plugin.eventBus.off("loaded-protyle-dynamic", onProtyleEvent);
        g_plugin.eventBus.off("switch-protyle", onProtyleEvent);
    }
    document.removeEventListener("click", onFocusClick, true);
    clearInline();
    dockPanel = null;   // dock 实例自己会在 destroy 里 dispose
    for (const t of g_initialTimers) window.clearTimeout(t);
    g_initialTimers.length = 0;
    window.clearTimeout(g_scanTimer);
    window.clearTimeout(g_focusTimer);
    g_plugin = null;
}

export function createDocPropertiesDockConfig(plugin: any) {
    return {
        type: DOC_PROPERTIES_DOCK_TYPE,
        config: {
            position: "RightBottom" as const,
            size: {width: 320, height: 0},
            icon: "iconInfo",
            title: "文档属性",
            hotkey: "",
            show: false,
            index: 3,
        },
        data: {},
        init(this: any) {
            this.element.classList.add("syfe-dp-dock", "fn__flex-column");
            this.element.innerHTML = "";
            const host = document.createElement("div");
            host.className = "syfe-dp-dock__body fn__flex-1";
            this.element.appendChild(host);
            dockPanel = createDocPropertiesPanel({
                plugin, host, getDocId: () => getCurrentDocId(),
            });
            this._dpPanel = dockPanel;
        },
        destroy(this: any) {
            this._dpPanel?.dispose();
            if (dockPanel === this._dpPanel) dockPanel = null;
            this._dpPanel = undefined;
        },
    };
}
