import {Plugin, Setting, showMessage} from "siyuan";
import {DOCK_TYPE, WORKSPACE_ROOT, DEFAULT_TERMINAL_SERVER_URL, MOUNT_TREE_DOCK_TYPE} from "./constants";
import {EditorConfig, DEFAULT_CONFIG} from "./types";
import {setupMonaco, applyTheme, getCurrentMode, disposeMonaco} from "./editor/monaco";
import {disposeAll} from "./editor/model-manager";
import {createEditorTabConfig, openFileTab} from "./tabs/editor-tab";
import {createImageTabConfig, openImageTab} from "./tabs/image-tab";
import {createOfficeTabConfig, openOfficeTab} from "./tabs/office-tab";
import {createMarkdownTabConfig, openMarkdownTab, MarkdownMode} from "./tabs/markdown-tab";
import {createMediaTabConfig, openMediaTab} from "./tabs/media-tab";
import {createNotebookTabConfig} from "./tabs/notebook-tab";
import {createStartTabConfig, openStartTab, installNewTabHijack} from "./tabs/start-tab";
import {createTerminalTabConfig, openTerminalTab} from "./tabs/terminal-tab";
import {createFileTreeDockConfig} from "./dock/file-tree-dock";
import {createRecentDockConfig} from "./dock/recent-dock";
import {createTagDockConfig} from "./dock/tag-dock";
import {createSearchTabConfig, openSearchTab} from "./components/search-panel";
import {loadConfig, saveConfig} from "./utils/config";
import {querySQL} from "./api/file";
import {basename} from "./utils/path";
import {loadAllExtensions} from "./extensions/extension-manager";
import {loadTagData} from "./tags/tag-store";
import {openTagManagerDialog} from "./tags/tag-ui";
import {loadOpenWithData} from "./open-with/open-with-store";
import {openOpenWithManagerDialog} from "./open-with/open-with-ui";
import {loadRecents, addRecent, addRecentDoc, flushRecents} from "./recent-files";
import {loadStartPage, itemFromPath, itemFromDoc, toggleInGroup} from "./start-page";
import {isVirtualPath, virtualId, initMountStore, getMountList, dropSyDocMounts} from "./utils/virtual-tree";
import {initBaiduPanStore} from "./api/baidu-pan";
import {openBaiduPanDialog} from "./components/baidu-pan-dialog";
import {registerSlashCommands} from "./protyle/slash-commands";
import {registerLinkReveal} from "./protyle/link-reveal";
import {registerMountMenu} from "./protyle/mount-menu";
import {registerCodeBlockRun, disposeCodeBlockRun} from "./protyle/code-block-run";
import {loadCodeBlockRunData, flushCodeBlockRunData} from "./protyle/code-block-run-store";
import {initMountTree, migrateSyDocMounts, SYFE_RELATION_TREE_CHANGED_EVENT} from "./mount-tree";
import {createMountTreeDockConfig} from "./dock/mount-tree-dock";
import {createTerminalDockConfig} from "./dock/terminal-dock";
import {openExtensionMarket} from "./extensions/market-ui";
import {clearAllGrammars} from "./extensions/grammar-loader";
import {clearAllThemes, applyThemeByPreference, getLoadedThemes} from "./extensions/theme-loader";
import {clearAllSnippets} from "./extensions/snippet-loader";
import {clearAllLsp} from "./extensions/lsp-loader";
import {clearAllIconThemes, getIconThemesWithMissingIcons, getLoadedIconThemes, activateIconThemeByPreference} from "./extensions/icon-theme-loader";
import {registerPythonLsp, disposePythonLsp} from "./utils/python-lsp-bridge";
import {disposePythonKernel} from "./utils/python-kernel";
import {stopPythonLanguageServer} from "./utils/python-lsp";
// vditor 会用自己的 lute 覆写 window.Lute,使思源之后新建的文档编辑器全部失效。
// 必须在任何 vditor 实例被创建之前装好守卫 —— 所以放在顶层 import 里(模块求值顺序)。
import {installLuteGuard} from "./utils/lute-guard";
import {refreshAllExpanded} from "./components/file-tree";
import "./index.scss";

// 守卫必须在插件加载的第一时间生效 —— 早于任何 vditor 实例被创建。
// 放在这里(模块求值期)而不是 onload 里:onload 之后页签才可能已经被打开。
installLuteGuard();

// addTab/addDock 的回调 this 在 siyuan 类型里钉死为 Custom(element: Element),
// 而各 Tab/Dock 的实例接口把 element 收窄成 HTMLElement、再挂一堆自有可选字段
// —— Custom 结构上赋不到它们那边(element 的型变方向相反),但运行时
// openTab/addDock 挂载的正是同一个实例对象,纯类型层冲突。
// 全部 13 个注册点统一走这里收口,as 只出现在这一处。
function asSiyuanCustom<C extends object>(cfg: C): any {
    return cfg;
}

export default class FileEditorPlugin extends Plugin {
    public config: EditorConfig = DEFAULT_CONFIG;
    private themeObserver?: MutationObserver;
    private fontSizeInput?: HTMLInputElement;
    private tabSizeInput?: HTMLInputElement;
    private wordWrapSelect?: HTMLSelectElement;
    private formatOnSaveInput?: HTMLInputElement;
    private searchMaxSizeInput?: HTMLInputElement;
    private fileTreeRootInput?: HTMLInputElement;
    private terminalBackendSelect?: HTMLSelectElement;
    private terminalServerUrlInput?: HTMLInputElement;
    private siyuanWorkspacePathInput?: HTMLInputElement;
    private terminalShellSelect?: HTMLSelectElement;
    private colorThemeSelect?: HTMLSelectElement;
    private iconThemeSelect?: HTMLSelectElement;
    private markdownModeSelect?: HTMLSelectElement;
    private newTabReplacePlusInput?: HTMLInputElement;
    private newTabShowPinnedInput?: HTMLInputElement;
    private newTabShowRecentInput?: HTMLInputElement;
    private newTabShowFavoritesInput?: HTMLInputElement;
    // 导入 md 到思源时,是否在文档顶部插入源文件资源引述块
    private importMdSourceAssetInput?: HTMLInputElement;
    // 侧边栏「文件」面板开关(默认关,功能已由虚拟文档树承接)
    private showFileTreeDockInput?: HTMLInputElement;
    // 引用关系树(移植自 siyuan-virtual-tree)
    private mountTreeRelationEnabledInput?: HTMLInputElement;
    private mountTreeRelationSortSelect?: HTMLSelectElement;
    private mountTreeRelationWeightInput?: HTMLInputElement;
    private mountTreeRelationPhysicalInput?: HTMLInputElement;
    private mountTreeRelationCaseInput?: HTMLInputElement;
    private mountTreeRelationDepthInput?: HTMLInputElement;
    private mountTreeRelationNodesInput?: HTMLInputElement;
    private mountTreeRelationExpandInput?: HTMLInputElement;
    private fileTreeDockAdded = false;

