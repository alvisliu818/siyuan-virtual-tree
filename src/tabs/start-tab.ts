// 新标签页:接管思源顶部「+」后打开的启动台。
// 内容:顶部文件搜索框(索引文件名,↑↓ 选择、回车打开)+ 固定区 + 最近打开 + 收藏。
// 固定/收藏数据来自 src/start-page.ts;最近打开来自 src/recent-files.ts(含思源文档)。
import {openTab, showMessage} from "siyuan";
import {START_TAB_TYPE} from "../constants";
import {EditorConfig} from "../types";
import {basename, dirname} from "../utils/path";
import {fileIconHTML} from "../utils/icons";
import {enumerateAll} from "../components/search-panel";
import {openEntry, showEntryMenu} from "../components/entry-menu";
import {getRecentEntries, RECENTS_CHANGED_EVENT} from "../recent-files";
import {
    getPinned,
    getFavorites,
    removeFromGroup,
    StartGroup,
    StartPageItem,
    START_PAGE_CHANGED_EVENT,
} from "../start-page";
import {openFileTab} from "./editor-tab";

// 新标签页所需的插件接口
export interface IPluginForStartTab {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
    getFileTreeRoot(): string;
    openFileSplit(path: string, position: "right" | "bottom"): void;
}

// Tab 实例上附加的字段
interface StartTabInstance {
    element: HTMLElement;
    parent?: { updateTitle?: (t: string) => void };
    _bodyEl?: HTMLElement;
    _suggestEl?: HTMLElement;
    _hintEl?: HTMLElement;
    _inputEl?: HTMLInputElement;
    _items?: PageItem[];          // 当前渲染的全部条目(按 data-idx 回查)
    _clickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
    _actionHandler?: (e: MouseEvent) => void;
    _keyHandler?: (e: KeyboardEvent) => void;
    _inputHandler?: () => void;
    _changedHandler?: () => void;
    _suggest?: SuggestItem[];     // 当前搜索建议
    _suggestIndex?: number;
    _entries?: Array<{path: string; name: string; isDir: boolean}>; // 文件名索引
    _indexing?: boolean;
}

// 页面内统一条目(文件 / 思源文档)
interface PageItem {
    kind: "file" | "doc";
    path?: string;
    id?: string;
    title: string;
    sub: string;      // 次行:父目录 或 文档 hpath
    group: StartGroup | "recent";
}

// 搜索建议条目
interface SuggestItem {
    path: string;
    name: string;
    isDir: boolean;
}

// 各区显示条数上限
const RECENT_LIMIT = 20;
const SUGGEST_LIMIT = 40;

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// === 顶部「+」接管 ===
// 思源布局顶部的「新建文档」按钮是 <span data-type="new" class="block__icon ...">,
// 点击后在 Wnd 的冒泡监听里调 newFile()。这里在**捕获阶段**拦截,改为打开新标签页。
// 注意:文件树 Dock 的「新建子文档」按钮也有 data-type="new",但 class 是 b3-list-item__action,
// 用 .block__icon 限定即可避免误伤。
// 分屏:每个分屏的标签栏都有自己的 + 按钮。思源自己的处理(setPanelFocus → 聚焦所点分屏)
// 在冒泡阶段,会被这里的 stopPropagation 拦掉,因此必须手动把**所点分屏**置为焦点分屏,
// 否则 openTab 永远把新页签开到之前聚焦的那个分屏(其余分屏的 + 看起来"没反应")。
let hijackInstalled = false;
let hijackBypass = false;
let startTabSeq = 0; // 每个起始页实例的唯一 data;否则思源按 type+data 去重,永远只会有一个起始页

// 生成起始页的实例标识。带时间戳:布局恢复会把旧实例的 data 带回来,
// 纯递增计数器重启后归零会与旧值撞车,又被思源去重合并。
function nextStartTabData(): {instance: string} {
    return {instance: `${Date.now().toString(36)}-${(++startTabSeq).toString(36)}`};
}

export function installNewTabHijack(plugin: IPluginForStartTab, isEnabled: () => boolean): void {
    if (hijackInstalled) return;
    hijackInstalled = true;
    document.addEventListener("click", (e: MouseEvent) => {
        if (hijackBypass || !isEnabled()) return;
        const target = e.target as HTMLElement | null;
        const btn = target?.closest?.('.block__icon[data-type="new"]') as HTMLElement | null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const wndId = btn.closest('[data-type="wnd"]')?.getAttribute("data-id") || undefined;
        openStartTab(plugin, {wndId, newTab: true});
    }, true);
}

