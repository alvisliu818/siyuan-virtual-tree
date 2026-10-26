// 侧边栏「虚拟文档树」面板:一棵初始为空、由用户自己组织的树。
// 可挂载:真实文件/文件夹、思源文档(自动带出子文档)、思源块(按子块递归展开);
// 支持嵌套挂载(把条目挂到另一个挂载项下),可随时取消挂载。
// 数据层 src/mount-tree.ts(virtual-tree.json);结构变化派发 syfe:mount-tree-changed 自动重绘。
import {Menu, Dialog, confirm, showMessage} from "siyuan";
import {MOUNT_TREE_DOCK_TYPE} from "../constants";
import {readDir, querySQL} from "../api/file";
import {DirEntry} from "../types";
import {basename, dirname, joinPath} from "../utils/path";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {toFileLink} from "../utils/system-path";
import {virtualListDir, virtualId, isNotebookRoot, isBoxDocEnabled} from "../utils/virtual-tree";
import {docTreeIconHTML, cachedDocIcon, ensureDocIcons, getNotebookIcon} from "../utils/siyuan-icon";
import {listChildBlocks, blockTitle, blockGutterIcon, soloImageInfo, BlockNode} from "../utils/blocks";
import {loadBlockDisplayModes, blockDisplayMode, setBlockDisplayMode} from "../utils/block-names";
import {copyText, revealInFileTree, pickMountTargetDialog, showFileTreeMenu, findTreeRootEl, createNewFile, createNewFolder, buildFileTreeActions} from "../components/file-tree";
import {openBaiduPanDialog} from "../components/baidu-pan-dialog";
import {tagIconHTML} from "../tags/tag-ui";
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
import {openSiyuanDoc, openSiyuanNotebook} from "../components/entry-menu";
import {openTrashDialog} from "../components/trash-dialog";
// 顶栏横向滚动(悬停滚轮转横向),复用面包屑同款
import {enableCrumbScroll} from "../components/path-crumbs";
import {showBacklinkDialog} from "../components/backlink-dialog";
import {BacklinkItem, findBacklinks, findDirBacklinks, findSiyuanRefBacklinks} from "../utils/backlink";
import {showDocMenu, showNotebookMenu, addPinFavEntries, DocMenuItem} from "../components/doc-menu";
import {openSiyuanTagDialog} from "../components/siyuan-tag-dialog";
import {openFileTab, syncOpenEditors} from "../tabs/editor-tab";
import {mountPayload, promptMountPathDialog, pickBlockDialog, showMountTargetMenu, ensureTargetMountItem} from "../components/mount-menu";
import {
    getRoots,
    removeMountItem,
    reorderMountItem,
    reorderAutoChildren,
    getAutoOrder,
    getParentUid,
    mountTreeEmptyHint,
    MOUNT_TREE_CHANGED_EVENT,
    SYFE_RELATION_TREE_CHANGED_EVENT,
    MountItem,
} from "../mount-tree";
import {
    buildRelationForest,
    flattenRelationForest,
    findRelationNode,
    pathToNode,
    initialExpandedSet,
    DEFAULT_RELATION_OPTIONS,
    RelationNode,
} from "../relation-tree/relation-tree";
import {loadConfig, saveConfig} from "../utils/config";
import {getAllEditor} from "siyuan";
import type {RelationTreeConfig} from "../types";

/**
 * 取当前激活文档的 rootID(多标签页下优先激活 tab 里的编辑器)。
 * 移植自 siyuan-virtual-tree 的同名工具:0) 3.8.7 激活页签元素(头 → data-id 反查)
 * 1) 激活 tab 的编辑器 2) 激活 tab 的 protyle[data-doc-id] 3) 可见编辑器
 * 4) 唯一编辑器 5) 任意有 rootID 的编辑器。
 */
