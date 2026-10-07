import {DOCK_TYPE, WORKSPACE_ROOT} from "../constants";
import {showMessage} from "siyuan";
import {
    renderTree,
    toggleFolder,
    showFileTreeMenu,
    collapseAll,
    createNewFile,
    createNewFolder,
    promptDialog,
    syncDirToggleInParent,
    IFileTreeActions,
    setTagFilter,
    computeTagFilterAllowed,
    getTagFilter,
    refreshPath,
} from "../components/file-tree";
import {isExternalPath, normalizePath, dirname, basename} from "../utils/path";
import {nativeIsDirectory, isNativeFsAvailable} from "../api/native-fs";
import {openTagMenu, tagIconHTML} from "../tags/tag-ui";
import {sortTagsTree, tagDepth, tagFullName} from "../tags/tag-store";
import {
    addMount,
    removeMount,
} from "../utils/virtual-tree";
import {isBaiduPath, baiduRootLabel} from "../utils/baidu-path";
import {openBaiduPanDialog} from "../components/baidu-pan-dialog";
import {clearBaiduListCache} from "../api/baidu-pan";

// 文件树 Dock 所需的插件接口
export interface IPluginForDock {
    app: any;
    name: string;
    openFile(path: string): void;
    openImage(path: string): void;
    openOffice(path: string): void;
    openMedia(path: string): void;
    openMarkdown(path: string, mode?: "live" | "source" | "reading"): void;
    openSearch(rootPath?: string): void;
    openTerminal(cwd: string): void;
    getFileTreeRoot(): string;
    setFileTreeRoot(path: string): void;
}