// 把焦点分屏切换到指定 wnd(复刻思源 setPanelFocus 的核心:layout__wnd--active 类切换)
function focusWnd(wndId: string): boolean {
    const wndEl = document.querySelector(`[data-type="wnd"][data-id="${wndId}"]`);
    if (!wndEl) return false;
    document.querySelectorAll(".layout__wnd--active").forEach(item => {
        item.classList.remove("layout__wnd--active");
    });
    wndEl.classList.add("layout__wnd--active");
    wndEl.querySelector(".layout-tab-bar .item--focus")?.setAttribute("data-activetime", Date.now().toString());
    return true;
}

// 触发思源原生「新建文档」(本次穿透拦截):新标签页内的入口仍要能建文档。
// scope 传起始页自身元素:优先用它所在分屏的 + 按钮,保证文档建在同一个分屏(思源原生
// 处理会先 setPanelFocus 该分屏);否则退回全局第一个 +。
export function triggerNativeNewDoc(scope?: HTMLElement | null): boolean {
    const scopeWnd = scope?.closest?.('[data-type="wnd"]');
    const btn = (scopeWnd?.querySelector('.block__icon[data-type="new"]')
        || document.querySelector('.block__icon[data-type="new"]')) as HTMLElement | null;
    if (!btn) return false;
    hijackBypass = true;
    try {
        btn.click();
    } finally {
        hijackBypass = false;
    }
    return true;
}

// 打开新标签页。
// - 分屏 + 接管(opts.wndId):先聚焦所点分屏再打开,新页签落在所点分屏;newTab=true 时每次
//   都新建一个起始页(data 唯一,绕过思源 openFile 按 type+data 的同类合并)
// - 其余调用(命令等):全局同类型只开一个,已存在则聚焦
export function openStartTab(plugin: IPluginForStartTab, opts?: {position?: "right" | "bottom"; wndId?: string; newTab?: boolean}): void {
    const opened = plugin.getOpenedTab()[START_TAB_TYPE] || [];
    if (opts?.wndId) {
        focusWnd(opts.wndId);
        if (!opts.newTab) {
            const mine = opened.find((t: any) => (t.parent?.parent as any)?.id === opts.wndId);
            if (mine && (mine as any).parent?.headElement) {
                ((mine as any).parent.headElement as HTMLElement).click();
                return;
            }
        }
    } else if (!opts?.position) {
        const existing = opened[0];
        if (existing) {
            const tab = (existing as any).parent;
            if (tab?.headElement) {
                (tab.headElement as HTMLElement).click();
                return;
            }
        }
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + START_TAB_TYPE,
            icon: "iconAdd",
            title: "新标签页",
            data: nextStartTabData(),
        },
        position: opts?.position,
    } as any);
}

// 最近使用条目 → 页面条目
function recentToItems(): PageItem[] {
    return getRecentEntries().slice(0, RECENT_LIMIT).map(e => {
        if (e.kind === "doc") {
            return {kind: "doc" as const, id: e.id, title: e.title, sub: e.hpath || "思源文档", group: "recent" as const};
        }
        return {kind: "file" as const, path: e.path, title: basename(e.path), sub: dirname(e.path), group: "recent" as const};
    });
}

// 固定/收藏条目 → 页面条目
function groupToItems(items: StartPageItem[], group: StartGroup): PageItem[] {
    return items.map(it => {
        if (it.kind === "doc") {
            return {kind: "doc" as const, id: it.id, title: it.title, sub: it.hpath || "思源文档", group};
        }
        return {kind: "file" as const, path: it.path, title: it.title || basename(it.path || ""), sub: dirname(it.path || ""), group};
    });
}

// 条目图标 HTML:文档用 iconFile,文件用扩展名图标
function itemIconHTML(item: PageItem): string {
    if (item.kind === "doc") {
        return `<svg class="b3-list-item__graphic"><use xlink:href="#iconFile"></use></svg>`;
    }
    return fileIconHTML(basename(item.path || ""));
}