function currentDocRootId(): string | null {
    try {
        // 3.8.7+:激活页签内容元素 → 里面的 protyle(protyle 可能是元素本身,也可能是后代)
        for (const el of activeTabEls()) {
            const py = el.classList.contains("protyle")
                ? el
                : el.querySelector<HTMLElement>(".protyle");
            if (!py) continue;
            const rootId = py.hasAttribute("data-doc-id")
                ? py.dataset.docId
                : (py.querySelector("[data-doc-id]") as HTMLElement | null)?.dataset?.docId;
            if (rootId) return rootId;
        }
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

/**
 * 取「当前激活页签」的内容元素(每个聚焦 pane 一个)。
 * 3.8.7 起 DOM 变了:激活页签头是 .layout-tab-bar .item--focus(带 data-id),
 * 内容元素是 .layout-tab-container 下同 data-id 的直接子元素(未激活的挂 fn__none);
 * 旧版 .layout-tab__item--focus 类已不存在 —— 两种都探,谁命中用谁。
 */
function activeTabEls(): HTMLElement[] {
    const out: HTMLElement[] = [];
    try {
        // 3.8.7+:头 → data-id → 内容元素
        document.querySelectorAll(".layout-tab-bar .item--focus").forEach(head => {
            const id = (head as HTMLElement).dataset?.id;
            if (!id) return;
            const el = document.querySelector(`.layout-tab-container [data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
            if (el) out.push(el);
        });
        if (out.length === 0) {
            // 旧版(<3.8.7)兼容:激活页签内容元素自带 --focus 类
            document.querySelectorAll(".layout-tab__item--focus").forEach(el => out.push(el as HTMLElement));
        }
    } catch {
        // ignore
    }
    return out;
}

/**
 * 取当前激活页签打开的本地文件路径(虚拟树打开的外部文件)。
 * 各文件类页签(markdown/editor/notebook/office/image/media)在挂载时会把自己的
 * 根元素打上 data-syfe-path 属性;拿到即说明当前激活的是本插件的文件编辑页签
 * (思源文档页签没有该属性,返回 null)。
 */
function currentFilePath(): string | null {
    try {
        for (const el of activeTabEls()) {
            // data-syfe-path 打在页签根元素上:activeTabEls 返回的就是它自己,
            // querySelector 只查后代 —— 必须先 matches 自身再查后代
            const hit = (el.matches("[data-syfe-path]") ? el : el.querySelector<HTMLElement>("[data-syfe-path]"));
            const p = hit?.dataset?.syfePath;
            if (p) return p;
        }
        return null;
    } catch {
        return null;
    }
}

export interface IPluginForMountTree {
    app: any;
    name: string;
    config: any;
    openFileSplit(path: string, position: "right" | "bottom"): void;
    loadData(key: string): Promise<any>;
    saveData(key: string, data: any): Promise<void>;
}

// ===== 顶栏按钮注册表(可配置显示与排序)=====
// 顶栏不再放「虚拟文档树」标题,整条都是按钮;按配置渲染,「更多」里可编辑。
// key:配置里的唯一标识;attr:委托事件读取的 data 属性(action / rel-action);
// value:attr 的值(与历史动作分发逻辑保持一致,rel 按钮的 key 带前缀避免撞名)。
//
// 按钮归属二选一(编辑工具栏里每个按钮一个开关):
//   开关开 = 显示在顶栏(不在「更多」里);开关关 = 收进「更多」菜单(不在顶栏上)。
// 「更多」里的**所有**按钮(含原本只存在于菜单里的动作)都能在编辑工具栏里配置归属。
interface TreeToolbarButton {
    key: string;
    attr: "action" | "rel-action";
    value: string;
    label: string;
    icon: string;
}
const TREE_TOOLBAR_BUTTONS: TreeToolbarButton[] = [
    {key: "locate-mount", attr: "action", value: "locate-mount", label: "定位当前文档", icon: "iconFocus"},
    {key: "tag-filter", attr: "action", value: "tag-filter", label: "标签筛选", icon: "iconTags"},
    {key: "drag-mode", attr: "action", value: "drag-mode", label: "拖拽排序模式", icon: "iconDrag"},
    {key: "search", attr: "action", value: "search", label: "搜索", icon: "iconSearch"},
    {key: "refresh", attr: "action", value: "refresh", label: "刷新", icon: "iconRefresh"},
    {key: "collapse", attr: "action", value: "collapse", label: "全部收起", icon: "iconRight"},
    {key: "new-file", attr: "action", value: "new-file", label: "在当前目录新建文件", icon: "iconFile"},
    {key: "new-folder", attr: "action", value: "new-folder", label: "在当前目录新建文件夹", icon: "iconFolder"},
    {key: "mount", attr: "action", value: "mount-menu", label: "挂载到虚拟文档树", icon: "iconAdd"},
    {key: "trash", attr: "action", value: "trash", label: "打开回收站", icon: "iconTrashcan"},
    {key: "reload-tags", attr: "action", value: "reload-tags", label: "重新加载标签", icon: "iconRefresh"},
    {key: "rel-refresh", attr: "rel-action", value: "refresh", label: "刷新引用关系", icon: "iconRefresh"},
    {key: "rel-collapse-all", attr: "rel-action", value: "collapse-all", label: "折叠引用关系", icon: "iconContract"},
    {key: "rel-expand-all", attr: "rel-action", value: "expand-all", label: "展开引用关系", icon: "iconExpand"},
    {key: "rel-locate", attr: "rel-action", value: "locate", label: "定位当前文档(引用)", icon: "iconFocus"},
    {key: "rel-focus", attr: "rel-action", value: "focus", label: "聚焦当前文档(引用)", icon: "iconList"},
    {key: "more", attr: "action", value: "more", label: "更多", icon: "iconMore"},
];
// 默认收进「更多」的按钮:纯菜单动作(顶栏默认只放高频按钮)。
// 老用户升级/首次使用都按这个初始化;之后以用户在编辑工具栏里的开关为准。
const MENU_ONLY_DEFAULTS = ["new-file", "new-folder", "mount", "trash", "reload-tags"];
// 配置结构版本:v1 = hidden 是「彻底隐藏」;v2 = hidden 是「收进更多」。v1 配置升级时迁移。
const TOOLBAR_CFG_VERSION = 2;
const byKey = (k: string) => TREE_TOOLBAR_BUTTONS.find(b => b.key === k);
const TOOLBAR_KEY = "tree-toolbar.json";
const TOOLBAR_FIXED = "more";   // 「更多」是编辑入口,固定在顶栏(否则没法再打开配置)

// Lute 实例(模块级单例):window.Lute 只是 emscripten 模块对象(只有 New/NewNodeID 等
// 静态方法),Md2BlockDOM 等渲染方法在 Lute.New() 创建的实例上。实例是无状态的纯转换器,
// 全局缓存一份即可;不挂 window(避免与思源/其他插件冲突),模块作用域本身就是单例。
let luteInstance: any;
let luteTried = false;
const getLute = (): any => {
    if (!luteTried) {
        luteTried = true;
        try {
            const L = (window as any).Lute;
            luteInstance = L?.New ? L.New() : L;
        } catch {
            luteInstance = null;    // 创建失败就退回文本行,不再反复重试
        }
    }
    return luteInstance;
};

interface TreeToolbarCfg {
    order: string[];
    hidden: string[];
    ver?: number;
}

async function loadToolbarCfg(plugin: IPluginForMountTree): Promise<TreeToolbarCfg> {
    let cfg: TreeToolbarCfg | null = null;
    try {
        const d = await plugin.loadData(TOOLBAR_KEY);
        if (d && Array.isArray(d.order) && Array.isArray(d.hidden)) {
            cfg = {
                order: d.order.filter((k: any) => typeof k === "string" && !!byKey(k)),
                hidden: d.hidden.filter((k: any) => typeof k === "string" && !!byKey(k)),
            };
        }
    } catch {
        // 存储读不到就用默认
    }
    if (!cfg) cfg = {order: [], hidden: []};
    if (cfg.ver !== TOOLBAR_CFG_VERSION) {
        // v1 → v2 语义迁移:老配置里的 hidden(原本=彻底隐藏)改为「收进更多」,
        // 没有按钮会凭空消失;菜单专属新按钮补进 hidden(收进更多),顶栏保持原样。
        for (const k of MENU_ONLY_DEFAULTS) {
            if (!cfg.hidden.includes(k)) cfg.hidden.push(k);
        }
        cfg.ver = TOOLBAR_CFG_VERSION;
    }
    return cfg;
}

async function saveToolbarCfg(plugin: IPluginForMountTree, cfg: TreeToolbarCfg): Promise<void> {
    try {
        await plugin.saveData(TOOLBAR_KEY, cfg);
    } catch {
        // 保存失败只影响下次记忆,不挡使用
    }
}

// 归一:order 补上注册表里新增的按钮(新版本加按钮自动进末尾)、去掉已下线的
function resolvedOrder(cfg: TreeToolbarCfg): string[] {
    const known = TREE_TOOLBAR_BUTTONS.map(b => b.key);
    const ordered = cfg.order.filter(k => known.includes(k));
    for (const k of known) {
        if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered;
}

// 渲染行(扁平化,按 data-idx 回查)
type Row =
    | {kind: "mount"; uid: string; depth: number; expanded: boolean; hasChildren: boolean; item: MountItem}
    | {kind: "file"; path: string; name: string; isDir: boolean; depth: number; expanded: boolean}
    | {kind: "doc"; docId: string; name: string; depth: number; expanded: boolean; icon?: string; subFileCount?: number; ownerUid?: string}
    // 自动挂载行:引用子层级(引用的文档 + 物理子文档),与挂载行同款渲染与行为
    | {kind: "auto"; docId: string; name: string; hpath: string; depth: number; expanded: boolean; hasChildren: boolean; parentDocId: string; subFileCount?: number}
    | {kind: "block"; blockId: string; name: string; depth: number; expanded: boolean; ownerUid?: string; btype?: string; bsubtype?: string; bmd?: string; bname?: string}
    | {kind: "empty"; depth: number}
    | {kind: "loading"; depth: number};

// 「外部文件定位」涉及的行种类:file 行 + 挂载了真实文件的 mount 行。
// 抽成别名而不是在函数里写 Extract<Row, ...>:函数内 `let exact: typeof bestRow = null`
// 会取到 bestRow 此刻的控制流窄化类型(null),把 exact 的声明类型钉成 null,
// 之后 exact = r 全报 TS2322(实测踩过)。
type FileLocateRow = Extract<Row, {kind: "file"}> | Extract<Row, {kind: "mount"}>;
// 「文档定位」涉及的行种类:挂载行 + doc 行 + 引用关系树的 auto 行
type DocLocateRow = Extract<Row, {kind: "doc"}> | Extract<Row, {kind: "auto"}> | Extract<Row, {kind: "mount"}>;

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
    // 拖拽监听统一在 _mountDragHandlers 表里(手动挂载行 + 自动挂载行)
    // 拖拽排序:挂载项(事件名 → 处理器,成对注册/反注册)
    _mountDragHandlers?: Array<[string, (e: Event) => void]>;
    // 工具栏窄面板折叠监听(已随横向滚动改造移除)
    _rows?: Row[];
    _expanded?: Set<string>;                       // 展开的节点键
    _cache?: Map<string, DirEntry[] | BlockNode[]>;// 已加载的子项
    _loading?: Set<string>;                        // 正在加载的节点键
    _nbIcons?: Map<string, string>;                // 笔记本 id → 自定义图标(后台取到后重绘)
    // 挂载块根行 → 块元数据(类型/子类型/markdown/命名):每次重绘现查比对,变了才重绘。
    // 块在文档里被转换类型(如标题转文档)后只要块 id 没变,树上就按新类型正常展示;
    // 块子行的数据随子块列表一起来,不缓存这里
    _blockMeta?: Map<string, {type: string; subtype: string; markdown: string; name: string}>;
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
            // 显式 index:见 recent-dock.ts 同位置注释(避免多 dock 同 index 导致图标乱跳)
            index: 1,
        },
        data: {},
        init(this: MountTreeDockInstance) {
            this.element.classList.add("syfe-mtree-dock", "fn__flex-column");
            // 顶栏整条都是按钮(不放标题),按钮集合与顺序由「更多 → 编辑工具栏」配置,
            // 渲染见 renderToolbar();横向滚动 + 悬停滚轮转横向见 enableCrumbScroll
            this.element.innerHTML = `
                <div class="block__icons syfe-mtree__toolbar"></div>
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
            self._blockMeta = new Map<string, {type: string; subtype: string; markdown: string; name: string}>();

            // 标签筛选状态(与文件面板一致:多选标签 = 或关系;"全部"= 只要打过任意标签)
            let tagSel: string[] = [];
            let tagAny = false;
            let filterOn = false;
            // 拖拽排序模式:开启后挂载行才可拖动(防误拖;默认关闭,会话内有效)
            let dragMode = false;
            // 最近一次点击的目录(新建文件/文件夹、搜索的默认位置)
            let currentDir: string | null = null;

            // ===== 引用关系树(设置开关控制,只读派生视图)=====
            // 与手动挂载共存:关系树排在手动挂载**上方**,两者互不影响。
            // 关系树结构不落盘(每次现查);只持久化用户的显式意图:
            // 排序设置、拖拽顺序(customOrder)、折叠状态(collapsed)——都存在 editor 配置里。
            let relationRoots: RelationNode[] = [];
            let relationLoaded = false;
            let relationBuilding = false;      // 首次构建期间(占位"加载中")
            let relationRefreshing = false;    // force 重建期间(保留旧树静默进行)
            // 展开状态:优先用持久化的 collapsed 计算;运行期改动写回配置
            let relExpanded = new Set<string>();
            // 「聚焦当前文档」:只看该文档的后代树
            let relationFocusId: string | null = null;
            // 「定位当前文档」的高亮目标
            let relationLocateFlash: string | null = null;
            // 「定位」按钮:挂载行 / doc 行的闪烁标记(与 relationLocateFlash 同一套 CSS)
            let mountLocateFlashUid: string | null = null;
            // 「定位」按钮:外部文件行(file 行)的闪烁标记
            let fileLocateFlashPath: string | null = null;
            const sleepMs = (ms: number) => new Promise(r => window.setTimeout(r, ms));
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

            // 把关系树设置的变更写回 editor 配置(折叠态走这里;自动挂载层顺序在挂载配置)
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


            /** 「定位」按钮:在挂载树里定位当前打开的思源文档。
             *  逐层展开挂载链(notebook/doc 挂载 → 子文档行),滚动到目标行并闪烁。
             *  展开键一律取 rowChildSource(与渲染同源),不手写键格式。 */
            // 路径比较:统一正斜杠 + 去尾分隔符;Windows 本地路径再比一层小写
            // (文件树里的路径与页签里的路径来源不同,盘符/目录大小写可能不一致)
            const normFsPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
            const sameFsPath = (a: string, b: string) => {
                const x = normFsPath(a), y = normFsPath(b);
                return x === y || x.toLowerCase() === y.toLowerCase();
            };
            // target 是否在 dir 之下(严格子路径,按目录边界切分)
            const fsPathUnder = (dir: string, target: string) => {
                const d = normFsPath(dir), t = normFsPath(target);
                if (!d) return false;
                const pre = d + "/";
                return (t.startsWith(pre) || t.toLowerCase().startsWith(pre.toLowerCase())) && t.length > d.length;
            };

            /** 「定位」按钮(外部文件):在挂载树里定位当前打开的本地文件。
             *  与文档版同思路:找最深已渲染的目录行(挂载行/file 行)逐层展开,
             *  最后在 file 行/挂载文件行上闪烁 + 滚动。 */
            const locateFileInMountTree = async (target: string) => {
                const notInRange = () => showMessage("当前文件不在虚拟文档树的挂载范围内", 3000, "info");
                for (let guard = 0; guard < 12; guard++) {
                    let bestDepth = -1;
                    let bestRow: FileLocateRow | null = null;
                    let exact: FileLocateRow | null = null;
                    for (const r of (self._rows || [])) {
                        if (r.kind === "file") {
                            if (sameFsPath(r.path, target)) { exact = r; break; }
                            if (r.isDir && fsPathUnder(r.path, target) && r.depth > bestDepth) { bestDepth = r.depth; bestRow = r; }
                        } else if (r.kind === "mount" && r.item.kind === "file") {
                            const p = r.item.path || "";
                            if (!p) continue;
                            if (!r.item.isDir && sameFsPath(p, target)) { exact = r; break; }
                            if (r.item.isDir && fsPathUnder(p, target) && r.depth > bestDepth) { bestDepth = r.depth; bestRow = r; }
                        }
                    }
                    if (exact) {
                        // 目标层:闪烁 + 滚动(mount 行用 uid 标记,file 行用路径标记)
                        if (exact.kind === "mount") {
                            mountLocateFlashUid = exact.uid;
                        } else {
                            fileLocateFlashPath = exact.path;
                        }
                        const want = exact.kind === "mount" ? exact.uid : exact.path;
                        render();
                        window.setTimeout(() => {
                            const el = exact!.kind === "mount"
                                ? (listEl.querySelector(`[data-mount-uid="${CSS.escape(want)}"]`) as HTMLElement | null)
                                : (() => {
                                    const idx = (self._rows || []).findIndex(r => r.kind === "file" && sameFsPath((r as any).path, want));
                                    return idx >= 0 ? (listEl.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null) : null;
                                })();
                            if (el) el.scrollIntoView({block: "center"});
                        }, 60);
                        window.setTimeout(() => {
                            mountLocateFlashUid = null;
                            fileLocateFlashPath = null;
                            render();
                        }, 2000);
                        return;
                    }
                    if (!bestRow) {
                        // 面板刚创建时行可能还没加载完:等一等再试,别急着判「不在挂载范围」
                        if ((self._rows || []).length === 0) { await sleepMs(500); continue; }
                        notInRange(); return;
                    }
                    // 中间层:未展开 → 展开(键取 rowChildSource,与渲染同源)
                    if (!bestRow.expanded) {
                        const src = rowChildSource(bestRow);
                        if (!src) { notInRange(); return; }
                        self._expanded!.add(src.key);
                        void load(src.key, src.loader);
                        render();
                        await sleepMs(700);
                        continue;
                    }
                    // 已展开但下一层没出现:目标不在挂载范围
                    notInRange();
                    return;
                }
                notInRange();
            };

            /** 定位文件夹(新标签页固定文件夹点击):展开面板 → 找到目录行 → 展开并闪烁。
             *  与文件版唯一的差异:挂载目录行自身也可作为精确命中(文件版只精确命中文件),
             *  且命中目录后顺手展开(用户点文件夹就是为了看里面的东西)。 */
            const locateFolderInMountTree = async (target: string) => {
                // dock 图标的 data-type 是「插件名+type」的全键 → 用后缀匹配
                const dockItem = document.querySelector(`.dock__item[data-type$="${MOUNT_TREE_DOCK_TYPE}"]`) as HTMLElement | null;
                const dockVisible = !!document.querySelector(".syfe-mtree-dock")?.getClientRects().length;
                if (!dockVisible && dockItem) dockItem.click();
                await sleepMs(300);
                const notInRange = () => showMessage("该目录不在虚拟文档树的挂载范围内,可右键该目录选择「挂载到虚拟文档树」", 3500, "info");
                for (let guard = 0; guard < 12; guard++) {
                    let bestDepth = -1;
                    let bestRow: FileLocateRow | null = null;
                    let exact: FileLocateRow | null = null;
                    for (const r of (self._rows || [])) {
                        if (r.kind === "file") {
                            if (sameFsPath(r.path, target)) { exact = r; break; }
                            if (r.isDir && fsPathUnder(r.path, target) && r.depth > bestDepth) { bestDepth = r.depth; bestRow = r; }
                        } else if (r.kind === "mount" && r.item.kind === "file") {
                            const p = r.item.path || "";
                            if (!p) continue;
                            // 目录自身也作为精确命中(文件版排除 isDir,这里不排除)
                            if (sameFsPath(p, target)) { exact = r; break; }
                            if (r.item.isDir && fsPathUnder(p, target) && r.depth > bestDepth) { bestDepth = r.depth; bestRow = r; }
                        }
                    }
                    if (exact) {
                        const isMount = exact.kind === "mount";
                        const isDirRow = isMount ? !!(exact as any).item?.isDir : !!(exact as any).isDir;
                        // 命中目录 → 顺手展开,children 立即可见
                        if (isDirRow) {
                            const src = rowChildSource(exact);
                            if (src) {
                                self._expanded!.add(src.key);
                                void load(src.key, src.loader);
                            }
                        }
                        if (isMount) {
                            mountLocateFlashUid = (exact as any).uid;
                        } else {
                            fileLocateFlashPath = (exact as any).path;
                        }
                        render();
                        window.setTimeout(() => {
                            const el = isMount
                                ? (listEl.querySelector(`[data-mount-uid="${CSS.escape((exact as any).uid)}"]`) as HTMLElement | null)
                                : (() => {
                                    const idx = (self._rows || []).findIndex(r => r.kind === "file" && sameFsPath((r as any).path, (exact as any).path));
                                    return idx >= 0 ? (listEl.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null) : null;
                                })();
                            if (el) el.scrollIntoView({block: "center"});
                        }, 60);
                        window.setTimeout(() => {
                            mountLocateFlashUid = null;
                            fileLocateFlashPath = null;
                            render();
                        }, 2000);
                        return;
                    }
                    if (!bestRow) {
                        // 面板刚创建时行可能还没加载完:等一等再试,别急着判「不在挂载范围」
                        if ((self._rows || []).length === 0) { await sleepMs(500); continue; }
                        notInRange(); return;
                    }
                    if (!bestRow.expanded) {
                        const src = rowChildSource(bestRow);
                        if (!src) { notInRange(); return; }
                        self._expanded!.add(src.key);
                        void load(src.key, src.loader);
                        render();
                        await sleepMs(700);
                        continue;
                    }
                    notInRange();
                    return;
                }
                notInRange();
            };
            // 外部触发:window.dispatchEvent(new CustomEvent("syfe:mount-tree-locate-folder", {detail:{path}}))
            window.addEventListener("syfe:mount-tree-locate-folder", (e: Event) => {
                const p = (e as CustomEvent).detail?.path;
                if (typeof p === "string" && p) void locateFolderInMountTree(p);
            });

            /**
             * 按文档 id 在挂载树里定位:SQL 取存储路径 → 逐段匹配挂载链 →
             * 展开沿途 → 滚动到该行并闪烁。
             * silent=true 用于「外部被动触发」(如点击固定/最近里的思源文档):
             * 文档不在挂载范围时不弹提示、也不强行展开面板 —— 打开文档才是主动作,
             * 树的闪烁只是顺带告诉你"它在这儿"。
             */
            const locateDocInMountTree = async (docId: string, silent = false, revealPanel = true): Promise<void> => {
                const dockItem = document.querySelector(`.dock__item[data-type$="${MOUNT_TREE_DOCK_TYPE}"]`) as HTMLElement | null;
                const dockVisible = !!document.querySelector(".syfe-mtree-dock")?.getClientRects().length;
                if (revealPanel) {
                    // 面板不可见 → 先点 dock 图标展开(闪烁要看得见才有意义)
                    if (!dockVisible && dockItem) dockItem.click();
                    if (!dockVisible) await sleepMs(300);
                } else if (!dockVisible) {
                    // 被动定位(打开文档后顺带闪一下):面板没显示就别展开、也别白等
                    return;
                }
                const rows = await querySQL(`SELECT box, path FROM blocks WHERE id = '${docId.replace(/'/g, "''")}' AND type = 'd' LIMIT 1`);
                const stPath = rows && rows[0] ? String(rows[0].path || "") : "";
                if (!stPath) {
                    if (!silent) showMessage("无法获取当前文档的存储路径", 3000, "error");
                    return;
                }
                const norm = (x: string) => x.replace(/\.sy$/i, "").replace(/^\/+|\/+$/g, "");
                // 目标链:存储路径逐段去 .sy → [nbId, d1, d2…],最后一段是当前文档
                const segs = stPath.split("/").filter(Boolean).map(x => x.replace(/\.sy$/i, ""));
                let prefix = "";
                const chain: string[] = [];
                for (const seg of segs) { prefix += "/" + seg; chain.push(prefix); }

                const notInRange = () => {
                    if (!silent) showMessage("当前文档不在虚拟文档树的挂载范围内", 3000, "info");
                };
                for (let guard = 0; guard < 12; guard++) {
                    // 找"最深匹配"的已渲染行:挂载行按 targetId,doc/auto 行按 docId
                    let bestK = -1;
                    let bestRow: DocLocateRow | null = null;
                    for (const r of (self._rows || [])) {
                        if (r.kind === "mount") {
                            const t = r.item.targetId || "";
                            for (let n = 0; n < chain.length; n++) {
                                if (norm(t) === norm(chain[n]) && n > bestK) { bestK = n; bestRow = r; break; }
                            }
                        } else if (r.kind === "doc" || r.kind === "auto") {
                            const d = norm(r.docId);
                            for (let n = 0; n < chain.length; n++) {
                                if (d === norm(chain[n]) && n > bestK) { bestK = n; bestRow = r; break; }
                            }
                        }
                    }
                    if (bestK < 0 || !bestRow) {
                        // 面板刚创建时行可能还没加载完:等一等再试
                        if ((self._rows || []).length === 0) { await sleepMs(500); continue; }
                        notInRange(); return;
                    }
                    if (bestK === chain.length - 1) {
                        // 目标层:闪烁 + 滚动(按行种类选各自的标记与选择器)
                        if (bestRow.kind === "mount") {
                            mountLocateFlashUid = bestRow.uid;
                            render();
                            window.setTimeout(() => {
                                const el = listEl.querySelector(`[data-mount-uid="${CSS.escape(bestRow.uid)}"]`) as HTMLElement | null;
                                if (el) el.scrollIntoView({block: "center"});
                            }, 60);
                        } else {
                            relationLocateFlash = bestRow.docId;
                            render();
                            window.setTimeout(() => {
                                const sel = bestRow.kind === "auto"
                                    ? `[data-rel-doc="${CSS.escape(bestRow.docId)}"]`
                                    : `[data-doc-path="${CSS.escape(bestRow.docId)}"]`;
                                const el = listEl.querySelector(sel) as HTMLElement | null;
                                if (el) el.scrollIntoView({block: "center"});
                            }, 60);
                        }
                        window.setTimeout(() => {
                            mountLocateFlashUid = null;
                            relationLocateFlash = null;
                            render();
                        }, 2000);
                        return;
                    }
                    // 中间层:未展开 → 展开(键取 rowChildSource,与渲染同源)
                    if (!bestRow.expanded) {
                        const src = rowChildSource(bestRow);
                        if (!src) { notInRange(); return; }
                        self._expanded!.add(src.key);
                        void load(src.key, src.loader);
                        render();
                        await sleepMs(700);
                        continue;
                    }
                    // 已展开但下一层没出现:不在挂载范围
                    notInRange();
                    return;
                }
                notInRange();
            };

            const locateActiveInMountTree = async () => {
                // 面板不可见 → 先点 dock 图标展开
                const dockItem = document.querySelector(`.dock__item[data-type="${MOUNT_TREE_DOCK_TYPE}"]`) as HTMLElement | null;
                const dockVisible = !!document.querySelector(".syfe-mtree-dock")?.getClientRects().length;
                if (!dockVisible && dockItem) dockItem.click();
                await sleepMs(300);

                // 焦点页签是本插件的文件页签(markdown/editor/notebook/office/image/media)
                // → 按文件路径定位;否则按思源文档定位
                const file = currentFilePath();
                if (file) { await locateFileInMountTree(file); return; }

                const cur = currentDocRootId();
                if (!cur) { showMessage("请先打开一个思源文档", 2500, "info"); return; }
                await locateDocInMountTree(cur);
            };
            const locateMountHandler = () => { void locateActiveInMountTree(); };
            window.addEventListener("syfe:mount-tree-locate", locateMountHandler);
            // 外部触发:点击固定/最近里的思源文档时,顺带在树上闪烁定位(静默失败)。
            // detail.revealPanel=false(默认,见 entry-menu 的顺带定位)→ 面板没开就不展开
            window.addEventListener("syfe:mount-tree-locate-doc", (e: Event) => {
                const detail = (e as CustomEvent).detail || {};
                const id = detail?.docId;
                const revealPanel = detail?.revealPanel !== false;
                if (typeof id === "string" && id) void locateDocInMountTree(id, true, revealPanel);
            });

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
                    const el = listEl.querySelector(`[data-rel-doc="${CSS.escape(cur)}"]`) as HTMLElement | null;
                    if (el) el.scrollIntoView({block: "center"});
                }, 60);
                // 闪烁 2s 后取消
                window.setTimeout(() => {
                    relationLocateFlash = null;
                    render();
                }, 2000);
            };

            // ===== 拖拽排序:自动挂载行(同一父文档下的引用子层级)=====
            // 顺序持久化到**挂载配置**的 customOrder[父文档id](与手动挂载同一文件);
            // 拖拽模式开启时才可拖,同层内 before/after。
            let dragAutoParent: string | null = null;
            let dragAutoDocId: string | null = null;
            let dragAutoOverDocId: string | null = null;
            let dragAutoPos: "before" | "after" = "before";

            // ===== 拖拽排序:挂载项(顶层根之间 / 同一父节点下的兄弟之间)=====
            // 与上面的引用关系树是两套独立状态:行种类不同、持久化目标也不同
            // (挂载项写 virtual-tree.json,关系树写 editor 配置的 customOrder)。
            // 只重排,不改变层级:嵌到别的挂载项属于换父节点,语义不同且要判子孙回环。
            let dragMountUid: string | null = null;
            let dragOverMountUid: string | null = null;
            let dragOverPos: "before" | "after" = "before";

            const clearMountDragMarks = () => {
                listEl.querySelectorAll(".syfe-mtree__row--dragover-before, .syfe-mtree__row--dragover-after")
                    .forEach((el) => {
                        el.classList.remove("syfe-mtree__row--dragover-before", "syfe-mtree__row--dragover-after");
                    });
            };

            // 指示线画在目标行的上/下缘,明确"插到这里之前还是之后"
            const renderMountDragOver = () => {
                clearMountDragMarks();
                if (!dragOverMountUid) return;
                const el = listEl.querySelector(`.syfe-mtree__row--mount[data-mount-uid="${CSS.escape(dragOverMountUid)}"]`);
                if (el) {
                    el.classList.add(dragOverPos === "before"
                        ? "syfe-mtree__row--dragover-before"
                        : "syfe-mtree__row--dragover-after");
                }
            };

            // 建树(带并发去重):开关关闭时清空并标记未加载。
            // 只有**首次**构建才占位"加载中";force 重建保留旧树静默进行,完成后一次性替换
            // (此前重建期间整树回退"加载中"再重载,是面板闪烁的来源之一)。
            const ensureRelationTree = (force = false) => {
                if (!relationEnabled()) {
                    relationRoots = [];
                    relationLoaded = false;
                    relExpanded = new Set();
                    return;
                }
                if ((relationLoaded && !force) || relationBuilding || relationRefreshing) return;
                if (!relationLoaded) {
                    // 首次构建:先占位渲染"加载中",避免用户干等
                    relationBuilding = true;
                    self._rows = [];
                    render();
                }
                relationRefreshing = true;
                void buildRelationForest(relCfg(), mountedDocIds())
                    .then((roots) => {
                        relationRoots = roots;
                        relationLoaded = true;
                        relationBuilding = false;
                        relationRefreshing = false;
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
                        relationRefreshing = false;
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
                    } else if (r.kind === "mount" || r.kind === "doc" || r.kind === "auto" || r.kind === "block") {
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

            // 子项缓存键 → 加载器(与 rowChildSource/autoLoader 同一套原语;静默刷新用)
            const loaderForKey = (key: string): (() => Promise<DirEntry[] | BlockNode[]>) | null => {
                if (key.startsWith("d:sydoc://")) return () => virtualListDir(key.slice(2));
                if (key.startsWith("b:")) return () => listChildBlocks(key.slice(2));
                if (key.startsWith("f:")) return () => readDir(key.slice(2));
                return null;
            };

            // 静默刷新:重取"已展开"的子项列表,内容有变化的键才更新缓存。
            // 返回是否有变化。数据没变就不重绘 —— 否则每次 switch-protyle(切文档防抖后必触发
            // syfe:files-changed)都清缓存全量重绘,整棵树回退「加载中」再重载,看起来就是面板时不时闪烁。
            const silentRefreshExpanded = async (): Promise<boolean> => {
                const jobs: Promise<void>[] = [];
                let changed = false;
                for (const key of Array.from(self._expanded!)) {
                    const loader = loaderForKey(key);
                    if (!loader || !self._cache!.has(key)) continue; // 尚未加载过的键,展开时自然取
                    jobs.push(loader().then((list) => {
                        if (JSON.stringify(self._cache!.get(key)) !== JSON.stringify(list)) {
                            self._cache!.set(key, list);
                            changed = true;
                        }
                    }).catch(() => { }));
                }
                await Promise.all(jobs);
                return changed;
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

            // 思源文档/笔记本下的子文档(按虚拟路径 sydoc://… 缓存;笔记本根是 sydoc://nb/<id>)。
            // owner = 这些行所属的挂载节点:虚拟文档行不是挂载项,右键嵌套挂载时要用它定位宿主。
            // 同层去重且**位置保持**:同一文档若已作为显式挂载子项挂在 owner 下,不再另出虚拟行,
            // 而是在虚拟行的原位置渲染挂载行(renderMount,由 walk 传入)——挂载行是虚拟行的
            // 超集(可嵌套挂载/取消挂载),信息无损;取消挂载后虚拟行自然回来。
            const emitDocs = (vPath: string, depth: number, out: Row[], owner?: MountItem, renderMount?: (it: MountItem, depth: number) => void): void => {
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
                const mountedMap = new Map(
                    (owner?.children || [])
                        .filter(c => c.kind === "doc" || c.kind === "notebook")
                        .map(c => [c.targetId || "", c] as const),
                );
                for (const e of kids) {
                    const childPath = String(e.path);
                    const childId = virtualId(childPath);
                    const mountedChild = mountedMap.get(childId);
                    if (mountedChild) {
                        // 已挂载:顶替虚拟行、在原位置渲染挂载行
                        if (renderMount) renderMount(mountedChild, depth);
                        continue;
                    }
                    const ex = self._expanded!.has("d:" + childPath);
                    // icon/subFileCount 来自 listDocsByPath,用于渲染思源文档树同款图标
                    out.push({
                        kind: "doc", docId: childId, name: String(e.name), depth, expanded: ex,
                        icon: e.icon, subFileCount: e.subFileCount, ownerUid: owner?.uid,
                    });
                    if (ex) emitDocs(childPath, depth + 1, out, owner, renderMount);
                }
            };

            const emitBlocks = (blockId: string, depth: number, out: Row[], owner?: MountItem, renderMount?: (it: MountItem, depth: number) => void): void => {
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
                // 同层去重且位置保持:已显式挂载的块顶替虚拟块行
                const mountedMap = new Map(
                    (owner?.children || []).filter(c => c.kind === "block").map(c => [c.targetId || "", c] as const),
                );
                for (const b of kids) {
                    const mountedChild = mountedMap.get(b.id);
                    if (mountedChild) {
                        if (renderMount) renderMount(mountedChild, depth);
                        continue;
                    }
                    const ex = self._expanded!.has("b:" + b.id);
                    out.push({
                        kind: "block", blockId: b.id, name: blockTitle(b.content, b.type),
                        depth, expanded: ex, ownerUid: owner?.uid,
                        btype: b.type, bsubtype: b.subtype, bmd: b.markdown, bname: b.name,
                    });
                    if (ex) emitBlocks(b.id, depth + 1, out, owner, renderMount);
                }
            };

            // 某一行对应的"子项缓存键 + 加载器";返回 null 表示该行不可能有子项(叶子)
            const rowChildSource = (r: Row): {key: string; loader: () => Promise<DirEntry[] | BlockNode[]>} | null => {
                if (r.kind === "mount") {
                    // doc 挂载 + 引用配置开启:子项来自预构建的引用关系,不走子文档 loader
                    if (r.item.kind === "doc" && relationEnabled()) return null;
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

            // 挂载项是否显示折叠箭头:有显式嵌套挂载一定显示;自动子项按实际条数。
            // doc 挂载在引用配置开启时,子项 = 自动挂载行(来自预构建的引用关系),不看子文档缓存
            const mountHasKids = (item: MountItem): boolean => {
                if (item.children.length > 0) return true;
                if (item.kind === "doc" && relationEnabled()) {
                    if (relationBuilding || !relationLoaded) return true; // 尚未建好:乐观显示
                    const node = findRelationNode(relationRoots, item.targetId!);
                    return !!node && node.children.length > 0;
                }
                const ldr = autoLoader(item);
                return ldr ? hasKidsOf(autoKeyOf(item)) : false;
            };

            // 该行是否显示折叠箭头
            const rowHasKids = (r: Row): boolean => {
                if (r.kind === "mount") return mountHasKids(r.item);
                if (r.kind === "auto") return r.hasChildren;
                const src = rowChildSource(r);
                return src ? hasKidsOf(src.key) : false;
            };

            // 递归渲染:显式嵌套挂载在前,自动子项在后。
            // 引用子层级不再是独立区块,直接作为**自动挂载行**内嵌在挂载树里:
            //   - 不去重:同一文档可以同时出现在手动挂载位置和各引用位置(用户明确要求);
            //   - 自动挂载层的顺序存挂载配置 customOrder[父文档id],未记录的按名称回退;
            //   - 聚焦模式:只渲染聚焦文档引用子树内的行。
            const buildRows = (): Row[] => {
                const rows: Row[] = [];
                const focusNode = relationFocusId ? findRelationNode(relationRoots, relationFocusId) : null;
                const focusIds = focusNode
                    ? (() => {
                        const s = new Set<string>();
                        const dfs = (n: RelationNode) => { s.add(n.docId); n.children.forEach(dfs); };
                        dfs(focusNode);
                        return s;
                    })()
                    : relationFocusId ? new Set([relationFocusId]) : null;

                const emitAutoLevel = (parentDocId: string, kids: RelationNode[], depth: number, out: Row[]): void => {
                    if (relationBuilding) {
                        out.push({kind: "loading", depth});
                        return;
                    }
                    const order = getAutoOrder(parentDocId);
                    const rank = new Map(order.map((id, i) => [id, i] as const));
                    const ordered = kids
                        .filter(n => !focusIds || focusIds.has(n.docId))
                        .slice()
                        .sort((a, b) => {
                            const ra = rank.has(a.docId) ? rank.get(a.docId)! : Number.MAX_SAFE_INTEGER;
                            const rb = rank.has(b.docId) ? rank.get(b.docId)! : Number.MAX_SAFE_INTEGER;
                            return ra !== rb ? ra - rb : a.displayName.localeCompare(b.displayName);
                        });
                    if (ordered.length === 0) {
                        out.push({kind: "empty", depth});
                        return;
                    }
                    for (const n of ordered) {
                        const ex = relExpanded.has(n.docId);
                        out.push({
                            kind: "auto", docId: n.docId, name: n.displayName, hpath: n.hpath,
                            depth, expanded: ex, hasChildren: n.children.length > 0,
                            parentDocId, subFileCount: n.subFileCount,
                        });
                        if (ex) emitAutoLevel(n.docId, n.children, depth + 1, out);
                    }
                };

                const walk = (item: MountItem, depth: number) => {
                    // 聚焦模式:子树外的挂载行隐藏
                    if (focusIds && !(item.kind === "doc" && item.targetId && focusIds.has(item.targetId))) return;
                    // 展开状态键必须与点击时 toggle() 写入的键一致(都用 autoKeyOf),
                    // 否则点击后 _expanded 记在 A 键、这里查 B 键,行永远不会翻转成展开
                    const expanded = self._expanded!.has(autoKeyOf(item));
                    const hasChildren = mountHasKids(item);
                    rows.push({kind: "mount", uid: item.uid, depth, expanded, hasChildren, item});
                    if (!expanded) return;
                    // 与自动子项(思源子文档/子块)同目标的挂载子项不在顶部渲染——
                    // 它们会在下面的 emitDocs/emitBlocks 里顶替虚拟行,保持文档中的原位置。
                    // 子项列表尚未加载(cache undefined)时先按老行为全量渲染,加载后重绘即归位。
                    let autoIds: Set<string> | null = null;
                    if (item.kind === "doc" || item.kind === "notebook") {
                        const autoKids = self._cache!.get(autoKeyOf(item)) as DirEntry[] | undefined;
                        autoIds = new Set((autoKids || []).map(e => virtualId(String(e.path || ""))));
                    } else if (item.kind === "block") {
                        const autoKids = self._cache!.get(autoKeyOf(item)) as BlockNode[] | undefined;
                        autoIds = new Set((autoKids || []).map(b => b.id));
                    }
                    for (const c of item.children) {
                        const isCounterpart = !!autoIds && !!c.targetId && autoIds.has(c.targetId)
                            && (item.kind === "block" ? c.kind === "block" : c.kind === "doc" || c.kind === "notebook");
                        if (isCounterpart) continue;
                        walk(c, depth + 1);
                    }
                    if (item.kind === "file" && item.isDir) emitDir(item.path!, depth + 1, rows);
                    else if (item.kind === "doc") {
                        // 引用配置开启:子项 = 自动挂载行(引用文档 + 物理子文档);关闭:回退为仅子文档
                        if (relationEnabled()) emitAutoLevel(item.targetId!, findRelationNode(relationRoots, item.targetId!)?.children || [], depth + 1, rows);
                        else emitDocs("sydoc://" + item.targetId!, depth + 1, rows, item, (c, d) => walk(c, d));
                    }
                    else if (item.kind === "notebook") emitDocs("sydoc://nb/" + item.targetId!, depth + 1, rows, item, (c, d) => walk(c, d));
                    else if (item.kind === "block") emitBlocks(item.targetId!, depth + 1, rows, item, (c, d) => walk(c, d));
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

            // 行末「查看引用」链接图标(hover 显示,加载中/空行不加;点击弹出反链对话框)。
            // 显示与否跟随设置 virtualTree.backlinkIcon(config.treeBacklinkIcon,默认开)
            const linkBtnHTML = () => plugin.config?.treeBacklinkIcon !== false
                ? `<span class="syfe-mtree__linkbtn" data-linkbtn="1" title="查看引用"><svg><use xlink:href="#iconLink"></use></svg></span>`
                : "";

            // 表格块行内预览:Lute 把 markdown 渲染成块 DOM(截掉尾部 protyle-attr 标记),
            // 等比缩放由 fitBlockPreviews 统一处理。结果必须含 <table>,否则视为失败(退回文字行)。
            const tablePreviewHTML = (md: string): string => {
                if (!md) return "";
                try {
                    const html = String(getLute()?.Md2BlockDOM?.(md) || "");
                    if (!html.includes("<table")) return "";
                    return `<span class="syfe-mtree__preview syfe-mtree__preview--fit">${html.replace(/<div class="protyle-attr"[\s\S]*$/, "")}</span>`;
                } catch {
                    return "";
                }
            };

            // 块行的图标/名称/预览/悬浮提示,统一由这里决定(块子行与挂载块根行共用):
            // - 单图段落(思源没有独立图片块,整段仅一图):图标用虚拟文档树的图片文件图标
            //   (与文件树里图片文件一致),行内等比缩略图,名称显示图片标题(次行显示提示文本 alt);
            // - 表格:块标图标(iconTable),行内等比缩放预览,名称显示块命名(没有就不显示文字);
            // - 其余块:块标(gutter)图标 —— 标题按层级 iconH1-H6、列表按有序/无序/任务细分,
            //   挂载标题块与下面的子标题都各用对应层级的图标;名称显示文本标题。
            // 表格行的文字显示块命名(bname);名称与预览的显示模式由右键切换,按块记忆。
            const blockRowParts = (blockId: string, fallbackName: string, info: {btype?: string; bsubtype?: string; bmd?: string; bname?: string}) => {
                // blockGutterIcon 返回的是图标名(如 iconH4),这里包成 svg 才能当行图标渲染
                const gutter = `<svg><use xlink:href="#${blockGutterIcon(info.btype || "p", info.bsubtype || "")}"></use></svg>`;
                const img = info.btype === "p" && info.bmd ? soloImageInfo(info.bmd) : null;
                if (img) {
                    const tip = `思源块:${blockId}`
                        + (img.title ? ` · 标题:${img.title}` : "")
                        + (img.alt ? ` · 提示文本:${img.alt}` : "");
                    // 右键可切「显示标题 / 显示缩放图」:两种模式只出一者,不混排。
                    // 标题模式:用图片标题或提示文字,都没有就用块 id
                    if (blockDisplayMode(blockId) === "text") {
                        return {
                            icon: fileIconHTML(basename(img.src)),
                            name: img.title || img.alt || blockId,
                            sub: "", tip, preview: "",
                        };
                    }
                    return {
                        icon: fileIconHTML(basename(img.src)),
                        // 缩放图模式:缩略图 + 标题或提示文字,都没有就块 id(避免行看起来是空的)
                        name: img.title || img.alt || blockId,
                        sub: "", tip,
                        preview: `<span class="syfe-mtree__preview"><img loading="lazy" src="/${encodeURI(img.src)}" alt="${escapeHTML(img.title || img.alt || "")}"></span>`,
                    };
                }
                if (info.btype === "t") {
                    // 右键可切「显示标题 / 显示缩放表格」:两种模式只出一者。
                    // 标题模式:用块命名,没有就用块 id(不用单元格拼接文本);预览渲染失败同样回退
                    const preview = blockDisplayMode(blockId) === "preview" ? tablePreviewHTML(info.bmd || "") : "";
                    const name = preview ? "" : (info.bname || blockId);
                    const tip = `思源块:${blockId}` + (name ? ` · 命名:${name}` : "");
                    return {icon: gutter, name, sub: "", tip, preview};
                }
                return {icon: gutter, name: fallbackName, sub: "", tip: `思源块:${blockId}`, preview: ""};
            };

            // 菜单/挂载标签用的行名称:缩放预览模式行上不显示文字(name=""),但
            // 「挂载…到『』下」等菜单标签需要名称 —— 图片用标题或提示文字,表格用块命名,
            // 都没有(或为空)就用块 id
            const blockMenuName = (blockId: string, fallbackName: string, info: {btype?: string; bmd?: string; bname?: string}): string => {
                if (info.btype === "p") {
                    const img = soloImageInfo(info.bmd || "");
                    if (img) return img.title || img.alt || blockId;
                }
                if (info.btype === "t") return info.bname || blockId;
                return fallbackName || blockId;
            };

            // 块行 HTML:块子行与挂载块根行共用(挂载行多 open/flash 样式与拖拽属性,由调用方拼)
            const blockRowHTML = (parts: ReturnType<typeof blockRowParts>, liClass: string, attrs: string, pad: number, arrow: string, linkBtn: string): string => {
                const text = parts.name || parts.sub
                    ? `<span class="syfe-mtree__text">${parts.name ? `<span class="syfe-mtree__name">${escapeHTML(parts.name)}</span>` : ""}${parts.sub ? `<span class="syfe-mtree__sub">${escapeHTML(parts.sub)}</span>` : ""}</span>`
                    : "";
                return `
                <li class="syfe-mtree__row ${liClass}" ${attrs} style="padding-left:${pad}px"
                    title="${escapeHTML(parts.tip)}">
                    ${arrow}
                    <span class="syfe-mtree__icon">${parts.icon}</span>
                    ${parts.preview}
                    ${text}
                    ${linkBtn}
                </li>`;
            };

            // 表格预览的等比缩放:单元格 nowrap 保持文档内列宽比例,量自然宽度后整体 zoom。
            // 每次重绘都是新 DOM(无残留 zoom),测量值即自然宽度;面板宽度为 0(隐藏中)时跳过。
            const fitBlockPreviews = (): void => {
                listEl.querySelectorAll<HTMLElement>(".syfe-mtree__preview--fit").forEach(box => {
                    const inner = box.firstElementChild as HTMLElement | null;
                    if (!inner) return;
                    const cw = box.clientWidth;
                    if (cw <= 0) return;
                    const sw = inner.scrollWidth;
                    if (sw > cw) inner.style.zoom = String(cw / sw);
                });
            };

            const render = () => {
                const LINK_BTN = linkBtnHTML();
                if (!self._listEl) return; // 已销毁
                const roots = getRoots();
                if (roots.length === 0) {
                    self._rows = [];
                    listEl.innerHTML = `<li class="syfe-mtree__empty">${mountTreeEmptyHint()}</li>`;
                    return;
                }
                const rows = buildRows();
                // 标签筛选只作用于手动挂载的行;关系树是只读视图,始终显示
                const filtering = filterOn && (tagSel.length > 0 || tagAny);
                const manualRows = filtering ? applyTagFilter(rows) : rows;
                const shown = filtering
                    ? manualRows.filter((r) => r.kind === "auto" || r.kind === "loading" || r.depth === 0)
                    : manualRows;
                self._rows = shown;
                renderChips();
                const curFile = currentFilePath(); // 焦点页签打开的本地文件(file 行高亮用)
                listEl.innerHTML = shown.map((r, i) => {
                    const pad = 6 + r.depth * 14;
                    if (r.kind === "loading") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">加载中…</li>`;
                    }
                    // 自动挂载行(引用子层级):与挂载行同款渲染,拖拽模式下可拖
                    if (r.kind === "auto") {
                        // 图标与思源文档树一致:自定义 icon 优先,否则按**真实子文档数**选
                        // folder/file。不能按"有没有引用者"选 —— 那是引用关系的父子,
                        // 与文档自身是否含子文档无关,会导致同一文档两处图标不一样。
                        const docIcon = docTreeIconHTML(cachedDocIcon(r.docId) || "", (r.subFileCount ?? 0) > 0 ? "folder" : "file");
                        const flashing = relationLocateFlash === r.docId ? " syfe-mtree__row--flash" : "";
                        const cur = currentDocRootId() === r.docId ? " syfe-mtree__row--current" : "";
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--auto${r.expanded ? " syfe-mtree__row--open" : ""}${flashing}${cur}"
                            data-idx="${i}" data-rel-doc="${escapeHTML(r.docId)}" data-auto-parent="${escapeHTML(r.parentDocId)}"
                            draggable="${dragMode ? "true" : "false"}"
                            style="padding-left:${pad}px"
                            title="${escapeHTML(r.name)}&#10;ID: ${escapeHTML(r.docId)}${r.hpath ? "\n" + escapeHTML(r.hpath) : ""}">
                            ${toggleArrow(r.expanded, r.hasChildren)}
                            <span class="syfe-mtree__icon">${docIcon}</span>
                            <span class="syfe-mtree__text">
                                <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                            </span>
                            ${LINK_BTN}
                        </li>`;
                    }
                    if (r.kind === "empty") {
                        return `<li class="syfe-mtree__row syfe-mtree__row--loading" style="padding-left:${pad + 14}px">(空)</li>`;
                    }
                    // 空节点(空文件夹 / 无子文档 / 无子块)不显示折叠箭头
                    const hasKids = rowHasKids(r);
                    const arrow = toggleArrow(r.expanded, hasKids);
                    // 挂载的思源块根行:块元数据(类型/markdown/命名)后台补齐后,与块子行同款渲染
                    // (块标图标/预览/命名标题);未取到前先落到下面的通用挂载行(iconEdit),到位后重绘替换
                    if (r.kind === "mount" && r.item.kind === "block") {
                        const meta = self._blockMeta?.get(r.item.targetId || "");
                        if (meta) {
                            return blockRowHTML(
                                blockRowParts(r.item.targetId || "", r.item.name || "", {
                                    btype: meta.type, bsubtype: meta.subtype, bmd: meta.markdown, bname: meta.name,
                                }),
                                `syfe-mtree__row--mount${r.expanded ? " syfe-mtree__row--open" : ""}${mountLocateFlashUid === r.uid ? " syfe-mtree__row--flash" : ""}`,
                                `data-idx="${i}" data-mount-uid="${escapeHTML(r.uid)}" draggable="${dragMode ? "true" : "false"}"`,
                                pad, arrow, LINK_BTN);
                        }
                    }
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
                        <li class="syfe-mtree__row syfe-mtree__row--mount${r.expanded ? " syfe-mtree__row--open" : ""}${mountLocateFlashUid === r.uid ? " syfe-mtree__row--flash" : ""}"
                            data-idx="${i}" data-mount-uid="${escapeHTML(r.uid)}" draggable="${dragMode ? "true" : "false"}"
                            style="padding-left:${pad}px"
                            title="${escapeHTML(it.kind === "file" ? (it.path || name) : (it.targetId || name))}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${icon}</span>
                            <span class="syfe-mtree__text">
                                <span class="syfe-mtree__name">${escapeHTML(name)}</span>
                                ${sub ? `<span class="syfe-mtree__sub">${escapeHTML(sub)}</span>` : ""}
                            </span>
                            ${LINK_BTN}
                        </li>`;
                    }
                    if (r.kind === "file") {
                        const icon = r.isDir ? folderIconHTML(r.name, r.expanded) : fileIconHTML(r.name);
                        // 定位闪烁 + 当前打开文件高亮(与 doc 行的 --flash/--current 同款)
                        const flashing = fileLocateFlashPath && sameFsPath(fileLocateFlashPath, r.path) ? " syfe-mtree__row--flash" : "";
                        const cur = curFile && sameFsPath(curFile, r.path) ? " syfe-mtree__row--current" : "";
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--file${r.isDir ? " syfe-mtree__row--dir" : ""}${flashing}${cur}"
                            data-idx="${i}" style="padding-left:${pad}px" title="${escapeHTML(r.path)}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${icon}</span>
                            <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                            ${LINK_BTN}
                        </li>`;
                    }
                    if (r.kind === "doc") {
                        const docIcon = docTreeIconHTML(r.icon || "", (r.subFileCount ?? 0) > 0 ? "folder" : "file");
                        return `
                        <li class="syfe-mtree__row syfe-mtree__row--doc${relationLocateFlash === r.docId ? " syfe-mtree__row--flash" : ""}" data-idx="${i}" data-doc-path="${escapeHTML(r.docId)}" style="padding-left:${pad}px"
                            title="思源文档:${escapeHTML(r.docId)}">
                            ${arrow}
                            <span class="syfe-mtree__icon">${docIcon}</span>
                            <span class="syfe-mtree__name">${escapeHTML(r.name)}</span>
                            ${LINK_BTN}
                        </li>`;
                    }
                    // 思源块行:图标/名称/预览统一走 blockRowParts(单图/表格有行内预览)
                    return blockRowHTML(blockRowParts(r.blockId, r.name, r), "syfe-mtree__row--block", `data-idx="${i}"`, pad, arrow, LINK_BTN);
                }).join("");
                fitBlockPreviews();

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
                // 自动挂载行同理:自定义图标要先按缓存画,后台补齐后重绘,
                // 否则首屏拿不到 icon 会与原生文档树显示不一致
                const autoDocs = shown.filter((r): r is Extract<Row, {kind: "auto"}> =>
                    r.kind === "auto").map(r => r.docId);
                ensureDocIcons(mountDocs.concat(autoDocs), () => render());
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

                // 挂载的思源块根行:每次重绘都现查块元数据(类型/子类型/markdown/命名)并与缓存比对,
                // 块在文档里被转换类型(如标题转文档)/改名后,树上跟着按新类型展示 —— 只要块 id 没变。
                // 比对无变化不重绘(避免渲染循环);查询失败保留旧缓存;查不到视为块已删除(占位,
                // 行回退到挂载时的名称与通用图标)。
                const blkIds = Array.from(new Set(shown
                    .filter((r): r is Extract<Row, {kind: "mount"}> => r.kind === "mount" && r.item.kind === "block")
                    .map(r => r.item.targetId || "")
                    .filter(id => id)));
                if (blkIds.length > 0) {
                    void (async () => {
                        let changed = false;
                        for (let i = 0; i < blkIds.length; i += 50) {
                            const chunkIds = blkIds.slice(i, i + 50);
                            const chunk = chunkIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",");
                            const fresh = new Map<string, {type: string; subtype: string; markdown: string; name: string}>();
                            try {
                                const rs = await querySQL(`SELECT id, type, subtype, markdown, name FROM blocks WHERE id IN (${chunk})`);
                                for (const b of (Array.isArray(rs) ? rs : [])) {
                                    if (b && b.id) {
                                        fresh.set(String(b.id), {
                                            type: String(b.type || "p"),
                                            subtype: String(b.subtype || ""),
                                            markdown: String(b.markdown == null ? "" : b.markdown),
                                            name: String(b.name == null ? "" : b.name),
                                        });
                                    }
                                }
                                for (const id of chunkIds) {
                                    const next = fresh.get(id) || {type: "", subtype: "", markdown: "", name: ""};
                                    const prev = self._blockMeta!.get(id);
                                    if (prev && prev.type === next.type && prev.subtype === next.subtype
                                        && prev.markdown === next.markdown && prev.name === next.name) {
                                        continue;
                                    }
                                    if (prev && prev.type !== next.type) {
                                        // 类型变了(如标题转文档):该块的子块列表按新结构重取
                                        self._cache!.delete("b:" + id);
                                    }
                                    self._blockMeta!.set(id, next);
                                    changed = true;
                                }
                            } catch {
                                // 查询失败:保留旧缓存,下次重绘再试
                            }
                        }
                        if (changed) render();
                    })();
                }
            };
            render();

            const rowOf = (el: HTMLElement | null): Row | null => {
                if (!el) return null;
                const idx = Number(el.dataset.idx);
                return Number.isFinite(idx) ? (self._rows![idx] || null) : null;
            };

            // 打开挂载项(文件→编辑器;笔记本→打开其中第一篇文档;文档/块→思源协议定位)
            // 必须传 plugin.app:openTab 在应用内直接打开;不传会走 siyuan:// 系统协议,
            // 协议未注册/唤起失败时静默失败(什么都不打开)。
            const openMount = (item: MountItem) => {
                if (item.kind === "file" && item.path) {
                    openFileTab(plugin as any, item.path);
                } else if (item.kind === "notebook" && item.targetId) {
                    // 笔记本 id 用 openSiyuanDoc(openTab/协议)打不开,走打开其中第一篇文档
                    void openSiyuanNotebook(item.targetId, plugin.app);
                } else if (item.targetId) {
                    openSiyuanDoc(item.targetId, plugin.app);
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
                } else if (row.kind === "auto") {
                    // 自动挂载行:箭头展开/收起引用子层级(状态按 docId 共享)
                    toggleRelationNode(row.docId);
                }
            };

            // 点击:行首箭头 → 只展开/收起;名称区 → 文件夹展开,文件/文档/笔记本/块打开
            // 关系树的工具动作(工具栏按钮与行内按钮共用)
            const runRelationAction = (action: string) => {
                // 顶栏按钮始终显示;引用关系树关闭时给提示而不是静默无反应
                if (!relationEnabled()) {
                    showMessage("引用关系树未开启,可在设置 → 引用关系中打开", 3500, "info");
                    return;
                }
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

            // 行末「查看引用」链接图标:按行类型构造数据加载,弹出反链对话框
            const openBacklinkDialogForRow = (row: Row): void => {
                if (row.kind === "loading" || row.kind === "empty") return;
                let title = "";
                let subtitle = "";
                let load: () => Promise<BacklinkItem[]>;
                if (row.kind === "mount") {
                    const it = row.item;
                    title = it.name || (it.path ? basename(it.path) : it.targetId || "");
                    if (it.kind === "file" && it.path) {
                        subtitle = it.path;
                        load = it.isDir
                            ? () => findDirBacklinks(it.path!)
                            : () => findBacklinks(it.path!);
                    } else if (it.kind === "notebook" && it.targetId) {
                        subtitle = `笔记本 ${it.targetId}`;
                        load = () => findSiyuanRefBacklinks(it.targetId!, it.targetId);
                    } else {
                        subtitle = it.targetId || "";
                        load = () => findSiyuanRefBacklinks(it.targetId!);
                    }
                } else if (row.kind === "file") {
                    title = row.name;
                    subtitle = row.path;
                    load = row.isDir
                        ? () => findDirBacklinks(row.path)
                        : () => findBacklinks(row.path);
                } else if (row.kind === "doc" || row.kind === "auto") {
                    title = row.name;
                    subtitle = `思源文档 ${row.docId}`;
                    load = () => findSiyuanRefBacklinks(row.docId);
                } else {
                    title = row.name;
                    subtitle = `思源块 ${row.blockId}`;
                    load = () => findSiyuanRefBacklinks(row.blockId);
                }
                showBacklinkDialog(plugin as any, {
                    title: `引用 — ${title}`,
                    subtitle,
                    load,
                });
            };

            const clickHandler = (e: MouseEvent) => {
                // 行末「查看引用」链接图标:弹反链对话框,不触发行自身的打开行为
                const linkBtn = (e.target as HTMLElement).closest("[data-linkbtn]") as HTMLElement | null;
                if (linkBtn) {
                    const row = rowOf(linkBtn.closest(".syfe-mtree__row") as HTMLElement | null);
                    if (row) openBacklinkDialogForRow(row);
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
                    openSiyuanDoc(row.docId, plugin.app);
                    return;
                }
                // 自动挂载行:点名称打开文档(箭头由上面统一分支处理展开/收起)
                if (row.kind === "auto") {
                    openSiyuanDoc(row.docId, plugin.app);
                    return;
                }
                if (row.kind === "block") {
                    openSiyuanDoc(row.blockId, plugin.app);
                    return;
                }
            };
            this._clickHandler = clickHandler;
            scrollEl.addEventListener("click", clickHandler);
            // 注:不注册 dblclick —— 名称区单击已是"打开",双击会重复触发 siyuan:// 跳转

            // 文件/文件夹:直接复用**文件树的完整右键菜单**(一份实现两处用,功能自动同步)。
            // rootEl 传文件树里对应的根(找不到就传 null——refreshPath 对 null 直接返回,
            // 重命名/删除仍会执行,只是不刷新文件树);操作完通过 syfe:files-changed 自行重绘。
            // actions 统一由 buildFileTreeActions 构建(与编辑器页签的面包屑「更多」菜单共用)。
            const fileTreeActions = buildFileTreeActions(plugin as any, () => render());

            // 面板内挂载入口(挂到顶层,或挂到右键命中的那个挂载节点下)。
            // 返回菜单项描述,供空白处菜单直接 addItem,也供文档/笔记本菜单的 extra 追加。
            // parentUid 可传解析函数:虚拟文档/块行不是挂载项(没有 uid),点击时才解析出
            // 它对应的挂载项(复用或自动创建),见 ensureTargetMountItem。
            const mountMenuItems = (parentUid: string | null | (() => Promise<string | null>), where: string): DocMenuItem[] => {
                const uidOf = async (): Promise<string | null> =>
                    typeof parentUid === "function" ? await parentUid() : parentUid;
                return [
                    {
                        icon: "iconFile",
                        label: `挂载思源文档/笔记本${where}`,
                        click: () => {
                            pickMountTargetDialog(where ? `挂载到「${where}」` : "挂载思源文档/笔记本到虚拟文档树", (vPath, label) => {
                                // 「启用顶层笔记本文档」时笔记本自己就是一篇文档(id 相同)→
                                // 挂载它等价于挂载那篇文档;否则仍按笔记本容器挂载。
                                const isNb = isNotebookRoot(vPath);
                                const kind = isNb && !isBoxDocEnabled() ? "notebook" : "doc";
                                void uidOf().then(uid => mountPayload(plugin, {kind, name: label, targetId: virtualId(vPath)}, uid));
                            });
                        },
                    },
                    {
                        icon: "iconFolder",
                        label: `挂载文件/文件夹${where}`,
                        click: () => {
                            promptMountPathDialog(where ? `挂载到「${where}」` : "挂载文件/文件夹到虚拟文档树", (p, isDir, name) => {
                                void uidOf().then(uid => mountPayload(plugin, {kind: "file", name, path: p, isDir}, uid));
                            });
                        },
                    },
                    // 百度网盘目录(readDir 原生支持 bdpan:// 路径,挂完可直接逐级列目录)
                    {
                        icon: "iconCloud",
                        label: `挂载百度网盘${where}`,
                        click: () => {
                            openBaiduPanDialog({
                                title: where ? `挂载百度网盘到「${where}」` : "挂载百度网盘到虚拟文档树",
                                onPicked: (vPath: string, label: string) => {
                                    void uidOf().then(uid => mountPayload(plugin, {kind: "file", name: label, path: vPath, isDir: true}, uid));
                                },
                            });
                        },
                    },
                    // 思源块:关键词搜索或粘贴块 ID;挂载后按 parent_id 递归展开子块
                    {
                        icon: "iconList",
                        label: `挂载思源块${where}`,
                        click: () => {
                            pickBlockDialog(where ? `挂载思源块到「${where}」` : "挂载思源块到虚拟文档树", (blockId, label) => {
                                void uidOf().then(uid => mountPayload(plugin, {kind: "block", name: label, targetId: blockId}, uid));
                            });
                        },
                    },
                ];
            };

            // 把挂载入口项追加到**已有内容**的自建菜单(前置分隔线与上方菜单项隔开);
            // 空菜单(如空白处右键)直接 add,否则分隔线会顶在菜单最上面变成一条横线
            const appendMountItems = (menu: Menu, parentUid: string | null | (() => Promise<string | null>), where: string) => {
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

            // 图片/表格块的右键显示项:行内显示模式二选一(打勾为当前模式,按块记忆)。
            // rowInfo 传块子行的行上数据;挂载根行传 null(从 _blockMeta 取)。
            const addBlockDisplayItems = (menu: Menu, blockId: string, rowInfo: {btype?: string; bmd?: string} | null) => {
                const meta = self._blockMeta?.get(blockId);
                const btype = rowInfo?.btype ?? meta?.type;
                const isImage = btype === "p" && soloImageInfo(rowInfo?.bmd ?? meta?.markdown ?? "");
                const isTable = btype === "t";
                if (!isImage && !isTable) return;
                const mode = blockDisplayMode(blockId);
                menu.addItem({
                    icon: "iconFont",
                    label: "显示标题",
                    current: mode === "text",
                    click: () => {
                        setBlockDisplayMode(blockId, "text");
                        render();
                    },
                } as any);
                menu.addItem({
                    icon: isImage ? "iconImage" : "iconTable",
                    label: isImage ? "显示缩放图" : "显示缩放表格",
                    current: mode === "preview",
                    click: () => {
                        setBlockDisplayMode(blockId, "preview");
                        render();
                    },
                } as any);
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
                    // 空菜单不加分隔线(顶部会悬一条横线),直接追加挂载项
                    const menu = new Menu();
                    for (const it of mountMenuItems(null, "")) menu.addItem(it as any);
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
                if (row.kind === "auto") {
                    // 自动挂载行(引用子层级):原生文档菜单 + 标签/刷新/聚焦 + 提升为手动挂载项
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
                                label: "刷新引用关系",
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
                            // 提升为手动挂载项:可选顶层或任意挂载节点下(手动挂载可在任意位置)
                            {
                                icon: "iconPin",
                                label: "固定为手动挂载项…",
                                click: () => showMountTargetMenu(e.clientX, e.clientY, plugin, {kind: "doc", name: row.name, targetId: row.docId}),
                            },
                        ],
                    });
                    return;
                }
                if (row.kind === "mount" && row.item.kind === "block") {
                    // 挂载的块:定位/复制块链接/文档标签 + 命名与显示切换(图片/表格) + 固定收藏 + 取消挂载/挂载入口
                    const it = row.item;
                    const menu = new Menu();
                    menu.addItem({icon: "iconOpen", label: "定位到块", click: () => openSiyuanDoc(it.targetId!, plugin.app)});
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
                    // 图片/表格块:命名 + 标题/缩放预览显示切换
                    addBlockDisplayItems(menu, it.targetId!, null);
                    addPinFavEntries(menu, plugin, it.targetId!, it.name, afterDocOp);
                    // 挂载标签:图片行在缩放图模式下行名为空,这里按 标题→提示文字→块 id 取
                    const meta = self._blockMeta?.get(it.targetId || "");
                    appendMountItems(menu, row.uid, `「${blockMenuName(it.targetId || "", it.name, meta ? {btype: meta.type, bmd: meta.markdown, bname: meta.name} : {})}」下`);
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
                            // 虚拟文档行不是挂载项:挂载入口先解析出它对应的挂载项
                            // (已有同目标挂载复用;否则自动挂到其所属挂载节点下并展开),再挂到它下面
                            ...mountMenuItems(async () => {
                                const r = await ensureTargetMountItem(plugin, "doc", row.docId, row.name, row.ownerUid ?? null);
                                if (r?.created) {
                                    self._expanded!.add(autoKeyOf(r.item)); // 新建的挂载行自动展开,直接看到刚挂进去的内容
                                }
                                return r ? r.item.uid : null;
                            }, `「${row.name}」下`),
                        ],
                    });
                    return;
                }
                if (row.kind === "block") {
                    const menu = new Menu();
                    menu.addItem({icon: "iconOpen", label: "定位到块", click: () => openSiyuanDoc(row.blockId, plugin.app)});
                    menu.addItem({
                        icon: "iconTags",
                        label: "文档标签…",
                        click: () => openSiyuanTagDialog(row.blockId, row.name),
                    });
                    // 图片/表格块:显示模式切换(标题/缩放预览)
                    addBlockDisplayItems(menu, row.blockId, row);
                    // 虚拟块行同虚拟文档行:先解析出块对应的挂载项再嵌套挂载
                    // 存名与标签用 blockMenuName:图片行在缩放图模式下行名为空
                    const menuName = blockMenuName(row.blockId, row.name, row);
                    appendMountItems(menu, async () => {
                        const r = await ensureTargetMountItem(plugin, "block", row.blockId, menuName, row.ownerUid ?? null);
                        if (r?.created) {
                            self._expanded!.add(autoKeyOf(r.item));
                        }
                        return r ? r.item.uid : null;
                    }, `「${menuName}」下`);
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

            // 工具栏:标签筛选 / 搜索 / 新建 / 挂载 / 回收站 / 更多 / 刷新 / 全部收起 / 引用关系
            // 菜单锚定:按注册表按钮的 data 属性找到工具栏上的对应图标,菜单弹在它下方
            const openMenuAtButton = (attr: "action" | "rel-action", value: string, menu: Menu) => {
                const btn = this.element.querySelector(`[data-${attr}="${value}"]`) as HTMLElement | null;
                const r = btn ? btn.getBoundingClientRect() : null;
                menu.open({x: r ? r.left : innerWidth / 2, y: r ? r.bottom + 4 : 80});
            };
            // 工具栏动作统一入口:顶栏按钮与「更多」菜单共用,避免两份实现漂移。
            // 「更多」= 收进去的按钮(hidden)的动态菜单 + 固定的「编辑工具栏」入口。
            const runToolbarAction = (action: string) => {
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
                } else if (action === "drag-mode") {
                    dragMode = !dragMode;
                    const actionEl = this.element.querySelector('[data-action="drag-mode"]') as HTMLElement | null;
                    actionEl?.classList.toggle("syfe-mtree__icon--on", dragMode);
                    showMessage(dragMode ? "拖拽模式已开启:拖动挂载项/自动挂载项调整顺序(同层内),再点一次图标关闭" : "拖拽模式已关闭", 2500, "info");
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
                } else if (action === "locate-mount") {
                    void locateActiveInMountTree();
                } else if (action === "new-file") {
                    void newFileInCurrentDir();
                } else if (action === "new-folder") {
                    void newFolderInCurrentDir();
                } else if (action === "mount-menu") {
                    // 挂载入口子菜单(顶栏按钮或「更多」菜单项点开均可),锚在触发按钮下方
                    const m = new Menu();
                    for (const it of mountMenuItems(null, "")) m.addItem(it as any);
                    openMenuAtButton("action", "mount-menu", m);
                } else if (action === "trash") {
                    openTrashDialog(plugin as any);
                } else if (action === "reload-tags") {
                    renderChips();
                    render();
                } else if (action === "more") {
                    // 「更多」= 编辑工具栏里开关关掉的按钮(收进来的),按顶栏同序渲染;
                    // 末尾固定「编辑工具栏…」入口(它不能被配置走,否则没法再打开配置)
                    const m = new Menu();
                    const hidden = new Set(toolbarCfg.hidden.filter(k => k !== TOOLBAR_FIXED));
                    for (const k of resolvedOrder(toolbarCfg)) {
                        if (k === TOOLBAR_FIXED || !hidden.has(k)) continue;
                        const b = byKey(k)!;
                        m.addItem({
                            icon: b.icon,
                            label: b.label,
                            click: () => {
                                if (b.attr === "rel-action") runRelationAction(b.value);
                                else runToolbarAction(b.value);
                            },
                        });
                    }
                    m.addSeparator();
                    m.addItem({
                        icon: "iconSettings",
                        label: "编辑工具栏…",
                        click: () => void openToolbarEditor(),
                    });
                    openMenuAtButton("action", "more", m);
                } else if (action === "refresh") {
                    self._cache = new Map<string, DirEntry[] | BlockNode[]>();
                    render();
                    // 顺带把"已在编辑器里打开、但外部被改过"的文件同步一次:
                    // 外部改动不会触发 syfe:files-changed(那是插件自己的操作才派发),
                    // 不处理的话刷新也只刷树,编辑器里还是旧内容。
                    void syncOpenEditors(plugin);
                }
                // 注:原工具栏「清空」按钮已移除(挂载项逐个取消挂载即可);空白处右键仍有挂载入口
            };
            const actionHandler = (e: MouseEvent) => {
                const actionEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
                if (!actionEl) return;
                // 「更多」/「挂载」分支会同步弹出菜单;若让 click 继续冒泡到 window,
                // 思源的全局点击处理器(globalClickHideMenu)会因为"点击目标不在菜单内"
                // 把刚弹出的菜单立刻关掉 —— 表现就是图标点不开。
                // 思源原生同类按钮(如大纲的展开级别菜单)也是弹出后 stopPropagation。
                const act = actionEl.dataset.action || "";
                if (act === "more" || act === "mount-menu") e.stopPropagation();
                runToolbarAction(act);
            };
            this._actionHandler = actionHandler;
            const toolbarEl = this.element.querySelector(".syfe-mtree__toolbar") as HTMLElement;
            toolbarEl.addEventListener("click", actionHandler);

            // ===== 顶栏按钮渲染(配置驱动)=====
            // 同步先按默认顺序画一遍(面板打开立即可用),配置异步读回来再校正
            let toolbarCfg: TreeToolbarCfg = {order: [], hidden: [...MENU_ONLY_DEFAULTS], ver: TOOLBAR_CFG_VERSION};
            const renderToolbar = () => {
                const order = resolvedOrder(toolbarCfg);
                const hidden = new Set(toolbarCfg.hidden.filter(k => k !== TOOLBAR_FIXED));
                const visible = order.filter(k => !hidden.has(k));
                // 首尾按钮打 auto-margin 标记:按钮组在放得下时居中,
                // 溢出时 auto margin 自动归零,横向滚动仍从左起(标准 flex 居中方案)
                const first = visible[0];
                const last = visible[visible.length - 1];
                toolbarEl.innerHTML = visible
                    .map(k => {
                        const b = byKey(k)!;
                        const edge = k === first ? " syfe-mtree__btn--edge-start" : (k === last ? " syfe-mtree__btn--edge-end" : "");
                        // 拖拽模式的开启态要跟着画(重绘配置后不丢);引用关系按钮始终显示,
                        // 开关关闭时点击给提示(见 runRelationAction)
                        const on = k === "drag-mode" && dragMode ? " syfe-mtree__icon--on" : "";
                        // block__icon--show:思源 3.8.8 起顶栏图标默认 opacity:0、悬停容器才浮现,
                        // 加官方常显修饰类让按钮始终可见
                        return `<span class="block__icon block__icon--show ariaLabel${edge}${on}" data-${b.attr}="${b.value}" aria-label="${b.label}" data-position="north"><svg><use xlink:href="#${b.icon}"></use></svg></span>`;
                    })
                    .join("");
            };
            renderToolbar();
            void loadBlockDisplayModes(plugin as any);
            void loadToolbarCfg(plugin as any).then((cfg) => {
                toolbarCfg = cfg;
                renderToolbar();
            });
            // 悬停滚轮转横向滚动(复用面包屑同款;工具栏从左往右看,不自动滚到最右)
            enableCrumbScroll(toolbarEl, {toEnd: false});
            const persistToolbar = async () => {
                await saveToolbarCfg(plugin as any, toolbarCfg);
                renderToolbar();
            };

            // ===== 编辑工具栏面板:勾选显示 + ↑↓ 排序,改动即时生效并持久化 =====
            const openToolbarEditor = () => {
                const dlg = new Dialog({
                    title: "编辑工具栏",
                    width: "460px",
                    content: `<div class="syfe-tbedit">
                        <div class="syfe-tbedit__hint">开关开 = 显示在顶栏(不进「更多」);开关关 = 收进「更多」菜单(不占顶栏)。拖动行(或 ↑↓)调整顺序,「更多」菜单里的按钮同样按此配置;「更多」本身固定在顶栏。改动即时生效。</div>
                        <div class="syfe-tbedit__rows"></div>
                        <div class="syfe-tbedit__bar">
                            <button class="b3-button b3-button--text" data-act="reset">恢复默认</button>
                            <span class="fn__flex-1"></span>
                            <button class="b3-button b3-button--cancel" data-act="close">完成</button>
                        </div>
                    </div>`,
                });
                const rowsEl = dlg.element.querySelector(".syfe-tbedit__rows") as HTMLElement;
                const draw = () => {
                    const order = resolvedOrder(toolbarCfg);
                    const hidden = new Set(toolbarCfg.hidden);
                    rowsEl.innerHTML = order.map((k, i) => {
                        const b = byKey(k)!;
                        const fixed = k === TOOLBAR_FIXED;
                        const check = fixed
                            ? `<input type="checkbox" class="b3-switch" disabled checked title="编辑入口,固定在顶栏">`
                            : `<input type="checkbox" class="b3-switch" data-act="toggle" title="开 = 顶栏;关 = 收进「更多」" ${hidden.has(k) ? "" : "checked"}>`;
                        return `<div class="syfe-tbedit__row" data-key="${k}" draggable="true">
                            ${check}
                            <svg class="syfe-tbedit__icon"><use xlink:href="#${b.icon}"></use></svg>
                            <span class="syfe-tbedit__label">${b.label}${b.attr === "rel-action" ? ' <span class="syfe-tbedit__tag">引用关系</span>' : ""}</span>
                            <span class="fn__flex-1"></span>
                            <button class="b3-button b3-button--icon" data-act="up" ${i === 0 ? "disabled" : ""} title="上移"><svg><use xlink:href="#iconUp"></use></svg></button>
                            <button class="b3-button b3-button--icon" data-act="down" ${i === order.length - 1 ? "disabled" : ""} title="下移"><svg><use xlink:href="#iconDown"></use></svg></button>
                        </div>`;
                    }).join("");
                };
                const commit = () => {
                    toolbarCfg.order = resolvedOrder(toolbarCfg);
                    toolbarCfg.hidden = [...hiddenSet()];
                    void persistToolbar();
                    draw();
                };
                const hiddenSet = () => new Set(toolbarCfg.hidden.filter(k => k !== TOOLBAR_FIXED));

                // 拖动排序:HTML5 DnD。dragover 只做视觉指示不重绘(重绘会掐断拖拽源),
                // drop 时按落点前/后半行插入,commit + 重绘
                let dragKey: string | null = null;
                const clearDragover = () => {
                    rowsEl.querySelectorAll(".syfe-tbedit__row").forEach(r => {
                        r.classList.remove("syfe-tbedit__row--dragover-before", "syfe-tbedit__row--dragover-after");
                    });
                };
                rowsEl.addEventListener("dragstart", (e) => {
                    const row = (e.target as HTMLElement).closest(".syfe-tbedit__row") as HTMLElement | null;
                    if (!row) return;
                    dragKey = row.dataset.key || null;
                    row.classList.add("syfe-tbedit__row--dragging");
                    try {
                        e.dataTransfer!.effectAllowed = "move";
                        e.dataTransfer!.setData("text/plain", dragKey || "");
                    } catch {
                        // 合成事件可能没有 dataTransfer 内容,不影响本地排序
                    }
                });
                rowsEl.addEventListener("dragover", (e) => {
                    if (!dragKey) return;
                    const row = (e.target as HTMLElement).closest(".syfe-tbedit__row") as HTMLElement | null;
                    if (!row || row.dataset.key === dragKey) return;
                    e.preventDefault();
                    e.dataTransfer!.dropEffect = "move";
                    const r = row.getBoundingClientRect();
                    const before = e.clientY < r.top + r.height / 2;
                    clearDragover();
                    row.classList.add(before ? "syfe-tbedit__row--dragover-before" : "syfe-tbedit__row--dragover-after");
                });
                rowsEl.addEventListener("drop", (e) => {
                    if (!dragKey) return;
                    const row = (e.target as HTMLElement).closest(".syfe-tbedit__row") as HTMLElement | null;
                    if (!row) return;
                    e.preventDefault();
                    const targetKey = row.dataset.key || "";
                    clearDragover();
                    if (targetKey && targetKey !== dragKey) {
                        const r = row.getBoundingClientRect();
                        const before = e.clientY < r.top + r.height / 2;
                        const order = resolvedOrder(toolbarCfg);
                        order.splice(order.indexOf(dragKey), 1);
                        let to = order.indexOf(targetKey);
                        if (!before) to += 1;
                        order.splice(to, 0, dragKey);
                        toolbarCfg.order = order;
                        commit();
                    }
                    dragKey = null;
                });
                rowsEl.addEventListener("dragend", () => {
                    dragKey = null;
                    clearDragover();
                    rowsEl.querySelectorAll(".syfe-tbedit__row--dragging").forEach(r => r.classList.remove("syfe-tbedit__row--dragging"));
                });

                rowsEl.addEventListener("click", (e) => {
                    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
                    const row = (e.target as HTMLElement).closest(".syfe-tbedit__row") as HTMLElement | null;
                    if (!btn || !row) return;
                    const act = btn.dataset.act;
                    const key = row.dataset.key || "";
                    const order = resolvedOrder(toolbarCfg);
                    const i = order.indexOf(key);
                    if (act === "up" && i > 0) {
                        order.splice(i, 1);
                        order.splice(i - 1, 0, key);
                        toolbarCfg.order = order;
                    } else if (act === "down" && i >= 0 && i < order.length - 1) {
                        order.splice(i, 1);
                        order.splice(i + 1, 0, key);
                        toolbarCfg.order = order;
                    } else {
                        return;
                    }
                    commit();
                });
                rowsEl.addEventListener("change", (e) => {
                    const input = e.target as HTMLInputElement;
                    if (!input || input.dataset.act !== "toggle") return;
                    const row = input.closest(".syfe-tbedit__row") as HTMLElement | null;
                    const key = row?.dataset.key || "";
                    if (!key || key === TOOLBAR_FIXED) return;
                    const hidden = hiddenSet();
                    if (input.checked) hidden.delete(key);
                    else hidden.add(key);
                    toolbarCfg.hidden = [...hidden];
                    commit();
                });
                dlg.element.addEventListener("click", (e) => {
                    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
                    if (!btn) return;
                    if (btn.dataset.act === "close") dlg.destroy();
                    else if (btn.dataset.act === "reset") {
                        toolbarCfg = {order: [], hidden: [...MENU_ONLY_DEFAULTS], ver: TOOLBAR_CFG_VERSION};
                        void persistToolbar();
                        draw();
                    }
                });
                draw();
            };
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

            // 顶栏改为横向滚动后,原「窄面板折叠进更多」逻辑已移除(不再按宽度藏按钮)

            // 挂载结构变化(任意入口挂载/取消)时自动重绘。
            // 关系树的根就是挂载的思源文档,所以挂载一变,根集合也变了,必须重建(不只是重绘):
            // 挂载结构先画出来(不等 SQL),关系树随后静默重建、完成后补渲染一次
            const changedHandler = () => {
                render();
                if (relationEnabled()) ensureRelationTree(true);
            };
            this._changedHandler = changedHandler;
            window.addEventListener(MOUNT_TREE_CHANGED_EVENT, changedHandler);

            // 文件系统/文档结构变动(来自 refreshFileTrees;switch-protyle 切文档防抖后也会派发)
            // → 静默刷新已展开的子项列表:数据有变化才重绘;数据没变但"当前文档"高亮变了
            //   也补一次轻量重绘(内容不变、无加载帧,不闪)。
            // 不再清空全部缓存全量重绘 —— 否则每次切文档整棵树回退"加载中"再重载,
            // 看起来就是面板时不时闪烁。手动刷新按钮仍是全量清缓存重绘。
            let lastHighlightKey: string | null = null;
            const filesChangedHandler = () => {
                void silentRefreshExpanded().then((changed) => {
                    const hk = (currentDocRootId() || "") + "|" + (currentFilePath() || "");
                    const highlightMoved = lastHighlightKey !== null && hk !== lastHighlightKey;
                    lastHighlightKey = hk;
                    if (changed || highlightMoved) render();
                });
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
                    // 不重置 relationLoaded:ensureRelationTree(true) 会保留旧树静默重建
                    // (置 false 会让重建期间整树回退"加载中"再重载,即闪烁)
                    ensureRelationTree(true);
                }, 1500);
            };
            this._relationRebuildHandler = relationRebuildHandler;
            window.addEventListener("syfe:files-changed", relationRebuildHandler);

            // 首次渲染:开关开启时建关系树(懒加载,只查一次)
            ensureRelationTree();
            render();

            // ===== 拖拽排序事件:自动挂载行(挂在滚动容器上,与行点击委托同一套模式)=====
            const autoDragStart = (e: DragEvent) => {
                if (!dragMode) return;
                if (filterOn) return;
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--auto") as HTMLElement | null;
                const docId = el?.dataset.relDoc;
                const parent = el?.dataset.autoParent;
                if (!el || !docId || !parent) return;
                dragAutoParent = parent;
                dragAutoDocId = docId;
                el.classList.add("syfe-mtree__row--dragging");
                try {
                    e.dataTransfer?.setData("text/plain", docId);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                } catch {
                    // ignore
                }
            };
            const autoDragOver = (e: DragEvent) => {
                if (!dragAutoDocId) return;
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--auto") as HTMLElement | null;
                const docId = el?.dataset.relDoc;
                if (!el || !docId || docId === dragAutoDocId) return;
                // 只有同一父文档下的自动挂载行能排
                if (el.dataset.autoParent !== dragAutoParent) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                const rect = el.getBoundingClientRect();
                const pos: "before" | "after" = (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
                if (dragAutoOverDocId !== docId || dragAutoPos !== pos) {
                    dragAutoOverDocId = docId;
                    dragAutoPos = pos;
                    clearMountDragMarks();
                    el.classList.add(dragAutoPos === "before"
                        ? "syfe-mtree__row--dragover-before"
                        : "syfe-mtree__row--dragover-after");
                }
            };
            const autoDrop = (e: DragEvent) => {
                const parent = dragAutoParent;
                const src = dragAutoDocId;
                const dst = dragAutoOverDocId;
                const pos = dragAutoPos;
                dragAutoParent = null;
                dragAutoDocId = null;
                dragAutoOverDocId = null;
                clearMountDragMarks();
                if (!parent || !src || !dst || src === dst) return;
                e.preventDefault();
                // 兄弟顺序 = 当前展示顺序(从 DOM 收集,含已应用的 customOrder)
                const siblingIds = Array.from(
                    listEl.querySelectorAll(`.syfe-mtree__row--auto[data-auto-parent="${CSS.escape(parent)}"]`),
                ).map(el => (el as HTMLElement).dataset.relDoc || "").filter(Boolean);
                void reorderAutoChildren(parent, siblingIds, src, dst, pos).then(() => render());
            };
            const autoDragEnd = () => {
                dragAutoParent = null;
                dragAutoDocId = null;
                dragAutoOverDocId = null;
                clearMountDragMarks();
                listEl.querySelectorAll(".syfe-mtree__row--dragging").forEach((el) => {
                    el.classList.remove("syfe-mtree__row--dragging");
                });
            };

            // ===== 拖拽排序事件:挂载项 =====
            const mountDragStart = (e: DragEvent) => {
                // 未开启拖拽模式:一律不可拖(与 draggable 属性双保险)
                if (!dragMode) return;
                // 标签筛选时行与行之间夹着被过滤掉的兄弟,重排结果不直观 → 不允许拖
                if (filterOn) return;
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--mount") as HTMLElement | null;
                const uid = el?.dataset.mountUid;
                if (!el || !uid) return;
                dragMountUid = uid;
                el.classList.add("syfe-mtree__row--dragging");
                try {
                    e.dataTransfer?.setData("text/plain", uid);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                } catch {
                    // ignore
                }
            };
            const mountDragOver = (e: DragEvent) => {
                if (!dragMountUid) return;
                const el = (e.target as HTMLElement).closest(".syfe-mtree__row--mount") as HTMLElement | null;
                const uid = el?.dataset.mountUid;
                if (!el || !uid || uid === dragMountUid) return;
                // 只有同一父节点下的兄弟能排;不同父直接放过(不改光标也不画指示线)
                if (getParentUid(dragMountUid) !== getParentUid(uid)) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                // 上半 → 插到它之前;下半 → 插到它之后
                const rect = el.getBoundingClientRect();
                const pos: "before" | "after" = (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
                if (dragOverMountUid !== uid || dragOverPos !== pos) {
                    dragOverMountUid = uid;
                    dragOverPos = pos;
                    renderMountDragOver();
                }
            };
            const mountDrop = (e: DragEvent) => {
                const src = dragMountUid;
                const dst = dragOverMountUid;
                const pos = dragOverPos;
                dragMountUid = null;
                dragOverMountUid = null;
                clearMountDragMarks();
                if (!src || !dst || src === dst) return;
                e.preventDefault();
                void reorderMountItem(src, dst, pos).then(() => render());
            };
            const mountDragEnd = () => {
                dragMountUid = null;
                dragOverMountUid = null;
                clearMountDragMarks();
                listEl.querySelectorAll(".syfe-mtree__row--dragging").forEach((el) => {
                    el.classList.remove("syfe-mtree__row--dragging");
                });
            };
            // destroy() 里按同样的表反注册,避免重复粘监听(手动挂载行 + 自动挂载行)
            this._mountDragHandlers = [
                ["dragstart", mountDragStart as (e: Event) => void],
                ["dragover", mountDragOver as (e: Event) => void],
                ["drop", mountDrop as (e: Event) => void],
                ["dragend", mountDragEnd as (e: Event) => void],
                ["dragstart", autoDragStart as (e: Event) => void],
                ["dragover", autoDragOver as (e: Event) => void],
                ["drop", autoDrop as (e: Event) => void],
                ["dragend", autoDragEnd as (e: Event) => void],
            ];
            for (const [evt, fn] of this._mountDragHandlers) {
                scrollEl.addEventListener(evt, fn);
            }
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
            if (this._scrollEl && this._mountDragHandlers) {
                for (const [evt, fn] of this._mountDragHandlers) {
                    this._scrollEl.removeEventListener(evt, fn);
                }
            }
            this._mountDragHandlers = undefined;
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
            this._blockMeta = undefined;
        },
    };
}
