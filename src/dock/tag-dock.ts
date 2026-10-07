// 侧边栏「标签」面板:按标签聚合文件与文件夹。
// 视图一(标签列表):列出全部标签(嵌套缩进 + 颜色图标 + 条目数),另有「全部已打标签」。
// 视图二(条目列表):列出该标签下的文件与文件夹;**文件夹可就地逐级展开其内部全部文件**,
// 相当于把打过标签的文件夹当收藏夹用(只展开一层,子文件夹再点再展开)。
// 数据来自 src/tags/tag-store.ts(tags.json);标签变化(syfe:tags-changed)自动重绘。
import {showMessage} from "siyuan";
import {TAG_DOCK_TYPE} from "../constants";
import {readDir} from "../api/file";
import {DirEntry} from "../types";
import {basename, dirname, joinPath} from "../utils/path";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {docTreeIconHTML, cachedDocIcon, ensureDocIcons} from "../utils/siyuan-icon";
import {isVirtualPath, virtualId, cachedDocTitle, ensureDocTitles} from "../utils/virtual-tree";
import {
    getChildTags,
    tagFullName,
    getTagById,
    getAllTaggedPaths,
    getPathsForTagIds,
    countForTag,
    expandWithDescendants,
    removeTagFromPath,
    clearTagsForPath,
    getTagsForPath,
    TAGS_CHANGED_EVENT,
} from "../tags/tag-store";
import {tagIconHTML, openTagMenu, openTagManagerDialog} from "../tags/tag-ui";
import {openEntry} from "../components/entry-menu";
import {showFileTreeMenu, findTreeRootEl, IFileTreeActions} from "../components/file-tree";
import {showDocMenu} from "../components/doc-menu";
import {openFileTab} from "../tabs/editor-tab";
import {openImageTab} from "../tabs/image-tab";
import {openOfficeTab} from "../tabs/office-tab";
import {openMediaTab} from "../tabs/media-tab";

// 面板所需的插件接口
export interface IPluginForTagDock {
    app: any;
    name: string;
    config: any;
    openFileSplit(path: string, position: "right" | "bottom"): void;
}

// 面板当前视图
type ViewMode = "tags" | "entries";

// 「全部已打标签」这一行的键(与真实标签 id 区分)
const ANY_KEY = "__any__";

// 渲染行(扁平化,便于按 data-idx 回查)
type Row =
    | {kind: "any"}
    // showEntries:该标签的条目是否已就地展开在标签行下面
    | {kind: "tag"; id: string; depth: number; hasKids: boolean; expanded: boolean; showEntries: boolean}
    | {kind: "entry"; path: string; isDir: boolean; depth: number; expanded: boolean}
    | {kind: "loading"; depth: number}
    | {kind: "empty"; depth: number};

// Dock 实例上附加的字段
interface TagDockInstance {
    element: HTMLElement;
    _listEl?: HTMLElement;
    _crumbEl?: HTMLElement;
    _clickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
    _actionHandler?: (e: MouseEvent) => void;
    _changedHandler?: () => void;
    _filesChangedHandler?: () => void;
    _mode?: ViewMode;
    _tagIds?: string[];        // 当前查看的标签 id(单选)
    _anyMode?: boolean;        // 「全部已打标签」
    _tagCollapsed?: Set<string>; // 标签树里被**收起**的标签(默认全展开,故记"收起"而非"展开")
    _entriesShown?: Set<string>; // 标签树里已就地展开条目的标签 id(点标签行切换)
    _anyEntriesShown?: boolean;  // 「全部已打标签」行是否已就地展开条目
    _selected?: string | null;   // 当前选中的行:标签 id 或 ANY_KEY
    _expanded?: Set<string>;   // 条目视图里已展开的文件夹路径
    _children?: Map<string, DirEntry[]>; // 已加载的目录子项
    _loading?: Set<string>;    // 正在加载子项的目录
    _kindCache?: Map<string, boolean>;   // 路径 → 是否目录
    _parentCache?: Map<string, DirEntry[]>; // 父目录 → 子项列表(用于判定 isDir)
    _rows?: Row[];
    _resolving?: boolean;
}

