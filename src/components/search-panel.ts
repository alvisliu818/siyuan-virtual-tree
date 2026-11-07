import {openTab} from "siyuan";
import {SEARCH_TAB_TYPE, TEXT_EXTENSIONS} from "../constants";
import {EditorConfig, SearchResult} from "../types";
import {readDir, readTextFile} from "../api/file";
import {joinPath, extname, dirname} from "../utils/path";
import {isBaiduPath} from "../utils/baidu-path";
import {openFileTab, IPluginForTab} from "../tabs/editor-tab";
import {openImageTab} from "../tabs/image-tab";
import {openOfficeTab} from "../tabs/office-tab";
import {openMediaTab} from "../tabs/media-tab";
import {setPendingReveal} from "../editor/model-manager";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {revealInFileTree, findTreeRootEl, showFileTreeMenu, IFileTreeActions} from "./file-tree";
import {enumerateMountItems, loadMountContent, MAX_ITEMS} from "./mount-search";
import {openSiyuanDoc} from "./entry-menu";
import {searchEverything, searchAnyTxt, fetchAnyTxtFragment, ServiceHit} from "../api/search-service";

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
// 搜索范围:目录(真实文件,递归) / 虚拟文档树(挂载的思源文档、块与文件)
//           / Everything(本地全盘文件名服务) / AnyTXT(本地全盘全文服务)
type SearchScope = "dir" | "mount" | "everything" | "anytxt";

// 服务范围取结果的上限(Everything 名字命中可以多点;AnyTXT 每个文件还要取一次片段)
const EVERYTHING_LIMIT = 300;
const ANYTXT_LIMIT = 50;
const ANYTXT_FRAGMENT_LIMIT = 30;

// 内容匹配选项(搜索栏下方一排开关)
interface SearchOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
    include: string;
    exclude: string;
    context: number;
}

// 名称搜索的条目(文件或文件夹)
interface NameEntry {
    path: string;
    name: string;
    isDir: boolean;
}

// 一个文件(文档)里的全部命中行,用于按文件分组渲染
interface FileGroup {
    path: string;
    name: string;
    subtitle: string;
    kind: "content" | "sydoc";
    docId?: string;
    matches: LineMatch[];
}

interface LineMatch {
    lineNo: number;
    preview: string;
    before: string[];
    after: string[];
}
// 搜索 Tab 实例上附加的字段
interface SearchTabInstance {
    element: HTMLElement;
    data: { rootPath?: string };
    _rootPath?: string;
    _keyword?: string;
    _mode?: SearchMode;
    _scope?: SearchScope;
    _results?: SearchResult[];
    _clickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 关键词 → 正则。返回 null = 用户输入了非法正则(调用方据此提示,不静默吞掉)
function buildRegex(keyword: string, o: SearchOptions): RegExp | null {
    const flags = o.caseSensitive ? "g" : "gi";
    if (o.regex) {
        try {
            return new RegExp(keyword, flags);
        } catch {
            return null;
        }
    }
    let src = escapeRegExp(keyword);
    if (o.wholeWord) {
        // 中文不是 \w,纯 \b 会把"中文词"判成全词失败;这里用「前后都不是字母数字/汉字」
        src = `(?<![\\w\\u4e00-\\u9fa5])(?:${src})(?![\\w\\u4e00-\\u9fa5])`;
    }
    try {
        return new RegExp(src, flags);
    } catch {
        return null;
    }
}

// glob(逗号分隔,* / ** / ?)→ 匹配器;空串返回 null(表示"不限制")
function buildGlobMatcher(raw: string): ((path: string, name: string) => boolean) | null {
    const pats = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (pats.length === 0) return null;
    const res: RegExp[] = [];
    for (const p of pats) {
        let src = "";
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c === "*") {
                if (p[i + 1] === "*") {
                    src += ".*";
                    i++;
                } else {
                    src += "[^/]*";
                }
            } else if (c === "?") {
                src += "[^/]";
            } else {
                src += escapeRegExp(c);
            }
        }
        try {
            res.push(new RegExp("^" + src + "$", "i"));
        } catch {
            // 非法 glob 忽略(不因此让整个搜索失败)
        }
    }
    if (res.length === 0) return null;
    return (path, name) => res.some(re => re.test(name) || re.test(path));
}