    onload(): void {
        setupMonaco(this.name);

        // 挂上「按需补注册文件面板」的钩子。必须在这里(而不是 addFileTreeDock
        // 内部)挂:面板默认不注册,那条路径在默认配置下根本不会走,
        // 结果新标签页点文件夹时 openFileTab 找不到钩子,只能干等。
        (window as any).__syfeAddFileTreeDock = () => this.addFileTreeDock();

        // 尽早注入插件磁盘目录,供终端的 node-pty 运行时定位预构建二进制
        // (目录 = 工作空间/data/plugins/<插件名>;PTY 检测依赖它,必须先于任何终端调用)
        try {
            const ws = (window as any).siyuan?.config?.system?.workspaceDir;
            if (ws) {
                (window as any).__SIYUAN_FILE_EDITOR_DIR__ = `${ws.replace(/[\\/]+$/, "")}/data/plugins/${this.name}`;
            }
        } catch {
            // ignore
        }

        // Python 语言服务(pyright)。
        // 必须放在 __SIYUAN_FILE_EDITOR_DIR__ 注入之后 —— pyright 入口是靠这个
        // 目录在<插件目录>/pyright/ 下定位的,拿不到就只会静默退回内核静态补全。
        // start() 内部是异步且有超时的,不会拖慢插件加载。
        try {
            registerPythonLsp();
        } catch (e) {
            console.warn("[siyuan-file-editor] Python LSP 注册失败:", e);
        }

        // 注册 Tab 类型
        this.addTab(asSiyuanCustom(createEditorTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createImageTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createOfficeTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createMarkdownTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createMediaTabConfig(this as any)));
        // Jupyter Notebook(.ipynb)查看与编辑
        this.addTab(asSiyuanCustom(createNotebookTabConfig(this as any)));
        // 新标签页(接管顶部「+」后打开的启动台:搜索 + 固定 + 最近打开 + 收藏)
        this.addTab(asSiyuanCustom(createStartTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createSearchTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createTerminalTabConfig(this as any)));

        // 注册 Dock
        // 注:「文件」面板默认**不注册**(能力已由「虚拟文档树」面板承接);
        // 若用户在设置里打开 showFileTreeDock,会在 onLayoutReady 补注册(见下)。
        // 侧边栏「最近使用」面板(展示最近打开的文件,点击打开/右键复制链接)
        this.addDock(asSiyuanCustom(createRecentDockConfig(this as any)));
        // 侧边栏「标签」面板(按标签聚合文件/文件夹,文件夹可就地逐级展开)
        this.addDock(asSiyuanCustom(createTagDockConfig(this as any)));
        // 侧边栏「虚拟文档树」面板(初始为空,挂载文件/文件夹/思源文档/思源块,支持嵌套)
        this.addDock(asSiyuanCustom(createMountTreeDockConfig(this as any)));
        // 侧边栏「终端」面板(复用终端 Tab 的 xterm 实现,常驻底部,与终端 Tab 互相独立)
        this.addDock(asSiyuanCustom(createTerminalDockConfig(this as any)));

        // 注册思源编辑器斜杆命令(输入 /file 或 /文件 插入文件链接)
        registerSlashCommands(this, () => this.getFileTreeRoot());

        // 思源正文 file:// 链接右键菜单:追加「在文件夹树中定位」等
        registerLinkReveal(this);

        // 思源文档树 / 正文块右键菜单:追加「挂载到虚拟文档树」
        registerMountMenu(this);

        // 正文内 Python 代码块:注入运行按钮 + 代码块下方的输出面板
        registerCodeBlockRun(this);

        // 接管思源顶部「+」:点击改为打开新标签页(设置里可关闭,恢复原生新建文档)
        installNewTabHijack(this as any, () => this.config.newTabReplacePlus !== false);

        // 顶栏图标 → 切换 Dock「虚拟文档树」(原「文件」面板已默认关闭,文件浏览由虚拟文档树承接)
        this.addTopBar({
            icon: "iconFolder",
            title: "文档树",
            position: "right",
            callback: () => {
                const dockItem = document.querySelector(
                    `.dock__item[data-type="${MOUNT_TREE_DOCK_TYPE}"]`,
                ) as HTMLElement;
                if (dockItem) {
                    dockItem.click();
                } else {
                    showMessage("请从侧边栏打开「虚拟文档树」面板", 3000, "info");
                }
            },
        });

        // 命令:全局搜索
        this.addCommand({
            langKey: "globalSearch",
            hotkey: "⇧⌘F",
            callback: () => this.openSearch(WORKSPACE_ROOT),
        });

        // 命令:扩展市场
        this.addCommand({
            langKey: "extensionMarket",
            hotkey: "⇧⌘E",
            callback: () => openExtensionMarket(this),
        });

        // 命令:打开终端
        this.addCommand({
            langKey: "openTerminal",
            hotkey: "⌃`",
            callback: () => this.openTerminal(this.getFileTreeRoot()),
        });

        // 顶栏图标:扩展市场(自定义拼图 SVG,currentColor 自适应工具栏配色)
        this.addTopBar({
            icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V5H6c-1.1 0-2 .9-2 2v3.8h1.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5H4V17c0 1.1.9 2 2 2h3.8v-1.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V19H17c1.1 0 2-.9 2-2v-3.8h1.5c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z"/></svg>`,
            title: "扩展市场",
            position: "right",
            callback: () => openExtensionMarket(this),
        });

        // 设置面板
        this.setting = new Setting({
            confirmCallback: () => this.saveSettings(),
        });
        this.buildSettingItems();

        // 主题同步
        this.startThemeSync();
    }