// 并发受限的异步遍历,避免一次性发出上百个 readDir
async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        workers.push((async () => {
            while (cursor < items.length) {
                const idx = cursor++;
                await fn(items[idx]);
            }
        })());
    }
    await Promise.all(workers);
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 排序:文件夹优先,再按名称(与文件树保持一致)
function sortEntries(entries: DirEntry[]): DirEntry[] {
    return entries.slice().sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// 构建侧边栏「标签」面板 addDock 配置
export function createTagDockConfig(plugin: IPluginForTagDock) {
    return {
        type: TAG_DOCK_TYPE,
        config: {
            position: "LeftBottom" as const,
            size: {width: 240, height: 0},
            icon: "iconTags",
            title: "标签",
            hotkey: "",
            show: true,
        },
        data: {},
        init(this: TagDockInstance) {
            this.element.classList.add("syfe-tag-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-tagdock__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconTags"></use></svg>
                        <span class="block__logotext">标签</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-action="refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="manage" aria-label="管理标签" data-position="north">
                        <svg><use xlink:href="#iconTags"></use></svg>
                    </span>
                </div>
                <div class="syfe-tagdock__crumb" style="display:none;"></div>
                <div class="fn__flex-1 syfe-tagdock__scroll">
                    <ul class="syfe-tagdock__list"></ul>
                </div>`;

            const listEl = this.element.querySelector(".syfe-tagdock__list") as HTMLElement;
            const crumbEl = this.element.querySelector(".syfe-tagdock__crumb") as HTMLElement;
            this._listEl = listEl;
            this._crumbEl = crumbEl;
            const self = this;
            self._mode = "tags";
            self._tagIds = [];
            self._anyMode = false;
            // 标签树默认全部展开:用"已收起"集合表示,新增标签天然是展开的
            self._tagCollapsed = new Set<string>();
            // 标签的条目默认不展开,点标签行才就地展开
            self._entriesShown = new Set<string>();
            self._anyEntriesShown = false;
            self._selected = null;
            self._expanded = new Set<string>();
            self._children = new Map<string, DirEntry[]>();
            self._loading = new Set<string>();
            self._kindCache = new Map<string, boolean>();
            self._parentCache = new Map<string, DirEntry[]>();
            self._rows = [];

            // 当前视图要展示的根路径(聚焦视图下用;标签树内联展开时由 buildRows 单独取)
            const currentPaths = (): string[] => {
                if (self._mode !== "entries") return [];
                if (self._anyMode) return getAllTaggedPaths();
                const ids = expandWithDescendants(self._tagIds || []);
                return getPathsForTagIds(ids);
            };

            // 当前**实际渲染出来的**顶层条目路径:聚焦视图 = currentPaths();
            // 标签树 = 各内联展开标签(含后代)的条目 + 「全部已打标签」内联展开时的全部条目。
            // 用来决定哪些路径需要补判 isDir(已展开文件夹的子项来自 DirEntry,无需补判)。
            const shownEntryPaths = (): string[] => {
                if (self._mode === "entries") return currentPaths();
                const out: string[] = [];
                if (self._anyEntriesShown) out.push(...getAllTaggedPaths());
                for (const id of Array.from(self._entriesShown!)) {
                    out.push(...getPathsForTagIds(expandWithDescendants([id])));
                }
                return out;
            };

            // 判定每个路径是文件还是文件夹:读其父目录,按名字回查(无法直接 readDir 目标:
            // 思源内核对文件也会返回空数组,区分不了"空目录"和"文件")
            const resolveKinds = async (paths: string[]): Promise<boolean> => {
                const unknown = paths.filter(p => !self._kindCache!.has(p));
                if (unknown.length === 0) return false;
                const parents = Array.from(new Set(unknown.map(dirname)));
                await mapLimit(parents, 6, async (parent) => {
                    if (self._parentCache!.has(parent)) return;
                    let list: DirEntry[] = [];
                    try {
                        const raw = await readDir(parent);
                        list = Array.isArray(raw) ? raw : [];
                    } catch {
                        list = [];
                    }
                    self._parentCache!.set(parent, list);
                });
                for (const p of unknown) {
                    const list = self._parentCache!.get(dirname(p)) || [];
                    const ent = list.find(e => e.name === basename(p));
                    // 在父目录里找不到(已删除/已改名)时按文件处理,仍可点击尝试打开
                    self._kindCache!.set(p, ent ? !!ent.isDir : false);
                }
                return true;
            };

            // 展开文件夹时加载其子项(懒加载,只取一层)
            const loadChildren = async (dirPath: string): Promise<void> => {
                if (self._children!.has(dirPath) || self._loading!.has(dirPath)) return;
                self._loading!.add(dirPath);
                try {
                    const raw = await readDir(dirPath);
                    self._children!.set(dirPath, sortEntries(Array.isArray(raw) ? raw : []));
                } catch {
                    self._children!.set(dirPath, []);
                } finally {
                    self._loading!.delete(dirPath);
                    render();
                }
            };

            // 把一批路径渲染成"条目行"(文件夹可继续就地展开)。两种场景共用:
            // 1) 标签树里某标签行就地展开;2) 点「聚焦」后的条目列表视图。
            const emitEntries = (paths: string[], depth: number, out: Row[]): void => {
                const withKind = paths.map(p => ({path: p, isDir: self._kindCache!.get(p) ?? false}));
                // 文件夹优先,再按名称
                withKind.sort((a, b) => {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return basename(a.path).localeCompare(basename(b.path));
                });
                const walk = (items: {path: string; isDir: boolean}[], d: number) => {
                    for (const it of items) {
                        const expanded = self._expanded!.has(it.path);
                        out.push({kind: "entry", path: it.path, isDir: it.isDir, depth: d, expanded});
                        if (it.isDir && expanded) {
                            const kids = self._children!.get(it.path);
                            if (!kids) {
                                // 还没加载完
                                out.push({kind: "loading", depth: d + 1});
                            } else if (kids.length === 0) {
                                // 确实是空文件夹(加载过且无子项),不要一直显示"加载中"
                                out.push({kind: "empty", depth: d + 1});
                            } else {
                                walk(kids.map(k => ({path: joinPath(it.path, k.name), isDir: !!k.isDir})), d + 1);
                            }
                        }
                    }
                };
                walk(withKind, depth);
            };

            // 构建扁平渲染行
            const buildRows = (): Row[] => {
                const rows: Row[] = [];
                if (self._mode === "tags") {
                    rows.push({kind: "any"});
                    // 「全部已打标签」行就地展开时,内联列出所有打过标签的条目
                    if (self._anyEntriesShown) {
                        emitEntries(getAllTaggedPaths(), 1, rows);
                    }
                    // 树形逐级渲染:默认全部展开,收起的节点不 emit 其子级
                    const walkTags = (parentId: string | undefined, depth: number) => {
                        for (const t of getChildTags(parentId)) {
                            const hasKids = getChildTags(t.id).length > 0;
                            const expanded = !self._tagCollapsed!.has(t.id);
                            const showEntries = self._entriesShown!.has(t.id);
                            rows.push({kind: "tag", id: t.id, depth, hasKids, expanded, showEntries});
                            // 子标签(标签层级)
                            if (hasKids && expanded) walkTags(t.id, depth + 1);
                            // 该标签打过的文件/文件夹(点标签行就地展开,含后代标签的条目)
                            if (showEntries) {
                                emitEntries(getPathsForTagIds(expandWithDescendants([t.id])), depth + 1, rows);
                            }
                        }
                    };
                    walkTags(undefined, 0);
                    return rows;
                }
                // 聚焦视图:整页列该标签的条目
                emitEntries(currentPaths(), 0, rows);
                return rows;
            };

            // 渲染:先按现有缓存画出来,再后台补判 isDir 后重绘
            const render = () => {
                const rows = buildRows();
                self._rows = rows;

                // 面包屑:条目视图下显示「← 全部标签 / 标签名 · N 项」
                if (self._mode === "entries") {
                    const name = self._anyMode
                        ? "全部已打标签"
                        : (getTagById((self._tagIds || [])[0])?.name || "标签");
                    const total = currentPaths().length;
                    crumbEl.style.display = "";
                    crumbEl.innerHTML = `
                        <span class="syfe-tagdock__crumb-back" data-action="back" title="返回标签列表">
                            <svg><use xlink:href="#iconLeft"></use></svg>
                        </span>
                        <span class="syfe-tagdock__crumb-name">${escapeHTML(name)}</span>
                        <span class="syfe-tagdock__crumb-count">${total}</span>`;
                } else {
                    crumbEl.style.display = "none";
                    crumbEl.innerHTML = "";
                }

                if (rows.length === 0) {
                    listEl.innerHTML = `<li class="syfe-tagdock__empty">${
                        self._mode === "tags" ? "暂无标签,可在文件树右键「标签」新建" : "该标签下暂无条目"
                    }</li>`;
                    return;
                }

                listEl.innerHTML = rows.map((r, i) => {
                    const pad = 8 + ("depth" in r ? r.depth : 0) * 14;
                    if (r.kind === "any") {
                        const selected = self._selected === ANY_KEY;
                        return `
                        <li class="syfe-tagdock__row syfe-tagdock__row--any${selected ? " syfe-tagdock__row--selected" : ""}${self._anyEntriesShown ? " syfe-tagdock__row--open" : ""}"
                            data-idx="${i}" data-any="1" title="点击展开/收起全部已打标签的条目">
                            <span class="syfe-tagdock__toggle"><svg><use xlink:href="#${self._anyEntriesShown ? "iconDown" : "iconRight"}"></use></svg></span>
                            <span class="syfe-tagdock__icon"><svg><use xlink:href="#iconTags"></use></svg></span>
                            <span class="syfe-tagdock__name">全部已打标签</span>
                            <span class="syfe-tagdock__count">${getAllTaggedPaths().length}</span>
                            <span class="syfe-tagdock__focus" data-focus="${ANY_KEY}" title="聚焦:整页列出全部已打标签的条目">聚焦</span>
                        </li>`;
                    }
                    if (r.kind === "tag") {
                        const t = getTagById(r.id);
                        if (!t) return "";
                        const selected = self._selected === r.id;
                        // 行首箭头只管"子标签"的展开/收起;点行本身是就地展开该标签的条目
                        const toggle = r.hasKids
                            ? `<span class="syfe-tagdock__toggle syfe-tagdock__toggle--arrow" data-arrow="${escapeHTML(r.id)}" title="展开/收起子标签"><svg><use xlink:href="#${r.expanded ? "iconDown" : "iconRight"}"></use></svg></span>`
                            : `<span class="syfe-tagdock__toggle"></span>`;
                        return `
                        <li class="syfe-tagdock__row syfe-tagdock__row--tag${selected ? " syfe-tagdock__row--selected" : ""}${r.showEntries ? " syfe-tagdock__row--open" : ""}"
                            data-idx="${i}" data-tag="${escapeHTML(r.id)}" style="padding-left:${8 + r.depth * 14}px"
                            title="点击展开/收起该标签的文件与文件夹${r.hasKids ? "(行首箭头展开子标签)" : ""}">
                            ${toggle}
                            <span class="syfe-tagdock__icon">${tagIconHTML(t)}</span>
                            <span class="syfe-tagdock__name">${escapeHTML(t.name)}</span>
                            <span class="syfe-tagdock__count">${countForTag(r.id)}</span>
                            <span class="syfe-tagdock__focus" data-focus="${escapeHTML(r.id)}" title="聚焦:整页列出该标签下的条目">聚焦</span>
                        </li>`;
                    }
                    if (r.kind === "loading") {
                        return `<li class="syfe-tagdock__row syfe-tagdock__row--loading" style="padding-left:${pad + 14}px">加载中…</li>`;
                    }
                    if (r.kind === "empty") {
                        return `<li class="syfe-tagdock__row syfe-tagdock__row--loading" style="padding-left:${pad + 14}px">(空文件夹)</li>`;
                    }
                    const name = basename(r.path);
                    const toggle = r.isDir
                        ? `<span class="syfe-tagdock__toggle"><svg><use xlink:href="#${r.expanded ? "iconDown" : "iconRight"}"></use></svg></span>`
                        : `<span class="syfe-tagdock__toggle"></span>`;
                    // 思源文档条目(sydoc://)显示与思源文档树一致的文档图标和文档标题
                    const isDoc = isVirtualPath(r.path);
                    const icon = isDoc
                        ? docTreeIconHTML(cachedDocIcon(virtualId(r.path)) || "", "file")
                        : (r.isDir ? folderIconHTML(name, r.expanded) : fileIconHTML(name));
                    const showName = isDoc ? (cachedDocTitle(virtualId(r.path)) || name) : name;
                    return `
                        <li class="syfe-tagdock__row syfe-tagdock__row--entry${r.isDir ? " syfe-tagdock__row--dir" : ""}"
                            data-idx="${i}" data-path="${escapeHTML(r.path)}" style="padding-left:${pad}px" title="${escapeHTML(r.path)}">
                            ${toggle}
                            <span class="syfe-tagdock__icon">${icon}</span>
                            <span class="syfe-tagdock__name">${escapeHTML(showName)}</span>
                        </li>`;
                }).join("");

                // 补判各路径是文件还是文件夹(标签树内联展开与聚焦视图都要),判定完重绘一次
                if (!self._resolving) {
                    const paths = shownEntryPaths();
                    if (paths.some(p => !self._kindCache!.has(p))) {
                        self._resolving = true;
                        void resolveKinds(paths).then(changed => {
                            self._resolving = false;
                            if (changed) render();
                        });
                    }
                }

                // 思源文档条目的自定义图标与标题:先按缓存画,后台补齐后重绘一次(内部去重)
                const docIds = rows
                    .filter((r): r is Extract<Row, {kind: "entry"}> => r.kind === "entry" && isVirtualPath(r.path))
                    .map(r => virtualId(r.path));
                ensureDocIcons(docIds, () => render());
                ensureDocTitles(docIds, () => render());
            };
            render();

            // 按当前视图拿到某行对应的路径(供右键菜单)
            const rowOf = (el: HTMLElement | null): Row | null => {
                if (!el) return null;
                const idx = Number(el.dataset.idx);
                return Number.isFinite(idx) ? (self._rows![idx] || null) : null;
            };

            // 点击:
            // - 「聚焦」按钮 → 整页进入该标签的条目列表
            // - 标签行 → 就地展开/收起该标签的文件与文件夹(文件夹还能再点开看内部文件)
            // - 行首箭头 → 展开/收起子标签
            // - 条目行 → 文件夹就地展开/收起,文件打开
            const clickHandler = (e: MouseEvent) => {
                // 聚焦按钮在最内层,优先处理:**只有点它才整页进入条目列表**
                const focusEl = (e.target as HTMLElement).closest("[data-focus]") as HTMLElement | null;
                if (focusEl) {
                    const id = focusEl.dataset.focus!;
                    self._selected = id;
                    self._mode = "entries";
                    self._anyMode = id === ANY_KEY;
                    self._tagIds = self._anyMode ? [] : [id];
                    self._expanded = new Set<string>();
                    render();
                    return;
                }
                // 行首箭头:仅切换子标签的展开/收起
                const arrowEl = (e.target as HTMLElement).closest("[data-arrow]") as HTMLElement | null;
                if (arrowEl) {
                    const id = arrowEl.dataset.arrow!;
                    if (self._tagCollapsed!.has(id)) self._tagCollapsed!.delete(id);
                    else self._tagCollapsed!.add(id);
                    render();
                    return;
                }
                const el = (e.target as HTMLElement).closest(".syfe-tagdock__row") as HTMLElement | null;
                if (!el) return;
                // 标签行:就地展开/收起该标签打过的文件与文件夹
                if (el.dataset.tag) {
                    const id = el.dataset.tag;
                    self._selected = id;
                    if (self._entriesShown!.has(id)) self._entriesShown!.delete(id);
                    else self._entriesShown!.add(id);
                    render();
                    return;
                }
                if (el.dataset.any === "1") {
                    self._selected = ANY_KEY;
                    self._anyEntriesShown = !self._anyEntriesShown;
                    render();
                    return;
                }
                const row = rowOf(el);
                if (!row || row.kind !== "entry") return;
                if (row.isDir) {
                    if (self._expanded!.has(row.path)) self._expanded!.delete(row.path);
                    else {
                        self._expanded!.add(row.path);
                        void loadChildren(row.path);
                    }
                    render();
                    return;
                }
                openEntry(plugin as any, {kind: "file", path: row.path});
            };
            this._clickHandler = clickHandler;
            listEl.addEventListener("click", clickHandler);

            // 文件操作回调:与虚拟文档树面板一致,复用文件树完整右键菜单(一份实现两处用)
            const fileTreeActions: IFileTreeActions = {
                plugin,
                openFile: (p) => openFileTab(plugin as any, p),
                openImage: (p) => openImageTab(plugin as any, p),
                openOffice: (p) => openOfficeTab(plugin as any, p),
                openMedia: (p) => openMediaTab(plugin as any, p),
                openMarkdown: (p, mode) => (plugin as any).openMarkdown(p, mode),
                openSearch: (rp) => (plugin as any).openSearch(rp),
                openTerminal: (cwd) => (plugin as any).openTerminal(cwd),
                openFileSplit: (p, pos) => openFileTab(plugin as any, p, {position: pos}),
                togglePin: (p) => (plugin as any).togglePin(p),
                toggleFavorite: (p) => (plugin as any).toggleFavorite(p),
                manageTags: (p, ev) => {
                    void openTagMenu(plugin as any, p, ev, () => render());
                },
            };

            // 右键:文件/文件夹复用**文件树完整菜单**(与虚拟文档树面板同款,含打开方式/新建/
            // 搜索/标签/固定收藏/挂载/重命名/删除/复制等);思源文档条目(sydoc://)给「原生」
            // 文档菜单(打开/新建子文档/复制/导出/重命名/删除,对齐思源文档树)。
            // 两种菜单都会在末尾追加标签相关项。
            const contextHandler = (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest(".syfe-tagdock__row") as HTMLElement | null;
                const row = rowOf(el);
                if (!row || row.kind !== "entry") return;
                e.preventDefault();
                e.stopPropagation();
                const path = row.path;
                // 标签相关追加项:「从此标签中移除 / 清除此条目的全部标签」(聚焦视图才有"当前标签"语义)
                const extra: Array<{icon?: string; label: string; click: () => void}> = [];
                if (self._mode === "entries") {
                    extra.push({
                        icon: "iconTrashcan",
                        label: self._anyMode ? "清除此条目的全部标签" : "从此标签中移除",
                        click: () => {
                            if (self._anyMode) {
                                void clearTagsForPath(plugin as any, path).then(() => {
                                    showMessage("已清除该条目的标签", 2000, "info");
                                    render();
                                });
                                return;
                            }
                            const ids = expandWithDescendants(self._tagIds || []);
                            const mine = getTagsForPath(path).filter(t => ids.has(t.id));
                            if (mine.length === 0) {
                                showMessage("该条目没有当前标签", 2000, "info");
                                return;
                            }
                            void (async () => {
                                for (const t of mine) await removeTagFromPath(plugin as any, path, t.id);
                                showMessage("已从此标签中移除", 2000, "info");
                                render();
                            })();
                        },
                    });
                }
                if (isVirtualPath(path)) {
                    showDocMenu({
                        x: e.clientX,
                        y: e.clientY,
                        plugin: plugin as any,
                        docId: virtualId(path),
                        name: cachedDocTitle(virtualId(path)) || basename(path),
                        extra: [
                            {
                                icon: "iconTags",
                                label: "标签…",
                                click: () => {
                                    void openTagMenu(plugin as any, path, e, () => render());
                                },
                            },
                            ...extra,
                        ],
                        onAfter: () => render(),
                    });
                    return;
                }
                const isDir = self._kindCache!.get(path) ?? false;
                const rootEl = findTreeRootEl(path);
                showFileTreeMenu(e, path, isDir, rootEl, rootEl?.dataset.path || "", fileTreeActions, undefined, extra as any);
            };
            this._contextHandler = contextHandler;
            listEl.addEventListener("contextmenu", contextHandler);

            // 工具栏 / 面包屑:返回、刷新、管理标签
            const actionHandler = (e: MouseEvent) => {
                const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
                if (!actionEl) return;
                const action = actionEl.dataset.action;
                if (action === "back") {
                    self._mode = "tags";
                    self._anyMode = false;
                    self._tagIds = [];
                    self._expanded = new Set<string>();
                    render();
                } else if (action === "refresh") {
                    // 清掉目录子项与类型缓存,重新读取
                    self._children = new Map<string, DirEntry[]>();
                    self._parentCache = new Map<string, DirEntry[]>();
                    self._kindCache = new Map<string, boolean>();
                    render();
                } else if (action === "manage") {
                    openTagManagerDialog(plugin as any, () => render());
                }
            };
            this._actionHandler = actionHandler;
            const toolbarEl = this.element.querySelector(".syfe-tagdock__toolbar") as HTMLElement;
            toolbarEl.addEventListener("click", actionHandler);
            crumbEl.addEventListener("click", actionHandler);

            // 标签数据变化(打标/取消/新建/删除)时自动重绘
            const changedHandler = () => render();
            this._changedHandler = changedHandler;
            window.addEventListener(TAGS_CHANGED_EVENT, changedHandler);

            // 文件系统变动(重命名/删除/新建/粘贴等,来自 refreshFileTrees;右键菜单里 rootEl
            // 传 null,操作本身不刷新文件树)→ 清缓存并重绘,让条目列表同步最新状态
            const filesChangedHandler = () => {
                self._children = new Map<string, DirEntry[]>();
                self._parentCache = new Map<string, DirEntry[]>();
                self._kindCache = new Map<string, boolean>();
                render();
            };
            this._filesChangedHandler = filesChangedHandler;
            window.addEventListener("syfe:files-changed", filesChangedHandler);
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: TagDockInstance) {
            if (this._listEl && this._clickHandler) {
                this._listEl.removeEventListener("click", this._clickHandler);
            }
            if (this._listEl && this._contextHandler) {
                this._listEl.removeEventListener("contextmenu", this._contextHandler);
            }
            if (this._changedHandler) {
                window.removeEventListener(TAGS_CHANGED_EVENT, this._changedHandler);
            }
            if (this._filesChangedHandler) {
                window.removeEventListener("syfe:files-changed", this._filesChangedHandler);
                this._filesChangedHandler = undefined;
            }
            this._listEl = undefined;
            this._crumbEl = undefined;
            this._clickHandler = undefined;
            this._contextHandler = undefined;
            this._actionHandler = undefined;
            this._changedHandler = undefined;
            this._rows = undefined;
            this._expanded = undefined;
            this._tagCollapsed = undefined;
            this._entriesShown = undefined;
            this._selected = undefined;
            this._children = undefined;
            this._loading = undefined;
            this._kindCache = undefined;
            this._parentCache = undefined;
        },
    };
}