// 构建新标签页 addTab 配置
export function createStartTabConfig(plugin: IPluginForStartTab) {
    return {
        type: START_TAB_TYPE,
        init(this: StartTabInstance) {
            this.element.classList.add("syfe-start-tab");
            this.element.innerHTML = `
                <div class="syfe-start">
                    <div class="syfe-start__top">
                        <div class="syfe-start__search">
                            <svg class="syfe-start__search-icon"><use xlink:href="#iconSearch"></use></svg>
                            <input type="text" class="b3-text-field syfe-start__input"
                                   placeholder="搜索文件(↑↓ 选择,回车打开)" />
                        </div>
                        <button class="b3-button b3-button--outline syfe-start__btn" data-action="new-doc">
                            <svg><use xlink:href="#iconAdd"></use></svg><span class="fn__space"></span>新建思源文档
                        </button>
                        <button class="b3-button b3-button--text syfe-start__btn" data-action="refresh" title="刷新列表与文件索引">刷新</button>
                    </div>
                    <div class="syfe-start__suggest" style="display:none;"></div>
                    <div class="syfe-start__hint"></div>
                    <div class="syfe-start__body"></div>
                </div>`;

            const bodyEl = this.element.querySelector(".syfe-start__body") as HTMLElement;
            const suggestEl = this.element.querySelector(".syfe-start__suggest") as HTMLElement;
            const hintEl = this.element.querySelector(".syfe-start__hint") as HTMLElement;
            const inputEl = this.element.querySelector(".syfe-start__input") as HTMLInputElement;
            this._bodyEl = bodyEl;
            this._suggestEl = suggestEl;
            this._hintEl = hintEl;
            this._inputEl = inputEl;
            const self = this;

            // ---- 渲染三个分区 ----
            const render = () => {
                const cfg = plugin.config || ({} as EditorConfig);
                const sections: string[] = [];
                let items: PageItem[] = [];

                const pushSection = (
                    group: StartGroup | "recent",
                    title: string,
                    icon: string,
                    list: PageItem[],
                    layout: "grid" | "list",
                    removable: boolean,
                ) => {
                    const startIdx = items.length;
                    items = items.concat(list);
                    const rows = list.length === 0
                        ? `<div class="syfe-start__empty">${group === "recent" ? "暂无最近打开的文件" : (group === "pinned" ? "还没有固定内容,可在文件树右键「固定到新标签页」" : "还没有收藏,可在文件树右键「收藏」")}</div>`
                        : list.map((it, i) => {
                            const idx = startIdx + i;
                            if (layout === "grid") {
                                return `
                                <div class="syfe-start__card" data-idx="${idx}" title="${escapeHTML(it.sub)}">
                                    <span class="syfe-start__card-icon">${itemIconHTML(it)}</span>
                                    <span class="syfe-start__card-name">${escapeHTML(it.title)}</span>
                                    ${removable ? `<span class="syfe-start__card-remove" data-remove="${idx}" title="移除">×</span>` : ""}
                                </div>`;
                            }
                            return `
                                <div class="syfe-start__row" data-idx="${idx}" title="${escapeHTML(it.sub)}">
                                    <span class="syfe-start__row-icon">${itemIconHTML(it)}</span>
                                    <span class="syfe-start__row-text">
                                        <span class="syfe-start__row-name">${escapeHTML(it.title)}</span>
                                        <span class="syfe-start__row-sub">${escapeHTML(it.sub)}</span>
                                    </span>
                                    ${removable ? `<span class="syfe-start__row-remove" data-remove="${idx}" title="移除">×</span>` : ""}
                                </div>`;
                        }).join("");
                    sections.push(`
                        <section class="syfe-start__section" data-section="${group}">
                            <div class="syfe-start__section-head">
                                <svg><use xlink:href="#${icon}"></use></svg>
                                <span>${escapeHTML(title)}</span>
                                <span class="syfe-start__count">${list.length}</span>
                            </div>
                            <div class="syfe-start__${layout}">${rows}</div>
                        </section>`);
                };

                if (cfg.newTabShowPinned !== false) {
                    pushSection("pinned", "固定", "iconPin", groupToItems(getPinned(), "pinned"), "grid", true);
                }
                if (cfg.newTabShowRecent !== false) {
                    pushSection("recent", "最近打开", "iconHistory", recentToItems(), "list", false);
                }
                if (cfg.newTabShowFavorites !== false) {
                    pushSection("favorites", "收藏", "iconStar", groupToItems(getFavorites(), "favorites"), "list", true);
                }

                self._items = items;
                if (sections.length === 0) {
                    bodyEl.innerHTML = `<div class="syfe-start__empty">所有分区都已隐藏,可在插件设置里重新开启</div>`;
                } else {
                    bodyEl.innerHTML = sections.join("");
                }
            };
            render();

            // ---- 交互:点击条目 ----
            const clickHandler = (e: MouseEvent) => {
                const removeEl = (e.target as HTMLElement).closest("[data-remove]") as HTMLElement | null;
                if (removeEl) {
                    const idx = Number(removeEl.dataset.remove);
                    const item = (self._items || [])[idx];
                    if (!item || item.group === "recent") return;
                    // 页面条目 → 存储条目(移除只按 kind+path/id 匹配)
                    const stored: StartPageItem = item.kind === "doc"
                        ? {kind: "doc", id: item.id, title: item.title, hpath: item.sub, ts: Date.now()}
                        : {kind: "file", path: item.path, title: item.title, ts: Date.now()};
                    void removeFromGroup(plugin as any, item.group as StartGroup, stored);
                    return;
                }
                const el = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement | null;
                if (!el) return;
                const item = (self._items || [])[Number(el.dataset.idx)];
                if (!item) return;
                openEntry(plugin as any, item);
            };
            this._clickHandler = clickHandler;
            bodyEl.addEventListener("click", clickHandler);

            // ---- 交互:右键条目 ----
            const contextHandler = (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement | null;
                if (!el) return;
                const item = (self._items || [])[Number(el.dataset.idx)];
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                showEntryMenu({
                    x: e.clientX,
                    y: e.clientY,
                    target: item,
                    plugin: plugin as any,
                    removable: item.group === "recent",
                });
            };
            this._contextHandler = contextHandler;
            bodyEl.addEventListener("contextmenu", contextHandler);

            // ---- 交互:顶部按钮 ----
            const actionHandler = (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
                if (!el) return;
                const action = el.dataset.action;
                if (action === "new-doc") {
                    // 走思源原生新建文档(穿透 + 按钮的拦截),不复制内核逻辑;
                    // 优先点起始页所在分屏的 +,文档才会建在同一个分屏
                    if (!triggerNativeNewDoc(self.element)) {
                        showMessage("未找到思源新建文档按钮", 3000, "error");
                    }
                } else if (action === "refresh") {
                    render();
                    void buildIndex();
                }
            };
            this._actionHandler = actionHandler;
            (this.element.querySelector(".syfe-start__top") as HTMLElement).addEventListener("click", actionHandler);

            // ---- 文件索引(供搜索框过滤) ----
            async function buildIndex(): Promise<void> {
                if (self._indexing) return;
                self._indexing = true;
                hintEl.textContent = "正在建立文件索引...";
                try {
                    const root = plugin.getFileTreeRoot() || "/data";
                    // maxFileSize=0:只收集名称,不做内容索引
                    const {entries} = await enumerateAll(root, 0);
                    self._entries = entries;
                    hintEl.textContent = `已索引 ${entries.length} 个条目(${root})`;
                } catch (e) {
                    hintEl.textContent = `文件索引失败: ${e}`;
                } finally {
                    self._indexing = false;
                }
            }
            void buildIndex();

            // ---- 搜索建议 ----
            const hideSuggest = () => {
                suggestEl.style.display = "none";
                suggestEl.innerHTML = "";
                self._suggest = [];
                self._suggestIndex = -1;
            };

            const renderSuggest = (list: SuggestItem[], keyword: string) => {
                if (list.length === 0) {
                    suggestEl.innerHTML = `<div class="syfe-start__suggest-empty">没有匹配「${escapeHTML(keyword)}」的文件</div>`;
                    suggestEl.style.display = "";
                    self._suggest = [];
                    self._suggestIndex = -1;
                    return;
                }
                suggestEl.innerHTML = list.map((it, i) => `
                    <div class="syfe-start__suggest-item${i === (self._suggestIndex ?? -1) ? " syfe-start__suggest-item--active" : ""}" data-i="${i}">
                        ${fileIconHTML(it.name)}
                        <span class="syfe-start__suggest-name">${escapeHTML(it.name)}</span>
                        <span class="syfe-start__suggest-path">${escapeHTML(dirname(it.path))}</span>
                    </div>`).join("");
                suggestEl.style.display = "";
            };

            const runSearch = () => {
                const keyword = inputEl.value.trim().toLowerCase();
                if (!keyword) {
                    hideSuggest();
                    return;
                }
                const seen = new Set<string>();
                const out: SuggestItem[] = [];
                // 先匹配本地三组(固定/收藏/最近),外部路径也能搜到
                const local = (self._items || []).filter(it => it.kind === "file" && it.path);
                for (const it of local) {
                    if (out.length >= SUGGEST_LIMIT) break;
                    const name = basename(it.path!).toLowerCase();
                    if (!name.includes(keyword) || seen.has(it.path!)) continue;
                    seen.add(it.path!);
                    out.push({path: it.path!, name: basename(it.path!), isDir: false});
                }
                // 再补全盘索引结果
                for (const e of self._entries || []) {
                    if (out.length >= SUGGEST_LIMIT) break;
                    if (seen.has(e.path) || !e.name.toLowerCase().includes(keyword)) continue;
                    seen.add(e.path);
                    out.push(e);
                }
                self._suggest = out;
                self._suggestIndex = out.length > 0 ? 0 : -1;
                renderSuggest(out, keyword);
            };

            let searchTimer: any = null;
            const inputHandler = () => {
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(runSearch, 150);
            };
            this._inputHandler = inputHandler;
            inputEl.addEventListener("input", inputHandler);

            const keyHandler = (e: KeyboardEvent) => {
                // 只在焦点位于本页搜索框时处理建议导航
                if (document.activeElement !== inputEl) return;
                const list = self._suggest || [];
                if (e.key === "Escape") {
                    hideSuggest();
                    return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    if (list.length === 0) return;
                    e.preventDefault();
                    const cur = self._suggestIndex ?? -1;
                    const next = e.key === "ArrowDown"
                        ? Math.min(cur + 1, list.length - 1)
                        : Math.max(cur - 1, 0);
                    self._suggestIndex = next;
                    renderSuggest(list, inputEl.value.trim());
                    return;
                }
                if (e.key === "Enter") {
                    const cur = self._suggestIndex ?? -1;
                    const target = list[cur] || list[0];
                    if (!target || target.isDir) return;
                    e.preventDefault();
                    hideSuggest();
                    inputEl.value = "";
                    openFileTab(plugin as any, target.path);
                }
            };
            this._keyHandler = keyHandler;
            inputEl.addEventListener("keydown", keyHandler);

            // 建议列表点击打开
            suggestEl.addEventListener("click", (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
                if (!el) return;
                const target = (self._suggest || [])[Number(el.dataset.i)];
                if (!target || target.isDir) return;
                hideSuggest();
                inputEl.value = "";
                openFileTab(plugin as any, target.path);
            });

            // ---- 数据变化自动重绘 ----
            const changedHandler = () => render();
            this._changedHandler = changedHandler;
            window.addEventListener(START_PAGE_CHANGED_EVENT, changedHandler);
            window.addEventListener(RECENTS_CHANGED_EVENT, changedHandler);
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: StartTabInstance) {
            if (this._bodyEl && this._clickHandler) {
                this._bodyEl.removeEventListener("click", this._clickHandler);
            }
            if (this._bodyEl && this._contextHandler) {
                this._bodyEl.removeEventListener("contextmenu", this._contextHandler);
            }
            if (this._inputEl && this._keyHandler) {
                this._inputEl.removeEventListener("keydown", this._keyHandler);
            }
            if (this._inputEl && this._inputHandler) {
                this._inputEl.removeEventListener("input", this._inputHandler);
            }
            if (this._changedHandler) {
                window.removeEventListener(START_PAGE_CHANGED_EVENT, this._changedHandler);
                window.removeEventListener(RECENTS_CHANGED_EVENT, this._changedHandler);
            }
            this._bodyEl = undefined;
            this._suggestEl = undefined;
            this._inputEl = undefined;
            this._items = undefined;
            this._suggest = undefined;
            this._entries = undefined;
        },
    };
}
