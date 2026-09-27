// 侧边栏「最近使用」面板:列出最近打开的文件与思源笔记文档(最新在前)。
// 点击条目:文件 → openFileTab 统一路由;文档 → siyuan://blocks/<id> 打开。
// 数据来源 src/recent-files.ts(recents.json);列表变化(recents-changed 事件)自动重绘。
import {confirm, showMessage} from "siyuan";
import {RECENT_DOCK_TYPE} from "../constants";
import {
    getRecentEntries,
    clearRecents,
    RECENTS_CHANGED_EVENT,
    RecentEntry,
} from "../recent-files";
import {basename, dirname} from "../utils/path";
import {fileIconHTML} from "../utils/icons";
// 条目右键菜单与打开逻辑抽到 components/entry-menu(新标签页共用同一套)
import {openEntry, showEntryMenu} from "../components/entry-menu";

// 面板所需的插件接口
export interface IPluginForRecent {
    app: any;
    name: string;
    config: any;
    getOpenedTab(): { [key: string]: any[] };
    openFileSplit(path: string, position: "right" | "bottom"): void;
}

// Dock 实例上附加的字段
interface RecentDockInstance {
    element: HTMLElement;
    _listEl?: HTMLElement;
    _clickHandler?: (e: MouseEvent) => void;
    _actionHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
    _recentsHandler?: () => void;
    _entries?: RecentEntry[];
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 渲染列表(文件与文档混合,按时间倒序);空态给出提示
export function createRecentDockConfig(plugin: IPluginForRecent) {
    return {
        type: RECENT_DOCK_TYPE,
        config: {
            position: "LeftBottom" as const,
            size: {width: 240, height: 0},
            icon: "iconHistory",
            title: "最近使用",
            hotkey: "",
            show: true,
        },
        data: {},
        init(this: RecentDockInstance) {
            this.element.classList.add("syfe-recent-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-recent__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconHistory"></use></svg>
                        <span class="block__logotext">最近使用</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-action="refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="clear" aria-label="清空" data-position="north">
                        <svg><use xlink:href="#iconTrashcan"></use></svg>
                    </span>
                </div>
                <div class="fn__flex-1 syfe-recent__scroll">
                    <ul class="syfe-recent__list"></ul>
                </div>`;

            const listEl = this.element.querySelector(".syfe-recent__list") as HTMLElement;
            this._listEl = listEl;
            const self = this;

            // 渲染列表(文件与文档混合,按时间倒序);空态给出提示
            const render = () => {
                const entries = getRecentEntries();
                self._entries = entries;
                if (entries.length === 0) {
                    listEl.innerHTML = `<li class="syfe-recent__empty">暂无最近使用记录</li>`;
                    return;
                }
                listEl.innerHTML = entries.map((e, i) => {
                    if (e.kind === "doc") {
                        return `
                        <li class="syfe-recent__item syfe-recent__item--doc" data-idx="${i}" data-kind="doc" title="${escapeHTML(e.hpath || e.title)}">
                            <span class="syfe-recent__icon"><svg><use xlink:href="#iconFile"></use></svg></span>
                            <span class="syfe-recent__text">
                                <span class="syfe-recent__name">${escapeHTML(e.title)}</span>
                                <span class="syfe-recent__dir">${escapeHTML(e.hpath || "思源文档")}</span>
                            </span>
                        </li>`;
                    }
                    return `
                        <li class="syfe-recent__item syfe-recent__item--file" data-idx="${i}" data-kind="file" title="${escapeHTML(e.path)}">
                            <span class="syfe-recent__icon">${fileIconHTML(basename(e.path))}</span>
                            <span class="syfe-recent__text">
                                <span class="syfe-recent__name">${escapeHTML(basename(e.path))}</span>
                                <span class="syfe-recent__dir">${escapeHTML(dirname(e.path))}</span>
                            </span>
                        </li>`;
                }).join("");
            };
            render();

            // 取条目(按 data-idx 回查,避免把整条路径/标题塞进 data 属性)
            const entryOf = (el: HTMLElement | null): RecentEntry | null => {
                if (!el) return null;
                const idx = Number(el.dataset.idx);
                const list = self._entries || getRecentEntries();
                return Number.isFinite(idx) ? (list[idx] || null) : null;
            };

            // 点击:文档 → 思源协议打开;文件 → openFileTab 统一路由
            const clickHandler = (e: MouseEvent) => {
                const item = (e.target as HTMLElement).closest(".syfe-recent__item") as HTMLElement | null;
                const entry = entryOf(item);
                if (!entry) return;
                openEntry(plugin as any, entry);
            };
            this._clickHandler = clickHandler;
            listEl.addEventListener("click", clickHandler);

            // 工具栏按钮:刷新 / 清空
            const actionHandler = (e: MouseEvent) => {
                const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
                if (!actionEl) return;
                const action = actionEl.dataset.action;
                if (action === "refresh") {
                    render();
                } else if (action === "clear") {
                    confirm("清空最近使用", "确定清空最近使用的文件与文档列表吗?", () => {
                        void clearRecents(plugin as any);
                    }, () => {});
                }
            };
            this._actionHandler = actionHandler;
            const toolbarEl = this.element.querySelector(".syfe-recent__toolbar") as HTMLElement;
            toolbarEl.addEventListener("click", actionHandler);

            // 右键菜单:文档与文件分别提供可用操作(与「新标签页」共用 entry-menu)
            const contextHandler = (e: MouseEvent) => {
                const item = (e.target as HTMLElement).closest(".syfe-recent__item") as HTMLElement | null;
                const entry = entryOf(item);
                if (!entry) return;
                e.preventDefault();
                e.stopPropagation();
                showEntryMenu({x: e.clientX, y: e.clientY, target: entry, plugin: plugin as any, removable: true});
            };
            this._contextHandler = contextHandler;
            listEl.addEventListener("contextmenu", contextHandler);

            // 列表变化(打开新文件/文档、移除、清空)时自动重绘
            const recentsHandler = () => render();
            this._recentsHandler = recentsHandler;
            window.addEventListener(RECENTS_CHANGED_EVENT, recentsHandler);
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: RecentDockInstance) {
            if (this._listEl && this._clickHandler) {
                this._listEl.removeEventListener("click", this._clickHandler);
            }
            if (this._listEl && this._contextHandler) {
                this._listEl.removeEventListener("contextmenu", this._contextHandler);
            }
            if (this._recentsHandler) {
                window.removeEventListener(RECENTS_CHANGED_EVENT, this._recentsHandler);
            }
            this._listEl = undefined;
            this._clickHandler = undefined;
            this._actionHandler = undefined;
            this._contextHandler = undefined;
            this._recentsHandler = undefined;
            this._entries = undefined;
        },
    };
}
