import {DOCK_TYPE, WORKSPACE_ROOT} from "../constants";
import {
    renderTree,
    toggleFolder,
    showFileTreeMenu,
    collapseAll,
    createNewFile,
    createNewFolder,
    promptDialog,
    IFileTreeActions,
} from "../components/file-tree";

// 文件树 Dock 所需的插件接口
export interface IPluginForDock {
    app: any;
    name: string;
    openFile(path: string): void;
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
        init(this: FileTreeDockInstance) {
            // 优先使用插件配置中的根目录,其次使用 data.rootPath,最后回退到默认值
            this._rootPath = plugin.getFileTreeRoot() || this.data?.rootPath || WORKSPACE_ROOT;
            this._actions = {
                openFile: (path: string) => plugin.openFile(path),
                openSearch: (rp?: string) => plugin.openSearch(rp),
                openTerminal: (cwd: string) => plugin.openTerminal(cwd),
            };

            this.element.classList.add("syfe-file-tree-dock", "fn__flex-column");
            this.element.innerHTML = `
                <div class="block__icons syfe-tree__toolbar">
                    <div class="block__logo">
                        <svg class="block__logoicon"><use xlink:href="#iconFolder"></use></svg>
                        <span class="block__logotext">文件</span>
                    </div>
                    <span class="fn__flex-1 fn__space"></span>
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
                </div>
                <div class="syfe-tree__path" data-action="change-root" title="点击切换根目录">${escapeHTML(this._rootPath)}</div>
                <div class="fn__flex-1 syfe-tree__scroll">
                    <ul class="syfe-tree__root" data-path="${escapeHTML(this._rootPath)}"></ul>
                </div>`;

            const rootEl = this.element.querySelector(".syfe-tree__root") as HTMLElement;
            this._rootEl = rootEl;
            const pathLabel = this.element.querySelector(".syfe-tree__path") as HTMLElement;
            const self = this;

            // 切换根目录:弹出输入框,保存到配置并重新渲染
            const changeRoot = async () => {
                const newPath = await promptDialog("切换根目录", self._rootPath || "/data");
                if (!newPath) return;
                self._rootPath = newPath;
                rootEl.dataset.path = newPath;
                pathLabel.textContent = newPath;
                // 保存到配置,下次打开 Dock 时生效
                plugin.setFileTreeRoot(newPath);
                renderTree(rootEl, newPath);
            };

            // 渲染根目录
            renderTree(rootEl, this._rootPath);

            // 点击事件(委托)
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // 工具栏按钮
                const actionEl = target.closest("[data-action]") as HTMLElement;
                if (actionEl) {
                    const action = actionEl.dataset.action;
                    const currentRoot = self._rootPath!;
                    switch (action) {
                        case "change-root":
                            changeRoot();
                            break;
                        case "refresh":
                            renderTree(rootEl, currentRoot);
                            break;
                        case "collapse":
                            collapseAll(rootEl);
                            break;
                        case "search":
                            plugin.openSearch(currentRoot);
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
                    toggleFolder(li);
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
                showFileTreeMenu(e, path, isDir, rootEl, self._rootPath!, self._actions!);
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
            if (this._contextHandler) {
                this.element.removeEventListener("contextmenu", this._contextHandler);
            }
            this._rootEl = undefined;
            this._actions = undefined;
            this._clickHandler = undefined;
            this._contextHandler = undefined;
        },
    };
}
