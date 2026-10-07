// 侧边栏「虚拟文档树」面板:一棵初始为空、由用户自己组织的树。
// 可挂载:真实文件/文件夹、思源文档(自动带出子文档)、思源块(按子块递归展开);
// 支持嵌套挂载(把条目挂到另一个挂载项下),可随时取消挂载。
// 数据层 src/mount-tree.ts(virtual-tree.json);结构变化派发 syfe:mount-tree-changed 自动重绘。
import {Menu, confirm, showMessage} from "siyuan";
import {MOUNT_TREE_DOCK_TYPE} from "../constants";
import {readDir} from "../api/file";
import {DirEntry} from "../types";
import {basename, dirname, joinPath} from "../utils/path";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {toFileLink} from "../utils/system-path";
import {virtualListDir, virtualId, isNotebookRoot} from "../utils/virtual-tree";
import {docTreeIconHTML, cachedDocIcon, ensureDocIcons, getNotebookIcon} from "../utils/siyuan-icon";
import {listChildBlocks, blockTitle, BlockNode} from "../utils/blocks";
import {copyText, revealInFileTree, pickMountTargetDialog, showFileTreeMenu, findTreeRootEl, createNewFile, createNewFolder, IFileTreeActions} from "../components/file-tree";
import {openBaiduPanDialog} from "../components/baidu-pan-dialog";
import {openImageTab} from "../tabs/image-tab";
import {openOfficeTab} from "../tabs/office-tab";
import {openMediaTab} from "../tabs/media-tab";
import {openTagMenu, tagIconHTML} from "../tags/tag-ui";
import {
    getAllTags,
    sortTagsTree,
    tagDepth,
    tagFullName,
    expandWithDescendants,
    pathMatchesFilter,
    pathHasAnyTag,
    TAGS_CHANGED_EVENT,
} from "../tags/tag-store";
import {openWithExternalApp, revealInSystemExplorer} from "../utils/external-app";
import {openSiyuanDoc} from "../components/entry-menu";
import {showDocMenu, showNotebookMenu, addPinFavEntries, DocMenuItem} from "../components/doc-menu";
import {openSiyuanTagDialog} from "../components/siyuan-tag-dialog";
import {openFileTab} from "../tabs/editor-tab";
import {mountPayload, promptMountPathDialog} from "../components/mount-menu";
import {
    getRoots,
    removeMountItem,
    mountTreeEmptyHint,
    MOUNT_TREE_CHANGED_EVENT,
    MountItem,
} from "../mount-tree";

export interface IPluginForMountTree {
    app: any;
    name: string;
    config: any;
    openFileSplit(path: string, position: "right" | "bottom"): void;
}

// 渲染行(扁平化,按 data-idx 回查)
type Row =
    | {kind: "mount"; uid: string; depth: number; expanded: boolean; hasChildren: boolean; item: MountItem}
    | {kind: "file"; path: string; name: string; isDir: boolean; depth: number; expanded: boolean}
    | {kind: "doc"; docId: string; name: string; depth: number; expanded: boolean; icon?: string; subFileCount?: number}
    | {kind: "block"; blockId: string; name: string; depth: number; expanded: boolean}
    | {kind: "empty"; depth: number}
    | {kind: "loading"; depth: number};

interface MountTreeDockInstance {
    element: HTMLElement;
    _listEl?: HTMLElement;
    // 交互监听挂在滚动容器上:**<ul> 高度只随行数增长**,面板下方空白区域属于滚动容器,
    // 监听 <ul> 会导致"在空白处右键"完全没反应
    _scrollEl?: HTMLElement;
    _clickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
    _actionHandler?: (e: MouseEvent) => void;
    _changedHandler?: () => void;
    _filesChangedHandler?: () => void;
    _tagsChangedHandler?: () => void;
    _rows?: Row[];
    _expanded?: Set<string>;                       // 展开的节点键
    _cache?: Map<string, DirEntry[] | BlockNode[]>;// 已加载的子项
    _loading?: Set<string>;                        // 正在加载的节点键
    _nbIcons?: Map<string, string>;                // 笔记本 id → 自定义图标(后台取到后重绘)
}

// 预取子项以判断箭头显隐的并发数与数量上限(超过上限不预取,避免大目录树把面板拖慢)
const PREFETCH_CONCURRENCY = 4;
const MAX_PREFETCH = 200;

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function copyWithToast(text: string | null, okMsg: string, failMsg: string): void {
    if (!text) {
        showMessage(failMsg, 3000, "error");
        return;
    }
    copyText(text).then(
        ok => ok ? showMessage(okMsg, 2500, "info") : showMessage("复制失败", 2000, "error"),
    );
}

// 调外部应用(系统默认应用 / 资源管理器),失败给可读提示
function runExternal(fn: () => Promise<void>): void {
    fn().catch(e => showMessage(`打开失败: ${e?.message || e}`, 3000, "error"));
}

// 文件夹优先、再按名称(与文件树一致)
function sortEntries(entries: DirEntry[]): DirEntry[] {
    return entries.slice().sort((a, b) => {
        if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
    });
}

