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
    SYFE_RELATION_TREE_CHANGED_EVENT,
    MountItem,
} from "../mount-tree";
import {
    buildRelationForest,
    flattenRelationForest,
    flattenVisibleRelationForest,
    relationForestSummary,
    reorderCustomOrder,
    findRelationNode,
    subtreeOf,
    pathToNode,
    initialExpandedSet,
    DEFAULT_RELATION_OPTIONS,
    RELATION_ROOT_KEY,
    RelationNode,
} from "../relation-tree/relation-tree";
import {loadConfig, saveConfig} from "../utils/config";
import {getAllEditor} from "siyuan";
import type {RelationTreeConfig} from "../types";

/**
 * 取当前激活文档的 rootID(多标签页下优先激活 tab 里的编辑器)。
 * 移植自 siyuan-virtual-tree 的同名工具:1) 激活 tab 的编辑器 2) 激活 tab 的
 * protyle[data-doc-id] 3) 可见编辑器 4) 唯一编辑器 5) 任意有 rootID 的编辑器。
 */
function currentDocRootId(): string | null {
    try {
        const editors = (getAllEditor?.() || []) as any[];
        for (const ed of editors) {
            const el = ed?.protyle?.element;
            const rootId = ed?.protyle?.block?.rootID;
            if (!el || !rootId) continue;
            if (el.closest(".layout-tab__item--focus")) return rootId;
        }
        const activeProtyle = document.querySelector(".layout-tab__item--focus .protyle") as HTMLElement | null;
        if (activeProtyle) {
            const el = activeProtyle.hasAttribute("data-doc-id")
                ? activeProtyle
                : activeProtyle.querySelector<HTMLElement>("[data-doc-id]");
            const docId = el?.dataset.docId;
            if (docId) return docId;
        }
        for (const ed of editors) {
            const el = ed?.protyle?.element;
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const rootId = ed?.protyle?.block?.rootID;
                if (rootId) return rootId;
            }
        }
        if (editors.length === 1) return editors[0]?.protyle?.block?.rootID || null;
        for (const ed of editors) {
            const rootId = ed?.protyle?.block?.rootID;
            if (rootId) return rootId;
        }
    } catch {
        // ignore
    }
    return null;
}

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
    // 引用关系树的只读行(自动生成)。isRoot = 该文档是挂载进来的根节点。
    | {kind: "relation"; docId: string; name: string; hpath: string; depth: number; expanded: boolean; hasChildren: boolean; draggable: boolean; subFileCount: number; isRoot: boolean}
    | {kind: "relationEmpty"; depth: number}
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
    // 工具栏上的关系树按钮(刷新/折叠/展开/定位/聚焦)
    _relActionHandler?: (e: MouseEvent) => void;
    _changedHandler?: () => void;
    _filesChangedHandler?: () => void;
    _tagsChangedHandler?: () => void;
    _relationHandler?: () => void;
    _relationRebuildHandler?: () => void;
    // 拖拽排序(仅自定义排序时用)
    _dragStartHandler?: (e: DragEvent) => void;
    _dragOverHandler?: (e: DragEvent) => void;
    _dropHandler?: (e: DragEvent) => void;
    _dragEndHandler?: () => void;
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
                    <span class="block__icon ariaLabel" data-rel-action="refresh" aria-label="刷新引用关系" data-position="north" style="display:none">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-rel-action="collapse-all" aria-label="折叠全部" data-position="north" style="display:none">
                        <svg><use xlink:href="#iconContract"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-rel-action="expand-all" aria-label="展开全部" data-position="north" style="display:none">
                        <svg><use xlink:href="#iconExpand"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-rel-action="locate" aria-label="定位当前文档" data-position="north" style="display:none">
                        <svg><use xlink:href="#iconFocus"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-rel-action="focus" aria-label="聚焦当前文档" data-position="north" style="display:none">
                        <svg><use xlink:href="#iconList"></use></svg>
                    </span>
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

            // ===== 引用关系树(设置开关控制,只读派生视图)=====
            // 与手动挂载共存:关系树排在手动挂载**上方**,两者互不影响。
            // 关系树结构不落盘(每次现查);只持久化用户的显式意图:
            // 排序设置、拖拽顺序(customOrder)、折叠状态(collapsed)——都存在 editor 配置里。
            let relationRoots: RelationNode[] = [];
            let relationLoaded = false;
            let relationBuilding = false;
            // 展开状态:优先用持久化的 collapsed 计算;运行期改动写回配置
            let relExpanded = new Set<string>();
            // 「聚焦当前文档」:只看该文档的后代树
            let relationFocusId: string | null = null;
            // 「定位当前文档」的高亮目标
            let relationLocateFlash: string | null = null;
            const relKey = (docId: string) => "rel:" + docId;

            const relCfg = (): RelationTreeConfig => {
                const c = plugin.config?.mountTreeRelation;
                return {...DEFAULT_RELATION_OPTIONS, ...(c || {}), enabled: c?.enabled === true} as RelationTreeConfig;
            };
            const relationEnabled = () => relCfg().enabled;

            // 关系树的根 = 挂载到虚拟文档树的思源文档(对齐原插件的 rootDocIds)。
            // 笔记本挂载不参与:笔记本是容器,不是引用关系里的文档节点。
            const mountedDocIds = (): string[] => {
                const out: string[] = [];
                const walk = (list: MountItem[]) => {
                    for (const it of list) {
                        if (it.kind === "doc" && it.targetId) out.push(it.targetId);
                        walk(it.children || []);
                    }
                };
                walk(getRoots() || []);
                return Array.from(new Set(out));
            };

            // 按 docId 找到对应的挂载项(用于「取消挂载」:要删的是挂载记录本身)
            const mountUidOfDoc = (docId: string): string | null => {
                let found: string | null = null;
                const walk = (list: MountItem[]) => {
                    for (const it of list) {
                        if (it.kind === "doc" && it.targetId === docId) found = it.uid;
                        walk(it.children || []);
                    }
                };
                walk(getRoots() || []);
                return found;
            };

            // 把关系树设置的变更写回 editor 配置(拖拽顺序、折叠态都走这里)
            const persistRelationConfig = async (patch: Partial<RelationTreeConfig>) => {
                try {
                    const latest = await loadConfig(plugin as any);
                    const next = {
                        ...DEFAULT_RELATION_OPTIONS,
                        ...(latest.mountTreeRelation || {}),
                        ...patch,
                    } as RelationTreeConfig;
                    latest.mountTreeRelation = next;
                    (plugin as any).config = latest;
                    await saveConfig(plugin as any, latest);
                } catch (e) {
                    console.error("[siyuan-file-editor] 保存关系树设置失败:", e);
                }
            };

            // 折叠状态:由配置里的 collapsed 数组反推(Set = 展开)
            const syncExpandedFromConfig = () => {
                const collapsed = new Set(relCfg().collapsed || []);
                relExpanded = new Set<string>();
                const walk = (nodes: RelationNode[]) => {
                    for (const n of nodes) {
                        if (n.children.length && !collapsed.has(n.docId)) {
                            relExpanded.add(n.docId);
                            walk(n.children);
                        }
                    }
                };
                walk(relationRoots);
            };

            // 折叠状态变化 → 写回配置(防抖,拖动/连续点击不会狂写磁盘)
            let collapseTimer: number | undefined;
            const persistCollapsed = () => {
                if (collapseTimer) window.clearTimeout(collapseTimer);
                collapseTimer = window.setTimeout(() => {
                    const collapsed: string[] = [];
                    const walk = (nodes: RelationNode[]) => {
                        for (const n of nodes) {
                            if (!n.children.length) continue;
                            if (!relExpanded.has(n.docId)) collapsed.push(n.docId);
                            walk(n.children);
                        }
                    };
                    walk(relationRoots);
                    void persistRelationConfig({collapsed});
                }, 600);
            };

            const toggleRelationNode = (docId: string) => {
                if (relExpanded.has(docId)) relExpanded.delete(docId);
                else relExpanded.add(docId);
                persistCollapsed();
                render();
            };

            // 取消挂载:行内 × 按钮已去掉,所有挂载类型统一走右键菜单这一个入口。
            // 嵌套挂载由 removeMountItem 连带移除(其下子挂载一起消失)。
            const unmountMountRow = (row: Extract<Row, {kind: "mount"}>) => {
                const it = row.item;
                confirm("取消挂载", `确定从虚拟文档树中移除「${it.name}」吗?(其下嵌套挂载也会一并移除)`, () => {
                    void removeMountItem(plugin as any, it.uid).then(() => {
                        showMessage("已取消挂载", 2000, "info");
                        render();
                    });
                }, () => {});
            };

            // 关系树上的「取消挂载」:关系树的根就是挂载进来的文档,所以取消挂载 = 把这条挂载摘掉。
            // 摘掉后该文档不再作为根出现(它的引用者也随之从关系树里消失)。
            // 行为/措辞与挂载行里的「取消挂载」完全一致,只是入口在关系树上。
            const unmountRelationNode = (docId: string, name: string) => {
                const uid = mountUidOfDoc(docId);
                if (!uid) {
                    showMessage("该文档不是挂载项,无法取消挂载", 2500, "error");
                    return;
                }
                void removeMountItem(plugin as any, uid).then(() => {
                    showMessage(`已取消挂载「${name}」`, 2500, "info");
                    if (relationFocusId === docId) relationFocusId = null;
                    // 挂载项变化会派发 MOUNT_TREE_CHANGED_EVENT,那里会重建;这里兜底重建一次
                    ensureRelationTree(true);
                });
            };

            /** 定位当前文档:退出聚焦 → 展开沿途 → 滚动到该行并闪烁提示 */
            const locateCurrentDoc = () => {
                const cur = currentDocRootId();
                if (!cur) {
                    showMessage("请先打开一个文档", 2500, "info");
                    return;
                }
                if (!findRelationNode(relationRoots, cur)) {
                    showMessage("当前文档不在引用关系树里(它的首块没有引用关系)", 3000, "info");
                    return;
                }
                if (relationFocusId) relationFocusId = null; // 定位时先退出聚焦,否则目标可能被过滤掉
                // 展开从根到目标的沿途节点,否则目标所在行根本没渲染
                for (const id of pathToNode(relationRoots, cur)) relExpanded.add(id);
                relationLocateFlash = cur;
                persistCollapsed();
                render();
                // 等 DOM 更新后再滚动
                window.setTimeout(() => {
                    const el = listEl.querySelector(`.syfe-mtree__row--relation[data-rel-doc="${CSS.escape(cur)}"]`) as HTMLElement | null;
                    if (el) el.scrollIntoView({block: "center"});
                }, 60);
                // 闪烁 2s 后取消
                window.setTimeout(() => {
                    relationLocateFlash = null;
                    render();
                }, 2000);
            };

            // ===== 拖拽排序(仅「自定义」排序方式下可用)=====
            // 同一父节点的兄弟之间才能排序;落下后把新顺序写回 customOrder 并持久化
            let dragDocId: string | null = null;
            let dragOverDocId: string | null = null;

            const parentKeyOf = (docId: string): string | null => {
                if (relationRoots.some((r) => r.docId === docId)) return RELATION_ROOT_KEY;
                const dfs = (nodes: RelationNode[]): string | null => {
                    for (const n of nodes) {
                        if (n.children.some((c) => c.docId === docId)) return n.docId;
                        const hit = dfs(n.children);
                        if (hit) return hit;
                    }
                    return null;
                };
                return dfs(relationRoots);
            };

            const siblingIdsOf = (parentKey: string): string[] => {
                if (parentKey === RELATION_ROOT_KEY) return relationRoots.map((r) => r.docId);
                const p = findRelationNode(relationRoots, parentKey);
                return p ? p.children.map((c) => c.docId) : [];
            };

            const renderDragOver = () => {
                listEl.querySelectorAll(".syfe-mtree__row--dragover").forEach((el) => {
                    el.classList.remove("syfe-mtree__row--dragover");
                });
                if (dragOverDocId) {
                    const el = listEl.querySelector(`.syfe-mtree__row--relation[data-rel-doc="${CSS.escape(dragOverDocId)}"]`);
                    if (el) el.classList.add("syfe-mtree__row--dragover");
                }
            };

            // 建树(带并发去重):开关关闭时清空并标记未加载
            const ensureRelationTree = (force = false) => {
                if (!relationEnabled()) {
                    relationRoots = [];
                    relationLoaded = false;
                    relExpanded = new Set();
                    return;
                }
                if ((relationLoaded && !force) || relationBuilding) return;
                relationBuilding = true;
                // 先占位渲染"加载中",避免用户干等
                self._rows = [];
                render();
                void buildRelationForest(relCfg(), mountedDocIds())
                    .then((roots) => {
                        relationRoots = roots;
                        relationLoaded = true;
                        relationBuilding = false;
                        syncExpandedFromConfig();
                        // 配置里没记录过折叠态(首次开启)时,按默认展开层级初始化
                        if (relCfg().defaultExpandLevel !== 0 && (relCfg().collapsed || []).length === 0) {
                            relExpanded = initialExpandedSet(relationRoots, relCfg().defaultExpandLevel);
                        }
                        render();
                    })
                    .catch(() => {
                        relationRoots = [];
                        relationLoaded = true;
                        relationBuilding = false;
                        render();
                    });
            };

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
                // --- 引用关系树(只读派生视图,排在手动挂载上方;不额外加标题栏)---
                if (relationEnabled()) {
                    if (relationBuilding) {
                        rows.push({kind: "loading", depth: 0});
                    } else if (relationRoots.length === 0) {
                        rows.push({kind: "relationEmpty", depth: 0});
                    } else {
                        // 聚焦视图:只渲染当前文档的子树
                        const viewRoots = relationFocusId
                            ? [subtreeOf(relationRoots, relationFocusId)].filter(Boolean) as RelationNode[]
                            : relationRoots;
                        for (const n of flattenVisibleRelationForest(viewRoots, (id) => relExpanded.has(id))) {
                            rows.push({
                                kind: "relation",
                                docId: n.docId,
                                name: n.displayName,
                                hpath: n.hpath,
                                depth: n.depth,
                                expanded: relExpanded.has(n.docId),
                                hasChildren: n.children.length > 0,
                                subFileCount: n.subFileCount,
                                draggable: relCfg().sortMethod === "custom",
                                isRoot: n.isRoot,
                            });
                        }
                    }
                }
                // --- 手动挂载 ---
                // 关系树开启时,已挂载的**思源文档**由关系树统一呈现(它们是关系树里的节点),
                // 这里跳过,否则同一个文档会同时出现两行。文件/文件夹/笔记本/块挂载不受影响。
                // 判据用"是否被挂载"而不是 isRoot:被挂载但只作为引用者出现的文档也要去重,
                // 否则它会既在关系树里、又在挂载区里露两次。
                const relTreeDocIds = new Set(flattenRelationForest(relationRoots).map(n => n.docId));
                const mountedDocSet = new Set(mountedDocIds());
                const relShownDocIds = new Set(
                    relationEnabled() ? Array.from(relTreeDocIds).filter(id => mountedDocSet.has(id)) : [],
                );
                const walk = (item: MountItem, depth: number) => {
                    if (item.kind === "doc" && item.targetId && relShownDocIds.has(item.targetId)) return;
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
                // 关系树的 5 个工具按钮:仅在开关开启时显示(与原虚拟树同一位置、同一图标)
                this.element.querySelectorAll("[data-rel-action]").forEach((el) => {
                    (el as HTMLElement).style.display = relationEnabled() ? "" : "none";
                });
                const roots = getRoots();
                // 关系树开启时,即使手动挂载为空也要渲染(它自己有区块)
                const relOn = relationEnabled();
                if (roots.length === 0 && !relOn) {
                    self._rows = [];
                    listEl.innerHTML = `<li class="syfe-mtree__empty">${mountTreeEmptyHint()}</li>`;
                    return;
                }
                const rows = buildRows();
                // 标签筛选只作用于手动挂载的行;关系树是只读视图,始终显示
                const filtering = filterOn && (tagSel.length > 0 || tagAny);
                const manualRows = filtering ? applyTagFilter(rows) : rows;
                const shown = filtering
                    ? manualRows.filter((r) => r.kind === "relation" || r.kind === "relationEmpty" || r.kind === "loading" || r.depth === 0)
                    : manualRows;
                self._rows = shown;
                renderChips();
                listEl.innerHTML = shown.map((r, i) => {
                    const pad = 6 + r.depth * 14;
                    if (r.kind === "loading") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">加载中…</li>`;
                    }
                    if (r.kind === "relationEmpty") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">暂无引用关系(文档首块里还没有引用其它文档)</li>`;
                    }
                    // 引用关系树的文档行:只读,单击打开文档
                    if (r.kind === "relation") {
                        // 图标与思源文档树一致:自定义 icon 优先,否则按**真实子文档数**选
                        // folder/file。不能按"有没有引用者"选 —— 那是引用关系的父子,
                        // 与文档自身是否含子文档无关,会导致同一文档两处图标不一样。
                        const docIcon = docTreeIconHTML(cachedDocIcon(r.docId) || "", (r.subFileCount ?? 0) > 0 ? "folder" : "file");
                        const flashing = relationLocateFlash === r.docId ? " syfe-mtree__row--flash" : "";
                        const cur = currentDocRootId() === r.docId ? " syfe-mtree__row--current" : "";
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--relation${r.expanded ? " syfe-mtree__row--open" : ""}${flashing}${cur}"
                            data-idx="${i}" style="padding-left:${pad}px"
                            ${r.draggable ? `draggable="true" data-rel-doc="${escapeHTML(r.docId)}"` : ""}
                            title="${escapeHTML(r.name)}&#10;ID: ${escapeHTML(r.docId)}${r.hpath ? "\n" + escapeHTML(r.hpath) : ""}">
                            ${toggleArrow(r.expanded, r.hasChildren)}
                            <span class="syfe-mtree__icon">${docIcon}</span>
                            <span class="syfe-mtree__text">
                                <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                            </span>
                        </li>`;
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
                // 关系树的文档同理:自定义图标要先按缓存画,后台补齐后重绘,
                // 否则首屏拿不到 icon 会与原生文档树显示不一致
                const relDocs = shown.filter((r): r is Extract<Row, {kind: "relation"}> =>
                    r.kind === "relation").map(r => r.docId);
                ensureDocIcons(mountDocs.concat(relDocs), () => render());
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
                } else if (row.kind === "relation") {
                    // 与原虚拟树一致:有子节点则展开/收起,否则打开该文档
                    toggleRelationNode(row.docId);
                }
            };

            // 点击:行首箭头 → 只展开/收起;名称区 → 文件夹展开,文件/文档/笔记本/块打开
            // 关系树的工具动作(工具栏按钮与行内按钮共用)
            const runRelationAction = (action: string) => {
                if (action === "refresh") {
                    ensureRelationTree(true);
                } else if (action === "collapse-all") {
                    relExpanded = new Set();
                    void persistRelationConfig({
                        collapsed: flattenRelationForest(relationRoots).filter((n) => n.children.length > 0).map((n) => n.docId),
                    });
                } else if (action === "expand-all") {
                    relExpanded = new Set(flattenRelationForest(relationRoots).filter((n) => n.children.length > 0).map((n) => n.docId));
                    void persistRelationConfig({collapsed: []});
                } else if (action === "locate") {
                    locateCurrentDoc();
                    return;
                } else if (action === "focus") {
                    const cur = currentDocRootId();
                    if (!cur) {
                        showMessage("请先打开一个文档", 2500, "info");
                        return;
                    }
                    if (!findRelationNode(relationRoots, cur)) {
                        showMessage("当前文档不在引用关系树里(它的首块没有引用关系)", 3000, "info");
                        return;
                    }
                    relationFocusId = relationFocusId === cur ? null : cur;
                    if (relationFocusId) {
                        for (const id of pathToNode(relationRoots, cur)) relExpanded.add(id);
                    }
                }
                render();
            };

            const clickHandler = (e: MouseEvent) => {
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
                    return;
                }
                // 引用关系树行:与原虚拟树一致 —— 点名称打开文档,点箭头展开/收起
                if (row.kind === "relation") {
                    const onArrow = !!(e.target as HTMLElement).closest("[data-arrow]");
                    if (!onArrow && row.hasChildren) {
                        // 有子节点:原插件是点名称直接打开;这里保持一致(点箭头才收展)
                        openSiyuanDoc(row.docId);
                    } else if (row.hasChildren) {
                        toggleRelationNode(row.docId);
                    } else {
                        openSiyuanDoc(row.docId);
                    }
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

            // 引用关系树是**只读派生视图**(每次现查,不落盘),文档被改名/删除/加子文档后
            // 引用链会变,必须强制重建,否则树上显示的还是旧名字/旧结构
            const afterRelationDocOp = () => {
                self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                ensureRelationTree(true);
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
                    // 挂载行(而非子项行)要能取消挂载:行内 × 按钮已去掉,入口只留右键菜单
                    const fileExtra: DocMenuItem[] = row.kind === "mount"
                        ? [{
                            icon: "iconTrashcan",
                            label: "取消挂载",
                            click: () => unmountMountRow(row),
                        }]
                        : [];
                    showFileTreeMenu(e, fPath, fIsDir, rootEl, rootEl?.dataset.path || "", fileTreeActions, undefined, fileExtra as any);
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
                                    click: () => unmountMountRow(row as Extract<Row, {kind: "mount"}>),
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
                                    click: () => unmountMountRow(row as Extract<Row, {kind: "mount"}>),
                                },
                                ...mountMenuItems(row.uid, where),
                            ],
                        });
                    }
                    return;
                }
                if (row.kind === "relation") {
                    // 引用关系树上的文档:给原生文档菜单(与挂载的思源文档完全一致),
                    // 外加关系树特有的项(刷新 / 只看子树 / 取消挂载)。
                    // 关系树的根就是挂载进来的文档,所以「取消挂载」摘掉的是那条挂载记录。
                    showDocMenu({
                        x: e.clientX,
                        y: e.clientY,
                        plugin,
                        docId: row.docId,
                        name: row.name,
                        onAfter: afterRelationDocOp,
                        extra: [
                            {
                                icon: "iconTags",
                                label: "标签…",
                                click: () => openSiyuanTagDialog(row.docId, row.name),
                            },
                            {
                                icon: "iconRefresh",
                                label: "刷新关系树",
                                click: () => ensureRelationTree(true),
                            },
                            {
                                icon: "iconFocus",
                                label: relationFocusId === row.docId ? "退出聚焦" : "只看此文档子树",
                                click: () => {
                                    relationFocusId = relationFocusId === row.docId ? null : row.docId;
                                    render();
                                },
                            },
                            // 只有**被挂载的**文档才对应一条挂载记录,纯引用者没东西可取消
                            ...(mountUidOfDoc(row.docId) ? [{
                                icon: "iconTrashcan",
                                label: "取消挂载",
                                click: () => unmountRelationNode(row.docId, row.name),
                            }] : []),
                        ],
                    });
                    return;
                }
                if (row.kind === "relationEmpty") {
                    // 关系树为空/无引用:只给"刷新",别让右键彻底无响应
                    const menu = new Menu();
                    menu.addItem({icon: "iconRefresh", label: "刷新关系树", click: () => ensureRelationTree(true)});
                    menu.addItem({
                        icon: "iconFocus",
                        label: "退出聚焦",
                        click: () => {
                            relationFocusId = null;
                            render();
                        },
                    });
                    menu.open({x: e.clientX, y: e.clientY});
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
                        click: () => unmountMountRow(row as Extract<Row, {kind: "mount"}>),
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
            const toolbarEl = this.element.querySelector(".syfe-mtree__toolbar") as HTMLElement;
            toolbarEl.addEventListener("click", actionHandler);
            // 关系树的 5 个按钮在**工具栏**里(与原虚拟树同一位置),而上面的 actionHandler
            // 绑在工具栏上、只处理 [data-action];这里补一个监听处理 [data-rel-action]。
            // 注意:不能只靠 scrollEl 的委托 —— 工具栏不在滚动容器内,事件到不了那里。
            const relActionHandler = (e: MouseEvent) => {
                const el = (e.target as HTMLElement).closest("[data-rel-action]") as HTMLElement | null;
                if (!el) return;
                e.stopPropagation();
                runRelationAction(el.dataset.relAction || "");
            };
            this._relActionHandler = relActionHandler;
            toolbarEl.addEventListener("click", relActionHandler);

            // 挂载结构变化(任意入口挂载/取消)时自动重绘。
            // 关系树的根就是挂载的思源文档,所以挂载一变,根集合也变了,必须重建(不只是重绘)。
            const changedHandler = () => {
                if (relationEnabled()) ensureRelationTree(true);
                else render();
            };
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

            // 引用关系树:开关切换(设置保存时派发)→ 重建或清空
            const relationToggleHandler = () => {
                ensureRelationTree();
                render();
            };
            this._relationHandler = relationToggleHandler;
            window.addEventListener(SYFE_RELATION_TREE_CHANGED_EVENT, relationToggleHandler);

            // 引用关系树:内容变动后自动重建(防抖,避免连续操作时反复查 SQL)
            // 复用 refreshFileTrees() 派发的 syfe:files-changed —— 思源文档的
            // 新建/重命名/删除/移动都会走到那里(editor 目前没有独立的 docs-changed 事件)
            let relationTimer: number | undefined;
            const relationRebuildHandler = () => {
                if (!relationEnabled()) return;
                if (relationTimer) window.clearTimeout(relationTimer);
                relationTimer = window.setTimeout(() => {
                    relationLoaded = false;
                    ensureRelationTree();
                }, 1500);
            };
            this._relationRebuildHandler = relationRebuildHandler;
            window.addEventListener("syfe:files-changed", relationRebuildHandler);

            // 首次渲染:开关开启时建关系树(懒加载,只查一次)
            ensureRelationTree();
            render();

            // ===== 拖拽排序事件(挂在滚动容器上,与行点击委托同一套模式)=====
            const dragStartHandler = (e: DragEvent) => {
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--relation") as HTMLElement | null;
                if (!el) return;
                const docId = el.dataset.relDoc;
                if (!docId) return;
                dragDocId = docId;
                el.classList.add("syfe-mtree__row--dragging");
                try {
                    e.dataTransfer?.setData("text/plain", docId);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                } catch {
                    // ignore
                }
            };
            const dragOverHandler = (e: DragEvent) => {
                if (!dragDocId) return;
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--relation") as HTMLElement | null;
                if (!el) return;
                const overId = el.dataset.relDoc;
                if (!overId || overId === dragDocId) return;
                // 只允许同级
                const srcKey = parentKeyOf(dragDocId);
                const dstKey = parentKeyOf(overId);
                if (!srcKey || srcKey !== dstKey) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                if (dragOverDocId !== overId) {
                    dragOverDocId = overId;
                    renderDragOver();
                }
            };
            const dropHandler = (e: DragEvent) => {
                const srcId = dragDocId;
                const dstId = dragOverDocId;
                dragDocId = null;
                dragOverDocId = null;
                if (!srcId || !dstId || srcId === dstId) {
                    renderDragOver();
                    return;
                }
                e.preventDefault();
                const key = parentKeyOf(srcId);
                if (!key || key !== parentKeyOf(dstId)) {
                    renderDragOver();
                    return;
                }
                const siblings = siblingIdsOf(key);
                const from = siblings.indexOf(srcId);
                const to = siblings.indexOf(dstId);
                if (from < 0 || to < 0) {
                    renderDragOver();
                    return;
                }
                // 拖到目标之前;往后拖时先移除再插入,避免索引偏移
                const next = siblings.slice();
                next.splice(from, 1);
                next.splice(to, 0, srcId);
                // 本地立即重排,避免等 SQL 回来才刷新
                const applyOrder = (nodes: RelationNode[], parentKey: string) => {
                    if (parentKey === RELATION_ROOT_KEY) {
                        const rank = new Map(next.map((id, i) => [id, i]));
                        nodes.sort((a, b) => (rank.get(a.docId) ?? 1e9) - (rank.get(b.docId) ?? 1e9));
                        return;
                    }
                    for (const n of nodes) {
                        if (n.docId === parentKey) {
                            const rank = new Map(next.map((id, i) => [id, i]));
                            n.children.sort((a, b) => (rank.get(a.docId) ?? 1e9) - (rank.get(b.docId) ?? 1e9));
                            return;
                        }
                        applyOrder(n.children, parentKey);
                    }
                };
                applyOrder(relationRoots, key);
                render();
                void persistRelationConfig({
                    customOrder: reorderCustomOrder(relCfg().customOrder || {}, key, next),
                }).then(() => {
                    relationLoaded = false;
                    ensureRelationTree();
                });
            };
            const dragEndHandler = () => {
                dragDocId = null;
                dragOverDocId = null;
                listEl.querySelectorAll(".syfe-mtree__row--dragging, .syfe-mtree__row--dragover").forEach((el) => {
                    el.classList.remove("syfe-mtree__row--dragging", "syfe-mtree__row--dragover");
                });
            };
            this._dragStartHandler = dragStartHandler;
            this._dragOverHandler = dragOverHandler;
            this._dropHandler = dropHandler;
            this._dragEndHandler = dragEndHandler;
            scrollEl.addEventListener("dragstart", dragStartHandler as EventListener);
            scrollEl.addEventListener("dragover", dragOverHandler as EventListener);
            scrollEl.addEventListener("drop", dropHandler as EventListener);
            scrollEl.addEventListener("dragend", dragEndHandler as EventListener);
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
            if (this._relationHandler) {
                window.removeEventListener(SYFE_RELATION_TREE_CHANGED_EVENT, this._relationHandler);
                this._relationHandler = undefined;
            }
            if (this._relationRebuildHandler) {
                window.removeEventListener("syfe:files-changed", this._relationRebuildHandler);
                this._relationRebuildHandler = undefined;
            }
            if (this._scrollEl) {
                if (this._dragStartHandler) this._scrollEl.removeEventListener("dragstart", this._dragStartHandler as EventListener);
                if (this._dragOverHandler) this._scrollEl.removeEventListener("dragover", this._dragOverHandler as EventListener);
                if (this._dropHandler) this._scrollEl.removeEventListener("drop", this._dropHandler as EventListener);
                if (this._dragEndHandler) this._scrollEl.removeEventListener("dragend", this._dragEndHandler as EventListener);
            }
            this._dragStartHandler = undefined;
            this._dragOverHandler = undefined;
            this._dropHandler = undefined;
            this._dragEndHandler = undefined;
            this._listEl = undefined;
            this._scrollEl = undefined;
            this._clickHandler = undefined;
            this._contextHandler = undefined;
            if (this._actionHandler) {
                const tb = this.element.querySelector('.syfe-mtree__toolbar') as HTMLElement | null;
                if (tb) tb.removeEventListener("click", this._actionHandler);
            }
            if (this._relActionHandler) {
                const tb = this.element.querySelector('.syfe-mtree__toolbar') as HTMLElement | null;
                if (tb) tb.removeEventListener("click", this._relActionHandler);
            }
            this._relActionHandler = undefined;
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
