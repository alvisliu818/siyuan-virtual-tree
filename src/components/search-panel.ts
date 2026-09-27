import {openTab} from "siyuan";
import {SEARCH_TAB_TYPE, TEXT_EXTENSIONS} from "../constants";
import {EditorConfig, SearchResult} from "../types";
import {readDir, readTextFile} from "../api/file";
import {joinPath, extname, dirname} from "../utils/path";
import {openFileTab, IPluginForTab} from "../tabs/editor-tab";
import {openImageTab} from "../tabs/image-tab";
import {openOfficeTab} from "../tabs/office-tab";
import {openMediaTab} from "../tabs/media-tab";
import {setPendingReveal} from "../editor/model-manager";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {revealInFileTree, findTreeRootEl, showFileTreeMenu, IFileTreeActions} from "./file-tree";

// 搜索面板所需的插件接口
export interface IPluginForSearch {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
    openSearch(rootPath?: string): void;
    openTerminal(cwd: string): void;
}

// 搜索模式:全部(名称+内容) / 文件名(仅名称匹配) / 内容(仅内容匹配)
type SearchMode = "all" | "filename" | "content";

// 名称搜索的条目(文件或文件夹)
interface NameEntry {
    path: string;
    name: string;
    isDir: boolean;
}

// 搜索 Tab 实例上附加的字段
interface SearchTabInstance {
    element: HTMLElement;
    data: { rootPath?: string };
    _rootPath?: string;
    _keyword?: string;
    _mode?: SearchMode;
    _results?: SearchResult[];
    _clickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 高亮关键词
function highlightKeyword(text: string, keyword: string): string {
    if (!keyword) return escapeHTML(text);
    const escaped = escapeHTML(text);
    const kwEscaped = escapeHTML(keyword);
    const re = new RegExp(`(${kwEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return escaped.replace(re, '<mark class="syfe-search__mark">$1</mark>');
}

// 递归枚举所有条目:返回全部条目(名称搜索用)与文本文件列表(内容搜索用)
// 导出供「新标签页」复用(传 maxFileSize=0 即只收集名称,不收集文本文件)
export async function enumerateAll(rootPath: string, maxFileSize: number): Promise<{ entries: NameEntry[]; textFiles: string[] }> {
    const entries: NameEntry[] = [];
    const textFiles: string[] = [];
    async function walk(dir: string): Promise<void> {
        let raw;
        try {
            raw = await readDir(dir);
        } catch {
            return;
        }
        if (!Array.isArray(raw)) return;
        for (const entry of raw) {
            const fullPath = joinPath(dir, entry.name);
            entries.push({path: fullPath, name: entry.name, isDir: entry.isDir});
            if (entry.isDir) {
                await walk(fullPath);
            } else {
                const ext = extname(entry.name);
                if (TEXT_EXTENSIONS.has(ext) && entry.size <= maxFileSize) {
                    textFiles.push(fullPath);
                }
            }
        }
    }
    await walk(rootPath);
    return {entries, textFiles};
}

// 打开搜索 Tab(同根路径去重)
export function openSearchTab(plugin: IPluginForSearch, rootPath: string): void {
    const opened = plugin.getOpenedTab()[SEARCH_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.rootPath === rootPath);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + SEARCH_TAB_TYPE,
            icon: "iconSearch",
            title: "搜索",
            data: {rootPath},
        },
    } as any);
}

// 在文件树中定位并高亮文件夹/文件(复用文件树的 revealInFileTree)
function revealInTree(path: string): void {
    void revealInFileTree(path);
}

// 跳转到搜索结果对应的文件与行
function revealInFile(plugin: IPluginForSearch, path: string, lineNo: number): void {
    // 设置待跳转行(新 Tab 在 init 中消费)
    setPendingReveal(path, lineNo);
    // 打开/聚焦文件 Tab
    openFileTab(plugin as IPluginForTab, path);
    // 若 Tab 已存在,直接定位行
    const editorTabs = (plugin.getOpenedTab() as any);
    const tabKey = Object.keys(editorTabs).find(k => k.includes("editor-tab"));
    if (tabKey) {
        const tabs = editorTabs[tabKey] || [];
        const existing = tabs.find((c: any) => c?.data?.path === path);
        if (existing && (existing as any)._editor) {
            const editor = (existing as any)._editor;
            setTimeout(() => {
                editor.revealLineInCenter(lineNo);
                editor.setPosition({lineNumber: lineNo, column: 1});
            }, 50);
        }
    }
}

// 创建搜索 Tab 配置
export function createSearchTabConfig(plugin: IPluginForSearch) {
    return {
        type: SEARCH_TAB_TYPE,
        init(this: SearchTabInstance) {
            const rootPath = this.data?.rootPath || "/data";
            this._rootPath = rootPath;
            this._mode = "all";
            this._results = [];
            this.element.classList.add("syfe-search-tab", "fn__flex-column");

            this.element.innerHTML = `
                <div class="syfe-search">
                    <div class="syfe-search__bar">
                        <input type="text" class="b3-text-field fn__flex-1" id="syfe-search-input"
                               placeholder="搜索文件名、文件夹名与内容..." />
                        <button class="b3-button b3-button--outline" id="syfe-search-btn">搜索</button>
                    </div>
                    <div class="syfe-search__modes" id="syfe-search-modes">
                        <button class="syfe-search__mode active" data-mode="all">全部</button>
                        <button class="syfe-search__mode" data-mode="filename">文件名</button>
                        <button class="syfe-search__mode" data-mode="content">内容</button>
                    </div>
                    <div class="syfe-search__info" id="syfe-search-info"></div>
                    <div class="fn__flex-1 syfe-search__scroll">
                        <ul class="syfe-search__results" id="syfe-search-results"></ul>
                    </div>
                </div>`;

            const input = this.element.querySelector("#syfe-search-input") as HTMLInputElement;
            const btn = this.element.querySelector("#syfe-search-btn") as HTMLButtonElement;
            const modesEl = this.element.querySelector("#syfe-search-modes") as HTMLElement;
            const infoEl = this.element.querySelector("#syfe-search-info") as HTMLElement;
            const resultsEl = this.element.querySelector("#syfe-search-results") as HTMLElement;
            const self = this;

            const updatePlaceholder = () => {
                input.placeholder = self._mode === "content"
                    ? "搜索文件内容..."
                    : self._mode === "filename"
                        ? "搜索文件名、文件夹名..."
                        : "搜索文件名、文件夹名与内容...";
            };

            const doSearch = async () => {
                const keyword = input.value.trim();
                if (!keyword) return;
                self._keyword = keyword;
                const myToken = Symbol();
                (self as any)._token = myToken;
                const mode = self._mode || "all";
                const lowerKeyword = keyword.toLowerCase();

                btn.disabled = true;
                infoEl.textContent = "搜索中...";
                resultsEl.innerHTML = "";
                self._results = [];

                try {
                    const {entries, textFiles} = await enumerateAll(rootPath, plugin.config.searchMaxFileSize);
                    if ((self as any)._token !== myToken) return;

                    let nameCount = 0;
                    let contentCount = 0;

                    // 1. 名称匹配(文件名/文件夹名,大小写不敏感)
                    if (mode !== "content") {
                        const matched = entries
                            .filter(e => e.name.toLowerCase().includes(lowerKeyword))
                            .sort((a, b) => (a.isDir === b.isDir) ? a.path.localeCompare(b.path) : (a.isDir ? -1 : 1));
                        for (const e of matched) {
                            const result: SearchResult = {
                                path: e.path,
                                lineNo: 0,
                                line: "",
                                preview: "",
                                kind: "name",
                                name: e.name,
                                isDir: e.isDir,
                            };
                            self._results!.push(result);
                            nameCount++;
                            appendResult(resultsEl, result, keyword);
                        }
                        infoEl.textContent = mode === "filename"
                            ? (nameCount > 0 ? `找到 ${nameCount} 个名称结果` : "未找到结果")
                            : `搜索中... 名称 ${nameCount}`;
                    }

                    // 2. 内容匹配
                    if (mode !== "filename") {
                        const concurrency = 8;
                        for (let i = 0; i < textFiles.length; i += concurrency) {
                            if ((self as any)._token !== myToken) return;
                            const batch = textFiles.slice(i, i + concurrency);
                            await Promise.all(batch.map(async file => {
                                try {
                                    const content = await readTextFile(file);
                                    const lines = content.split("\n");
                                    for (let j = 0; j < lines.length; j++) {
                                        if (lines[j].includes(keyword)) {
                                            const result: SearchResult = {
                                                path: file,
                                                lineNo: j + 1,
                                                line: lines[j],
                                                preview: lines[j].trim().slice(0, 200),
                                                kind: "content",
                                            };
                                            self._results!.push(result);
                                            contentCount++;
                                            appendResult(resultsEl, result, keyword);
                                        }
                                    }
                                } catch {
                                    // 跳过无法读取的文件
                                }
                            }));
                            if ((self as any)._token !== myToken) return;
                            const prefix = mode === "all" ? `名称 ${nameCount} · ` : "";
                            infoEl.textContent = `搜索中... ${prefix}内容 ${contentCount} (${i + batch.length}/${textFiles.length})`;
                        }
                        if ((self as any)._token !== myToken) return;
                    }

                    // 最终统计
                    if (mode === "all") {
                        infoEl.textContent = (nameCount + contentCount) > 0
                            ? `名称 ${nameCount} · 内容 ${contentCount}`
                            : "未找到结果";
                    }
                } catch (e) {
                    if ((self as any)._token !== myToken) return;
                    infoEl.textContent = `搜索出错: ${e}`;
                } finally {
                    if ((self as any)._token === myToken) {
                        btn.disabled = false;
                    }
                }
            };

            btn.addEventListener("click", doSearch);
            input.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    doSearch();
                }
            });

            // 模式切换:更新高亮与占位符,已有关键词时自动重新搜索
            modesEl.addEventListener("click", (e: MouseEvent) => {
                const btnMode = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement;
                if (!btnMode) return;
                self._mode = btnMode.dataset.mode as SearchMode;
                modesEl.querySelectorAll(".syfe-search__mode").forEach(b => {
                    b.classList.toggle("active", b === btnMode);
                });
                updatePlaceholder();
                if (input.value.trim()) doSearch();
            });

            // 结果点击(委托)
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const item = target.closest(".syfe-search__item") as HTMLElement;
                if (!item) return;
                const path = item.dataset.path!;
                if (!path) return;
                if (item.dataset.kind === "name") {
                    // 名称结果:文件 → 打开编辑;文件夹 → 文件树中定位
                    if (item.dataset.isDir === "true") {
                        revealInTree(path);
                    } else {
                        openFileTab(plugin as IPluginForTab, path);
                    }
                } else {
                    // 内容结果:跳转到对应文件与行
                    const lineNo = parseInt(item.dataset.line!, 10);
                    if (lineNo) {
                        revealInFile(plugin, path, lineNo);
                    }
                }
            };
            resultsEl.addEventListener("click", this._clickHandler);

            // 右键菜单(委托):复用文件树菜单,提供与选中文件/文件夹相同的全部功能
            this._contextHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const item = target.closest(".syfe-search__item") as HTMLElement;
                if (!item) return;
                const path = item.dataset.path;
                if (!path) return;
                e.preventDefault();
                e.stopPropagation();
                // 名称结果按 dataset 判断;内容结果必为文件
                const isDir = item.dataset.isDir === "true";
                // 找到包含该路径的文件树,操作后就地刷新;找不到时菜单仍可用,仅跳过树刷新
                const rootEl = findTreeRootEl(path);
                const actions: IFileTreeActions = {
                    openFile: (p: string) => openFileTab(plugin as IPluginForTab, p),
                    openImage: (p: string) => openImageTab(plugin as any, p),
                    openOffice: (p: string) => openOfficeTab(plugin as any, p),
                    openMedia: (p: string) => openMediaTab(plugin as any, p),
                    openMarkdown: (p: string, mode?: "live" | "source" | "reading") => (plugin as any).openMarkdown(p, mode),
                    openSearch: (rp?: string) => plugin.openSearch(rp),
                    openTerminal: (cwd: string) => plugin.openTerminal(cwd),
                    openFileSplit: (p: string, pos: "right" | "bottom") => openFileTab(plugin as IPluginForTab, p, {position: pos}),
                    togglePin: (p: string) => (plugin as any).togglePin(p),
                    toggleFavorite: (p: string) => (plugin as any).toggleFavorite(p),
                };
                showFileTreeMenu(e, path, isDir, rootEl, rootEl?.dataset.path || rootPath, actions);
            };
            resultsEl.addEventListener("contextmenu", this._contextHandler);

            input.focus();
        },
        destroy(this: SearchTabInstance) {
            (this as any)._token = Symbol(); // 使进行中的搜索失效
            const resultsEl = this.element.querySelector("#syfe-search-results") as HTMLElement | null;
            if (this._clickHandler) {
                resultsEl?.removeEventListener("click", this._clickHandler);
            }
            if (this._contextHandler) {
                resultsEl?.removeEventListener("contextmenu", this._contextHandler);
            }
        },
    };
}

// 追加单条搜索结果到列表
function appendResult(container: HTMLElement, result: SearchResult, keyword: string): void {
    const li = document.createElement("li");
    li.className = "syfe-search__item";
    li.dataset.path = result.path;
    if (result.kind === "name") {
        // 名称匹配结果:图标 + 高亮名称 + 所在目录
        li.dataset.kind = "name";
        li.dataset.isDir = result.isDir ? "true" : "false";
        const icon = result.isDir ? folderIconHTML(result.name, false) : fileIconHTML(result.name || "");
        const parent = dirname(result.path) || result.path;
        const badge = result.isDir ? `<span class="syfe-search__name-badge">文件夹</span>` : "";
        li.innerHTML = `
            <div class="syfe-search__item-name">
                <span class="syfe-search__item-icon">${icon}</span>
                <span class="syfe-search__name-text">${highlightKeyword(result.name || "", keyword)}</span>
                ${badge}
            </div>
            <div class="syfe-search__item-path">${escapeHTML(parent)}</div>`;
    } else {
        // 内容匹配结果:路径:行号 + 内容预览
        li.dataset.kind = "content";
        li.dataset.line = String(result.lineNo);
        li.innerHTML = `
            <div class="syfe-search__item-path">${escapeHTML(result.path)}<span class="syfe-search__item-line">:${result.lineNo}</span></div>
            <div class="syfe-search__item-preview">${highlightKeyword(result.preview, keyword)}</div>`;
    }
    container.appendChild(li);
}