// 构建侧边栏「虚拟文档树」面板 addDock 配置
export function createMountTreeDockConfig(plugin: IPluginForMountTree) {
    return {
        type: MOUNT_TREE_DOCK_TYPE,
        config: {
            position: "LeftBottom" as const,
            size: {width: 260, height: 0},
            icon: "iconList",
            title: "虚拟文档树",
            hotkey: "",
            show: true,
        },
        data: {},
        init(this: MountTreeDockInstance) {
            this.element.classList.add("syfe-mtree-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-mtree__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconList"></use></svg>
                        <span class="block__logotext">虚拟文档树</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-action="tag-filter" aria-label="标签筛选" data-position="north">
                        <svg><use xlink:href="#iconTags"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="search" aria-label="搜索" data-position="north">
                        <svg><use xlink:href="#iconSearch"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="collapse" aria-label="全部收起" data-position="north">
                        <svg><use xlink:href="#iconRight"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="more" aria-label="更多" data-position="north">
                        <svg><use xlink:href="#iconMore"></use></svg>
                    </span>
                </div>
                <div class="fn__flex-1 syfe-mtree__scroll">
                    <div class="syfe-mtree__chips" style="display:none;"></div>
                    <ul class="syfe-mtree__list"></ul>
                </div>`;

            const listEl = this.element.querySelector(".syfe-mtree__list") as HTMLElement;
            const chipsEl = this.element.querySelector(".syfe-mtree__chips") as HTMLElement;
            const scrollEl = this.element.querySelector(".syfe-mtree__scroll") as HTMLElement;
            this._listEl = listEl;
            this._scrollEl = scrollEl;
            const self = this;
            self._rows = [];
            self._expanded = new Set<string>();
            self._cache = new Map<string, DirEntry[] | BlockNode[]>();
            self._loading = new Set<string>();
            self._nbIcons = new Map<string, string>();

            // 标签筛选状态(与文件面板一致:多选标签 = 或关系;"全部"= 只要打过任意标签)
            let tagSel: string[] = [];
            let tagAny = false;
            let filterOn = false;
            // 最近一次点击的目录(新建文件/文件夹、搜索的默认位置)
            let currentDir: string | null = null;

            // 命中父行:DFS 顺序里,父行 = 往前最近的 depth-1 的行
            const parentIndexOf = (rows: Row[], i: number): number => {
                const d = rows[i].depth;
                for (let j = i - 1; j >= 0; j--) {
                    if (rows[j].depth === d - 1) return j;
                    if (rows[j].depth < d - 1) return -1;
                }
                return -1;
            };

            // 标签筛选:隐藏未命中的**文件**;目录/挂载节点仅在自身命中或有命中后代时保留
            const applyTagFilter = (rows: Row[]): Row[] => {
                const ids = expandWithDescendants(tagSel);
                const hit = (p: string) => (tagAny ? pathHasAnyTag(p) : pathMatchesFilter(p, ids));
                const keep = new Set<number>();
                rows.forEach((r, i) => {
                    if (r.kind === "file") {
                        if (hit(r.path)) keep.add(i);
                    } else if (r.kind === "mount" || r.kind === "doc" || r.kind === "block") {
                        keep.add(i); // 挂载点与思源内容不参与文件标签筛选,始终可见
                    }
                });
                // 自底向上把命中项的祖先带出来(DFS 序保证后代在父之后)
                for (let i = rows.length - 1; i >= 0; i--) {
                    if (!keep.has(i)) continue;
                    const p = parentIndexOf(rows, i);
                    if (p >= 0) keep.add(p);
                }
                return rows.filter((_, i) => keep.has(i));
            };

            // 标签 chip 行
            const renderChips = () => {
                if (!filterOn) {
                    chipsEl.style.display = "none";
                    return;
                }
                chipsEl.style.display = "";
                const tags = sortTagsTree();
                const allOn = tagAny ? " syfe-mtree__chip--on" : "";
                const head = `<span class="syfe-mtree__chip syfe-mtree__chip--all${allOn}" data-all="1"
                    title="不指定标签,筛出所有打过标签的条目">全部已打标签</span>`;
                chipsEl.innerHTML = tags.length === 0
                    ? head + `<span class="syfe-mtree__chip--empty">暂无标签,右键文件可新建</span>`
                    : head + tags.map(t => {
                        const on = !tagAny && tagSel.includes(t.id);
                        const pad = tagDepth(t.id) * 10;
                        return `<span class="syfe-mtree__chip${on ? " syfe-mtree__chip--on" : ""}" data-id="${escapeHTML(t.id)}"
                            style="margin-left:${pad}px" title="${escapeHTML(tagFullName(t.id))}">${tagIconHTML(t)}<span class="syfe-mtree__chip-text">${escapeHTML(t.name)}</span></span>`;
                    }).join("");
            };

            // 懒加载某个节点的子项(键相同则只加载一次)
            const load = async (key: string, loader: () => Promise<DirEntry[] | BlockNode[]>): Promise<void> => {
                if (self._cache!.has(key) || self._loading!.has(key)) return;
                self._loading!.add(key);
                try {
                    const kids = await loader();
                    self._cache!.set(key, Array.isArray(kids) ? kids : []);
                } catch {
                    self._cache!.set(key, []);
                } finally {
                    self._loading!.delete(key);
                    render();
                }
            };

            // 后台预取"有没有子项":空节点(空文件夹 / 无子文档 / 无子块)就不显示折叠箭头。
            // 结果直接写进 _cache,用户再点开时**无需二次请求**。
            // 不逐个重绘,整批结束后统一 render 一次;数量超上限则放弃预取,保持乐观显示箭头。
            const prefetch = (list: {key: string; loader: () => Promise<DirEntry[] | BlockNode[]>}[]): void => {
                const todo = list.filter(x => !self._cache!.has(x.key) && !self._loading!.has(x.key));
                if (todo.length === 0 || todo.length > MAX_PREFETCH) return;
                void (async () => {
                    let cursor = 0;
                    const worker = async (): Promise<void> => {
                        while (cursor < todo.length) {
                            const t = todo[cursor++];
                            self._loading!.add(t.key);
                            try {
                                const kids = await t.loader();
                                self._cache!.set(t.key, Array.isArray(kids) ? kids : []);
                            } catch {
                                self._cache!.set(t.key, []);
                            } finally {
                                self._loading!.delete(t.key);
                            }
                        }
                    };
                    await Promise.all(Array.from({length: PREFETCH_CONCURRENCY}, () => worker()));
                    render();
                })();
            };

            // 该节点是否显示折叠箭头:已预取/已加载则按实际条数,未预取时先乐观显示
            const hasKidsOf = (key: string): boolean => {
                const kids = self._cache!.get(key);
                return kids ? kids.length > 0 : true;
            };

            // 挂载项"自动子项"的加载器
            // 文件夹→真实内容;文档→子文档;笔记本→顶级文档;块→子块
            const autoLoader = (item: MountItem): (() => Promise<DirEntry[] | BlockNode[]>) | null => {
                if (item.kind === "file") {
                    return item.isDir ? () => readDir(item.path!) : null;
                }
                if (item.kind === "notebook") {
                    return () => virtualListDir("sydoc://nb/" + item.targetId);
                }
                if (item.kind === "doc") {
                    return () => virtualListDir("sydoc://" + item.targetId);
                }
                return () => listChildBlocks(item.targetId!);
            };

            // 挂载项"自动子项"的缓存键。
            // **必须与 emitDir/emitDocs/emitBlocks 读取时用的键完全一致**,
            // 否则加载结果写进一个键、渲染从另一个键读,子项永远停在"加载中…"。
            const autoKeyOf = (item: MountItem): string => {
                if (item.kind === "file") return "f:" + item.path;
                if (item.kind === "notebook") return "d:sydoc://nb/" + item.targetId;
                if (item.kind === "doc") return "d:sydoc://" + item.targetId;
                return "b:" + item.targetId;
            };

            // 三类自动子项的扁平渲染
            const emitDir = (path: string, depth: number, out: Row[]): void => {
                const key = "f:" + path;
                const kids = self._cache!.get(key) as DirEntry[] | undefined;
                if (!kids) {
                    out.push({kind: "loading", depth});
                    return;
                }
                if (kids.length === 0) {
                    out.push({kind: "empty", depth});
                    return;
                }
                for (const e of sortEntries(kids)) {
                    const full = joinPath(path, e.name);
                    const ex = self._expanded!.has("f:" + full);
                    out.push({kind: "file", path: full, name: String(e.name), isDir: !!e.isDir, depth, expanded: ex});
                    if (e.isDir && ex) emitDir(full, depth + 1, out);
                }
            };

            // 思源文档/笔记本下的子文档(按虚拟路径 sydoc://… 缓存;笔记本根是 sydoc://nb/<id>)
            const emitDocs = (vPath: string, depth: number, out: Row[]): void => {
                const key = "d:" + vPath;
                const kids = self._cache!.get(key) as DirEntry[] | undefined;
                if (!kids) {
                    out.push({kind: "loading", depth});
                    return;
                }
                if (kids.length === 0) {
                    out.push({kind: "empty", depth});
                    return;
                }
                for (const e of kids) {
                    const childPath = String(e.path);
                    const ex = self._expanded!.has("d:" + childPath);
                    // icon/subFileCount 来自 listDocsByPath,用于渲染思源文档树同款图标
                    out.push({
                        kind: "doc", docId: virtualId(childPath), name: String(e.name), depth, expanded: ex,
                        icon: e.icon, subFileCount: e.subFileCount,
                    });
                    if (ex) emitDocs(childPath, depth + 1, out);
                }
            };

            const emitBlocks = (blockId: string, depth: number, out: Row[]): void => {
                const key = "b:" + blockId;
                const kids = self._cache!.get(key) as BlockNode[] | undefined;
                if (!kids) {
                    out.push({kind: "loading", depth});
                    return;
                }
                if (kids.length === 0) {
                    out.push({kind: "empty", depth});
                    return;
                }
                for (const b of kids) {
                    const ex = self._expanded!.has("b:" + b.id);
                    out.push({kind: "block", blockId: b.id, name: blockTitle(b.content, b.type), depth, expanded: ex});
                    if (ex) emitBlocks(b.id, depth + 1, out);
                }
            };

            // 某一行对应的"子项缓存键 + 加载器";返回 null 表示该行不可能有子项(叶子)
            const rowChildSource = (r: Row): {key: string; loader: () => Promise<DirEntry[] | BlockNode[]>} | null => {
                if (r.kind === "mount") {
                    const ldr = autoLoader(r.item);
                    return ldr ? {key: autoKeyOf(r.item), loader: ldr} : null;
                }
                if (r.kind === "file" && r.isDir) {
                    return {key: "f:" + r.path, loader: () => readDir(r.path)};
                }
                if (r.kind === "doc") {
                    const vPath = "sydoc://" + r.docId;
                    return {key: "d:" + vPath, loader: () => virtualListDir(vPath)};
                }
                if (r.kind === "block") {
                    return {key: "b:" + r.blockId, loader: () => listChildBlocks(r.blockId)};
                }
                return null;
            };

            // 挂载项是否显示折叠箭头:有显式嵌套挂载一定显示;自动子项按实际条数
            const mountHasKids = (item: MountItem): boolean => {
                if (item.children.length > 0) return true;
                const ldr = autoLoader(item);
                return ldr ? hasKidsOf(autoKeyOf(item)) : false;
            };

            // 该行是否显示折叠箭头
            const rowHasKids = (r: Row): boolean => {
                if (r.kind === "mount") return mountHasKids(r.item);
                const src = rowChildSource(r);
                return src ? hasKidsOf(src.key) : false;
            };

            // 递归渲染:显式嵌套挂载在前,自动子项在后
            const buildRows = (): Row[] => {
                const rows: Row[] = [];
                const walk = (item: MountItem, depth: number) => {
                    // 展开状态键必须与点击时 toggle() 写入的键一致(都用 autoKeyOf),
                    // 否则点击后 _expanded 记在 A 键、这里查 B 键,行永远不会翻转成展开
                    const expanded = self._expanded!.has(autoKeyOf(item));
                    const hasChildren = mountHasKids(item);
                    rows.push({kind: "mount", uid: item.uid, depth, expanded, hasChildren, item});
                    if (!expanded) return;
                    for (const c of item.children) walk(c, depth + 1);
                    if (item.kind === "file" && item.isDir) emitDir(item.path!, depth + 1, rows);
                    else if (item.kind === "doc" || item.kind === "notebook") {
                        const vPath = item.kind === "notebook"
                            ? "sydoc://nb/" + item.targetId
                            : "sydoc://" + item.targetId;
                        emitDocs(vPath, depth + 1, rows);
                    } else if (item.kind === "block") emitBlocks(item.targetId!, depth + 1, rows);
                };
                for (const r of getRoots()) walk(r, 0);
                return rows;
            };

            // 在"当前目录"新建文件/文件夹(当前目录 = 最近点击的目录行)
            const resolveCurrentDir = (): string | null =>
                currentDir
                || getRoots().find(r => r.kind === "file" && r.isDir)?.path
                || null;

            const newFileInCurrentDir = async (): Promise<void> => {
                const dir = resolveCurrentDir();
                if (!dir) {
                    showMessage("请先在树上点击一个文件夹(或挂载一个文件夹)", 2500, "info");
                    return;
                }
                const rootEl = findTreeRootEl(dir);
                await createNewFile(dir, rootEl, rootEl?.dataset.path || "");
                self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                render();
            };

            const newFolderInCurrentDir = async (): Promise<void> => {
                const dir = resolveCurrentDir();
                if (!dir) {
                    showMessage("请先在树上点击一个文件夹(或挂载一个文件夹)", 2500, "info");
                    return;
                }
                const rootEl = findTreeRootEl(dir);
                await createNewFolder(dir, rootEl, rootEl?.dataset.path || "");
                self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                render();
            };

            // 行首箭头:只管展开/收起;名称区点击是"打开"。
            // 文档/笔记本/块即使有子项,单击名称也要能打开(否则永远只展开、打不开)
            const toggleArrow = (expanded: boolean, interactive: boolean) => interactive
                ? `<span class="syfe-mtree__toggle syfe-mtree__toggle--arrow" data-arrow="1" title="展开/收起"><svg><use xlink:href="#${expanded ? "iconDown" : "iconRight"}"></use></svg></span>`
                : `<span class="syfe-mtree__toggle"></span>`;

            const render = () => {
                if (!self._listEl) return; // 已销毁
                const roots = getRoots();
                if (roots.length === 0) {
                    self._rows = [];
                    listEl.innerHTML = `<li class="syfe-mtree__empty">${mountTreeEmptyHint()}</li>`;
                    return;
                }
                const rows = buildRows();
                const filtering = filterOn && (tagSel.length > 0 || tagAny);
                const shown = filtering ? applyTagFilter(rows) : rows;
                self._rows = shown;
                renderChips();
                listEl.innerHTML = shown.map((r, i) => {
                    const pad = 6 + r.depth * 14;
                    if (r.kind === "loading") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">加载中…</li>`;
                    }
                    if (r.kind === "empty") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">(空)</li>`;
                    }
                    // 空节点(空文件夹 / 无子文档 / 无子块)不显示折叠箭头
                    const hasKids = rowHasKids(r);
                    const arrow = toggleArrow(r.expanded, hasKids);
                    if (r.kind === "mount") {
                        const it = r.item;
                        const name = it.name || (it.path ? basename(it.path) : it.targetId || "");
                        const sub = it.kind === "file" ? dirname(it.path || "") : "";
                        // 图标与思源文档树一致:文档/笔记本显示其自定义图标(emoji),
                        // 未设置时用与思源相同的默认图标(子文档数>0 用"文件夹"形态,否则"文档"形态)
                        let icon: string;
                        if (it.kind === "file") {
                            icon = it.isDir ? folderIconHTML(name, r.expanded) : fileIconHTML(name);
                        } else if (it.kind === "block") {
                            icon = `<svg><use xlink:href="#iconEdit"></use></svg>`;
                        } else if (it.kind === "notebook") {
                            icon = docTreeIconHTML(self._nbIcons!.get(it.targetId!) || "", "notebook");
                        } else {
                            icon = docTreeIconHTML(cachedDocIcon(it.targetId!) || "", r.hasChildren ? "folder" : "file");
                        }
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--mount${r.expanded ? " syfe-mtree__row--open" : ""}"
                            data-idx="${i}" style="padding-left:${pad}px"
                            title="${escapeHTML(it.kind === "file" ? (it.path || name) : (it.targetId || name))}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${icon}</span>
                            <span class="syfe-mtree__text">
                                <span class="syfe-mtree__name">${escapeHTML(name)}</span>
                                ${sub ? `<span class="syfe-mtree__sub">${escapeHTML(sub)}</span>` : ""}
                            </span>
                            <span class="syfe-mtree__unmount" data-unmount="${escapeHTML(it.uid)}" title="取消挂载">×</span>
                        </li>`;
                    }
                    if (r.kind === "file") {
                        const icon = r.isDir ? folderIconHTML(r.name, r.expanded) : fileIconHTML(r.name);
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--file${r.isDir ? " syfe-mtree__row--dir" : ""}"
                            data-idx="${i}" style="padding-left:${pad}px" title="${escapeHTML(r.path)}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${icon}</span>
                            <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                        </li>`;
                    }
                    if (r.kind === "doc") {
                        const docIcon = docTreeIconHTML(r.icon || "", (r.subFileCount ?? 0) > 0 ? "folder" : "file");
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--doc" data-idx="${i}" style="padding-left:${pad}px"
                            title="思源文档:${escapeHTML(r.docId)}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${docIcon}</span>
                            <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                        </li>`;
                    }
                    return `
                    <li class="syfe-mtree__row syfe-mtree__row--block" data-idx="${i}" style="padding-left:${pad}px"
                        title="思源块:${escapeHTML(r.blockId)}">
                        ${arrow}
                        <span class="syfe-mtree__icon"><svg><use xlink:href="#iconEdit"></use></svg></span>
                        <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                    </li>`;
                }).join("");

                // 后台预取当前可见行的子项,用于把空节点的折叠箭头去掉(取完统一重绘一次)
                const pending: {key: string; loader: () => Promise<DirEntry[] | BlockNode[]>}[] = [];
                for (const r of shown) {
                    if (r.kind === "loading" || r.kind === "empty") continue;
                    const src = rowChildSource(r);
                    if (src) pending.push(src);
                }
                prefetch(pending);

                // 思源文档/笔记本的自定义图标:先按缓存画,后台补齐后重绘一次
                // (ensureDocIcons 内部去重;挂载节点图标要查块属性,子文档图标已随 listDocsByPath 带回)
                const mountDocs = shown.filter((r): r is Extract<Row, {kind: "mount"}> =>
                    r.kind === "mount" && r.item.kind === "doc").map(r => r.item.targetId!);
                ensureDocIcons(mountDocs, () => render());
                const nbIds = Array.from(new Set(shown.filter((r): r is Extract<Row, {kind: "mount"}> =>
                    r.kind === "mount" && r.item.kind === "notebook").map(r => r.item.targetId!)))
                    .filter(id => !self._nbIcons!.has(id));
                if (nbIds.length > 0) {
                    void (async () => {
                        for (const id of nbIds) {
                            if (!self._nbIcons!.has(id)) self._nbIcons!.set(id, await getNotebookIcon(id));
                        }
                        render();
                    })();
                }
            };
            render();

            const rowOf = (el: HTMLElement | null): Row | null => {
                if (!el) return null;
                const idx = Number(el.dataset.idx);
                return Number.isFinite(idx) ? (self._rows![idx] || null) : null;
            };

            // 打开挂载项(文件→编辑器;文档/块→思源协议定位)
            const openMount = (item: MountItem) => {
                if (item.kind === "file" && item.path) {
                    openFileTab(plugin as any, item.path);
                } else if (item.targetId) {
                    openSiyuanDoc(item.targetId);
                }
            };

            // 切换展开;同时保证子项已加载(load 内部对已缓存的键会直接返回),
            // 这样"已展开但预取被跳过(超过 MAX_PREFETCH)"的节点再点一次也能补上数据
            const toggle = (key: string, loader: (() => Promise<DirEntry[] | BlockNode[]>) | null) => {
                if (self._expanded!.has(key)) {
                    self._expanded!.delete(key);
                } else {
                    self._expanded!.add(key);
                }
                if (loader) void load(key, loader);
                render();
            };

            // 展开/收起某一行(首次展开时懒加载自动子项)
            const toggleRow = (row: Row): void => {
                if (row.kind === "mount") {
                    // 用 autoKeyOf 保证加载键与渲染读取键一致
                    toggle(autoKeyOf(row.item), autoLoader(row.item));
                } else if (row.kind === "file" && row.isDir) {
                    toggle("f:" + row.path, () => readDir(row.path));
                } else if (row.kind === "doc") {
                    const vPath = "sydoc://" + row.docId;
                    toggle("d:" + vPath, () => virtualListDir(vPath));
                } else if (row.kind === "block") {
                    toggle("b:" + row.blockId, () => listChildBlocks(row.blockId));
                }
            };

            // 点击:行首箭头 → 只展开/收起;名称区 → 文件夹展开,文件/文档/笔记本/块打开
            const clickHandler = (e: MouseEvent) => {
                const unEl = (e.target as HTMLElement).closest("[data-unmount]") as HTMLElement | null;
                if (unEl) {
                    e.stopPropagation();
                    const uid = unEl.dataset.unmount!;
                    confirm("取消挂载", "确定从虚拟文档树中移除该条目吗?(其下嵌套挂载也会一并移除)", () => {
                        void removeMountItem(plugin as any, uid).then(() => {
                            showMessage("已取消挂载", 2000, "info");
                            render();
                        });
                    }, () => {});
                    return;
                }
                // 行首箭头:无论哪一行,箭头都只负责展开/收起
                const arrowEl = (e.target as HTMLElement).closest("[data-arrow]") as HTMLElement | null;
                if (arrowEl) {
                    const arrowRow = rowOf(arrowEl.closest(".syfe-mtree__row") as HTMLElement | null);
                    if (arrowRow) toggleRow(arrowRow);
                    return;
                }
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row") as HTMLElement | null;
                const row = rowOf(el);
                if (!row) return;
                if (row.kind === "mount") {
                    // 只有文件夹挂载才是"目录行为";文档/笔记本/块单击直接打开
                    if (row.item.kind === "file" && row.item.isDir) {
                        currentDir = row.item.path!;
                        toggleRow(row);
                    } else {
                        openMount(row.item);
                    }
                    return;
                }
                if (row.kind === "file") {
                    if (row.isDir) {
                        currentDir = row.path;   // 记住最近点击的目录,供工具栏新建/搜索使用
                        toggleRow(row);
                    } else {
                        openFileTab(plugin as any, row.path);
                    }
                    return;
                }
                if (row.kind === "doc") {
                    openSiyuanDoc(row.docId);
                    return;
                }
                if (row.kind === "block") {
                    openSiyuanDoc(row.blockId);
                }
            };
            this._clickHandler = clickHandler;
            scrollEl.addEventListener("click", clickHandler);
            // 注:不注册 dblclick —— 名称区单击已是"打开",双击会重复触发 siyuan:// 跳转

            // 文件/文件夹:直接复用**文件树的完整右键菜单**(一份实现两处用,功能自动同步)。
            // rootEl 传文件树里对应的根(找不到就传 null——refreshPath 对 null 直接返回,
            // 重命名/删除仍会执行,只是不刷新文件树);操作完通过 syfe:files-changed 自行重绘。
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

            // 面板内挂载入口(挂到顶层,或挂到右键命中的那个挂载节点下)。
            // 返回菜单项描述,供空白处菜单直接 addItem,也供文档/笔记本菜单的 extra 追加。
            const mountMenuItems = (parentUid: string | null, where: string): DocMenuItem[] => [
                {
                    icon: "iconFile",
                    label: `挂载思源文档/笔记本…${where}`,
                    click: () => {
                        pickMountTargetDialog(where ? `挂载到「${where}」` : "挂载思源文档/笔记本到虚拟文档树", (vPath, label) => {
                            const kind = isNotebookRoot(vPath) ? "notebook" : "doc";
                            void mountPayload(plugin, {kind, name: label, targetId: virtualId(vPath)}, parentUid);
                        });
                    },
                },
                {
                    icon: "iconFolder",
                    label: `挂载文件/文件夹…${where}`,
                    click: () => {
                        promptMountPathDialog(where ? `挂载到「${where}」` : "挂载文件/文件夹到虚拟文档树", (p, isDir, name) => {
                            void mountPayload(plugin, {kind: "file", name, path: p, isDir}, parentUid);
                        });
                    },
                },
                // 百度网盘目录(readDir 原生支持 bdpan:// 路径,挂完可直接逐级列目录)
                {
                    icon: "iconCloud",
                    label: `挂载百度网盘…${where}`,
                    click: () => {
                        openBaiduPanDialog({
                            title: where ? `挂载百度网盘到「${where}」` : "挂载百度网盘到虚拟文档树",
                            onPicked: (vPath: string, label: string) => {
                                void mountPayload(plugin, {kind: "file", name: label, path: vPath, isDir: true}, parentUid);
                            },
                        });
                    },
                },
            ];

            // 把挂载入口项追加到自建菜单(空白处右键用,前面补一条分隔线)
            const appendMountItems = (menu: Menu, parentUid: string | null, where: string) => {
                menu.addSeparator();
                for (const it of mountMenuItems(parentUid, where)) menu.addItem(it as any);
            };

            // 文档类操作后的统一收尾:文档结构变了,清子项缓存重绘(getDocInfo 缓存由 doc-menu 内部清)
            const afterDocOp = () => {
                self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                render();
            };

            // 右键:文件/文件夹复用文件树完整菜单;思源文档/笔记本给「原生」文档菜单
            // (打开/新建子文档/复制/导出/重命名/删除/固定/收藏,对齐思源文档树),再追加面板特有项
            const contextHandler = (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row") as HTMLElement | null;
                const row = rowOf(el);
                e.preventDefault();
                e.stopPropagation();
                if (!row) {
                    // 点在空白处:只给"添加挂载"入口(逐个取消挂载即可,按用户要求不提供"一键清空")
                    const menu = new Menu();
                    appendMountItems(menu, null, "");
                    menu.open({x: e.clientX, y: e.clientY});
                    return;
                }
                // 文件/文件夹(挂载行或子项行)→ 复用文件树的完整右键菜单
                if (row.kind === "file" || (row.kind === "mount" && row.item.kind === "file")) {
                    const fPath = row.kind === "file" ? row.path : row.item.path!;
                    const fIsDir = row.kind === "file" ? row.isDir : !!row.item.isDir;
                    const rootEl = findTreeRootEl(fPath);
                    showFileTreeMenu(e, fPath, fIsDir, rootEl, rootEl?.dataset.path || "", fileTreeActions);
                    return;
                }
                // 挂载的思源文档/笔记本 → 原生文档/笔记本菜单 + 标签/取消挂载/挂载子菜单
                if (row.kind === "mount" && (row.item.kind === "doc" || row.item.kind === "notebook")) {
                    const it = row.item;
                    const where = `「${it.name}」下`;
                    if (it.kind === "doc") {
                        showDocMenu({
                            x: e.clientX,
                            y: e.clientY,
                            plugin,
                            docId: it.targetId!,
                            name: it.name,
                            onAfter: afterDocOp,
                            extra: [
                                {
                                    icon: "iconTags",
                                    label: "标签…",
                                    click: () => openSiyuanTagDialog(it.targetId!, it.name),
                                },
                                {
                                    icon: "iconTrashcan",
                                    label: "取消挂载",
                                    click: () => {
                                        void removeMountItem(plugin as any, it.uid).then(() => {
                                            showMessage("已取消挂载", 2000, "info");
                                            render();
                                        });
                                    },
                                },
                                ...mountMenuItems(row.uid, where),
                            ],
                        });
                    } else {
                        showNotebookMenu({
                            x: e.clientX,
                            y: e.clientY,
                            plugin,
                            notebookId: it.targetId!,
                            name: it.name,
                            onAfter: afterDocOp,
                            extra: [
                                {
                                    icon: "iconTrashcan",
                                    label: "取消挂载",
                                    click: () => {
                                        void removeMountItem(plugin as any, it.uid).then(() => {
                                            showMessage("已取消挂载", 2000, "info");
                                            render();
                                        });
                                    },
                                },
                                ...mountMenuItems(row.uid, where),
                            ],
                        });
                    }
                    return;
                }
                if (row.kind === "mount" && row.item.kind === "block") {
                    // 挂载的块:定位/复制块链接/文档标签 + 固定收藏 + 取消挂载/挂载入口
                    const it = row.item;
                    const menu = new Menu();
                    menu.addItem({icon: "iconOpen", label: "定位到块", click: () => openSiyuanDoc(it.targetId!)});
                    menu.addItem({
                        icon: "iconLink",
                        label: "复制块链接",
                        click: () => copyWithToast(`siyuan://blocks/${it.targetId}`, "块链接已复制", "复制失败"),
                    });
                    // 块标签作用在它所在的文档上
                    menu.addItem({
                        icon: "iconTags",
                        label: "文档标签…",
                        click: () => openSiyuanTagDialog(it.targetId!, it.name),
                    });
                    addPinFavEntries(menu, plugin, it.targetId!, it.name, afterDocOp);
                    appendMountItems(menu, row.uid, `「${it.name}」下`);
                    menu.addItem({
                        icon: "iconTrashcan",
                        label: "取消挂载",
                        click: () => {
                            void removeMountItem(plugin as any, it.uid).then(() => {
                                showMessage("已取消挂载", 2000, "info");
                                render();
                            });
                        },
                    });
                    menu.open({x: e.clientX, y: e.clientY});
                    return;
                }
                // 思源文档/块的子项行
                if (row.kind === "doc") {
                    showDocMenu({
                        x: e.clientX,
                        y: e.clientY,
                        plugin,
                        docId: row.docId,
                        name: row.name,
                        onAfter: afterDocOp,
                        extra: [
                            {
                                icon: "iconTags",
                                label: "标签…",
                                click: () => openSiyuanTagDialog(row.docId, row.name),
                            },
                            ...mountMenuItems(null, ""),
                        ],
                    });
                    return;
                }
                if (row.kind === "block") {
                    const menu = new Menu();
                    menu.addItem({icon: "iconOpen", label: "定位到块", click: () => openSiyuanDoc(row.blockId)});
                    menu.addItem({
                        icon: "iconTags",
                        label: "文档标签…",
                        click: () => openSiyuanTagDialog(row.blockId, row.name),
                    });
                    appendMountItems(menu, null, "");
                    menu.open({x: e.clientX, y: e.clientY});
                }
            };
            this._contextHandler = contextHandler;
            scrollEl.addEventListener("contextmenu", contextHandler);

            // 标签筛选:把"打过标签的目录"自动展开,便于直接看到它们的内容
            const expandTaggedDirs = (): void => {
                if (!filterOn) return;
                const ids = expandWithDescendants(tagSel);
                const hit = (p: string) => (tagAny ? pathHasAnyTag(p) : pathMatchesFilter(p, ids));
                for (const key of Array.from(self._cache!.keys())) {
                    if (!key.startsWith("f:")) continue;
                    const p = key.slice(2);
                    if (hit(p)) self._expanded!.add(key);
                }
            };

            // 标签 chip 点击:多选(与文件面板一致,多选=或关系;"全部"与具体标签互斥)
            chipsEl.addEventListener("click", (ev: MouseEvent) => {
                const chip = (ev.target as HTMLElement).closest(".syfe-mtree__chip") as HTMLElement | null;
                if (!chip) return;
                if (chip.dataset.all === "1") {
                    tagAny = !tagAny;
                    if (tagAny) tagSel = [];
                } else {
                    tagAny = false;
                    const id = chip.dataset.id!;
                    tagSel = tagSel.includes(id) ? tagSel.filter(x => x !== id) : [...tagSel, id];
                }
                expandTaggedDirs();
                render();
            });

            // 工具栏:标签筛选 / 搜索 / 挂载百度网盘 / 更多 / 刷新 / 全部收起 / 清空
            const actionHandler = (e: MouseEvent) => {
                const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
                if (!actionEl) return;
                const action = actionEl.dataset.action;
                if (action === "collapse") {
                    self._expanded = new Set<string>();
                    render();
                } else if (action === "tag-filter") {
                    filterOn = !filterOn;
                    if (!filterOn) {
                        tagSel = [];
                        tagAny = false;
                    }
                    expandTaggedDirs();
                    render();
                } else if (action === "search") {
                    // 在虚拟树已挂载的目录范围内搜索:优先最近点击的目录,否则第一个挂载文件夹
                    const target = currentDir
                        || getRoots().find(r => r.kind === "file" && r.isDir)?.path
                        || getRoots().find(r => r.kind === "file")?.path;
                    if (!target) {
                        showMessage("请先挂载一个文件夹,再使用搜索", 2500, "info");
                        return;
                    }
                    (plugin as any).openSearch(target);
                } else if (action === "more") {
                    const m = new Menu();
                    m.addItem({
                        icon: "iconFile",
                        label: "在当前目录新建文件",
                        click: () => void newFileInCurrentDir(),
                    });
                    m.addItem({
                        icon: "iconFolder",
                        label: "在当前目录新建文件夹",
                        click: () => void newFolderInCurrentDir(),
                    });
                    m.addSeparator();
                    m.addItem({
                        icon: "iconRefresh",
                        label: "重新加载标签",
                        click: () => {
                            renderChips();
                            render();
                        },
                    });
                    const r = actionEl.getBoundingClientRect();
                    m.open({x: r.left, y: r.bottom + 4});
                } else if (action === "refresh") {
                    self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                    render();
                }
                // 注:原工具栏「清空」按钮已移除;清空入口保留在「更多」菜单与空白处右键菜单里
            };
            this._actionHandler = actionHandler;
            (this.element.querySelector(".syfe-mtree__toolbar") as HTMLElement)
                .addEventListener("click", actionHandler);

            // 挂载结构变化(任意入口挂载/取消)时自动重绘
            const changedHandler = () => render();
            this._changedHandler = changedHandler;
            window.addEventListener(MOUNT_TREE_CHANGED_EVENT, changedHandler);

            // 文件系统变动(重命名/删除/新建/粘贴等,来自 refreshFileTrees)→ 清缓存并重绘,
            // 让复用文件树菜单做完操作后,虚拟文档树里的文件/文件夹列表同步更新
            const filesChangedHandler = () => {
                self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                render();
            };
            this._filesChangedHandler = filesChangedHandler;
            window.addEventListener("syfe:files-changed", filesChangedHandler);

            // 标签数据变化(新建/删除标签、文件加标签)→ 刷新 chip 行与筛选结果
            const tagsChangedHandler = () => {
                renderChips();
                render();
            };
            this._tagsChangedHandler = tagsChangedHandler;
            window.addEventListener(TAGS_CHANGED_EVENT, tagsChangedHandler);
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: MountTreeDockInstance) {
            if (this._scrollEl && this._clickHandler) {
                this._scrollEl.removeEventListener("click", this._clickHandler);
            }
            if (this._scrollEl && this._contextHandler) {
                this._scrollEl.removeEventListener("contextmenu", this._contextHandler);
            }
            if (this._changedHandler) {
                window.removeEventListener(MOUNT_TREE_CHANGED_EVENT, this._changedHandler);
            }
            if (this._filesChangedHandler) {
                window.removeEventListener("syfe:files-changed", this._filesChangedHandler);
                this._filesChangedHandler = undefined;
            }
            if (this._tagsChangedHandler) {
                window.removeEventListener(TAGS_CHANGED_EVENT, this._tagsChangedHandler);
                this._tagsChangedHandler = undefined;
            }
            this._listEl = undefined;
            this._scrollEl = undefined;
            this._clickHandler = undefined;
            this._contextHandler = undefined;
            this._actionHandler = undefined;
            this._changedHandler = undefined;
            this._rows = undefined;
            this._expanded = undefined;
            this._cache = undefined;
            this._loading = undefined;
            this._nbIcons = undefined;
        },
    };
}