// 高亮关键词
function highlightKeyword(text: string, keyword: string): string {
    if (!keyword) return escapeHTML(text);
    const escaped = escapeHTML(text);
    const kwEscaped = escapeHTML(keyword);
    const re = new RegExp(`(${kwEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return escaped.replace(re, '<mark class="syfe-search__mark">$1</mark>');
}

// 按正则高亮(正则/全词模式下关键词本身不是字面量,必须用它,否则高亮错位)
function highlightRegex(text: string, re: RegExp): string {
    const escaped = escapeHTML(text);
    re.lastIndex = 0;
    return escaped.replace(re, (m) => `<mark class="syfe-search__mark">${m}</mark>`);
}

// 服务范围(Everything/AnyTXT)的高亮正则:查询语法是我们不解析的服务方言,
// 按空白拆词转义后取「或」,只为结果里描黄,不参与服务端匹配
function buildServiceHighlight(keyword: string): RegExp | null {
    const terms = keyword.split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (terms.length === 0) return null;
    try {
        return new RegExp(`(${terms.join("|")})`, "gi");
    } catch {
        return null;
    }
}

// 服务命中的副标题:目录 · 修改日期 · 大小
function serviceHitSubtitle(h: ServiceHit): string {
    const parts: string[] = [];
    const dir = dirname(h.path);
    if (dir && dir !== h.path) parts.push(dir);
    if (h.modifiedMs && Number.isFinite(h.modifiedMs)) {
        const d = new Date(h.modifiedMs);
        if (!isNaN(d.getTime())) parts.push(d.toLocaleDateString());
    }
    if (h.size && h.size > 0) {
        parts.push(h.size >= 1024 * 1024
            ? `${(h.size / 1024 / 1024).toFixed(1)} MB`
            : `${Math.max(1, Math.round(h.size / 1024))} KB`);
    }
    return parts.join(" · ");
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
                // 网盘文件不参与内容搜索(逐个下载代价过高),保留名称搜索
                if (!isBaiduPath(fullPath) && TEXT_EXTENSIONS.has(ext) && entry.size <= maxFileSize) {
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

// 追加一个"文件分组"(内容命中按文件聚合,点击标题可折叠)
function appendGroup(container: HTMLElement, g: FileGroup, re: RegExp, keyword: string): void {
    const li = document.createElement("li");
    li.className = "syfe-search__group";
    li.dataset.path = g.path;
    if (g.docId) li.dataset.docId = g.docId;
    li.dataset.kind = g.kind;
    const icon = g.kind === "sydoc" ? folderIconHTML(g.name, false) : fileIconHTML(g.name);
    const head = `${escapeHTML(g.name)} <span class="syfe-search__group-count">${g.matches.length}</span> <span class="syfe-search__group-sub">${escapeHTML(g.subtitle)}</span>`;
    li.innerHTML = `
        <div class="syfe-search__group-head">
            <span class="syfe-search__group-icon">${icon}</span>
            <span class="syfe-search__group-name">${head}</span>
        </div>
        <ul class="syfe-search__group-items">
            ${g.matches.map(m => {
                const ctxBefore = m.before.map(b => `<div class="syfe-search__ctx">${highlightRegex(b, re) || highlightKeyword(b, keyword)}</div>`).join("");
                const ctxAfter = m.after.map(b => `<div class="syfe-search__ctx">${highlightRegex(b, re) || highlightKeyword(b, keyword)}</div>`).join("");
                // lineNo<=0 表示无行号(AnyTXT 服务只给片段),不渲染行号徽标
                const lineBadge = m.lineNo > 0 ? `<span class="syfe-search__item-line">${m.lineNo}</span>` : "";
                return `<li class="syfe-search__item" data-kind="${g.kind}" data-path="${escapeHTML(g.path)}" data-line="${m.lineNo}"${g.docId ? ` data-doc-id="${escapeHTML(g.docId)}"` : ""}>
                    ${ctxBefore}
                    <div class="syfe-search__hit">${lineBadge}${highlightRegex(m.preview, re) || highlightKeyword(m.preview, keyword)}</div>
                    ${ctxAfter}
                </li>`;
            }).join("")}
        </ul>`;
    container.appendChild(li);
}

// 追加单条名称搜索结果
function appendNameResult(container: HTMLElement, result: SearchResult, keyword: string): void {
    const li = document.createElement("li");
    li.className = "syfe-search__item";
    li.dataset.path = result.path;
    li.dataset.kind = "name";
    li.dataset.isDir = result.isDir ? "true" : "false";
    if (result.docId) li.dataset.docId = result.docId;
    const icon = result.isDir ? folderIconHTML(result.name || "", false) : fileIconHTML(result.name || "");
    const parent = dirname(result.path) || result.path;
    const badge = result.isDir ? `<span class="syfe-search__name-badge">文件夹</span>` : "";
    li.innerHTML = `
        <div class="syfe-search__item-name">
            <span class="syfe-search__item-icon">${icon}</span>
            <span class="syfe-search__name-text">${highlightKeyword(result.name || "", keyword)}</span>
            ${badge}
        </div>
        <div class="syfe-search__item-path">${escapeHTML(result.docId ? result.path : parent)}</div>`;
    container.appendChild(li);
}

// 创建搜索 Tab 配置
export function createSearchTabConfig(plugin: IPluginForSearch) {
    return {
        type: SEARCH_TAB_TYPE,
        init(this: SearchTabInstance) {
            const rootPath = this.data?.rootPath || "/data";
            this._rootPath = rootPath;
            this._mode = "all";
            this._scope = "dir";
            this._results = [];
            this.element.classList.add("syfe-search-tab", "fn__flex-column");

            this.element.innerHTML = `
                <div class="syfe-search">
                    <div class="syfe-search__bar">
                        <input type="text" class="b3-text-field fn__flex-1" id="syfe-search-input"
                               placeholder="搜索文件名、文件夹名与内容..." />
                        <button class="b3-button b3-button--outline" id="syfe-search-btn">搜索</button>
                    </div>
                    <div class="syfe-search__row">
                        <div class="syfe-search__modes" id="syfe-search-modes">
                            <button class="syfe-search__mode active" data-mode="all">全部</button>
                            <button class="syfe-search__mode" data-mode="filename">文件名</button>
                            <button class="syfe-search__mode" data-mode="content">内容</button>
                        </div>
                        <div class="syfe-search__scopes" id="syfe-search-scopes">
                            <button class="syfe-search__scope active" data-scope="dir" title="${escapeHTML(rootPath)}">目录</button>
                            <button class="syfe-search__scope" data-scope="mount" title="虚拟文档树里挂载的思源文档、块与文件">虚拟文档树</button>
                            <button class="syfe-search__scope" data-scope="everything" title="voidtools Everything 全盘文件名搜索(需在 Everything 选项→HTTP 服务器 中启用)">Everything</button>
                            <button class="syfe-search__scope" data-scope="anytxt" title="AnyTXT Searcher 全盘全文搜索(需保持 AnyTXT 运行)">AnyTXT</button>
                        </div>
                    </div>
                    <div class="syfe-search__opts">
                        <label class="syfe-search__opt" title="区分大小写"><input type="checkbox" id="syfe-opt-case" /> 大小写</label>
                        <label class="syfe-search__opt" title="只匹配完整词(前后不是字母/数字/汉字)"><input type="checkbox" id="syfe-opt-word" /> 全词</label>
                        <label class="syfe-search__opt" title="按正则表达式搜索"><input type="checkbox" id="syfe-opt-regex" /> 正则</label>
                        <label class="syfe-search__opt syfe-search__opt--grow">包含 <input type="text" class="b3-text-field" id="syfe-opt-include" placeholder="*.md, *.ts" /></label>
                        <label class="syfe-search__opt syfe-search__opt--grow">排除 <input type="text" class="b3-text-field" id="syfe-opt-exclude" placeholder="node_modules/**, *.log" /></label>
                        <label class="syfe-search__opt">上下文
                            <select class="b3-select" id="syfe-opt-ctx">
                                <option value="0">0</option>
                                <option value="1">1</option>
                                <option value="2">2</option>
                            </select>
                        </label>
                    </div>
                    <div class="syfe-search__info" id="syfe-search-info"></div>
                    <div class="fn__flex-1 syfe-search__scroll">
                        <ul class="syfe-search__results" id="syfe-search-results"></ul>
                    </div>
                </div>`;

            const input = this.element.querySelector("#syfe-search-input") as HTMLInputElement;
            const btn = this.element.querySelector("#syfe-search-btn") as HTMLButtonElement;
            const modesEl = this.element.querySelector("#syfe-search-modes") as HTMLElement;
            const scopesEl = this.element.querySelector("#syfe-search-scopes") as HTMLElement;
            const infoEl = this.element.querySelector("#syfe-search-info") as HTMLElement;
            const resultsEl = this.element.querySelector("#syfe-search-results") as HTMLElement;
            const caseChk = this.element.querySelector("#syfe-opt-case") as HTMLInputElement;
            const wordChk = this.element.querySelector("#syfe-opt-word") as HTMLInputElement;
            const regexChk = this.element.querySelector("#syfe-opt-regex") as HTMLInputElement;
            const includeInput = this.element.querySelector("#syfe-opt-include") as HTMLInputElement;
            const excludeInput = this.element.querySelector("#syfe-opt-exclude") as HTMLInputElement;
            const ctxSel = this.element.querySelector("#syfe-opt-ctx") as HTMLSelectElement;
            const self = this;

            const scopeLabel = (scope: SearchScope): string => {
                switch (scope) {
                    case "mount": return "虚拟文档树";
                    case "everything": return "全盘(Everything)";
                    case "anytxt": return "全盘(AnyTXT)";
                    default: return "目录";
                }
            };

            const updatePlaceholder = () => {
                const scope = scopeLabel(self._scope || "dir");
                input.placeholder = self._mode === "content"
                    ? `在${scope}中搜索文件内容...`
                    : self._mode === "filename"
                        ? `在${scope}中搜索名称...`
                        : `在${scope}中搜索名称与内容...`;
            };

            const readOptions = (): SearchOptions => ({
                caseSensitive: caseChk.checked,
                wholeWord: wordChk.checked,
                regex: regexChk.checked,
                include: includeInput.value,
                exclude: excludeInput.value,
                context: parseInt(ctxSel.value || "0", 10) || 0,
            });

            // 内容搜索的核心:一批候选 → 各自读内容 → 逐行匹配 → 按文件成组追加
            const scanContent = async (
                candidates: Array<{path: string; name: string; subtitle: string; kind: "content" | "sydoc"; docId?: string; read: () => Promise<string>}>,
                testRe: RegExp,
                re: RegExp,
                keyword: string,
                opts: SearchOptions,
                token: symbol,
                onBatch: (done: number, total: number) => void,
            ): Promise<{contentCount: number; fileCount: number}> => {
                let contentCount = 0;
                let fileCount = 0;
                const concurrency = 8;
                for (let i = 0; i < candidates.length; i += concurrency) {
                    if ((self as any)._token !== token) return {contentCount, fileCount};
                    const batch = candidates.slice(i, i + concurrency);
                    await Promise.all(batch.map(async cand => {
                        try {
                            const content = await cand.read();
                            if (!content) return;
                            const lines = content.replace(/\r\n?/g, "\n").split("\n");
                            const matches: LineMatch[] = [];
                            for (let j = 0; j < lines.length; j++) {
                                testRe.lastIndex = 0;
                                if (!testRe.test(lines[j])) continue;
                                const before: string[] = [];
                                const after: string[] = [];
                                for (let k = Math.max(0, j - opts.context); k < j; k++) before.push(lines[k].trim().slice(0, 200));
                                for (let k = j + 1; k <= Math.min(lines.length - 1, j + opts.context); k++) after.push(lines[k].trim().slice(0, 200));
                                matches.push({lineNo: j + 1, preview: lines[j].trim().slice(0, 200), before, after});
                            }
                            if (matches.length === 0) return;
                            const g: FileGroup = {
                                path: cand.path,
                                name: cand.name,
                                subtitle: cand.subtitle,
                                kind: cand.kind,
                                ...(cand.docId ? {docId: cand.docId} : {}),
                                matches,
                            };
                            if ((self as any)._token !== token) return;
                            appendGroup(resultsEl, g, re, keyword);
                            fileCount++;
                            contentCount += matches.length;
                            for (const m of matches) {
                                self._results!.push({
                                    path: cand.path,
                                    lineNo: m.lineNo,
                                    line: m.preview,
                                    preview: m.preview,
                                    kind: cand.kind === "sydoc" ? "sydoc" : "content",
                                    ...(cand.docId ? {docId: cand.docId} : {}),
                                });
                            }
                        } catch {
                            // 跳过无法读取的文件
                        }
                    }));
                    if ((self as any)._token !== token) return {contentCount, fileCount};
                    onBatch(Math.min(i + batch.length, candidates.length), candidates.length);
                }
                return {contentCount, fileCount};
            };

            const doSearch = async () => {
                const keyword = input.value.trim();
                if (!keyword) return;
                self._keyword = keyword;
                const myToken = Symbol();
                (self as any)._token = myToken;
                const mode = self._mode || "all";
                const scope = self._scope || "dir";
                const opts = readOptions();
                // 服务范围(Everything/AnyTXT)用的是服务自己的查询方言,不做本端正则校验,
                // 只为描黄构造宽松的拆词正则;目录/虚拟文档树范围维持原逻辑
                const isServiceScope = scope === "everything" || scope === "anytxt";
                const re = isServiceScope ? buildServiceHighlight(keyword) : buildRegex(keyword, opts);
                if (!re) {
                    infoEl.textContent = "正则表达式无效,请检查后重试";
                    return;
                }
                // 测试用副本不带 g(带 g 的正则用 test 会推进 lastIndex,逐行判断会漏)
                const testRe = new RegExp(re.source, re.flags.replace(/g/g, ""));
                const includeMatch = buildGlobMatcher(opts.include);
                const excludeMatch = buildGlobMatcher(opts.exclude);
                const keep = (path: string, name: string): boolean => {
                    if (includeMatch && !includeMatch(path, name)) return false;
                    if (excludeMatch && excludeMatch(path, name)) return false;
                    return true;
                };
                const lowerKeyword = keyword.toLowerCase();

                btn.disabled = true;
                infoEl.textContent = "搜索中...";
                resultsEl.innerHTML = "";
                self._results = [];

                try {
                    let nameCount = 0;
                    let contentCount = 0;
                    let fileCount = 0;

                    // ===== 服务范围:Everything(全盘文件名)=====
                    if (scope === "everything") {
                        if (mode === "content") {
                            infoEl.textContent = "Everything 只提供文件名搜索,请切回「文件名」模式";
                            return;
                        }
                        infoEl.textContent = "搜索中... Everything 查询中";
                        const hits = await searchEverything(keyword, {
                            url: plugin.config.searchEverythingUrl,
                            limit: EVERYTHING_LIMIT,
                        });
                        if ((self as any)._token !== myToken) return;
                        const matched = hits.filter(h => h.path && h.name && keep(h.path, h.name));
                        for (const h of matched) {
                            const result: SearchResult = {
                                path: h.path,
                                lineNo: 0,
                                line: "",
                                preview: "",
                                kind: "name",
                                name: h.name,
                                isDir: h.isDir,
                            };
                            self._results!.push(result);
                            nameCount++;
                            appendNameResult(resultsEl, result, keyword);
                        }
                        infoEl.textContent = nameCount > 0
                            ? `名称 ${nameCount}` + (mode === "all" ? "(Everything 只有文件名维度)" : "")
                            : "未找到结果";
                        return;
                    }

                    // ===== 服务范围:AnyTXT(全盘全文)=====
                    if (scope === "anytxt") {
                        infoEl.textContent = "搜索中... AnyTXT 查询中";
                        const hits = await searchAnyTxt(keyword, {
                            url: plugin.config.searchAnytxtUrl,
                            limit: ANYTXT_LIMIT,
                        });
                        if ((self as any)._token !== myToken) return;
                        const matched = hits.filter(h => h.path && h.name && keep(h.path, h.name));
                        // 有 fid 的前 N 个并发取命中片段;失败降级为只列文件
                        const fragTexts = new Map<number, string>();
                        if (mode !== "filename") {
                            const targets = matched.slice(0, ANYTXT_FRAGMENT_LIMIT);
                            const concurrency = 4;
                            for (let i = 0; i < targets.length; i += concurrency) {
                                if ((self as any)._token !== myToken) return;
                                await Promise.all(targets.slice(i, i + concurrency).map(async (h, j) => {
                                    const text = h.fid
                                        ? await fetchAnyTxtFragment(plugin.config.searchAnytxtUrl, h.fid!, keyword)
                                        : "";
                                    fragTexts.set(i + j, text);
                                }));
                                infoEl.textContent = `搜索中... 文件 ${matched.length},片段 ${Math.min(i + concurrency, targets.length)}/${targets.length}`;
                            }
                            if ((self as any)._token !== myToken) return;
                        }
                        for (let idx = 0; idx < matched.length; idx++) {
                            const h = matched[idx];
                            const frag = (fragTexts.get(idx) || "").replace(/\s+/g, " ").trim().slice(0, 300);
                            if (frag) {
                                const g: FileGroup = {
                                    path: h.path,
                                    name: h.name,
                                    subtitle: serviceHitSubtitle(h),
                                    kind: "content",
                                    matches: [{lineNo: 0, preview: frag, before: [], after: []}],
                                };
                                appendGroup(resultsEl, g, re, keyword);
                                contentCount++;
                                fileCount++;
                            } else {
                                // 无片段(文件名命中 / 片段获取失败):退化为普通名称结果,点击直接打开
                                const result: SearchResult = {
                                    path: h.path,
                                    lineNo: 0,
                                    line: "",
                                    preview: "",
                                    kind: "name",
                                    name: h.name,
                                    isDir: h.isDir,
                                };
                                self._results!.push(result);
                                appendNameResult(resultsEl, result, keyword);
                            }
                        }
                        for (const h of matched) {
                            self._results!.push({
                                path: h.path,
                                lineNo: 0,
                                line: fragTexts.get(matched.indexOf(h)) || "",
                                preview: (fragTexts.get(matched.indexOf(h)) || "").slice(0, 200),
                                kind: "content",
                            });
                        }
                        infoEl.textContent = (contentCount + matched.length) > 0
                            ? (contentCount > 0
                                ? `内容 ${contentCount} 片段(${fileCount} 个文件,取前 ${Math.min(matched.length, ANYTXT_FRAGMENT_LIMIT)} 个的片段)`
                                : `文件 ${matched.length}(未取到片段)`)
                            : "未找到结果" + (hits.length === 0 && mode !== "filename" ? "(AnyTXT 建索引期间可能搜不到东西)" : "");
                        return;
                    }

                    // 1. 名称匹配(大小写不敏感)
                    if (mode !== "content") {
                        if (scope === "dir") {
                            const {entries} = await enumerateAll(rootPath, 0);
                            if ((self as any)._token !== myToken) return;
                            const matched = entries
                                .filter(e => keep(e.path, e.name))
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
                                appendNameResult(resultsEl, result, keyword);
                            }
                        } else {
                            const {items} = await enumerateMountItems();
                            if ((self as any)._token !== myToken) return;
                            const matched = items.filter(it => keep(it.id, it.title) && it.title.toLowerCase().includes(lowerKeyword));
                            for (const it of matched) {
                                const result: SearchResult = {
                                    path: it.subtitle,
                                    lineNo: 0,
                                    line: "",
                                    preview: "",
                                    kind: "name",
                                    name: it.title,
                                    isDir: false,
                                    docId: it.kind === "file" ? undefined : it.id,
                                };
                                self._results!.push(result);
                                nameCount++;
                                appendNameResult(resultsEl, result, keyword);
                            }
                        }
                        infoEl.textContent = mode === "filename"
                            ? (nameCount > 0 ? `找到 ${nameCount} 个名称结果` : "未找到结果")
                            : `搜索中... 名称 ${nameCount}`;
                    }

                    // 2. 内容匹配
                    if (mode !== "filename") {
                        let candidates: Array<{path: string; name: string; subtitle: string; kind: "content" | "sydoc"; docId?: string; read: () => Promise<string>}>;
                        if (scope === "dir") {
                            const {textFiles} = await enumerateAll(rootPath, plugin.config.searchMaxFileSize);
                            if ((self as any)._token !== myToken) return;
                            candidates = textFiles
                                .filter(p => keep(p, p.split("/").pop() || p))
                                .map(p => ({
                                    path: p,
                                    name: p.split("/").pop() || p,
                                    subtitle: dirname(p) || p,
                                    kind: "content" as const,
                                    read: () => readTextFile(p),
                                }));
                        } else {
                            const {items, truncated} = await enumerateMountItems();
                            if ((self as any)._token !== myToken) return;
                            candidates = items
                                .filter(it => keep(it.id, it.title))
                                .map(it => ({
                                    path: it.kind === "file" ? it.id : "sydoc://" + it.id,
                                    name: it.title,
                                    subtitle: it.subtitle,
                                    kind: (it.kind === "file" ? "content" : "sydoc") as "content" | "sydoc",
                                    ...(it.kind === "file" ? {} : {docId: it.id}),
                                    read: () => loadMountContent(it),
                                }));
                            if (truncated) {
                                infoEl.textContent = `挂载项超过 ${MAX_ITEMS} 个,本次只搜索前 ${items.length} 个(建议挂载具体文档而非整个笔记本)`;
                            }
                        }
                        const r = await scanContent(candidates, testRe, re, keyword, opts, myToken, (done, total) => {
                            const prefix = mode === "all" ? `名称 ${nameCount} · ` : "";
                            infoEl.textContent = `搜索中... ${prefix}内容 ${contentCount} (${done}/${total})`;
                        });
                        if ((self as any)._token !== myToken) return;
                        contentCount = r.contentCount;
                        fileCount = r.fileCount;
                    }

                    // 最终统计
                    if (mode === "all") {
                        infoEl.textContent = (nameCount + contentCount) > 0
                            ? `名称 ${nameCount} · 内容 ${contentCount}(${fileCount} 个文件)`
                            : "未找到结果";
                    } else if (mode === "content") {
                        infoEl.textContent = contentCount > 0
                            ? `内容 ${contentCount}(${fileCount} 个文件)`
                            : "未找到结果";
                    } else {
                        infoEl.textContent = nameCount > 0 ? `名称 ${nameCount}` : "未找到结果";
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

            // 范围切换:目录 ⇄ 虚拟文档树挂载项 ⇄ 本地服务(Everything/AnyTXT)
            scopesEl.addEventListener("click", (e: MouseEvent) => {
                const btnScope = (e.target as HTMLElement).closest("[data-scope]") as HTMLElement;
                if (!btnScope) return;
                self._scope = btnScope.dataset.scope as SearchScope;
                // 服务范围固定可用模式:Everything 只做文件名;AnyTXT 主打内容(「全部」等同内容)
                if (self._scope === "everything" && self._mode !== "filename") self._mode = "filename";
                if (self._scope === "anytxt" && self._mode === "all") self._mode = "content";
                modesEl.querySelectorAll<HTMLElement>(".syfe-search__mode").forEach(b => {
                    b.classList.toggle("active", b.dataset.mode === self._mode);
                });
                scopesEl.querySelectorAll(".syfe-search__scope").forEach(b => {
                    b.classList.toggle("active", b === btnScope);
                });
                updatePlaceholder();
                if (input.value.trim()) doSearch();
            });

            // 选项变更:已搜过就按新条件重跑(输入包含/排除时失焦或回车触发)
            for (const el of [caseChk, wordChk, regexChk, ctxSel]) {
                el.addEventListener("change", () => {
                    if (input.value.trim()) doSearch();
                });
            }
            for (const el of [includeInput, excludeInput]) {
                el.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (input.value.trim()) doSearch();
                    }
                });
                el.addEventListener("change", () => {
                    if (input.value.trim()) doSearch();
                });
            }

            // 结果点击(委托)
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // 分组标题:折叠/展开
                const head = target.closest(".syfe-search__group-head") as HTMLElement | null;
                if (head) {
                    const group = head.parentElement;
                    group?.classList.toggle("syfe-search__group--collapsed");
                    return;
                }
                const item = target.closest(".syfe-search__item") as HTMLElement | null;
                if (!item) return;
                const path = item.dataset.path!;
                if (!path) return;
                const docId = item.dataset.docId;
                if (docId) {
                    // 虚拟文档树:思源文档/块 → 打开并定位(传 app 走 openTab,协议回退会静默失败)
                    openSiyuanDoc(docId, plugin.app);
                    return;
                }
                if (item.dataset.kind === "name") {
                    // 名称结果:文件 → 打开编辑;文件夹 → 文件树中定位
                    if (item.dataset.isDir === "true") {
                        revealInTree(path);
                    } else {
                        openFileTab(plugin as IPluginForTab, path);
                    }
                } else {
                    // 内容结果:跳转到对应文件与行;无行号(服务范围的命中片段)直接打开文件
                    const lineNo = parseInt(item.dataset.line!, 10);
                    if (lineNo) {
                        revealInFile(plugin, path, lineNo);
                    } else {
                        openFileTab(plugin as IPluginForTab, path);
                    }
                }
            };
            resultsEl.addEventListener("click", this._clickHandler);

            // 右键菜单(委托):复用文件树菜单,提供与选中文件/文件夹相同的全部功能
            this._contextHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const item = target.closest(".syfe-search__item") as HTMLElement | null;
                if (!item) return;
                const path = item.dataset.path;
                if (!path) return;
                // 虚拟文档树结果不是真实路径,不套用文件菜单(会按目录去 readDir)
                if (item.dataset.docId) return;
                e.preventDefault();
                e.stopPropagation();
                // 名称结果按 dataset 判断;内容结果必为文件
                const isDir = item.dataset.isDir === "true";
                // 找到包含该路径的文件树,操作后就地刷新;找不到时菜单仍可用,仅跳过树刷新
                const rootEl = findTreeRootEl(path);
                const actions: IFileTreeActions = {
                    plugin: plugin as any,
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

            updatePlaceholder();
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