    // 注册「文件」侧边栏面板。
    // 该面板默认不注册(见 onload);用户在设置里打开时调用本方法即时生效。
    // 也可以由 openFileTab 在打开文件夹时按需触发(钩子挂在 onload)。
    // 注:思源插件**没有 removeDock**,所以关闭开关后需要重启思源才真正隐藏。
    private addFileTreeDock(): void {
        if (this.fileTreeDockAdded) return;
        this.fileTreeDockAdded = true;
        this.addDock(asSiyuanCustom(createFileTreeDockConfig(this as any)));
    }

    async onLayoutReady(): Promise<void> {
        this.config = await loadConfig(this);
        // 设置面板控件同步当前值
        this.syncSettingUI();
        // 设置里打开了「文件」面板 → 在此补注册(onload 是同步的,拿不到配置,只能延后到布局就绪)
        if (this.config.showFileTreeDock === true) this.addFileTreeDock();

// 加载标签数据(预设标签库 + 文件/文件夹打标记录)
  try {
   await loadTagData(this);
    } catch (e) {
            console.error("[siyuan-file-editor] 加载标签失败:", e);
        }
        // 加载自定义「打开方式」配置。
   // 必须在标签之后、且早于任何一次菜单构建:菜单里的「打开方式」是**同步**
        // 读内存缓存的(getOpenWithItems),没先 load 的话第一次右键看到的是空列表。
        try {
    await loadOpenWithData(this);
        } catch (e) {
     console.error("[siyuan-file-editor] 加载打开方式失败:", e);
        }
        // 加载正文代码块的运行输出存档(代码块面板是同步读内存缓存的,
        // 必须在 registerCodeBlockRun 之前完成 —— 注册时会立刻给已打开的文档补面板)
        try {
            await loadCodeBlockRunData(this);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载代码块输出失败:", e);
        }
        // 加载最近使用列表(文件 + 思源文档,供侧边栏面板与斜杆命令选择器使用)
        try {
            await loadRecents(this);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载最近使用失败:", e);
        }
        // 加载新标签页的固定/收藏数据(文件树右键与新标签页都依赖,失败不影响其他功能)
        try {
            await loadStartPage(this);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载新标签页数据失败:", e);
        }
        // 加载思源文档挂载记录(挂到真实目录下的虚拟条目;Dock 初始化早于此刻,加载后刷新文件树)
        try {
            await initMountStore(this as any);
            this.refreshFileTrees();
        } catch (e) {
            console.error("[siyuan-file-editor] 加载思源文档挂载记录失败:", e);
        }
        // 加载虚拟文档树的挂载节点(初始为空树;面板已注册,加载后自动重绘)
        try {
            await initMountTree(this);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载虚拟文档树失败:", e);
        }
        // 一次性迁移:文件树里的思源文档树挂载(sy-mounts.json 的 sydoc:// 条目)→ 虚拟文档树,
        // 迁移后清掉旧记录(百度网盘 bdpan:// 条目保留,仍在文件树里)
        try {
            const legacy = getMountList();
            if (legacy.some(m => m.vPath.startsWith("sydoc://"))) {
                const moved = await migrateSyDocMounts(this, legacy);
                await dropSyDocMounts();
                this.refreshFileTrees();
                if (moved > 0) showMessage(`已把 ${moved} 个思源文档挂载迁移到虚拟文档树`, 4000, "info");
            }
        } catch (e) {
            console.error("[siyuan-file-editor] 迁移思源文档挂载失败:", e);
        }
        // 加载百度网盘配置(Cookie 与同步空间目录;失败不影响其他功能)
        try {
            await initBaiduPanStore(this as any);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载百度网盘配置失败:", e);
        }
        // 记录最近使用的思源文档(必须在 loadRecents 之后注册,否则会被加载结果覆盖)
        this.eventBus.on("switch-protyle", (e: any) => {
            const protyle = e?.detail?.protyle;
            const rootID = protyle?.block?.rootID;
            if (!rootID) return;
            void this.recordRecentDoc(rootID, protyle?.path);
        });
        // 加载已安装的 VSCode 扩展
        try {
            const results = await loadAllExtensions(this);
            const loaded = results.filter(r => r.status === "loaded");
            if (loaded.length > 0) {
                const total = loaded.reduce((acc, r) => acc + r.loadedGrammars + r.loadedThemes + r.loadedSnippets + r.loadedIconThemes, 0);
                // 只写控制台不弹提示:启动和移到新窗口时 onLayoutReady 都会执行,弹窗很吵
                console.info(`[siyuan-file-editor] 已加载 ${loaded.length} 个扩展(${total} 项贡献)`);
            }
            // 按用户偏好应用代码主题与图标主题(无偏好时自动)
            this.applyConfiguredThemes();
            // 设置面板主题下拉选项同步(扩展加载完成后才有数据)
            this.refreshThemeSettingUI();
            // 扩展加载完成后,刷新已打开的文件树以更新图标
            this.refreshFileTrees();
            // 图标主题声明了图标却没解析出 SVG(历史安装数据不完整),提示重装
            const brokenIcons = getIconThemesWithMissingIcons();
            if (brokenIcons.length > 0) {
                showMessage(
                    `图标主题「${brokenIcons[0].label}」缺少图标文件,请在扩展市场重装该扩展`,
                    8000,
                    "info",
                );
            }
        } catch (e) {
            console.error("[siyuan-file-editor] 加载扩展失败:", e);
        }
    }

    // 刷新所有已打开的文件树 Dock,更新文件/文件夹图标
    private refreshFileTrees(): void {
        // 通知其它面板(虚拟文档树):文件系统已变动,需清缓存并重绘
        try {
            window.dispatchEvent(new CustomEvent("syfe:files-changed"));
        } catch {
            // 非浏览器环境忽略
        }
        const rootEls = document.querySelectorAll<HTMLElement>(".syfe-tree__root");
        if (rootEls.length === 0) {
            // 文件树可能还没渲染,延迟重试
            setTimeout(() => {
                document.querySelectorAll<HTMLElement>(".syfe-tree__root").forEach(el => refreshAllExpanded(el));
            }, 1000);
            return;
        }
        rootEls.forEach(el => refreshAllExpanded(el));
    }