// Dock 实例上附加的字段
interface FileTreeDockInstance {
    element: HTMLElement;
    data: { rootPath?: string };
    _rootEl?: HTMLElement;
    _rootPath?: string;
    _actions?: IFileTreeActions;
    _clickHandler?: (e: MouseEvent) => void;
    _dblclickHandler?: (e: MouseEvent) => void;
    _contextHandler?: (e: MouseEvent) => void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createFileTreeDockConfig(plugin: IPluginForDock) {
    return {
        type: DOCK_TYPE,
        config: {
            position: "LeftBottom" as const,
            size: {width: 240, height: 0},
            icon: "iconFolder",
            title: "文件",
            hotkey: "",
            show: true,
        },
        data: {},
        async init(this: FileTreeDockInstance) {
            // 优先使用插件配置中的根目录,其次使用 data.rootPath,最后回退到默认值
            this._rootPath = plugin.getFileTreeRoot() || this.data?.rootPath || WORKSPACE_ROOT;
            this._actions = {
                plugin: plugin as any,
                openFile: (path: string) => plugin.openFile(path),
                openImage: (path: string) => plugin.openImage(path),
                openOffice: (path: string) => plugin.openOffice(path),
                openMedia: (path: string) => plugin.openMedia(path),
                openMarkdown: (path: string, mode?: "live" | "source" | "reading") => plugin.openMarkdown(path, mode),
                openSearch: (rp?: string) => plugin.openSearch(rp),
                openTerminal: (cwd: string) => plugin.openTerminal(cwd),
                openFileSplit: (path: string, position: "right" | "bottom") => (plugin as any).openFileSplit(path, position),
                // 新标签页:固定/收藏切换(数据存 start-page.json)
                togglePin: (path: string) => (plugin as any).togglePin(path),
                toggleFavorite: (path: string) => (plugin as any).toggleFavorite(path),
                // 挂载/取消挂载百度网盘(文件树右键)
                unmountDoc: (parentDir: string, vPath: string) => unmountDocFrom(parentDir, vPath),
                manageTags: (path: string, ev: MouseEvent, onChanged?: () => void) => {
                    void openTagMenu(plugin as any, path, ev, () => {
                        // 标签变更后重绘:先刷新父目录,筛选生效时也要重算
                        void refreshPath(rootEl, dirname(path), self._rootPath!);
                        onChanged?.();
                    });
                },
            };

            this.element.classList.add("syfe-file-tree-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-tree__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconFolder"></use></svg>
                        <span class="block__logotext">文件</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
                    <span class="block__icon ariaLabel" data-action="mount-bdpan" aria-label="挂载百度网盘" data-position="north">
                        <svg><use xlink:href="#iconCloud"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="change-root" aria-label="切换根目录" data-position="north">
                        <svg><use xlink:href="#iconFolder"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="new-file" aria-label="新建文件" data-position="north">
                        <svg><use xlink:href="#iconFile"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="new-folder" aria-label="新建文件夹" data-position="north">
                        <svg><use xlink:href="#iconFolder"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="refresh" aria-label="刷新" data-position="north">
                        <svg><use xlink:href="#iconRefresh"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="collapse" aria-label="全部折叠" data-position="north">
                        <svg><use xlink:href="#iconContract"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="search" aria-label="搜索" data-position="north">
                        <svg><use xlink:href="#iconSearch"></use></svg>
                    </span>
                    <span class="block__icon ariaLabel" data-action="tag-filter" aria-label="按标签筛选" data-position="north">
                        <svg><use xlink:href="#iconTags"></use></svg>
                    </span>
                </div>
                <div class="syfe-tree__path" data-action="change-root" title="点击切换根目录">${escapeHTML(this._rootPath)}</div>
                <div class="syfe-tree__tagfilter" style="display:none;">
                    <div class="syfe-tree__tagchips"></div>
                    <span class="syfe-tree__tagclear" title="清除筛选">清除</span>
                </div>
                <div class="fn__flex-1 syfe-tree__scroll">
                    <ul class="syfe-tree__root" data-path="${escapeHTML(this._rootPath)}"></ul>
                </div>`;

            const rootEl = this.element.querySelector(".syfe-tree__root") as HTMLElement;
            this._rootEl = rootEl;
            const pathLabel = this.element.querySelector(".syfe-tree__path") as HTMLElement;
            const tagFilterEl = this.element.querySelector(".syfe-tree__tagfilter") as HTMLElement;
            const chipsEl = this.element.querySelector(".syfe-tree__tagchips") as HTMLElement;
            const clearEl = this.element.querySelector(".syfe-tree__tagclear") as HTMLElement;
            const self = this;
            // 当前选中的筛选标签 id;anyMode=只筛"打过任意标签"的条目
            let selected: string[] = [];
            let anyMode = false;

            // 渲染标签筛选条(嵌套标签缩进)
            const renderChips = () => {
                const tags = sortTagsTree();
                const allOn = anyMode ? " syfe-tree__chip--on" : "";
                const head = `<span class="syfe-tree__chip syfe-tree__chip--all${allOn}" data-all="1" title="不指定标签,筛出所有打过标签的条目">全部已打标签</span>`;
                if (tags.length === 0) {
                    chipsEl.innerHTML = head + `<span class="syfe-tree__tagempty">暂无标签,右键文件可新建</span>`;
                    return;
                }
                chipsEl.innerHTML = head + tags.map(t => {
                    const on = !anyMode && selected.includes(t.id);
                    const pad = tagDepth(t.id) * 10;
                    return `<span class="syfe-tree__chip${on ? " syfe-tree__chip--on" : ""}" data-id="${escapeHTML(t.id)}" style="margin-left:${pad}px" title="${escapeHTML(tagFullName(t.id))}">${tagIconHTML(t)}<span class="syfe-tree__chip-text">${escapeHTML(t.name)}</span></span>`;
                }).join("");
            };

            // 应用筛选:递归算出允许显示的路径集合后重绘
            const applyFilter = async () => {
                if (!anyMode && selected.length === 0) {
                    setTagFilter(null, null);
                    tagFilterEl.style.display = "none";
                    await renderTree(rootEl, self._rootPath!);
                    return;
                }
                tagFilterEl.style.display = "";
                const allowed = await computeTagFilterAllowed(self._rootPath!, selected, anyMode);
                setTagFilter(selected, allowed, anyMode);
                await renderTree(rootEl, self._rootPath!);
            };

            // 切换筛选条显示
            const toggleFilterBar = async () => {
                if (tagFilterEl.style.display === "none") {
                    selected = Array.from(getTagFilter() || []).length ? selected : [];
                    renderChips();
                    tagFilterEl.style.display = "";
                } else {
                    tagFilterEl.style.display = "none";
                    selected = [];
                    anyMode = false;
                    await applyFilter();
                }
            };

            // 点击标签 chip:多选切换(同一层多选为"或"关系,选中父标签含其子标签)
            chipsEl.addEventListener("click", (ev) => {
                const chip = (ev.target as HTMLElement).closest(".syfe-tree__chip") as HTMLElement | null;
                if (!chip) return;
                if (chip.dataset.all === "1") {
                    // "全部已打标签"与具体标签互斥
                    anyMode = !anyMode;
                    if (anyMode) selected = [];
                } else {
                    anyMode = false;
                    const id = chip.dataset.id!;
                    const idx = selected.indexOf(id);
                    if (idx >= 0) selected.splice(idx, 1);
                    else selected.push(id);
                }
                renderChips();
                void applyFilter();
            });

            clearEl.addEventListener("click", () => {
                selected = [];
                anyMode = false;
                renderChips();
                void applyFilter();
            });

            // 应用新根目录(保存配置 + 更新 UI + 渲染)
            const applyRoot = (newPath: string) => {
                self._rootPath = newPath;
                rootEl.dataset.path = newPath;
                if (isBaiduPath(newPath)) {
                    pathLabel.textContent = baiduRootLabel(newPath);
                } else {
                    pathLabel.textContent = newPath;
                }
                plugin.setFileTreeRoot(newPath);
                renderTree(rootEl, newPath);
            };

            // 取消挂载:移除某真实目录下的百度网盘挂载记录并刷新
            const unmountDocFrom = (parentDir: string, vPath: string) => {
                void (async () => {
                    const removed = await removeMount(parentDir, vPath);
                    if (!removed) return;
                    await refreshPath(rootEl, parentDir, self._rootPath!);
                    await syncDirToggleInParent(rootEl, parentDir, self._rootPath!);
                    showMessage("已取消挂载", 2000, "info");
                })();
            };

            // 把百度网盘目录挂载到指定真实目录下(与该目录下的真实文件并存,持久化保存)
            const mountBdPanInto = (dir: string) => {
                openBaiduPanDialog({
                    title: `挂载百度网盘到「${basename(dir) || dir}」`,
                    onPicked: (vPath, label) => {
                        void (async () => {
                            await addMount(dir, vPath, label);
                            await refreshPath(rootEl, dir, self._rootPath!);
                            await syncDirToggleInParent(rootEl, dir, self._rootPath!);
                            showMessage(`已挂载「${label}」;单击展开目录,双击/单击文件打开`, 3500, "info");
                        })();
                    },
                });
            };

            // 切换根目录:弹出输入框(支持 bdpan:// 虚拟路径),校验后保存到配置并重新渲染
            const changeRoot = async () => {
                const input = await promptDialog("切换根目录(/data、系统路径 或 bdpan:// 网盘路径)", self._rootPath || "/data");
                if (!input) return;
                const trimmed = input.trim();
                // 百度网盘虚拟路径:无需本地目录校验
                if (isBaiduPath(trimmed)) {
                    applyRoot(trimmed);
                    return;
                }
                const newPath = normalizePath(input);
                // 工作空间外的系统绝对路径(如 E:\HOME\BaiduSyncdisk)需要原生 fs 支持
                if (isExternalPath(newPath)) {
                    if (!isNativeFsAvailable()) {
                        showMessage("当前环境不支持访问工作空间外的文件,请使用思源桌面端", -1);
                        return;
                    }
                    let isDir = false;
                    try {
                        isDir = await nativeIsDirectory(newPath);
                    } catch {
                        isDir = false;
                    }
                    if (!isDir) {
                        showMessage(`路径不存在或不是目录: ${newPath}`, -1);
                        return;
                    }
                }
                applyRoot(newPath);
            };

            // 渲染根目录(外部路径先校验可达性,不可用时回退到工作空间;虚拟根显示友好名)
            if (isExternalPath(this._rootPath)) {
                if (!isNativeFsAvailable()) {
                    showMessage("当前环境不支持访问工作空间外的文件,已回退到思源工作空间", -1);
                    this._rootPath = WORKSPACE_ROOT;
                } else if (!(await nativeIsDirectory(this._rootPath))) {
                    showMessage(`已保存的根目录不存在或不是目录,已回退到思源工作空间: ${this._rootPath}`, -1);
                    this._rootPath = WORKSPACE_ROOT;
                }
                rootEl.dataset.path = this._rootPath;
                pathLabel.textContent = this._rootPath;
            } else if (isBaiduPath(this._rootPath)) {
                pathLabel.textContent = baiduRootLabel(this._rootPath);
            }
            renderTree(rootEl, this._rootPath);

            // 点击事件(委托)
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // 工具栏按钮
                const actionEl = target.closest("[data-action]") as HTMLElement;
                if (actionEl) {
                const action = actionEl.dataset.action;
                const currentRoot = self._rootPath!;
                // 百度网盘根:标签/内容搜索不适用(新建文件/文件夹走网盘接口,可用)
                if (isBaiduPath(currentRoot) && (action === "tag-filter" || action === "search")) {
                    showMessage("百度网盘目录暂不支持标签筛选与内容搜索", 2500, "info");
                    return;
                }
                switch (action) {
                    case "change-root":
                        changeRoot();
                        break;
                    case "mount-bdpan":
                        // 系统路径根目录:挂载到当前根目录下(不替换根);其他根:直接切换到网盘目录
                        if (isExternalPath(currentRoot)) {
                            mountBdPanInto(currentRoot);
                        } else {
                            openBaiduPanDialog({
                                title: "挂载百度网盘",
                                onPicked: (vPath, label) => {
                                    applyRoot(vPath);
                                    showMessage(`已打开「${label}」;右键目录可挂载到其他真实目录下`, 3500, "info");
                                },
                            });
                        }
                        break;
                    case "refresh":
                        clearBaiduListCache();
                        renderTree(rootEl, currentRoot);
                        break;
                        case "collapse":
                            collapseAll(rootEl);
                            break;
                    case "search":
                        plugin.openSearch(currentRoot);
                        break;
                        case "tag-filter":
                            void toggleFilterBar();
                            break;
                        case "new-file":
                            createNewFile(currentRoot, rootEl, currentRoot);
                            break;
                        case "new-folder":
                            createNewFolder(currentRoot, rootEl, currentRoot);
                            break;
                    }
                    return;
                }
                // 树节点点击
                const row = target.closest(".syfe-tree__row") as HTMLElement;
                if (!row) return;
                const li = row.parentElement as HTMLElement;
                if (!li || !li.dataset.path) return;
                const isDir = li.dataset.isDir === "true";
                const path = li.dataset.path!;
                if (isDir) {
                    void toggleFolder(li);
                } else {
                    plugin.openFile(path);
                }
            };
            this.element.addEventListener("click", this._clickHandler);

            // 右键菜单(委托)
            this._contextHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const row = target.closest(".syfe-tree__row") as HTMLElement;
                if (!row) return;
                const li = row.parentElement as HTMLElement;
                if (!li || !li.dataset.path) return;
                e.preventDefault();
                e.stopPropagation();
                const path = li.dataset.path!;
                const isDir = li.dataset.isDir === "true";
                showFileTreeMenu(e, path, isDir, rootEl, self._rootPath!, self._actions!, li);
            };
            this.element.addEventListener("contextmenu", this._contextHandler);
        },
        resize() {
            // 无需特殊处理
        },
        destroy(this: FileTreeDockInstance) {
            if (this._clickHandler) {
                this.element.removeEventListener("click", this._clickHandler);
            }
            if (this._dblclickHandler) {
                this.element.removeEventListener("dblclick", this._dblclickHandler);
            }
            if (this._contextHandler) {
                this.element.removeEventListener("contextmenu", this._contextHandler);
            }
            this._rootEl = undefined;
            this._actions = undefined;
            this._clickHandler = undefined;
            this._dblclickHandler = undefined;
            this._contextHandler = undefined;
        },
    };
}
