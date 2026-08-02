import {openTab, showMessage} from "siyuan";
import {SEARCH_TAB_TYPE, TEXT_EXTENSIONS} from "../constants";
import {EditorConfig, SearchResult} from "../types";
import {readDir, readTextFile} from "../api/file";
import {joinPath, extname} from "../utils/path";
import {openFileTab, IPluginForTab} from "../tabs/editor-tab";
import {setPendingReveal} from "../editor/model-manager";

// 搜索面板所需的插件接口
export interface IPluginForSearch {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
}

// 搜索 Tab 实例上附加的字段
interface SearchTabInstance {
    element: HTMLElement;
    data: { rootPath?: string };
    _rootPath?: string;
    _keyword?: string;
    _results?: SearchResult[];
    _abort?: boolean;
    _clickHandler?: (e: MouseEvent) => void;
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

// 递归枚举所有文本文件
async function enumerateFiles(rootPath: string, maxFileSize: number): Promise<string[]> {
    const results: string[] = [];
    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readDir(dir);
        } catch {
            return;
        }
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
            const fullPath = joinPath(dir, entry.name);
            if (entry.isDir) {
                await walk(fullPath);
            } else {
                const ext = extname(entry.name);
                if (TEXT_EXTENSIONS.has(ext) && entry.size <= maxFileSize) {
                    results.push(fullPath);
                }
            }
        }
    }
    await walk(rootPath);
    return results;
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

// 跳转到搜索结果对应的文件与行
function revealInFile(plugin: IPluginForSearch, path: string, lineNo: number): void {
    // 设置待跳转行(新 Tab 在 init 中消费)
    setPendingReveal(path, lineNo);
    // 打开/聚焦文件 Tab
    openFileTab(plugin as IPluginForTab, path);
    // 若 Tab 已存在,直接定位行
    const opened = plugin.getOpenedTab()[SEARCH_TAB_TYPE.replace("search", "tab")] || [];
    // 查找编辑器 Tab(类型为 TAB_TYPE)
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
            this._results = [];
            this._abort = false;
            this.element.classList.add("syfe-search-tab", "fn__flex-column");

            this.element.innerHTML = `
                <div class="syfe-search">
                    <div class="syfe-search__bar">
                        <input type="text" class="b3-text-field fn__flex-1" id="syfe-search-input"
                               placeholder="输入搜索关键词..." />
                        <button class="b3-button b3-button--outline" id="syfe-search-btn">搜索</button>
                    </div>
                    <div class="syfe-search__info" id="syfe-search-info"></div>
                    <div class="fn__flex-1 syfe-search__scroll">
                        <ul class="syfe-search__results" id="syfe-search-results"></ul>
                    </div>
                </div>`;

            const input = this.element.querySelector("#syfe-search-input") as HTMLInputElement;
            const btn = this.element.querySelector("#syfe-search-btn") as HTMLButtonElement;
            const infoEl = this.element.querySelector("#syfe-search-info") as HTMLElement;
            const resultsEl = this.element.querySelector("#syfe-search-results") as HTMLElement;
            const self = this;

            const doSearch = async () => {
                const keyword = input.value.trim();
                if (!keyword) return;
                self._keyword = keyword;
                self._abort = true; // 中断上一次
                const myToken = Symbol();
                self._abort = false as any;
                (self as any)._token = myToken;

                btn.disabled = true;
                infoEl.textContent = "搜索中...";
                resultsEl.innerHTML = "";
                self._results = [];

                try {
                    const files = await enumerateFiles(rootPath, plugin.config.searchMaxFileSize);
                    let total = 0;
                    const concurrency = 8;

                    for (let i = 0; i < files.length; i += concurrency) {
                        if ((self as any)._token !== myToken) return; // 被新搜索取代
                        const batch = files.slice(i, i + concurrency);
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
                                        };
                                        self._results!.push(result);
                                        total++;
                                        appendResult(resultsEl, result, keyword);
                                    }
                                }
                            } catch {
                                // 跳过无法读取的文件
                            }
                        }));
                        infoEl.textContent = `搜索中... 已找到 ${total} 个结果 (${i + batch.length}/${files.length})`;
                    }

                    if ((self as any)._token !== myToken) return;
                    infoEl.textContent = total > 0
                        ? `找到 ${total} 个结果`
                        : "未找到结果";
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

            // 结果点击(委托)
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const item = target.closest(".syfe-search__item") as HTMLElement;
                if (!item) return;
                const path = item.dataset.path!;
                const lineNo = parseInt(item.dataset.line!, 10);
                if (path && lineNo) {
                    revealInFile(plugin, path, lineNo);
                }
            };
            resultsEl.addEventListener("click", this._clickHandler);

            input.focus();
        },
        destroy(this: SearchTabInstance) {
            this._abort = true;
            if (this._clickHandler) {
                const resultsEl = this.element.querySelector("#syfe-search-results");
                resultsEl?.removeEventListener("click", this._clickHandler);
            }
        },
    };
}

// 追加单条搜索结果到列表
function appendResult(container: HTMLElement, result: SearchResult, keyword: string): void {
    const li = document.createElement("li");
    li.className = "syfe-search__item";
    li.dataset.path = result.path;
    li.dataset.line = String(result.lineNo);
    li.innerHTML = `
        <div class="syfe-search__item-path">${escapeHTML(result.path)}<span class="syfe-search__item-line">:${result.lineNo}</span></div>
        <div class="syfe-search__item-preview">${highlightKeyword(result.preview, keyword)}</div>`;
    container.appendChild(li);
}