    // 记录最近使用的思源文档:查 blocks 表取 hpath(末段即文档标题),content 作为兜底
    private async recordRecentDoc(rootID: string, path?: string): Promise<void> {
        let title = "";
        let hpath = "";
        try {
            const id = String(rootID).replace(/'/g, "''");
            const rows = await querySQL(`SELECT content, hpath FROM blocks WHERE id = '${id}' LIMIT 1`);
            const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
            if (row) {
                hpath = String(row.hpath || "");
                const segs = hpath.split("/").filter(Boolean);
                title = segs.length > 0 ? segs[segs.length - 1] : String(row.content || "");
            }
        } catch {
            // 查询失败则用路径兜底
        }
        if (!title && path) title = basename(path).replace(/\.sy$/i, "");
        await addRecentDoc(this as any, rootID, title || rootID, hpath || undefined);
    }

    onunload(): void {
        // 停掉 Python 语言服务与持久内核:两者都是常驻子进程,
        // 不显式关的话思源禁用插件后它们会一直挂在后台吃内存
        try {
            disposePythonLsp();
        } catch {
            // ignore
        }
        void disposePythonKernel();
        void stopPythonLanguageServer();
        disposeAll();
        // 正文代码块运行:中断所有还在跑的进程、摘掉注入的面板与按钮,
        // 并把防抖窗口内的输出强制落盘
        disposeCodeBlockRun();
        void flushCodeBlockRunData();
        // 清理扩展系统
        clearAllGrammars();
        clearAllThemes();
        clearAllSnippets();
        clearAllLsp();
        clearAllIconThemes();
        disposeMonaco();
        this.themeObserver?.disconnect();
        // 最近使用防抖落盘:卸载前强制写入,避免丢失防抖窗口内的记录
        void flushRecents();
    }

    // 打开文件编辑 Tab
    openFile(path: string): void {
        openFileTab(this as any, path);
    }

    // 在指定方向以分栏方式打开文件(支持同时查看多个文件)
    openFileSplit(path: string, position: "right" | "bottom"): void {
        openFileTab(this as any, path, {position});
    }

    // 打开图片查看 Tab("打开方式"用)
    openImage(path: string): void {
        void addRecent(this as any, path);
        openImageTab(this as any, path);
    }

    // 打开 Office 查看 Tab("打开方式"用)
    openOffice(path: string): void {
        void addRecent(this as any, path);
        openOfficeTab(this as any, path);
    }

    // 打开 Markdown 编辑 Tab(双模式:所见即所得/源码)
    openMarkdown(path: string, mode?: MarkdownMode): void {
        void addRecent(this as any, path);
        openMarkdownTab(this as any, path, mode);
    }

    // 打开音视频播放器 Tab("打开方式"用)
    openMedia(path: string): void {
        void addRecent(this as any, path);
        openMediaTab(this as any, path);
    }

    // 打开新标签页(接管顶部「+」后的启动台)
    openStart(): void {
        openStartTab(this as any);
    }

    // 新标签页:切换固定 / 收藏(供文件树右键菜单调用)
    async togglePin(path: string): Promise<void> {
        // 虚拟文档:条目为思源文档(title 用树节点标签,由调用方刷新)
        const item = isVirtualPath(path)
            ? itemFromDoc(virtualId(path), virtualLabelFromDOM(path) || virtualId(path))
            : itemFromPath(path);
        const nowIn = await toggleInGroup(this as any, "pinned", item);
        showMessage(nowIn ? "已固定到新标签页" : "已取消固定", 2000, "info");
    }

    async toggleFavorite(path: string): Promise<void> {
        const item = isVirtualPath(path)
            ? itemFromDoc(virtualId(path), virtualLabelFromDOM(path) || virtualId(path))
            : itemFromPath(path);
        const nowIn = await toggleInGroup(this as any, "favorites", item);
        showMessage(nowIn ? "已收藏" : "已取消收藏", 2000, "info");
    }
    // 打开搜索面板
    openSearch(rootPath?: string): void {
        openSearchTab(this as any, rootPath || this.config.fileTreeRoot || WORKSPACE_ROOT);
    }

    // 打开终端
    openTerminal(cwd?: string): void {
        openTerminalTab(this as any, cwd);
    }

    // 获取文件树根目录(供 Dock 调用)
    getFileTreeRoot(): string {
        return this.config.fileTreeRoot || WORKSPACE_ROOT;
    }

    // 设置文件树根目录(供 Dock 切换根目录时调用)
    async setFileTreeRoot(path: string): Promise<void> {
        this.config.fileTreeRoot = path;
        await saveConfig(this, this.config);
    }

    // 主题同步:观察 data-theme 属性变化
    // 思源明暗模式切换时,按用户偏好应用主题;无扩展主题时回退到思源配色
    private startThemeSync(): void {
        this.themeObserver = new MutationObserver(() => {
            const isDark = getCurrentMode() === 1;
            if (!applyThemeByPreference(this.config.colorTheme, isDark)) {
                applyTheme(getCurrentMode());
            }
        });
        this.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });
    }

    // 按用户偏好应用代码主题与图标主题
    public applyConfiguredThemes(): void {
        const isDark = getCurrentMode() === 1;
        if (!applyThemeByPreference(this.config.colorTheme, isDark)) {
            applyTheme(getCurrentMode());
        }
        activateIconThemeByPreference(this.config.iconTheme);
    }

    // 重建设置面板中主题下拉的选项(扩展安装/卸载后调用)
    public refreshThemeSettingUI(): void {
        if (this.colorThemeSelect) {
            const themes = getLoadedThemes();
            const cur = this.config.colorTheme;
            this.colorThemeSelect.innerHTML = [
                `<option value="">自动(优先扩展主题)</option>`,
                `<option value="__siyuan__">思源配色(不使用扩展主题)</option>`,
                ...themes.map(t => `<option value="${escapeAttr(t.name)}">${escapeText(t.label)}(${t.base === "vs" ? "亮色" : "暗色"})</option>`),
            ].join("");
            this.colorThemeSelect.value =
                cur === "__siyuan__" || themes.some(t => t.name === cur) ? cur : "";
        }
        if (this.iconThemeSelect) {
            const iconThemes = getLoadedIconThemes();
            const cur = this.config.iconTheme;
            this.iconThemeSelect.innerHTML = [
                `<option value="">自动(使用第一个图标主题)</option>`,
                `<option value="__none__">思源内置图标</option>`,
                ...iconThemes.map(t => `<option value="${escapeAttr(t.extensionId)}">${escapeText(t.label)}</option>`),
            ].join("");
            this.iconThemeSelect.value =
                cur === "__none__" || iconThemes.some(t => t.extensionId === cur) ? cur : "";
        }
    }

    // 构建设置面板项
    private buildSettingItems(): void {
        // 字体大小
        this.fontSizeInput = document.createElement("input");
        this.fontSizeInput.className = "b3-text-field fn__size200";
        this.fontSizeInput.type = "number";
        this.fontSizeInput.min = "8";
        this.fontSizeInput.max = "32";
        this.setting!.addItem({
            title: "字体大小",
            description: "编辑器字体大小(px)",
            actionElement: this.fontSizeInput,
        });

        // Tab 宽度
        this.tabSizeInput = document.createElement("input");
        this.tabSizeInput.className = "b3-text-field fn__size200";
        this.tabSizeInput.type = "number";
        this.tabSizeInput.min = "1";
        this.tabSizeInput.max = "16";
        this.setting!.addItem({
            title: "Tab 宽度",
            description: "缩进空格数",
            actionElement: this.tabSizeInput,
        });

        // 自动换行
        this.wordWrapSelect = document.createElement("select");
        this.wordWrapSelect.className = "b3-select fn__size200";
        this.wordWrapSelect.innerHTML = `
            <option value="off">关闭</option>
            <option value="on">开启</option>`;
        this.setting!.addItem({
            title: "自动换行",
            description: "长行是否自动换行",
            actionElement: this.wordWrapSelect,
        });

        // 保存时格式化
        this.formatOnSaveInput = document.createElement("input");
        this.formatOnSaveInput.type = "checkbox";
        this.formatOnSaveInput.className = "b3-switch";
        this.setting!.addItem({
            title: "保存时格式化",
            description: "Ctrl+S 保存时自动格式化文档",
            actionElement: this.formatOnSaveInput,
        });

        // 标签管理(新建/编辑/删除预设标签,支持嵌套、颜色、图标)
        const tagManageBtn = document.createElement("button");
        tagManageBtn.className = "b3-button b3-button--outline fn__size200";
        tagManageBtn.textContent = "管理标签…";
        tagManageBtn.addEventListener("click", () => {
            openTagManagerDialog(this, () => this.refreshFileTrees());
        });
this.setting!.addItem({
title: "标签",
            description: "管理预设标签(支持嵌套、颜色、图标);在文件树右键条目可打标签,工具栏标签按钮可按标签筛选",
actionElement: tagManageBtn,
        });

   // 自定义打开方式(预置 VS Code / Cursor / Windsurf / 记事本 / 资源管理器,可增删改)
        const openWithBtn = document.createElement("button");
      openWithBtn.className = "b3-button b3-button--outline fn__size200";
      openWithBtn.textContent = "管理打开方式…";
        openWithBtn.addEventListener("click", () => {
  openOpenWithManagerDialog(this, () => this.refreshFileTrees());
  });
     this.setting!.addItem({
      title: "自定义打开方式",
            description: "为文件与文件夹配置「用 XX 打开」的入口(预置 VS Code / Cursor / Windsurf / 记事本 / 资源管理器,可自行增删改命令与参数);配置后出现在文件树、虚拟文档树、搜索结果的右键「打开方式」里",
            actionElement: openWithBtn,
   });

// 百度网盘(接入方式配置 + 挂载入口说明)
        const bdPanBtn = document.createElement("button");
        bdPanBtn.className = "b3-button b3-button--outline fn__size200";
        bdPanBtn.textContent = "百度网盘账号…";
        bdPanBtn.addEventListener("click", () => openBaiduPanDialog());
        this.setting!.addItem({
            title: "百度网盘",
            description: "接入方式:官方 API(推荐,开放平台 AppKey/SecretKey + 设备码授权,未过审仅能访问 /apps/应用名/ 目录)或网页 Cookie(全盘 + 同步空间,非官方)。配置后点击文件树工具栏云图标挂载网盘目录,支持浏览、编辑并保存回网盘",
            actionElement: bdPanBtn,
        });

        // 搜索最大文件大小
        this.searchMaxSizeInput = document.createElement("input");
        this.searchMaxSizeInput.className = "b3-text-field fn__size200";
        this.searchMaxSizeInput.type = "number";
        this.searchMaxSizeInput.min = "100";
        this.searchMaxSizeInput.max = "10240";
        this.setting!.addItem({
            title: "搜索最大文件大小(KB)",
            description: "超过此大小的文件不参与搜索",
            actionElement: this.searchMaxSizeInput,
        });

        // 文件树根目录
        this.fileTreeRootInput = document.createElement("input");
        this.fileTreeRootInput.className = "b3-text-field fn__flex-1";
        this.fileTreeRootInput.type = "text";
        this.fileTreeRootInput.placeholder = "/data 或 E:\\HOME\\BaiduSyncdisk";
        this.setting!.addItem({
            title: "文件树根目录",
            description: "文件管理器 Dock 默认打开的目录路径。思源工作空间内填 /data 或 /data/public;工作空间外填系统绝对路径(如 E:\\HOME\\BaiduSyncdisk,仅桌面端支持)",
            actionElement: this.fileTreeRootInput,
        });

        // 终端后端模式
        this.terminalBackendSelect = document.createElement("select");
        this.terminalBackendSelect.className = "b3-select fn__size200";
        this.terminalBackendSelect.innerHTML = `
            <option value="auto">自动(推荐)</option>
            <option value="builtin">内置(开箱即用)</option>
            <option value="server">外部服务(完整 PTY)</option>`;
        this.setting!.addItem({
            title: "终端后端",
            description: "内置:直接在思源中启动 shell,无需额外服务(不支持 vim/htop 等全屏交互程序)。外部服务:需启动 scripts/start-terminal.bat,支持完整 PTY 交互。自动:桌面端优先内置",
            actionElement: this.terminalBackendSelect,
        });

        // 终端服务地址
        this.terminalServerUrlInput = document.createElement("input");
        this.terminalServerUrlInput.className = "b3-text-field fn__flex-1";
        this.terminalServerUrlInput.type = "text";
        this.terminalServerUrlInput.placeholder = "ws://127.0.0.1:9800";
        this.setting!.addItem({
            title: "终端服务地址",
            description: "仅「外部服务」模式需要。需先启动服务:双击 scripts/start-terminal.bat 或运行 node scripts/terminal-server.js",
            actionElement: this.terminalServerUrlInput,
        });

        // 思源工作空间路径
        this.siyuanWorkspacePathInput = document.createElement("input");
        this.siyuanWorkspacePathInput.className = "b3-text-field fn__flex-1";
        this.siyuanWorkspacePathInput.type = "text";
        this.siyuanWorkspacePathInput.placeholder = "留空则自动检测";
        this.setting!.addItem({
            title: "思源工作空间路径",
            description: "思源工作空间在文件系统中的绝对路径,用于将终端工作目录从 /data/... 转换为系统路径。留空则自动从思源配置获取",
            actionElement: this.siyuanWorkspacePathInput,
        });

        // 终端 Shell 选择
        this.terminalShellSelect = document.createElement("select");
        this.terminalShellSelect.className = "b3-select fn__size200";
        this.terminalShellSelect.innerHTML = `
            <option value="auto">自动检测</option>
            <option value="pwsh">PowerShell 7</option>
            <option value="powershell">Windows PowerShell</option>
            <option value="cmd">命令提示符 (cmd)</option>`;
        this.setting!.addItem({
            title: "终端 Shell",
            description: "集成终端使用的 shell 程序,需重启终端 Tab 后生效",
            actionElement: this.terminalShellSelect,
        });

        // 代码主题(扩展加载后填充选项)
        this.colorThemeSelect = document.createElement("select");
        this.colorThemeSelect.className = "b3-select fn__size200";
        this.colorThemeSelect.innerHTML = `<option value="">自动(优先扩展主题)</option>`;
        this.setting!.addItem({
            title: "代码主题",
            description: "Monaco 编辑器配色主题。安装主题类扩展(如 One Light)后可在此选择,保存后立即生效",
            actionElement: this.colorThemeSelect,
        });

        // 图标主题(扩展加载后填充选项)
        this.iconThemeSelect = document.createElement("select");
        this.iconThemeSelect.className = "b3-select fn__size200";
        this.iconThemeSelect.innerHTML = `<option value="">自动(使用第一个图标主题)</option>`;
        this.setting!.addItem({
            title: "图标主题",
            description: "文件树与 Tab 的文件/文件夹图标。安装图标类扩展(如 Material Icon Theme)后可在此选择,保存后立即生效",
            actionElement: this.iconThemeSelect,
        });

        // 新标签页:接管顶部「+」
        this.newTabReplacePlusInput = document.createElement("input");
        this.newTabReplacePlusInput.type = "checkbox";
        this.newTabReplacePlusInput.className = "b3-switch";
        this.setting!.addItem({
            title: "新标签页:接管顶部「+」",
            description: "开启后,点击思源顶部的「+」不再新建文档,而是打开插件「新标签页」(搜索文件 + 固定 + 最近打开 + 收藏)。页内「新建思源文档」按钮保留原生新建能力",
            actionElement: this.newTabReplacePlusInput,
        });

        // 新标签页:各分区显隐
        this.newTabShowPinnedInput = document.createElement("input");
        this.newTabShowPinnedInput.type = "checkbox";
        this.newTabShowPinnedInput.className = "b3-switch";
        this.setting!.addItem({
            title: "新标签页:显示「固定」",
            description: "固定区钉在页顶,可在文件树右键「固定到新标签页」添加",
            actionElement: this.newTabShowPinnedInput,
        });

        this.newTabShowRecentInput = document.createElement("input");
        this.newTabShowRecentInput.type = "checkbox";
        this.newTabShowRecentInput.className = "b3-switch";
        this.setting!.addItem({
            title: "新标签页:显示「最近打开」",
            description: "最近打开的文件与思源文档(来自「最近使用」列表)",
            actionElement: this.newTabShowRecentInput,
        });

        this.newTabShowFavoritesInput = document.createElement("input");
        this.newTabShowFavoritesInput.type = "checkbox";
        this.newTabShowFavoritesInput.className = "b3-switch";
        this.setting!.addItem({
            title: "新标签页:显示「收藏」",
            description: "收藏区,可在文件树右键「收藏」添加",
            actionElement: this.newTabShowFavoritesInput,
        });

        // 侧边栏「文件」面板:文件浏览能力已由「虚拟文档树」承接,默认隐藏
        this.showFileTreeDockInput = document.createElement("input");
        this.showFileTreeDockInput.type = "checkbox";
        this.showFileTreeDockInput.className = "b3-switch";
        this.setting!.addItem({
            title: "侧边栏:显示「文件」面板",
            description: "恢复传统的文件树面板(按根目录浏览真实文件)。文件浏览/重命名/删除/打开方式等已由「虚拟文档树」面板提供,一般不需要开启;关闭此项需重启思源后生效",
            actionElement: this.showFileTreeDockInput,
        });

        // 「虚拟文档树」面板:引用关系树(移植自 siyuan-virtual-tree)
        this.mountTreeRelationEnabledInput = document.createElement("input");
        this.mountTreeRelationEnabledInput.type = "checkbox";
        this.mountTreeRelationEnabledInput.className = "b3-switch";
        this.setting!.addItem({
            title: "虚拟文档树:引用关系树",
            description: "在「虚拟文档树」面板顶部额外显示一棵按文档首块引用关系自动构建的树(被引用方为父,发起引用方为子,自动挑出没有上级的文档作为根)。它是只读的派生视图,不改动你手动挂载的内容",
            actionElement: this.mountTreeRelationEnabledInput,
        });

        this.mountTreeRelationSortSelect = document.createElement("select");
        this.mountTreeRelationSortSelect.className = "b3-select fn__size200";
        this.mountTreeRelationSortSelect.innerHTML = `
            <option value="name">按名称排序</option>
            <option value="weight">按权重排序</option>
            <option value="custom">自定义(拖拽排序)</option>`;
        this.setting!.addItem({
            title: "关系树:排序方式",
            description: "子节点的排序方式。选「自定义」后可在关系树上直接拖拽调整顺序,顺序会被保存",
            actionElement: this.mountTreeRelationSortSelect,
        });

        this.mountTreeRelationWeightInput = document.createElement("input");
        this.mountTreeRelationWeightInput.className = "b3-text-field fn__flex1";
        this.mountTreeRelationWeightInput.type = "text";
        this.mountTreeRelationWeightInput.placeholder = "weight";
        this.setting!.addItem({
            title: "关系树:权重属性名",
            description: "文档自定义属性中用于排序的权重字段名,缺失则权重为 0(仅「按权重排序」时生效)",
            actionElement: this.mountTreeRelationWeightInput,
        });

        this.mountTreeRelationPhysicalInput = document.createElement("input");
        this.mountTreeRelationPhysicalInput.type = "checkbox";
        this.mountTreeRelationPhysicalInput.className = "b3-switch";
        this.setting!.addItem({
            title: "关系树:包含物理子树",
            description: "开启后,文档在思源原生层级的物理子文档也会作为关系树的子节点显示",
            actionElement: this.mountTreeRelationPhysicalInput,
        });

        this.mountTreeRelationCaseInput = document.createElement("input");
        this.mountTreeRelationCaseInput.type = "checkbox";
        this.mountTreeRelationCaseInput.className = "b3-switch";
        this.setting!.addItem({
            title: "关系树:排序区分大小写",
            description: "按名称排序时是否区分大小写",
            actionElement: this.mountTreeRelationCaseInput,
        });

        this.mountTreeRelationDepthInput = document.createElement("input");
        this.mountTreeRelationDepthInput.className = "b3-text-field fn__size200";
        this.mountTreeRelationDepthInput.type = "number";
        this.mountTreeRelationDepthInput.min = "1";
        this.mountTreeRelationDepthInput.placeholder = "8";
        this.setting!.addItem({
            title: "关系树:最大递归深度",
            description: "构建子树时的最大层数,防止深层引用造成卡顿",
            actionElement: this.mountTreeRelationDepthInput,
        });

        this.mountTreeRelationNodesInput = document.createElement("input");
        this.mountTreeRelationNodesInput.className = "b3-text-field fn__size200";
        this.mountTreeRelationNodesInput.type = "number";
        this.mountTreeRelationNodesInput.placeholder = "500";
        this.setting!.addItem({
            title: "关系树:最大节点数",
            description: "关系树最多显示多少个文档,超出则停止构建",
            actionElement: this.mountTreeRelationNodesInput,
        });

        this.mountTreeRelationExpandInput = document.createElement("input");
        this.mountTreeRelationExpandInput.className = "b3-text-field fn__size200";
        this.mountTreeRelationExpandInput.type = "number";
        this.mountTreeRelationExpandInput.placeholder = "1";
        this.setting!.addItem({
            title: "关系树:默认展开层级",
            description: "0 = 全部折叠,-1 = 全部展开,N = 展开前 N 层(修改后点「刷新」生效)",
            actionElement: this.mountTreeRelationExpandInput,
        });

        // 导入 Markdown 到思源时,是否把源文件作为资源插入文档顶部的引述块
        this.importMdSourceAssetInput = document.createElement("input");
        this.importMdSourceAssetInput.type = "checkbox";
        this.importMdSourceAssetInput.className = "b3-switch";
        this.setting!.addItem({
            title: "导入 Markdown:插入源文件资源引述块",
            description: "导入 .md 到思源后,把源文件上传为资源,并在文档顶部插入一个引述块链接到它(保留出处,便于回溯原文件);仅对单个 Markdown 文件生效,导入文件夹时不处理",
            actionElement: this.importMdSourceAssetInput,
        });

        // Markdown 默认模式(对齐 Obsidian:实时预览 / 源码 / 阅读)
        this.markdownModeSelect = document.createElement("select");
        this.markdownModeSelect.className = "b3-select fn__size200";
        this.markdownModeSelect.innerHTML = `
            <option value="live">实时预览</option>
            <option value="source">源码</option>
            <option value="reading">阅读</option>`;
        this.setting!.addItem({
            title: "Markdown 默认模式",
            description: "打开 .md 文件时的默认模式,Tab 顶部可随时切换。实时预览=边写边渲染(光标行显示源码);源码=纯文本;阅读=完整渲染且只读。超过 512KB 的大文件始终以源码模式打开",
            actionElement: this.markdownModeSelect,
        });
    }

    // 同步设置面板控件值为当前配置
    private syncSettingUI(): void {
        if (this.fontSizeInput) this.fontSizeInput.value = String(this.config.fontSize);
        if (this.tabSizeInput) this.tabSizeInput.value = String(this.config.tabSize);
        if (this.wordWrapSelect) this.wordWrapSelect.value = this.config.wordWrap;
        if (this.formatOnSaveInput) this.formatOnSaveInput.checked = this.config.formatOnSave;
        if (this.searchMaxSizeInput) {
            this.searchMaxSizeInput.value = String(Math.round(this.config.searchMaxFileSize / 1024));
        }
        if (this.fileTreeRootInput) this.fileTreeRootInput.value = this.config.fileTreeRoot;
        if (this.terminalBackendSelect) this.terminalBackendSelect.value = this.config.terminalBackend || "auto";
        if (this.terminalServerUrlInput) this.terminalServerUrlInput.value = this.config.terminalServerUrl;
        if (this.siyuanWorkspacePathInput) this.siyuanWorkspacePathInput.value = this.config.siyuanWorkspacePath;
        if (this.terminalShellSelect) this.terminalShellSelect.value = this.config.terminalShell || "auto";
        if (this.markdownModeSelect) this.markdownModeSelect.value = this.config.markdownDefaultMode || "live";
        if (this.newTabReplacePlusInput) this.newTabReplacePlusInput.checked = this.config.newTabReplacePlus !== false;
        if (this.newTabShowPinnedInput) this.newTabShowPinnedInput.checked = this.config.newTabShowPinned !== false;
        if (this.newTabShowRecentInput) this.newTabShowRecentInput.checked = this.config.newTabShowRecent !== false;
        if (this.newTabShowFavoritesInput) this.newTabShowFavoritesInput.checked = this.config.newTabShowFavorites !== false;
        if (this.importMdSourceAssetInput) this.importMdSourceAssetInput.checked = this.config.importMdSourceAsset === true;
        if (this.showFileTreeDockInput) this.showFileTreeDockInput.checked = this.config.showFileTreeDock === true;
        // 关系树设置回填(只回填设置项;customOrder/collapsed 由面板维护,不在这里改)
        const rel = this.config.mountTreeRelation || DEFAULT_CONFIG.mountTreeRelation;
        if (this.mountTreeRelationEnabledInput) this.mountTreeRelationEnabledInput.checked = rel.enabled === true;
        if (this.mountTreeRelationSortSelect) this.mountTreeRelationSortSelect.value = rel.sortMethod || "name";
        if (this.mountTreeRelationWeightInput) this.mountTreeRelationWeightInput.value = rel.weightAttrName || "weight";
        if (this.mountTreeRelationPhysicalInput) this.mountTreeRelationPhysicalInput.checked = rel.includePhysicalSubtree === true;
        if (this.mountTreeRelationCaseInput) this.mountTreeRelationCaseInput.checked = rel.caseSensitive === true;
        if (this.mountTreeRelationDepthInput) this.mountTreeRelationDepthInput.value = String(rel.maxDepth ?? 8);
        if (this.mountTreeRelationNodesInput) this.mountTreeRelationNodesInput.value = String(rel.maxNodes ?? 500);
        if (this.mountTreeRelationExpandInput) this.mountTreeRelationExpandInput.value = String(rel.defaultExpandLevel ?? 1);
        // 主题下拉的选项依赖扩展数据,此处仅同步值;选项在 onLayoutReady 后填充
        this.refreshThemeSettingUI();
    }

    // 保存设置
    private async saveSettings(): Promise<void> {
        this.config = {
            fontSize: parseInt(this.fontSizeInput?.value || "14", 10),
            tabSize: parseInt(this.tabSizeInput?.value || "4", 10),
            wordWrap: (this.wordWrapSelect?.value as "on" | "off") || "off",
            formatOnSave: this.formatOnSaveInput?.checked ?? false,
            searchMaxFileSize: (parseInt(this.searchMaxSizeInput?.value || "1024", 10)) * 1024,
            fileTreeRoot: (this.fileTreeRootInput?.value || "").trim() || "/data",
            terminalBackend: (this.terminalBackendSelect?.value as "auto" | "builtin" | "server") || "auto",
            terminalShell: (this.terminalShellSelect?.value as string) || "auto",
            terminalServerUrl: (this.terminalServerUrlInput?.value || "").trim() || DEFAULT_TERMINAL_SERVER_URL,
            siyuanWorkspacePath: (this.siyuanWorkspacePathInput?.value || "").trim(),
            colorTheme: this.colorThemeSelect?.value || "",
            iconTheme: this.iconThemeSelect?.value || "",
            markdownDefaultMode: (this.markdownModeSelect?.value as "live" | "source" | "reading") || "live",
            newTabReplacePlus: this.newTabReplacePlusInput?.checked ?? true,
            newTabShowPinned: this.newTabShowPinnedInput?.checked ?? true,
            newTabShowRecent: this.newTabShowRecentInput?.checked ?? true,
            newTabShowFavorites: this.newTabShowFavoritesInput?.checked ?? true,
            importMdSourceAsset: this.importMdSourceAssetInput?.checked ?? false,
            showFileTreeDock: this.showFileTreeDockInput?.checked ?? false,
            mountTreeRelation: {
                // 保留既有的 customOrder / collapsed(面板运行时维护,不在这里覆盖)
                ...(this.config.mountTreeRelation || {}),
                enabled: this.mountTreeRelationEnabledInput?.checked ?? false,
                sortMethod: (this.mountTreeRelationSortSelect?.value as "name" | "weight" | "custom") || "name",
                weightAttrName: (this.mountTreeRelationWeightInput?.value || "").trim() || "weight",
                includePhysicalSubtree: this.mountTreeRelationPhysicalInput?.checked ?? false,
                caseSensitive: this.mountTreeRelationCaseInput?.checked ?? false,
                maxDepth: Math.max(1, parseInt(this.mountTreeRelationDepthInput?.value || "8", 10) || 8),
                maxNodes: Math.max(10, parseInt(this.mountTreeRelationNodesInput?.value || "500", 10) || 500),
                defaultExpandLevel: parseInt(this.mountTreeRelationExpandInput?.value || "1", 10) || 0,
            },
        };
        // 打开开关时即时注册「文件」面板(关闭需重启思源,插件无 removeDock)
        if (this.config.showFileTreeDock === true) this.addFileTreeDock();
        await saveConfig(this, this.config);
        // 主题设置立即生效
        this.applyConfiguredThemes();
        this.refreshFileTrees();
        // 引用关系树开关影响「虚拟文档树」面板内容,通知面板重建(立即生效,无需重启)
        window.dispatchEvent(new CustomEvent(SYFE_RELATION_TREE_CHANGED_EVENT));
        showMessage("设置已保存,主题立即生效;终端设置需重开终端 Tab", 3000, "info");
    }
}

// HTML 属性/文本转义(主题名与 label 来自扩展包,不可信)
function escapeAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

// 虚拟文档树节点的显示名:优先从可见树节点取标签文本(同步),
// 树不可见(如新标签页固定区右键)时回退缓存,再回退空
const docLabelCache = new Map<string, string>();
function virtualLabelFromDOM(vPath: string): string {
    const sel = `.syfe-tree__item[data-path="${vPath.replace(/["\\]/g, "\\$&")}"] .syfe-tree__label`;
    const el = document.querySelector(sel) as HTMLElement | null;
    const text = el?.textContent?.trim();
    if (text) {
        docLabelCache.set(vPath, text);
        return text;
    }
    return docLabelCache.get(vPath) || "";
}
