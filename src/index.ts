import {Plugin, showMessage} from "siyuan";
import {
    WORKSPACE_ROOT,
    DEFAULT_TERMINAL_SERVER_URL,
    DOCK_TYPE,
    MARKDOWN_TAB_TYPE,
    RECENT_DOCK_TYPE,
    TAG_DOCK_TYPE,
    MOUNT_TREE_DOCK_TYPE,
    TERMINAL_DOCK_TYPE,
    BACKLINK_DOCK_TYPE,
    DOC_PROPERTIES_DOCK_TYPE,
} from "./constants";
import {EditorConfig, DEFAULT_CONFIG} from "./types";
import {setupMonaco, applyTheme, getCurrentMode, disposeMonaco} from "./editor/monaco";
import {disposeAllGlobal, onDispose} from "./utils/disposal";
import {disposeAll} from "./editor/model-manager";
import {notifyCm6RenderConfigChanged} from "./editor/cm6-render";
import {createEditorTabConfig, openFileTab} from "./tabs/editor-tab";
import {createImageTabConfig, openImageTab} from "./tabs/image-tab";
import {createOfficeTabConfig, openOfficeTab} from "./tabs/office-tab";
import {createMarkdownTabConfig, openMarkdownTab, MarkdownMode, MarkdownTabInstance} from "./tabs/markdown-tab";
import {createMediaTabConfig, openMediaTab} from "./tabs/media-tab";
import {createNotebookTabConfig} from "./tabs/notebook-tab";
import {createDiffTabConfig} from "./tabs/diff-tab";
import {createStartTabConfig, openStartTab, installNewTabHijack} from "./tabs/start-tab";
import {createTerminalTabConfig, openTerminalTab, applyTerminalStatusBarVisibility} from "./tabs/terminal-tab";
import {initDocProperties, destroyDocProperties, notifyDocPropertiesConfigChanged, createDocPropertiesDockConfig} from "./doc-properties";
import {registerBlockPlanner, destroyBlockPlanner} from "./block-planner";
import {createRecentDockConfig} from "./dock/recent-dock";
import {createTagDockConfig} from "./dock/tag-dock";
import {createSearchTabConfig, openSearchTab} from "./components/search-panel";
import {loadConfig, saveConfig} from "./utils/config";
import {
    applyEditorOptions,
    applyUserSettingsToConfig,
    flushUserSettings,
    getResolved,
    getNumberSetting,
    initUserSettings,
    registerSettingsChangedHandler,
    registerSettingsJsonSchema,
    syncUserSettingsFromConfig,
} from "./settings/user-settings";
import {buildEditorAllPanel, buildEditorGroupPanel, getEditorSubgroups} from "./settings/editor-settings-ui";
import {createSettingsPanel, settingsRow, SettingsPanel} from "./settings/plugin-settings-dialog";
// 自定义快捷键:录入(hotkeyFromEvent)+ 规范化/显示
import {normalizeHotkeyText, formatHotkey, hotkeyFromEvent} from "./utils/hotkey";
import {querySQL, lsNotebooks} from "./api/file";
import {basename} from "./utils/path";
import {isMobileFrontend} from "./utils/platform";
import {openCreateSiyuanDocDialog, fileBaseName} from "./components/siyuan-new-doc";
import {loadAllExtensions} from "./extensions/extension-manager";
import {loadBuiltinGrammars} from "./extensions/grammar-loader";
import {loadTagData} from "./tags/tag-store";
import {openTagManagerDialog} from "./tags/tag-ui";
import {loadOpenWithData} from "./open-with/open-with-store";
import {openOpenWithManagerDialog} from "./open-with/open-with-ui";
import {registerDocOpenTakeover} from "./open-takeover/doc-open-takeover";
import {initFileVersions, setVersionKeepCount} from "./version-control/file-versions";
import {setTrashMode} from "./utils/trash";
import {openTrashDialog} from "./components/trash-dialog";
import {loadRecents, addRecent, addRecentDoc, flushRecents, reloadRecentsIfChanged} from "./recent-files";
import {loadStartPage, itemFromPath, itemFromDoc, toggleInGroup, START_PAGE_CHANGED_EVENT} from "./start-page";
import {isVirtualPath, virtualId, initMountStore, getMountList, dropSyDocMounts} from "./utils/virtual-tree";
import {initBaiduPanStore} from "./api/baidu-pan";
import {openBaiduPanDialog} from "./components/baidu-pan-dialog";
import {initGitRepoStore} from "./api/git-repo";
import {initLibraryStore} from "./api/library";
import {openGitRepoDialog} from "./components/git-repo-dialog";
import {registerSlashCommands, emitBacklinkRefresh} from "./protyle/slash-commands";
import {registerDocWikilinkHint} from "./protyle/doc-wikilink-hint";
import {onDidSaveModel} from "./editor/model-manager";
import {clearBacklinkCache} from "./utils/backlink";
import {registerLinkReveal} from "./protyle/link-reveal";
import {registerDocExternalFilesMenu} from "./protyle/doc-external-files";
import {registerMountMenu} from "./protyle/mount-menu";
import {registerCodeBlockRun, disposeCodeBlockRun} from "./protyle/code-block-run";
import {loadCodeBlockRunData, flushCodeBlockRunData} from "./protyle/code-block-run-store";
import {initMountTree, reloadMountTreeIfChanged, migrateSyDocMounts, SYFE_RELATION_TREE_CHANGED_EVENT, getRoots, ensureLibraryMount} from "./mount-tree";
import {createMountTreeDockConfig} from "./dock/mount-tree-dock";
import {createBacklinkDockConfig} from "./dock/backlink-dock";
import {createTerminalDockConfig} from "./dock/terminal-dock";
import {openExtensionMarket} from "./extensions/market-ui";
import {clearAllGrammars} from "./extensions/grammar-loader";
import {clearAllThemes, applyThemeByPreference, getLoadedThemes} from "./extensions/theme-loader";
import {clearAllSnippets} from "./extensions/snippet-loader";
import {clearAllLsp} from "./extensions/lsp-loader";
import {clearAllIconThemes, getIconThemesWithMissingIcons, getLoadedIconThemes, activateIconThemeByPreference, ICON_THEME_CHANGED_EVENT} from "./extensions/icon-theme-loader";
import {setCloseUnsavedAction} from "./utils/close-guard";
import {registerPythonLsp, disposePythonLsp, setupBlockSemanticBridge} from "./utils/python-lsp-bridge";
import {disposePythonKernel} from "./utils/python-kernel";
import {disposeAllKernels, disposeAllKernelsSync, getGlobalDefaultChoice, getKernelChoice, loadKernelChoices, registerKernelChoicePersistence, setKernelChoice, DEFAULT_KERNEL_ID} from "./utils/kernel/registry";
import {listKernelSpecs} from "./utils/kernel/interpreter";
import {stopPythonLanguageServer, maybeRestartForInterpreterChange} from "./utils/python-lsp";
// vditor 会用自己的 lute 覆写 window.Lute,使思源之后新建的文档编辑器全部失效。
// 必须在任何 vditor 实例被创建之前装好守卫 —— 所以放在顶层 import 里(模块求值顺序)。
import {installLuteGuard} from "./utils/lute-guard";
import {refreshAllExpanded} from "./components/file-tree";
import {refreshAllTabIcons} from "./utils/tab-icon";
import {destroyCodeRender, initCodeRender, buildCodeRenderSettingPages} from "./code-render";
import {applyFakeDocBreadcrumb, destroyFakeDocBreadcrumb, getFakeDocBreadcrumbDefaultSettings, getFakeDocBreadcrumbSettings, saveFakeDocBreadcrumbSettings} from "./fake-doc-breadcrumb";
import {initLanguage as initFdbLanguage, language as fdbLang} from "./fake-doc-breadcrumb/i18n";
// 习惯与目标(并入自 siyuan-planner):打卡/目标/任务/番茄计时/倒数日
import {applyPlannerEnabled, destroyPlanner, isPlannerActive} from "./planner";
import {createPlannerDockConfig} from "./planner/dock";
import {createPlannerTabConfig, openPlannerTab} from "./planner/tab";
import {openPlannerSettingsDialog} from "./planner/dialogs";
import {getSettings as getPlannerSettings, updatePlannerSettings, PLANNER_CHANGED_EVENT} from "./planner/store";
import {PLANNER_DOCK_TYPE} from "./planner/constants";
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
    // 「关闭未保存标签页时的行为」下拉
    private closeUnsavedSelect?: HTMLSelectElement;
    // 「接管打开用分栏」开关
    private takeoverSplitOpenInput?: HTMLInputElement;
    private treeBacklinkIconInput?: HTMLInputElement;
    // VS Code 式设置面板(左分类树 + 右内容);onload 装配,openSetting 打开
    private settingsPanel?: SettingsPanel;

    /** 内核设置菜单点击时打开自绘设置面板(覆盖 Plugin.openSetting 默认实现) */
    public openSetting(): void {
        this.settingsPanel?.open();
    }

    /** 代码块渲染设置(外观/规则/数据源三块)装配为单个设置页 */
    private addCodeRenderSettingsPage(): void {
        if (!this.settingsPanel) return;
        const blocks = buildCodeRenderSettingPages(this);
        const host = document.createElement("div");
        host.className = "syfe-set__page";
        for (const b of blocks) {
            const wrap = document.createElement("div");
            wrap.className = "syfe-set__block";
            wrap.dataset.tags = `${b.label} ${b.desc}`.toLowerCase();
            const head = document.createElement("div");
            head.className = "syfe-set__blocktitle";
            head.textContent = b.label;
            wrap.appendChild(head);
            if (b.desc) {
                const desc = document.createElement("div");
                desc.className = "syfe-set__blockdesc";
                desc.textContent = b.desc;
                wrap.appendChild(desc);
            }
            wrap.appendChild(b.buildEl());
            host.appendChild(wrap);
        }
        this.settingsPanel.addPage({id: "codeRender", label: "代码块渲染", build: () => host});
    }
    private searchMaxSizeInput?: HTMLInputElement;
    private fileTreeRootInput?: HTMLInputElement;
    // 全局搜索服务地址(Everything 文件名 / AnyTXT 全文)
    private searchEverythingUrlInput?: HTMLInputElement;
    private searchAnytxtUrlInput?: HTMLInputElement;
    private terminalBackendSelect?: HTMLSelectElement;
    private terminalServerUrlInput?: HTMLInputElement;
    private siyuanWorkspacePathInput?: HTMLInputElement;
    private terminalShellSelect?: HTMLSelectElement;
    private terminalShowStatusBarInput?: HTMLInputElement;
    private colorThemeSelect?: HTMLSelectElement;
    private iconThemeSelect?: HTMLSelectElement;
    // 顶栏「扩展市场」图标:元素引用(显隐控制)+ 设置面板开关
    private marketTopBarIconEl?: HTMLElement;
    private marketTopBarIconInput?: HTMLInputElement;
    // 顶栏「习惯与目标」图标(显隐跟随 plannerEnabled)
    private plannerTopBarIconEl?: HTMLElement;
    // 习惯与目标(并入自 siyuan-planner)总开关
    private plannerEnabledInput?: HTMLInputElement;
    // planner 细分设置控件(键见 buildSettingItems 的 plannerSpec;变更即时写 planner.json)
    private plannerControls: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    private markdownModeSelect?: HTMLSelectElement;
    // Markdown 编辑器引擎下拉(vditor 所见即所得 / cm6 源码编辑)
    private markdownEditorSelect?: HTMLSelectElement;
    private markdownReadingEngineSelect?: HTMLSelectElement;
    private cm6CodeBlockMonacoInput?: HTMLInputElement;
    private newTabReplacePlusInput?: HTMLInputElement;
    private newTabShowPinnedInput?: HTMLInputElement;
    private newTabShowRecentInput?: HTMLInputElement;
    private newTabShowFavoritesInput?: HTMLInputElement;
    private newTabShowPlannerInput?: HTMLInputElement;
    private newTabSectionOrderInput?: HTMLInputElement;
    private newTabItemSortSelect?: HTMLSelectElement;
    private newTabPlannerOrderInput?: HTMLInputElement;
    private docPropertiesShowInDocInput?: HTMLInputElement;
    private docPropertiesSchemaInput?: HTMLTextAreaElement;
    // 导入 md 到思源时,是否在文档顶部插入源文件资源引述块
    private importMdSourceAssetInput?: HTMLInputElement;
    // 双链扫描:所有文本文件作为链接源(关=仅 Markdown)
    private backlinkScanAllTextInput?: HTMLInputElement;
    // 思源文档 [[: 双链补全(关=只有思源原生 [[ 文档/块引用)
    private docWikilinkHintInput?: HTMLInputElement;
    // 双链文件名索引的白/黑名单(多行规则文本,支持正则)
    private indexWhitelistInput?: HTMLTextAreaElement;
    private indexBlacklistInput?: HTMLTextAreaElement;
    // 接管思源文档内文件打开:模式下拉 + 扩展名白名单
    private docOpenTakeoverSelect?: HTMLSelectElement;
    private docOpenTakeoverExtsInput?: HTMLInputElement;
    // 右键「新建思源文档」:目标笔记本下拉 + 子路径 + 文件同名开关
    private newDocNotebookSelect?: HTMLSelectElement;
    private newDocSubPathInput?: HTMLInputElement;
    private newDocSameNameInput?: HTMLInputElement;
    // 文件右键挂载思源文档的落点(文件下 / 所在文件夹下)
    private fileMountTargetSelect?: HTMLSelectElement;
    // 插件库「取消同步」时对已绑定 Git 远端的处理方式
    private libraryUnlinkModeSelect?: HTMLSelectElement;
    private _unregisterDocOpenTakeover?: () => void;
    // 文档右键「引用的外部文件」的 window 监听注销(正文入口走 eventBus 无需处理)
    private _unregisterDocExternalFiles?: () => void;
    // 顶部「+」劫持的 document 监听注销(不摘的话禁用插件后「+」仍被旧监听接管)
    private _unregisterNewTabHijack?: () => void;
    // 切换思源文档后刷新文件树的防抖 timer(见 switch-protyle 监听)
    private _docSwitchRefreshTimer?: number;
    // 全局阅读模式:Markdown 默认只读打开
    private globalReadingModeInput?: HTMLInputElement;
    // 版本控制:每文件保留的历史版本条数
    private versionKeepCountInput?: HTMLInputElement;
    // 删除方式:插件回收站 / 系统回收站(没有"直接删除"选项)
    private deleteModeSelect?: HTMLSelectElement;
    // 音视频播放器自定义快捷键(点击输入框后按键录入)
    private mediaHotkeyMarkInput?: HTMLInputElement;
    private mediaHotkeyInsertInput?: HTMLInputElement;
    // 默认运行内核(代码块/代码文件/ipynb 共用的全局兜底)
    private kernelDefaultSelect?: HTMLSelectElement;
    // 引用关系树(移植自 siyuan-virtual-tree)
    private mountTreeRelationEnabledInput?: HTMLInputElement;
    private mountTreeRelationSortSelect?: HTMLSelectElement;
    private mountTreeRelationWeightInput?: HTMLInputElement;
    private mountTreeRelationPhysicalInput?: HTMLInputElement;
    private mountTreeRelationCaseInput?: HTMLInputElement;
    private mountTreeRelationDepthInput?: HTMLInputElement;
    private mountTreeRelationNodesInput?: HTMLInputElement;
    private mountTreeRelationExpandInput?: HTMLInputElement;
    // 文档面包屑(并入自 fake-doc-breadcrumb)总开关
    private fakeDocBreadcrumbEnabledInput?: HTMLInputElement;
    // 文档面包屑细分设置控件(键 = 模块设置键,见 buildSettingItems 的 fdbSpec)
    private fdbControls: Record<string, HTMLInputElement | HTMLSelectElement> = {};

    /**
     * 清掉失效的 dock 状态记录。
     *
     * 思源把插件 dock 的显隐/位置/顺序存在 `window.siyuan.storage["local-plugin-docks"]`
     * (落盘 `data/storage/local.json`),键形如 `<插件名><dockType>`。
     * **插件改名或卸载后,旧条目不会自动清理** —— 它们会和新条目占同一个 index/position 槽位,
     * dock 栏重建时两套交替生效,表现为侧栏图标来回跳(2026-10-13 实测)。
     * 更隐蔽的是:插件改名后,旧条目的 `<插件名><type>` 键会**漂移到新插件名下**
     * (旧 `siyuan-virtual-tree` 的 `virtual-tree-dock` 就是这么变成我们的僵尸条目的),
     * 所以不能只按"旧插件名"找,必须按**当前代码还注不注册这个 type** 来判定。
     *
     * 只改内存里的 storage,不落盘 —— 下次启动照样再清一遍,天然自愈,也不会触发写盘同步。
     * 必须在 addDock **之前**调用。
     */
    private pruneStalePluginDocks(): void {
        // 当前代码会注册的 dock type;文件 dock 即使默认不注册也保留(设置里可开)
        const registered = [
            DOCK_TYPE, RECENT_DOCK_TYPE, TAG_DOCK_TYPE, MOUNT_TREE_DOCK_TYPE, TERMINAL_DOCK_TYPE, PLANNER_DOCK_TYPE, BACKLINK_DOCK_TYPE, DOC_PROPERTIES_DOCK_TYPE,
        ];
        // 本插件用过的旧名字(改名前的命名空间,整个都该清);
        // siyuan-planner = 已并入的习惯与目标模块的独立插件期命名空间,它的 dock 记录一并清掉
        const legacyNames = ["siyuan-file-editor", "siyuan-planner"];
        try {
            const storage = (window as any).siyuan?.storage?.["local-plugin-docks"];
            if (!storage || typeof storage !== "object") return;
            const valid = new Set(registered.map((t) => this.name + t));
            for (const ns of [this.name, ...legacyNames]) {
                const group = storage[ns];
                if (!group || typeof group !== "object") continue;
                let removed = 0;
                for (const key of Object.keys(group)) {
                    // 旧命名空间里的全部作废;当前命名空间里只保留还注册的 type
                    if (ns === this.name && valid.has(key)) continue;
                    delete group[key];
                    removed++;
                }
                if (ns !== this.name && Object.keys(group).length === 0) delete storage[ns];
                if (removed > 0) {
                    console.info(`[siyuan-virtual-tree] 清理 ${removed} 条失效 dock 记录(${ns})`);
                }
            }
        } catch {
            // storage 结构异常不影响插件加载
        }
    }

    /**
     * 注册 Dock,但**只注册一次**。
     *
     * 多窗口(文档在新窗口打开)时插件会被反复加载,每次 onload 都走一遍 addDock ——
     * 而卸载时思源并不会把上一轮的 dock 项从侧栏摘掉,于是侧栏里会短暂出现两套图标,
     * dock 栏重建的瞬间图标集合在两个状态之间来回切,表现为「虚拟文档树图标跳动」。
     * 注册前先查 DOM:dock 项已经在栏上就跳过,保证图标集合恒定。
     */
    private addDockOnce(cfg: any): void {
        const type = String(cfg?.type || "");
        if (type) {
            // 思源的 dock 项 data-type 有两种形态:裸 type 与 <插件名><type>,都查一遍
            const sel = `.dock__item[data-type="${type}"], .dock__item[data-type="${this.name}${type}"]`;
            try {
                if (document.querySelector(sel)) return;
            } catch {
                // 选择器异常不影响注册
            }
        }
        this.addDock(asSiyuanCustom(cfg));
    }

    /**
     * 移动端注册链。
     *
     * 只注册移动端真正可用的东西:dock 是官方支持的插件载体(思源 plugin/index.ts
     * 的 MOBILE 分支会走 MobileCustom),Dialog 可全屏,Command 无门禁。
     * 页签系统(addTab/openTab)、Monaco、终端、Python LSP、Protyle 正文注入
     * 全部跳过 —— 它们在移动端要么空实现要么没有 Node。
     * 文件打开改走 tabs/mobile-open.ts 的全屏 Dialog。
     */
    private onloadMobile(): void {
        this.pruneStalePluginDocks();
        // 保存快照与删除方式:移动端编辑同样要落历史版本、同样受删除方式约束
        void initFileVersions(this);
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        setTrashMode(this.config.deleteMode || "plugin");

        this.addDockOnce(createRecentDockConfig(this as any));
        this.addDockOnce(createTagDockConfig(this as any));
        this.addDockOnce(createMountTreeDockConfig(this as any));
        this.addDockOnce(createBacklinkDockConfig(this as any));
        this.addDockOnce(createDocPropertiesDockConfig(this as any));
        initDocProperties(this as any);

        onDidSaveModel((path) => {
            clearBacklinkCache();
            emitBacklinkRefresh(path);
        });

        // 图标主题切换后重绘文件树;页签头图标在移动端不存在,不刷
        const onIconThemeChanged = () => this.refreshFileTrees();
        window.addEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged);
        onDispose(() => window.removeEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged));

        this.addCommand({
            langKey: "globalSearch",
            hotkey: "",
            callback: () => this.openSearch(WORKSPACE_ROOT),
        });

        this.settingsPanel = createSettingsPanel({
            title: "虚拟文档树 设置",
            onOpen: () => this.syncSettingUI(),
            onSave: () => this.saveSettings(),
        });
        this.buildSettingItems();
        // startThemeSync 驱动的是 Monaco 主题,移动端没有 Monaco 编辑器,不启动
    }

    onload(): void {
        // 换届自愈(与入口 banner 双保险):摘掉上一轮 bundle 残留的全局资源。
        disposeAllGlobal();
        // 移动端走独立的注册链:桌面 onload 里的 addTab / Monaco / 终端 / Python LSP
        // 在移动端要么空实现要么没有 Node,中途抛错会让思源跳过 kernelInit 与
        // onLayoutReady,连移动端官方支持的 dock 都注册不上(见 utils/platform.ts)。
        if (isMobileFrontend()) {
            this.onloadMobile();
            return;
        }
        // 内置 TextMate 语法(python/js/ts 等官方语法接管着色,不依赖扩展)。
        // 放 onload 最前:布局恢复建模型之前就开始取语法,注册完成后对既有
        // 模型强制重分词(见 loadBuiltinGrammars)。内置先注册、扩展后注册 ——
        // 扩展自带同语言语法时自然覆盖内置
        void loadBuiltinGrammars();
        // 必须在注册 dock 之前:先把改名/卸载留下的僵尸 dock 记录摘掉,
        // 否则它们会和现役 dock 抢同一批 index/position 槽位(见方法注释)
        this.pruneStalePluginDocks();
        // 内核选择的持久化走插件存储(workspace 级),onload 注册
        registerKernelChoicePersistence({
            load: async () => {
                try {
                    return (await this.loadData("kernel-choices")) as Record<string, import("./utils/kernel/registry").KernelChoice> | null;
                } catch {
                    return null;
                }
            },
            save: async (data) => {
                try {
                    await this.saveData("kernel-choices", data);
                } catch {                    // ignore
                }
            },
        });
        // 渲染进程退出(关窗口/刷新)时同步清理内核:L杀进程 + 关 zmq 套接字。
        // 不做的话原生句柄随渲染进程异常卸载,实测触发 0xC0000409 崩溃,
        // 思源下次启动会弹安全模式确认框(20:44 / 21:46 两次崩溃均此模式)。
        const onBeforeUnload = () => {
            try { disposeAllKernelsSync(); } catch { /* ignore */ }
            try { stopPythonLanguageServer(); } catch { /* ignore */ }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        onDispose(() => window.removeEventListener("beforeunload", onBeforeUnload));
        // 启动即加载持久化的内核选择。之前只有笔记本 Tab 会调 loadKernelChoices,
        // 代码块路径直接 getKernel(docKey) → choices 还是空的 → 永远拿到内置内核,
        // 用户选的 conda/Jupyter 环境对代码块完全无效(实测复现过)。
        void loadKernelChoices();
        setupMonaco(this.name);

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
            // CM6 代码块语义接线(编辑态虚拟文档 + 阅读态 colorize 语义覆盖)
            setupBlockSemanticBridge();
        } catch (e) {
            console.warn("[siyuan-file-editor] Python LSP 注册失败:", e);
        }

        // 注册 Tab 类型
        this.addTab(asSiyuanCustom(createEditorTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createImageTabConfig(this as any)));
        // 版本控制:接入独立存储(file-versions.json)并应用保留条数。
        // 必须在任何保存动作发生前完成(保存快照走 saveModel → recordVersion)
        void initFileVersions(this);
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        // 删除方式:onload 里是 DEFAULT_CONFIG 的默认值,onLayoutReady 会按磁盘配置补一次
        setTrashMode(this.config.deleteMode || "plugin");
        // 接管思源文档内打开文件(open-asset/open-link 事件,配置热读,卸载时注销)
        this._unregisterDocOpenTakeover = registerDocOpenTakeover(this as any, () => ({
            mode: this.config.docOpenTakeover || "off",
            exts: this.config.docOpenTakeoverExts || "",
            // 「接管打开用分栏」必须透传:漏了它 handler 里恒为 undefined,
            // position 传不出去,设置项在链接点击路径完全失效(实测踩过)
            takeoverSplitOpen: this.config.takeoverSplitOpen === true,
        }));
        this.addTab(asSiyuanCustom(createOfficeTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createMarkdownTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createMediaTabConfig(this as any)));
        // Jupyter Notebook(.ipynb)查看与编辑
        this.addTab(asSiyuanCustom(createNotebookTabConfig(this as any)));
        // 新标签页(接管顶部「+」后打开的启动台:搜索 + 固定 + 最近打开 + 收藏)
        this.addTab(asSiyuanCustom(createStartTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createSearchTabConfig(this as any)));
        // 版本比较页签(历史版本 ↔ 当前内容,或两个历史版本互比)
        this.addTab(asSiyuanCustom(createDiffTabConfig(this as any)));
        this.addTab(asSiyuanCustom(createTerminalTabConfig(this as any)));
        // 习惯与目标:全屏面板 Tab。工厂必须始终注册(布局恢复可能带着 planner 页签;
        // 功能开关只控制数据引擎与入口可见性,不控制 Tab 工厂)
        this.addTab(asSiyuanCustom(createPlannerTabConfig(this as any)));

        // 注册 Dock
        // 注:「文件」面板默认**不注册**(能力已由「虚拟文档树」面板承接);
        // 若用户在设置里打开 showFileTreeDock,会在 onLayoutReady 补注册(见下)。
        // 侧边栏「最近使用」面板(展示最近打开的文件,点击打开/右键复制链接)
        this.addDockOnce(createRecentDockConfig(this as any));
        // 侧边栏「标签」面板(按标签聚合文件/文件夹,文件夹可就地逐级展开)
        this.addDockOnce(createTagDockConfig(this as any));
        // 侧边栏「虚拟文档树」面板(初始为空,挂载文件/文件夹/思源文档/思源块,支持嵌套)
        this.addDockOnce(createMountTreeDockConfig(this as any));
        // 侧边栏「终端」面板(复用终端 Tab 的 xterm 实现,常驻底部,与终端 Tab 互相独立)
        this.addDockOnce(createTerminalDockConfig(this as any));
        // 侧边栏「双链」面板(入链/出链,跟随当前活动的文件页签)
        this.addDockOnce(createBacklinkDockConfig(this as any));
        // 侧边栏「文档属性」面板(思源文档块属性,跟随当前活动文档)
        this.addDockOnce(createDocPropertiesDockConfig(this as any));
        initDocProperties(this as any);

        // 注册思源编辑器斜杆命令(输入 /file 或 /文件 插入文件链接)
        registerSlashCommands(this, () => this.getFileTreeRoot());

        // 思源文档双链补全:[[ 留给思源原生引用,[[: 弹插件的任意文件补全
        // (落地 [名称](file:///...),支持 :行号 / #标题 与思源块);
        // 浮层上 Esc 可让行给原生 [[。设置里可关,关掉则完全只有原生 [[
        registerDocWikilinkHint(() => this.config.docWikilinkHint !== false);

        // 双链:文件保存后失效反链/出链缓存,并让目标文件已打开的双链面板立即重扫
        // (onDidSaveModel 是统一保存出口:Ctrl+S / 关闭确认 / 命令面板都走这里)
        onDidSaveModel((path) => {
            clearBacklinkCache();
            emitBacklinkRefresh(path);
        });

        // 思源正文 file:// 链接右键菜单:追加「在文件夹树中定位」等
        registerLinkReveal(this);

        // 思源文档正文右键:列出文档引用的外部文件(排除图片);
        // 返回注销函数(页签头监听挂 window,卸载时必须摘除)
        this._unregisterDocExternalFiles = registerDocExternalFilesMenu(this);

        // 思源文档树 / 正文块右键菜单:追加「挂载到虚拟文档树」
        registerMountMenu(this);

        // 正文内 Python 代码块:注入运行按钮 + 代码块下方的输出面板
        registerCodeBlockRun(this);

        // 思源块通过 custom-planner 属性绑定习惯与目标项目(块菜单 + 块旁徽标 + 状态同步)
        registerBlockPlanner(this as any);

        // 接管思源顶部「+」:点击改为打开新标签页(设置里可关闭,恢复原生新建文档);
        // 返回注销函数(onunload 摘除,防止思源重载插件后旧监听残留、点一次开两个标签页)
        this._unregisterNewTabHijack = installNewTabHijack(this as any, () => this.config.newTabReplacePlus !== false);

        // 图标主题就绪/切换:文件树、页签头、新标签页都要按新的主题重画。
        // 扩展是异步加载的,它们首屏渲染时常还没有主题(画出来是思源内置图标),
        // 这里补画一次即可保证「一开始就显示虚拟文档树同款图标」。
        const onIconThemeChanged = () => {
            // 文件树 / 虚拟文档树
            this.refreshFileTrees();
            // 已经打开的插件页签:重刷页签头图标
            refreshAllTabIcons();
        };
        window.addEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged);
        onDispose(() => window.removeEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged));

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

        // 命令:打开习惯与目标面板(功能开关关闭时提示而不是静默)
        this.addCommand({
            langKey: "openPlanner",
            hotkey: "",
            callback: () => {
                if (!isPlannerActive()) {
                    showMessage("「习惯与目标」已在设置中停用", 3000, "info");
                    return;
                }
                openPlannerTab(this as any);
            },
        });

        // 顶栏图标:习惯与目标(勾形)。显隐跟随 plannerEnabled,onLayoutReady/saveSettings 里同步
        this.plannerTopBarIconEl = this.addTopBar({
            icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`,
            title: "习惯与目标",
            position: "right",
            callback: () => {
                if (!isPlannerActive()) {
                    showMessage("「习惯与目标」已在设置中停用", 3000, "info");
                    return;
                }
                openPlannerTab(this as any);
            },
        });

        // 顶栏图标:扩展市场(自定义拼图 SVG,currentColor 自适应工具栏配色)
        // 显隐跟随 config.marketTopBarIcon(默认显示),onLayoutReady 里按配置收起
        this.marketTopBarIconEl = this.addTopBar({
            icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V5H6c-1.1 0-2 .9-2 2v3.8h1.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5H4V17c0 1.1.9 2 2 2h3.8v-1.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V19H17c1.1 0 2-.9 2-2v-3.8h1.5c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z"/></svg>`,
            title: "扩展市场",
            position: "right",
            callback: () => openExtensionMarket(this),
        });

        // 设置面板(VS Code 式:左分类树 + 右内容,自绘 Dialog)
        this.settingsPanel = createSettingsPanel({
            title: "虚拟文档树 设置",
            onOpen: () => this.syncSettingUI(),
            onSave: () => this.saveSettings(),
        });
        this.buildSettingItems();
        // 代码块渲染(并入自 siyuan-plugin-code-render):设置页 + 引擎初始化
        this.addCodeRenderSettingsPage();
        initCodeRender(this);

        // 主题同步
        this.startThemeSync();
    }

    // 注册「文件」侧边栏面板。
    // 该面板默认不注册(见 onload);用户在设置里打开时调用本方法即时生效。
    // 也可以由 openFileTab 在打开文件夹时按需触发(钩子挂在 onload)。
    // 注:思源插件**没有 removeDock**,所以关闭开关后需要重启思源才真正隐藏。
    // 习惯与目标 Dock 同理:启用时补注册,关闭后图标留到下次重启。
    private ensurePlannerDock(): void {
        if (this.config.plannerEnabled === false) return;
        this.addDockOnce(createPlannerDockConfig(this as any) as any);
    }

    // 顶栏「习惯与目标」图标显隐跟随配置(立即生效)
    private applyPlannerTopBarIcon(): void {
        if (!this.plannerTopBarIconEl) return;
        this.plannerTopBarIconEl.style.display = this.config.plannerEnabled === false ? "none" : "";
    }

    // 读取 planner 设置控件值:开关=布尔,数字=夹紧到 [min,max],下拉=字符串
    private readPlannerControl(ctl: HTMLInputElement | HTMLSelectElement, spec: {kind: "switch" | "number" | "select"}): string | number | boolean {
        if (spec.kind === "switch") {
            return (ctl as HTMLInputElement).checked;
        }
        if (spec.kind === "number") {
            const el = ctl as HTMLInputElement;
            const min = el.min === "" ? -Infinity : parseFloat(el.min);
            const max = el.max === "" ? Infinity : parseFloat(el.max);
            const n = parseFloat(el.value);
            if (isNaN(n)) return 0;
            return Math.min(max, Math.max(min, n));
        }
        return (ctl as HTMLSelectElement).value;
    }

    async onLayoutReady(): Promise<void> {
        this.config = await loadConfig(this);
        const mobile = isMobileFrontend();
        // settings.json(VS Code 风格用户设置):优先级高于 config.json。
        // 读完后把值回写进 config,这样所有读 plugin.config 的既有代码都自动拿到最终值,
        // 不需要在各处再加一层"先查 settings.json"的判断。
        try {
            await initUserSettings(this);
            applyUserSettingsToConfig(this.config);
            if (!mobile) {
                // 布局恢复的编辑器可能创建于 settings.json 读取完成之前(读到空值时
                // buildEditorOptions 出的是空选项)→ 这里统一刷一遍已存在的编辑器
                applyEditorOptions();
                // Python 解释器同理:pyright 若在 settings.json 读到之前就启动了,
                // 拿到的是空配置;与 server 已应用值不同则在这里补一次重启
                void maybeRestartForInterpreterChange();
                registerSettingsJsonSchema();
            }
        } catch (e) {
            console.error("[siyuan-file-editor] 加载 settings.json 失败:", e);
        }
        // 布局恢复的 Markdown 页签创建于上面的 loadConfig 之前:挂引擎时读到的还是
        // DEFAULT_CONFIG(vditor),设置 cm6 的用户恢复出来的 live/reading 页签会挂错
        // 引擎(实测:重启后 live 页签全变 vditor)。现在配置与 settings.json 都已就位,
        // 统一重进一遍 —— 引擎挂对的页签是 no-op。
        const mdTabs = ((this.getOpenedTab?.() ?? {})[MARKDOWN_TAB_TYPE] || []) as unknown as MarkdownTabInstance[];
        for (const mdInst of mdTabs) {
            try {
                mdInst._resyncEngineForConfig?.();
            } catch {
                // 单页签重进失败不影响其余页签
            }
        }
        // 顶栏「扩展市场」图标显隐跟随配置(默认显示,配置为 false 时在此收起)
        this.applyMarketTopBarIcon();
        // settings.json 在编辑器里保存后图标显隐跟着变(上面 applyUserSettingsToConfig 已先同步 config)
        registerSettingsChangedHandler(() => this.applyMarketTopBarIcon());
        // 版本控制保留条数以**磁盘配置**为准 —— onload 里那次跑在 loadConfig 之前,
        // 拿到的是 DEFAULT_CONFIG 的值,改设置后不重启也不会生效,必须在这里补一次
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        // 删除方式同理:以磁盘配置为准
        setTrashMode(this.config.deleteMode || "plugin");
        // 关闭未保存行为跟随磁盘配置生效
        setCloseUnsavedAction(this.config.closeUnsavedAction);
        // 文档面包屑与习惯目标都依赖桌面页签/Protyle 注入,移动端跳过
        if (!mobile) {
            // 文档面包屑(并入自 fake-doc-breadcrumb):按总开关启用;启用时会自动给已打开文档补插面包屑
            applyFakeDocBreadcrumb(this as any, this.config.fakeDocBreadcrumbEnabled !== false);
            // 习惯与目标(并入自 siyuan-planner):按总开关启用(读档 + 计时引擎 + 首次迁移),并补注册 Dock
            void applyPlannerEnabled(this as any, this.config.plannerEnabled !== false).then(() => {
                this.ensurePlannerDock();
                this.applyPlannerTopBarIcon();
                // 布局恢复的新标签页早于模块激活,且设置里切换总开关后也要同步:
                // 数据/启用状态就绪后通知新标签页重绘「习惯与目标」速览区
                window.dispatchEvent(new CustomEvent(PLANNER_CHANGED_EVENT));
            });
        }
        // 设置面板控件同步当前值
        this.syncSettingUI();
        // 配置就位后按真实设置重扫文档内属性面板(onload 时 config 还是 DEFAULT_CONFIG)
        notifyDocPropertiesConfigChanged(this as any);
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
            // wikilink 索引读挂载根的 window 注册桥:webpack 分块可能把 mount-tree
            // 模块求值两份,副本的 getRoots() 恒空(loaded=false),补全/索引会拿到
            // 空根 —— 这里把「已加载那份」的读取函数挂到 window 上兜底
            // (project_memory「webpack 分块双实例」同款修法,参 __syfeMonacoBlock)
            (window as any).__syfeMountTreeGetRoots = getRoots;
            // 插件库根常驻在虚拟文档树里(库内条目 = 指向外部路径的链接)
            await ensureLibraryMount(this);
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
        // 加载 Git 仓库配置(GitHub / Gitee 访问令牌;失败不影响其他功能)
        try {
            await initGitRepoStore(this as any);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载 Git 仓库配置失败:", e);
        }
        // 加载插件库注册表(库内链接条目 → 外部路径 + Git 绑定;移动端靠它访问库内容)
        try {
            await initLibraryStore(this as any);
        } catch (e) {
            console.error("[siyuan-file-editor] 加载插件库失败:", e);
        }
        // 记录最近使用的思源文档(必须在 loadRecents 之后注册,否则会被加载结果覆盖)
        this.eventBus.on("switch-protyle", (e: any) => {
            const protyle = e?.detail?.protyle;
            const rootID = protyle?.block?.rootID;
            if (!rootID) return;
            void this.recordRecentDoc(rootID, protyle?.path);
            // 思源文档结构变化(新建文档/新建子文档/重命名/移动)没有独立的
            // docs-changed 事件,但发生后必然会打开目标文档 —— switch-protyle
            // 就是可靠的刷新信号。防抖避免连续切文档时反复重绘;
            // 不刷的后果:虚拟文档树里新建的文档不出现,要手动刷新才看得到(实测)
            if (this._docSwitchRefreshTimer) window.clearTimeout(this._docSwitchRefreshTimer);
            this._docSwitchRefreshTimer = window.setTimeout(() => {
                this._docSwitchRefreshTimer = undefined;
                this.refreshFileTrees();
            }, 800);
        });
        // 加载已安装的 VSCode 扩展(语法/主题/代码片段都服务于 Monaco,移动端用不到)
        if (mobile) return;
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

    // 存储数据被其他前端实例写入(内核对写入者以外的窗口广播 dataChangePlugins)。
    // **必须覆写**:未覆写时思源 lifecycle 会把数据变更升级为整个插件重载
    // (重新执行插件脚本 + onload + onLayoutReady),新窗口与主窗口互相触发,
    // 形成无限乒乓 —— 实测右键"在新窗口打开"文档后 19 秒内完整重载 19 次,
    // 表现为插件面板反复加载、编辑器 tab 被重建到空白。
    // 这里只做定向同步:重读跨窗口最常写的挂载树与最近使用,内容有变化才刷新对应面板。
    async onDataChanged(_reason?: "sync" | "overwrite"): Promise<void> {
        try {
            await reloadMountTreeIfChanged(this as any);
        } catch {
            // ignore
        }
        try {
            await reloadRecentsIfChanged(this as any);
        } catch {
            // ignore
        }
    }

    onunload(): void {
        // 摘掉本轮登记的全局监听器/observer(入口 banner 会在下一轮再兜一次)
        disposeAllGlobal();
        // 习惯与目标:停计时引擎、强制落盘(planner.json 数据保留)
        try {
            destroyPlanner();
        } catch {
            // ignore
        }
        // 块绑定:摘事件、移除所有块旁徽标与选择器
        try {
            destroyBlockPlanner();
        } catch {
            // ignore
        }
        // 文档属性:摘事件、移除所有文档内插入的面板
        try {
            destroyDocProperties();
        } catch {
            // ignore
        }
        // 文档面包屑:摘事件、去样式、移除已插入的面包屑
        try {
            destroyFakeDocBreadcrumb();
        } catch {
            // ignore
        }
        // 代码块渲染:还原被接管的代码块为思源原生高亮
        try {
            destroyCodeRender();
        } catch {
            // ignore
        }
        // 注销文档内文件打开接管的事件监听
        try {
            this._unregisterDocOpenTakeover?.();
            this._unregisterDocExternalFiles?.();
            this._unregisterNewTabHijack?.();
            if (this._docSwitchRefreshTimer) {
                window.clearTimeout(this._docSwitchRefreshTimer);
                this._docSwitchRefreshTimer = undefined;
            }
        } catch {
            // ignore
        }
        // 停掉 Python 语言服务与持久内核:两者都是常驻子进程,
        // 不显式关的话思源禁用插件后它们会一直挂在后台吃内存
        try {
            disposePythonLsp();
        } catch {
            // ignore
        }
        void disposePythonKernel();
        // 注册表里的内核(Jupyter/Legacy,按文档)统一收尾
        void disposeAllKernels();
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

        // 热重载内存泄漏兜底:与 webpack.config.js 的入口 banner 配套。
        // banner 管「新 bundle 被 window.eval 求值之前」,这里管「旧实例卸载时」,
        // 两处都是幂等的软重置(清空数组 + 把 push 恢复成原生方法),目的都是让
        // 上一份 webpack runtime 的 jsonp 回调闭包失去全局引用、可被 GC。
        // 注意**不能 delete 这个全局数组**:飞行中的异步 chunk 脚本形如
        // `(self.webpackChunkXXX = self.webpackChunkXXX || []).push(...)`,删掉后
        // 它会新建一个不受新 runtime 劫持的数组,该 chunk 将永远不被 resolve。
        // 部署旧产物时 banner 不存在,此处是可选调用,静默跳过即可。
        try {
            (self as any).__syfeResetJsonp?.();
        } catch {
            // ignore
        }
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

    // 右键「新建思源文档」:文件与文件夹都可发起。名字默认值:
    // 文件 + 「与文件同名」开启 → 文件主名(去扩展名);其余留空由用户填。
    // 创建位置(笔记本/子路径)在设置里配置,见 siyuan-new-doc.ts。
    // 创建成功后:①把来源路径(内核路径补全成真实绝对路径)追加为文档别名;
    // ②mountParent 提供时(虚拟文档树右键)按右键行的显示父链自动挂载。
    openNewSiyuanDocDialog(path: string, isDir: boolean, mountParent?: () => Promise<string | null>, onMounted?: (parentUid: string) => void): void {
        const defaultName = !isDir && this.config?.newDocSameName !== false ? fileBaseName(path) : "";
        void openCreateSiyuanDocDialog(this as any, defaultName, path, mountParent, onMounted);
    }

    // 设置面板用:刷新「新建思源文档」目标笔记本下拉的选项与当前值
    refreshNewDocSettingUI(): void {
        const sel = this.newDocNotebookSelect;
        if (!sel) return;
        // 注意不要因 sel.isConnected 早退:设置行所在页未打开时 select 尚未挂到 DOM,
        // 但元素对象持久存在,照常填充,页打开时即是就绪状态
        const cur = this.config?.newDocNotebook || "";
        void (async () => {
            let list: any[] = [];
            try {
                list = (await lsNotebooks()) || [];
            } catch {
                list = [];
            }
            const open = list.filter((n: any) => n && n.id && !n.closed);
            const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
            sel.innerHTML = open.length
                ? open.map((n: any) => `<option value="${esc(n.id)}">${esc(String(n.name || n.id))}</option>`).join("")
                : `<option value="">(没有已打开的笔记本)</option>`;
            // 配置的笔记本不可用(已删/已关)时落在第一项,不残留无效 value
            sel.value = open.some((n: any) => n.id === cur) ? cur : (open[0]?.id || "");
        })();
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
        // 内部会派发 ICON_THEME_CHANGED_EVENT,已在下方 onload 统一监听刷新
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

    // 顶栏「扩展市场」图标显隐跟随配置;设置面板保存 / settings.json 变更后调用,立即生效
    private applyMarketTopBarIcon(): void {
        if (!this.marketTopBarIconEl) return;
        this.marketTopBarIconEl.style.display = this.config?.marketTopBarIcon === false ? "none" : "";
    }

    // 构建设置面板页(VS Code 式:左分类树 + 右内容,面板框架见 settings/plugin-settings-dialog.ts)。
    // 普通设置行按页聚合,页 DOM 只构建一次;编辑器页由 editor-settings-ui 提供构建器。
    private buildSettingItems(): void {
        const panel = this.settingsPanel!;
        const pageRows = new Map<string, HTMLElement[]>();
        const addRow = (page: string, title: string, description: string, control: HTMLElement): void => {
            let rows = pageRows.get(page);
            if (!rows) {
                rows = [];
                pageRows.set(page, rows);
            }
            rows.push(settingsRow(title, description, control));
        };
        const addRowsPage = (id: string, label: string, parent?: string): void => {
            const rows = pageRows.get(id) || [];
            const host = document.createElement("div");
            host.className = "syfe-set__page";
            rows.forEach(r => host.appendChild(r));
            panel.addPage({id, label, parent, build: () => host});
        };

        // ---------- 代码编辑器(父页 + 子分类二级树节点) ----------
        // 全部编辑器设置项(自动换行、字体、缩进、光标、导航窗格……)。
        // 这些控件改的是 settings.json,与直接编辑该文件完全等价 —— 见 settings/ 目录。
        panel.addPage({id: "editor", label: "代码编辑器", build: () => buildEditorAllPanel()});
        for (const sub of getEditorSubgroups()) {
            panel.addPage({
                id: "editor:" + sub.name,
                label: `${sub.name} (${sub.count})`,
                parent: "editor",
                build: () => buildEditorGroupPanel(sub.name),
            });
        }

        // ---------- 标签 ----------
        const tagManageBtn = document.createElement("button");
        tagManageBtn.className = "b3-button b3-button--outline";
        tagManageBtn.textContent = "管理标签…";
        tagManageBtn.addEventListener("click", () => {
            openTagManagerDialog(this, () => this.refreshFileTrees());
        });
        addRow("tags", "标签", "管理预设标签(支持嵌套、颜色、图标);在文件树右键条目可打标签,工具栏标签按钮可按标签筛选", tagManageBtn);

        // ---------- 文件与打开 ----------
        // 自定义打开方式(预置 VS Code / Cursor / Windsurf / 记事本 / 资源管理器,可增删改)
        const openWithBtn = document.createElement("button");
        openWithBtn.className = "b3-button b3-button--outline";
        openWithBtn.textContent = "管理打开方式…";
        openWithBtn.addEventListener("click", () => {
            openOpenWithManagerDialog(this, () => this.refreshFileTrees());
        });
        addRow("openFiles", "自定义打开方式", "为文件与文件夹配置「用 XX 打开」的入口(预置 VS Code / Cursor / Windsurf / 记事本 / 资源管理器,可自行增删改命令与参数);配置后出现在文件树、虚拟文档树、搜索结果的右键「打开方式」里", openWithBtn);

        // 接管思源文档内打开文件(open-asset/open-link 事件)
        this.docOpenTakeoverSelect = document.createElement("select");
        this.docOpenTakeoverSelect.className = "b3-select";
        this.docOpenTakeoverSelect.innerHTML =
            `<option value="off">不接管</option>` +
            `<option value="exts">指定扩展名</option>` +
            `<option value="all">全部接管</option>`;
        addRow("openFiles", "接管文档内打开文件", "点击文档里的 assets/ 链接、file:// 或本地路径文件时,改用本插件的编辑器打开(按扩展名自动分派 markdown/图片/媒体/office 页签);仅思源文档内的链接生效", this.docOpenTakeoverSelect);
        this.docOpenTakeoverExtsInput = document.createElement("input");
        this.docOpenTakeoverExtsInput.className = "b3-text-field";
        this.docOpenTakeoverExtsInput.placeholder = "md,txt,log";
        addRow("openFiles", "接管扩展名", "「指定扩展名」模式下生效,逗号分隔,如 md,txt,log;留空则不接管任何类型", this.docOpenTakeoverExtsInput);

        // 关闭未保存标签页时的行为
        this.closeUnsavedSelect = document.createElement("select");
        this.closeUnsavedSelect.className = "b3-select";
        this.closeUnsavedSelect.innerHTML =
            `<option value="ask">每次询问(保存 / 放弃)</option>` +
            `<option value="discard">不提示,直接放弃修改</option>` +
            `<option value="save">不提示,直接保存</option>`;
        addRow("openFiles", "关闭未保存标签页时", "关闭有未保存修改的编辑器 / Markdown / 笔记本 / Office 页签时的行为;「直接放弃」丢失的修改无法找回", this.closeUnsavedSelect);

        // 文档内链接接管打开:是否用分栏
        this.takeoverSplitOpenInput = document.createElement("input");
        this.takeoverSplitOpenInput.type = "checkbox";
        this.takeoverSplitOpenInput.className = "b3-switch";
        addRow("openFiles", "接管打开用分栏", "在思源文档里点击链接被本插件接管打开文件时,用右侧分栏打开(文档与文件同屏);关闭则在当前页签区打开", this.takeoverSplitOpenInput);

        // Markdown 默认模式(对齐 Obsidian:实时预览 / 源码 / 阅读)
        this.markdownModeSelect = document.createElement("select");
        this.markdownModeSelect.className = "b3-select";
        this.markdownModeSelect.innerHTML = `
            <option value="live">实时预览</option>
            <option value="source">源码</option>
            <option value="reading">阅读</option>`;
        addRow("openFiles", "Markdown 默认模式", "打开 .md 文件时的默认模式,Tab 顶部可随时切换。实时预览=边写边渲染(光标行显示源码);源码=纯文本;阅读=完整渲染且只读。超过 512KB 的大文件始终以源码模式打开", this.markdownModeSelect);

        // 全局阅读模式:Markdown 默认只读打开(优先级高于上面的默认模式)
        this.globalReadingModeInput = document.createElement("input");
        this.globalReadingModeInput.type = "checkbox";
        this.globalReadingModeInput.className = "b3-switch";
        addRow("openFiles", "全局阅读模式", "开启后所有 Markdown 文件默认以「阅读」(只读渲染)方式打开,需要编辑时再用页签顶部的按钮切换;关闭则使用上面的「Markdown 默认模式」", this.globalReadingModeInput);

        // Markdown 编辑器引擎(live 态的编辑面;对新开页签生效)
        this.markdownEditorSelect = document.createElement("select");
        this.markdownEditorSelect.className = "b3-select";
        this.markdownEditorSelect.innerHTML = `
            <option value="vditor">Vditor(所见即所得)</option>
            <option value="cm6">CodeMirror 6(源码编辑)</option>`;
        addRow("openFiles", "Markdown 编辑器", "实时预览模式的编辑引擎,对新开页签生效:vditor = 所见即所得(光标行显示源码,其余实时渲染);cm6 = CodeMirror 6 源码编辑(整篇源码 + 语法高亮,大文件更流畅)。阅读模式的渲染引擎由下面的独立设置决定。已有页签按页签顶部按钮重新切换即可应用", this.markdownEditorSelect);

        // 阅读模式引擎:vditor = Vditor wysiwyg 只读;cm6 = CM6 只读富渲染(禁止点击进入编辑)
        this.markdownReadingEngineSelect = document.createElement("select");
        this.markdownReadingEngineSelect.className = "b3-select";
        this.markdownReadingEngineSelect.innerHTML = `
            <option value="vditor">Vditor(静态阅读)</option>
            <option value="cm6">CodeMirror 6(只读富渲染)</option>`;
        addRow("openFiles", "Markdown 阅读模式引擎", "阅读(只读)模式用哪个引擎渲染:vditor = Vditor wysiwyg 只读(旧行为);cm6 = CodeMirror 6 只读富渲染,代码块/公式/表格/图片/页面属性与实时预览同一套渲染,但禁止点击进入编辑(contenteditable=false,点击渲染物不回源码、不挂 Monaco)。对新开页签或重新点「阅读」按钮生效", this.markdownReadingEngineSelect);

        // CM6 代码块 Monaco 渲染/编辑开关(仅 markdownEditor=cm6 的实时预览生效)
        this.cm6CodeBlockMonacoInput = document.createElement("input");
        this.cm6CodeBlockMonacoInput.type = "checkbox";
        this.cm6CodeBlockMonacoInput.className = "b3-switch";
        addRow("openFiles", "CM6 代码块 Monaco 渲染", "Markdown 编辑器 = cm6 时生效:代码块渲染为 Monaco 主题配色卡片(点击进 Monaco 编辑,与代码文件同一套主题和语义着色);关闭后代码块回落为编辑器原生源码行", this.cm6CodeBlockMonacoInput);

        // 导入 Markdown 到思源时,是否把源文件作为资源插入文档顶部的引述块
        this.importMdSourceAssetInput = document.createElement("input");
        this.importMdSourceAssetInput.type = "checkbox";
        this.importMdSourceAssetInput.className = "b3-switch";
        addRow("openFiles", "导入 Markdown:插入源文件资源引述块", "导入 .md 到思源后,把源文件上传为资源,并在文档顶部插入一个引述块链接到它(保留出处,便于回溯原文件);仅对单个 Markdown 文件生效,导入文件夹时不处理", this.importMdSourceAssetInput);

        // 双链扫描:链接源范围(所有文本文件 / 仅 Markdown)
        this.backlinkScanAllTextInput = document.createElement("input");
        this.backlinkScanAllTextInput.type = "checkbox";
        this.backlinkScanAllTextInput.className = "b3-switch";
        addRow("openFiles", "双链:扫描所有文本文件", "反向链接扫描把挂载根下所有文本文件(代码/配置等)里的文件路径与 [[链接]] 都算作引用;关闭后仅扫描 Markdown 文件(超大库可关以提升扫描速度)", this.backlinkScanAllTextInput);

        // 思源文档 [[: 双链补全:[[ 仍归思源原生,插件用独立触发符 [[:
        this.docWikilinkHintInput = document.createElement("input");
        this.docWikilinkHintInput.type = "checkbox";
        this.docWikilinkHintInput.className = "b3-switch";
        addRow("openFiles", "双链:思源文档 [[: 补全", "输入 [[ 仍弹思源原生文档/块引用;输入 [[: 后弹本插件补全,可继续输入筛选全部挂载根下的任意文件,选中后落地为 [名称](file:///路径) 的 Markdown 链接(可被反链扫描识别);支持 名:行号 定位到行、名#标题 定位到标题、文字搜索思源块。补全浮层上按 Esc 可让行给思源原生 [[;关闭本开关则完全只有原生 [[", this.docWikilinkHintInput);

        // 索引白/黑名单:每行一条规则,支持正则;保存后自动失效重建索引
        const makeRuleTextarea = (placeholder: string): HTMLTextAreaElement => {
            const ta = document.createElement("textarea");
            ta.className = "b3-text-field fn__block";
            ta.rows = 5;
            ta.spellcheck = false;
            ta.placeholder = placeholder;
            ta.style.width = "100%";
            ta.style.minHeight = "96px";
            ta.style.fontFamily = "var(--b3-font-family-code, monospace)";
            ta.style.fontSize = "12px";
            ta.style.resize = "vertical";
            return ta;
        };
        this.indexBlacklistInput = makeRuleTextarea("每行一条规则,如 node_modules 或 /\\.tmp$/i");
        addRow("openFiles", "双链:索引黑名单", "每行一条规则,空行与 # 注释忽略;支持 /正则/flags、裸正则、普通子串(不区分大小写)。匹配完整路径 + 每一级目录名 + 文件名,目录命中会跳过整棵子树。默认忽略 node_modules、.git/.svn/.hg、.Trash、$RECYCLE.BIN、System Volume Information,以及思源 data 下的 plugins/widgets/themes/icons/snippets/remnants/history/temp/push/storage/conf;隐藏目录与 .sy 块文件始终跳过。删掉规则即可让它们重新进索引", this.indexBlacklistInput);
        this.indexWhitelistInput = makeRuleTextarea("留空 = 不限制;如 \\.md$ 只索引 Markdown");
        addRow("openFiles", "双链:索引白名单", "每行一条规则(语法同黑名单)。留空不限制;非空时只索引命中的文件,例如 \\.md$ 只索引 Markdown、^E:/notes/ 只索引某目录。白名单不挡目录(否则走不进目标目录),黑名单始终优先", this.indexWhitelistInput);

        // 右键「新建思源文档」:目标位置(笔记本 + 子路径)与文件同名默认
        this.newDocNotebookSelect = document.createElement("select");
        this.newDocNotebookSelect.className = "b3-select";
        this.newDocNotebookSelect.innerHTML = `<option value="">(加载中…)</option>`;
        addRow("openFiles", "新建思源文档:目标笔记本", "在文件树/虚拟文档树右键「新建思源文档」时,文档创建到这个笔记本。配置的笔记本被删除或关闭时自动落到第一个可用笔记本", this.newDocNotebookSelect);
        this.newDocSubPathInput = document.createElement("input");
        this.newDocSubPathInput.className = "b3-text-field";
        this.newDocSubPathInput.placeholder = "如 journal 或 book/golang;留空 = 笔记本根";
        addRow("openFiles", "新建思源文档:子路径", "目标笔记本下的子路径(斜杠分隔多级,不存在时由内核自动创建父级);留空则建在笔记本根", this.newDocSubPathInput);
        this.newDocSameNameInput = document.createElement("input");
        this.newDocSameNameInput.type = "checkbox";
        this.newDocSameNameInput.className = "b3-switch";
        addRow("openFiles", "新建思源文档:与文件同名", "右键的是文件时,新文档名默认取文件主名(去扩展名)预填;关闭则默认留空。文件夹右键始终留空", this.newDocSameNameInput);

        // 虚拟文档树文件右键「挂载思源文档」的落点
        this.fileMountTargetSelect = document.createElement("select");
        this.fileMountTargetSelect.className = "b3-select";
        this.fileMountTargetSelect.innerHTML = `
            <option value="file">挂载到文件下(文档成为文件的子行)</option>
            <option value="folder">挂载到所在文件夹下</option>`;
        addRow("openFiles", "挂载思源文档:文件右键落点", "在虚拟文档树里右键文件选「挂载思源文档」时,文档挂到文件下面(文件会建成挂载行,文档为其子行),还是挂到文件所在的文件夹下。文件夹右键始终挂到该文件夹下", this.fileMountTargetSelect);

        // 版本控制:每文件保留多少个修改前版本
        this.versionKeepCountInput = document.createElement("input");
        this.versionKeepCountInput.className = "b3-text-field";
        this.versionKeepCountInput.type = "number";
        this.versionKeepCountInput.min = "0";
        this.versionKeepCountInput.placeholder = "10";
        addRow("openFiles", "版本控制:保留版本数", "每次保存时自动把修改前的内容存为历史版本(文本文件通用,含代码文件),页签顶部「历史版本」可查看与恢复;0 = 关闭版本控制", this.versionKeepCountInput);

        // ---------- 虚拟文档树 ----------
        // 行末「查看引用」链接图标开关
        this.treeBacklinkIconInput = document.createElement("input");
        this.treeBacklinkIconInput.type = "checkbox";
        this.treeBacklinkIconInput.className = "b3-switch";
        addRow("virtualTree", "显示引用图标", "在「虚拟文档树」行末显示「查看引用」链接图标(鼠标悬停显示),点击可查看引用当前文件/文件夹/文档的反链", this.treeBacklinkIconInput);

        // 引用关系树(移植自 siyuan-virtual-tree)
        this.mountTreeRelationEnabledInput = document.createElement("input");
        this.mountTreeRelationEnabledInput.type = "checkbox";
        this.mountTreeRelationEnabledInput.className = "b3-switch";
        addRow("virtualTree", "引用关系树", "在「虚拟文档树」面板顶部额外显示一棵按文档首块引用关系自动构建的树(被引用方为父,发起引用方为子,自动挑出没有上级的文档作为根)。它是只读的派生视图,不改动你手动挂载的内容", this.mountTreeRelationEnabledInput);

        this.mountTreeRelationSortSelect = document.createElement("select");
        this.mountTreeRelationSortSelect.className = "b3-select";
        this.mountTreeRelationSortSelect.innerHTML = `
            <option value="name">按名称排序</option>
            <option value="weight">按权重排序</option>`;
        addRow("virtualTree", "引用子层级:排序方式", "自动挂载行(引用子层级)的回退排序;在虚拟文档树开拖拽模式拖动后的顺序存在挂载配置里,优先生效", this.mountTreeRelationSortSelect);

        this.mountTreeRelationWeightInput = document.createElement("input");
        this.mountTreeRelationWeightInput.className = "b3-text-field";
        this.mountTreeRelationWeightInput.type = "text";
        this.mountTreeRelationWeightInput.placeholder = "weight";
        addRow("virtualTree", "关系树:权重属性名", "文档自定义属性中用于排序的权重字段名,缺失则权重为 0(仅「按权重排序」时生效)", this.mountTreeRelationWeightInput);

        this.mountTreeRelationPhysicalInput = document.createElement("input");
        this.mountTreeRelationPhysicalInput.type = "checkbox";
        this.mountTreeRelationPhysicalInput.className = "b3-switch";
        addRow("virtualTree", "关系树:包含物理子树", "开启后,文档在思源原生层级的物理子文档也会作为关系树的子节点显示", this.mountTreeRelationPhysicalInput);

        this.mountTreeRelationCaseInput = document.createElement("input");
        this.mountTreeRelationCaseInput.type = "checkbox";
        this.mountTreeRelationCaseInput.className = "b3-switch";
        addRow("virtualTree", "关系树:排序区分大小写", "按名称排序时是否区分大小写", this.mountTreeRelationCaseInput);

        this.mountTreeRelationDepthInput = document.createElement("input");
        this.mountTreeRelationDepthInput.className = "b3-text-field";
        this.mountTreeRelationDepthInput.type = "number";
        this.mountTreeRelationDepthInput.min = "1";
        this.mountTreeRelationDepthInput.placeholder = "8";
        addRow("virtualTree", "关系树:最大递归深度", "构建子树时的最大层数,防止深层引用造成卡顿", this.mountTreeRelationDepthInput);

        this.mountTreeRelationNodesInput = document.createElement("input");
        this.mountTreeRelationNodesInput.className = "b3-text-field";
        this.mountTreeRelationNodesInput.type = "number";
        this.mountTreeRelationNodesInput.placeholder = "500";
        addRow("virtualTree", "关系树:最大节点数", "关系树最多显示多少个文档,超出则停止构建", this.mountTreeRelationNodesInput);

        this.mountTreeRelationExpandInput = document.createElement("input");
        this.mountTreeRelationExpandInput.className = "b3-text-field";
        this.mountTreeRelationExpandInput.type = "number";
        this.mountTreeRelationExpandInput.placeholder = "1";
        addRow("virtualTree", "关系树:默认展开层级", "0 = 全部折叠,-1 = 全部展开,N = 展开前 N 层(修改后点「刷新」生效)", this.mountTreeRelationExpandInput);

        // ---------- 文档面包屑 ----------
        // 总开关:并入自 fake-doc-breadcrumb 模块;关闭后立即摘除已插入的面包屑并停止监听
        this.fakeDocBreadcrumbEnabledInput = document.createElement("input");
        this.fakeDocBreadcrumbEnabledInput.type = "checkbox";
        this.fakeDocBreadcrumbEnabledInput.className = "b3-switch";
        addRow("docBreadcrumb", "启用文档面包屑", "在思源文档顶部插入一行「文档面包屑」:显示笔记本与文档路径层级,点击层级打开文档,点「>」展开同层子文档菜单,右侧可显示上一篇/下一篇;并附带「新开页签不恢复聚焦」「块面包屑仅显示标题」「点击路径滚动定位」等增强。关闭后立即移除已插入的面包屑并停止监听", this.fakeDocBreadcrumbEnabledInput);

        // 细分设置:原独立对话框的 23 项直接铺进本页;文案复用模块 i18n(标题/描述/下拉选项)
        // 设置存模块自己的 fake-doc-breadcrumb-settings.json,保存走 saveFakeDocBreadcrumbSettings(立即生效)
        initFdbLanguage();
        const fdbStrip = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, "");
        const fdbSpec: Array<{key: string; kind: "switch" | "number" | "select"; min?: number; max?: number; options?: string[]}> = [
            {key: "docMaxNum", kind: "number", min: 0, max: 1024},
            {key: "nameMaxLength", kind: "number", min: 0, max: 1024},
            {key: "showNotebook", kind: "switch"},
            {key: "showRoot", kind: "switch"},
            {key: "typeHide", kind: "switch"},
            // oneLineBreadcrumb(与块面包屑同行)不暴露:上游已标记废弃,保持默认关闭的休眠状态
            {key: "foldedFrontShow", kind: "number", min: 0, max: 8},
            {key: "foldedEndShow", kind: "number", min: 0, max: 8},
            {key: "allowFloatWindow", kind: "switch"},
            {key: "usePluginArrow", kind: "switch"},
            {key: "notOnlyOpenDocs", kind: "switch"},
            {key: "preferOpenInCurrentSplit", kind: "switch"},
            {key: "icon", kind: "select", options: ["0", "1", "2"]},
            {key: "immediatelyUpdate", kind: "switch"},
            {key: "menuExtendSubDocDepth", kind: "number", min: 1, max: 7},
            {key: "swapClickFunction", kind: "switch"},
            {key: "showAdjacentDocButton", kind: "select", options: ["0", "1", "2"]},
            {key: "createDocBtnInMenu", kind: "switch"},
            {key: "noFocusRestore", kind: "switch"},
            {key: "headingOnlyBreadcrumb", kind: "switch"},
            {key: "bdClickScroll", kind: "switch"},
            {key: "docIconScrollTop", kind: "switch"},
            {key: "showCurrentDocName", kind: "switch"},
        ];
        for (const spec of fdbSpec) {
            const title = fdbStrip(fdbLang[`setting_${spec.key}_name`]) || spec.key;
            const desc = fdbStrip(fdbLang[`setting_${spec.key}_desp`]);
            let ctl: HTMLInputElement | HTMLSelectElement;
            if (spec.kind === "switch") {
                const input = document.createElement("input");
                input.type = "checkbox";
                input.className = "b3-switch";
                ctl = input;
            } else if (spec.kind === "number") {
                const input = document.createElement("input");
                input.type = "number";
                input.className = "b3-text-field";
                if (spec.min != null) input.min = String(spec.min);
                if (spec.max != null) input.max = String(spec.max);
                ctl = input;
            } else {
                const select = document.createElement("select");
                select.className = "b3-select";
                for (const v of spec.options ?? []) {
                    const opt = document.createElement("option");
                    opt.value = v;
                    opt.textContent = fdbStrip(fdbLang[`setting_${spec.key}_option_${v}`]) || v;
                    select.appendChild(opt);
                }
                ctl = select;
            }
            this.fdbControls[spec.key] = ctl;
            addRow("docBreadcrumb", title, desc, ctl);
        }

        // ---------- 习惯与目标 ----------
        // 总开关:并入自 siyuan-planner 模块;关闭后停计时引擎并落盘,Dock 图标需重启思源才消失
        this.plannerEnabledInput = document.createElement("input");
        this.plannerEnabledInput.type = "checkbox";
        this.plannerEnabledInput.className = "b3-switch";
        addRow("planner", "启用习惯与目标", "习惯打卡、目标进度、任务与待办、番茄/正计时/倒计时、倒数日。数据存插件的 planner.json;关闭后停用计时引擎并停止记录,数据保留,侧边栏 Dock 图标需重启思源才消失", this.plannerEnabledInput);

        // 细分设置:与独立版设置对话框同一存储(planner.json 的 settings 段),改动即时生效
        const plStrip = (s: unknown) => String(s ?? "");
        const plannerSpec: Array<{key: string; label: keyof typeof PLANNER_LABELS; kind: "switch" | "number" | "select"; min?: number; max?: number; options?: Array<[string, string]>}> = [
            {key: "pomodoro.focus", label: "plFocus", kind: "number", min: 1, max: 120},
            {key: "pomodoro.short", label: "plShort", kind: "number", min: 1, max: 60},
            {key: "pomodoro.long", label: "plLong", kind: "number", min: 1, max: 60},
            {key: "pomodoro.longEvery", label: "plLongEvery", kind: "number", min: 2, max: 8},
            {key: "pomodoro.autoStartBreak", label: "plAutoBreak", kind: "switch"},
            {key: "pomodoro.autoStartNext", label: "plAutoNext", kind: "switch"},
            {key: "defaultCountdownMin", label: "plCountdownMin", kind: "number", min: 1, max: 180},
            {key: "notify", label: "plNotify", kind: "switch"},
            {key: "remindersEnabled", label: "plReminders", kind: "switch"},
            {key: "sound", label: "plSound", kind: "switch"},
            {key: "weekStart", label: "plWeekStart", kind: "select", options: [["1", "周一"], ["0", "周日"]]},
            {key: "heatmapWeeks", label: "plHeatmapWeeks", kind: "number", min: 4, max: 52},
        ];
        const PLANNER_LABELS: Record<string, [string, string]> = {
            plFocus: ["番茄专注时长(分钟)", "一个专注番茄的分钟数;完成一个番茄记一次专注统计"],
            plShort: ["短休时长(分钟)", "两个番茄之间的短休息"],
            plLong: ["长休时长(分钟)", "每完成一组番茄后的长休息"],
            plLongEvery: ["长休间隔(番茄数)", "每完成多少个番茄进入一次长休息"],
            plAutoBreak: ["自动开始休息", "番茄结束后自动进入休息倒计时"],
            plAutoNext: ["自动开始下一个番茄", "休息结束后自动开始下一个专注"],
            plCountdownMin: ["倒计时默认分钟", "计时页倒计时模式的默认时长"],
            plNotify: ["结束时系统通知", "番茄/倒计时结束弹系统通知(不只是应用内提示)"],
            plReminders: ["任务/习惯提醒", "任务的提醒时间、习惯的每日提醒到点时发系统通知(每个实体每天一次);在任务/习惯编辑表单里设置提醒时间"],
            plSound: ["结束提示音", "计时结束时播放提示音(WebAudio 合成,无资源文件)"],
            plWeekStart: ["一周起始日", "统计与日历的周起始日"],
            plHeatmapWeeks: ["热力图周数", "习惯统计热力图显示的周数"],
        };
        for (const spec of plannerSpec) {
            const [title, desc] = PLANNER_LABELS[spec.label];
            let ctl: HTMLInputElement | HTMLSelectElement;
            if (spec.kind === "switch") {
                const input = document.createElement("input");
                input.type = "checkbox";
                input.className = "b3-switch";
                ctl = input;
            } else if (spec.kind === "number") {
                const input = document.createElement("input");
                input.type = "number";
                input.className = "b3-text-field";
                if (spec.min != null) input.min = String(spec.min);
                if (spec.max != null) input.max = String(spec.max);
                ctl = input;
            } else {
                const select = document.createElement("select");
                select.className = "b3-select";
                for (const [v, label] of spec.options ?? []) {
                    const opt = document.createElement("option");
                    opt.value = v;
                    opt.textContent = label;
                    select.appendChild(opt);
                }
                ctl = select;
            }
            // 即时保存:planner 设置与宿主 config 无关,变更直接写 planner.json 并广播刷新
            ctl.addEventListener("change", () => {
                const patch: Record<string, unknown> = {};
                const topKey = spec.key.split(".")[0];
                if (spec.key.startsWith("pomodoro.")) {
                    const sub = spec.key.split(".")[1];
                    const cur = getPlannerSettings().pomodoro as unknown as Record<string, unknown>;
                    patch.pomodoro = {...cur};
                    (patch.pomodoro as Record<string, unknown>)[sub] = this.readPlannerControl(ctl, spec);
                } else {
                    patch[topKey] = this.readPlannerControl(ctl, spec);
                }
                updatePlannerSettings(this as any, patch as any);
            });
            this.plannerControls[spec.key] = ctl;
            addRow("planner", title, desc, ctl);
        }

        // 数据管理:导入/导出/示例数据/清空(沿用独立版设置对话框的数据区)
        const plannerDataBtn = document.createElement("button");
        plannerDataBtn.className = "b3-button b3-button--outline";
        plannerDataBtn.textContent = "数据管理…";
        plannerDataBtn.addEventListener("click", () => openPlannerSettingsDialog(this as any));
        addRow("planner", "数据管理", "导出/导入 planner.json、一键生成示例数据、清空全部数据;设置项的完整对话框也可在此打开", plannerDataBtn);

        // ---------- 百度网盘 ----------
        const bdPanBtn = document.createElement("button");
        bdPanBtn.className = "b3-button b3-button--outline";
        bdPanBtn.textContent = "百度网盘账号…";
        bdPanBtn.addEventListener("click", () => openBaiduPanDialog());
        addRow("baiduPan", "百度网盘", "接入方式:官方 API(推荐,开放平台 AppKey/SecretKey + 设备码授权,未过审仅能访问 /apps/应用名/ 目录)或网页 Cookie(全盘 + 同步空间,非官方)。配置后点击文件树工具栏云图标挂载网盘目录,支持浏览、编辑并保存回网盘", bdPanBtn);

        // ---------- Git 仓库 ----------
        const gitRepoBtn = document.createElement("button");
        gitRepoBtn.className = "b3-button b3-button--outline";
        gitRepoBtn.textContent = "Git 仓库令牌…";
        gitRepoBtn.addEventListener("click", () => openGitRepoDialog({title: "Git 仓库(GitHub / Gitee)"}));
        addRow("gitRepo", "Git 仓库", "把 GitHub / Gitee 仓库的某个分支挂进虚拟文档树:可浏览、编辑,保存即提交回该分支(新建/删除/改名同样提交)。公开仓库不填令牌也能浏览(匿名 60 次/小时),私有仓库与写回提交需要令牌。在文件树空白处右键 →「挂载 GitHub 仓库 / 挂载 Gitee 仓库」", gitRepoBtn);

        // ---------- 插件库 ----------
        // 库内条目是指向外部真实路径的正向链接,库内与外部是同一份数据:
        // 取消同步永远只摘链接,这里选的是「顺带怎么处理已绑定的 Git 远端」。
        this.libraryUnlinkModeSelect = document.createElement("select");
        this.libraryUnlinkModeSelect.className = "b3-select";
        this.libraryUnlinkModeSelect.innerHTML = `
            <option value="push">先推送本地改动到远端,再解绑(推荐)</option>
            <option value="keep">直接解绑,远端保持原样</option>
            <option value="deleteRemote">解绑并在远端删除该条目(外部文件仍保留)</option>`;
        addRow("library", "取消同步:远端处理方式", "在插件库里右键条目选「取消同步」时,只移除库内链接,外部文件与文件夹一个字节都不动。这里决定已绑定的 Git 远端仓库怎么处理:先推送(不丢改动)、原样保留,或在远端提交一次删除(仍可从 Git 历史恢复)。未绑定远端的条目不受此设置影响", this.libraryUnlinkModeSelect);

        // ---------- 文件树 ----------
        // 搜索最大文件大小
        this.searchMaxSizeInput = document.createElement("input");
        this.searchMaxSizeInput.className = "b3-text-field";
        this.searchMaxSizeInput.type = "number";
        this.searchMaxSizeInput.min = "100";
        this.searchMaxSizeInput.max = "10240";
        addRow("fileTree", "搜索最大文件大小(KB)", "超过此大小的文件不参与搜索", this.searchMaxSizeInput);

        // 本地搜索服务地址:全局搜索面板的「Everything」「AnyTXT」两个范围用
        this.searchEverythingUrlInput = document.createElement("input");
        this.searchEverythingUrlInput.className = "b3-text-field";
        this.searchEverythingUrlInput.type = "text";
        this.searchEverythingUrlInput.placeholder = "http://127.0.0.1:80";
        addRow("fileTree", "Everything 服务地址", "全局搜索范围「Everything」连接的 voidtools Everything HTTP 服务,全盘秒搜文件名。需在 Everything「工具→选项→HTTP 服务器」中启用(默认关闭,端口默认 80)", this.searchEverythingUrlInput);

        this.searchAnytxtUrlInput = document.createElement("input");
        this.searchAnytxtUrlInput.className = "b3-text-field";
        this.searchAnytxtUrlInput.type = "text";
        this.searchAnytxtUrlInput.placeholder = "http://127.0.0.1:9920";
        addRow("fileTree", "AnyTXT 服务地址", "全局搜索范围「AnyTXT」连接的 AnyTXT Searcher 内建 SDK 服务(JSON-RPC),全盘全文搜索。桌面端保持 AnyTXT 运行即可;刚启动还在建索引时可能搜不到东西", this.searchAnytxtUrlInput);

        // 文件树根目录
        this.fileTreeRootInput = document.createElement("input");
        this.fileTreeRootInput.className = "b3-text-field";
        this.fileTreeRootInput.type = "text";
        this.fileTreeRootInput.placeholder = "/data 或 E:\\HOME\\BaiduSyncdisk";
        addRow("fileTree", "文件树根目录", "文件管理器 Dock 默认打开的目录路径。思源工作空间内填 /data 或 /data/public;工作空间外填系统绝对路径(如 E:\\HOME\\BaiduSyncdisk,仅桌面端支持)", this.fileTreeRootInput);

        // 删除方式:回收站二选一(没有"直接删除";环境不支持时删除会中止并提示)
        this.deleteModeSelect = document.createElement("select");
        this.deleteModeSelect.className = "b3-select";
        this.deleteModeSelect.innerHTML = `
            <option value="plugin">插件回收站(推荐,可一键恢复)</option>
            <option value="system">系统回收站</option>`;
        addRow("fileTree", "删除方式", "文件/文件夹删除时移入对应回收站:插件回收站按原路径镜像存放(工作空间 .siyuan/virtual-tree-trash),可随时恢复;系统回收站由操作系统管理。百度网盘文件始终走网盘删除(由网盘回收站兜底)", this.deleteModeSelect);

        // 回收站管理入口:查看/恢复/彻底删除/清空
        const trashManageBtn = document.createElement("button");
        trashManageBtn.className = "b3-button b3-button--outline";
        trashManageBtn.textContent = "打开回收站…";
        trashManageBtn.addEventListener("click", () => {
            openTrashDialog(this as any);
        });
        addRow("fileTree", "回收站", "查看插件回收站内容,可恢复到原位置、彻底删除或清空;删除方式为「系统回收站」时请到系统回收站里恢复", trashManageBtn);

        // ---------- 终端 ----------
        this.terminalBackendSelect = document.createElement("select");
        this.terminalBackendSelect.className = "b3-select";
        this.terminalBackendSelect.innerHTML = `
            <option value="auto">自动(推荐)</option>
            <option value="builtin">内置(开箱即用)</option>
            <option value="server">外部服务(完整 PTY)</option>`;
        addRow("terminal", "终端后端", "内置:直接在思源中启动 shell,无需额外服务(不支持 vim/htop 等全屏交互程序)。外部服务:需启动 scripts/start-terminal.bat,支持完整 PTY 交互。自动:桌面端优先内置", this.terminalBackendSelect);

        this.terminalServerUrlInput = document.createElement("input");
        this.terminalServerUrlInput.className = "b3-text-field";
        this.terminalServerUrlInput.type = "text";
        this.terminalServerUrlInput.placeholder = "ws://127.0.0.1:9800";
        addRow("terminal", "终端服务地址", "仅「外部服务」模式需要。需先启动服务:双击 scripts/start-terminal.bat 或运行 node scripts/terminal-server.js", this.terminalServerUrlInput);

        this.siyuanWorkspacePathInput = document.createElement("input");
        this.siyuanWorkspacePathInput.className = "b3-text-field";
        this.siyuanWorkspacePathInput.type = "text";
        this.siyuanWorkspacePathInput.placeholder = "留空则自动检测";
        addRow("terminal", "思源工作空间路径", "思源工作空间在文件系统中的绝对路径,用于将终端工作目录从 /data/... 转换为系统路径。留空则自动从思源配置获取", this.siyuanWorkspacePathInput);

        this.terminalShellSelect = document.createElement("select");
        this.terminalShellSelect.className = "b3-select";
        this.terminalShellSelect.innerHTML = `
            <option value="auto">自动检测</option>
            <option value="pwsh">PowerShell 7</option>
            <option value="powershell">Windows PowerShell</option>
            <option value="cmd">命令提示符 (cmd)</option>
            <option value="bash">Git Bash</option>`;
        addRow("terminal", "终端 Shell", "集成终端使用的 shell 程序,需重启终端 Tab 后生效", this.terminalShellSelect);

        this.terminalShowStatusBarInput = document.createElement("input");
        this.terminalShowStatusBarInput.type = "checkbox";
        this.terminalShowStatusBarInput.className = "b3-switch";
        addRow("terminal", "显示终端状态栏", "终端顶部的「目录 / 已连接 / PTY / 重启按钮」一行,默认隐藏以腾出终端空间;改动立即对已打开的终端生效。隐藏后重启按钮也不可用,关闭页签重开即可重启", this.terminalShowStatusBarInput);

        // ---------- 外观 ----------
        this.colorThemeSelect = document.createElement("select");
        this.colorThemeSelect.className = "b3-select";
        this.colorThemeSelect.innerHTML = `<option value="">自动(优先扩展主题)</option>`;
        addRow("appearance", "代码主题", "Monaco 编辑器配色主题。安装主题类扩展(如 One Light)后可在此选择,保存后立即生效", this.colorThemeSelect);

        this.iconThemeSelect = document.createElement("select");
        this.iconThemeSelect.className = "b3-select";
        this.iconThemeSelect.innerHTML = `<option value="">自动(使用第一个图标主题)</option>`;
        addRow("appearance", "图标主题", "文件树与 Tab 的文件/文件夹图标。安装图标类扩展(如 Material Icon Theme)后可在此选择,保存后立即生效", this.iconThemeSelect);

        // 顶栏「扩展市场」图标显隐
        this.marketTopBarIconInput = document.createElement("input");
        this.marketTopBarIconInput.type = "checkbox";
        this.marketTopBarIconInput.className = "b3-switch";
        addRow("appearance", "顶栏「扩展市场」图标", "顶栏右侧的拼图图标,点击打开扩展市场;隐藏后仍可用命令面板或快捷键 ⇧⌘E 打开,保存后立即生效", this.marketTopBarIconInput);

        // ---------- 音视频播放器 ----------
        // 快捷键录入控件:点击输入框后直接按组合键(纯修饰键等待,Esc 取消);× 清空 = 禁用
        const makeHotkeyInput = (): {wrap: HTMLElement; input: HTMLInputElement} => {
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.type = "text";
            input.style.width = "140px";
            input.placeholder = "点击后按键录入";
            input.addEventListener("keydown", (e: KeyboardEvent) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") {
                    input.blur();
                    return;
                }
                const combo = hotkeyFromEvent(e);
                if (!combo) return; // 纯修饰键:等待主键
                input.value = combo;
                input.blur();
            });
            const clearBtn = document.createElement("button");
            clearBtn.className = "b3-button b3-button--text";
            clearBtn.textContent = "×";
            clearBtn.title = "清空(禁用该快捷键)";
            clearBtn.addEventListener("click", () => {
                input.value = "";
                input.focus();
            });
            const wrap = document.createElement("span");
            wrap.style.display = "inline-flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "4px";
            wrap.appendChild(input);
            wrap.appendChild(clearBtn);
            return {wrap, input};
        };
        const markHotkey = makeHotkeyInput();
        this.mediaHotkeyMarkInput = markHotkey.input;
        addRow("media", "时间戳打点快捷键", "音视频播放器页签可见时按此键在当前时间打点。点击输入框后直接按组合键录入(Esc 取消,× 清空 = 禁用);播放器工具栏按钮提示会同步显示", markHotkey.wrap);
        const insertHotkey = makeHotkeyInput();
        this.mediaHotkeyInsertInput = insertHotkey.input;
        addRow("media", "时间戳插入笔记快捷键", "按此键把当前时间戳的 Markdown 链接插入旁边可见笔记页签的光标处(分屏记笔记),没有可编辑笔记页签时复制到剪贴板。带修饰键的组合在笔记里打字时也可用;纯字母键在编辑器里让位给打字", insertHotkey.wrap);

        // ---------- 新标签页 ----------
        this.newTabReplacePlusInput = document.createElement("input");
        this.newTabReplacePlusInput.type = "checkbox";
        this.newTabReplacePlusInput.className = "b3-switch";
        addRow("newTab", "接管顶部「+」", "开启后,点击思源顶部的「+」不再新建文档,而是打开插件「新标签页」(搜索文件 + 固定 + 最近打开 + 收藏)。页内「新建思源文档」按钮保留原生新建能力", this.newTabReplacePlusInput);

        this.newTabShowPinnedInput = document.createElement("input");
        this.newTabShowPinnedInput.type = "checkbox";
        this.newTabShowPinnedInput.className = "b3-switch";
        addRow("newTab", "显示「固定」", "固定区钉在页顶,可在文件树右键「固定到新标签页」添加", this.newTabShowPinnedInput);

        this.newTabShowRecentInput = document.createElement("input");
        this.newTabShowRecentInput.type = "checkbox";
        this.newTabShowRecentInput.className = "b3-switch";
        addRow("newTab", "显示「最近打开」", "最近打开的文件与思源文档(来自「最近使用」列表)", this.newTabShowRecentInput);

        this.newTabShowFavoritesInput = document.createElement("input");
        this.newTabShowFavoritesInput.type = "checkbox";
        this.newTabShowFavoritesInput.className = "b3-switch";
        addRow("newTab", "显示「收藏」", "收藏区,可在文件树右键「收藏」添加", this.newTabShowFavoritesInput);

        this.newTabShowPlannerInput = document.createElement("input");
        this.newTabShowPlannerInput.type = "checkbox";
        this.newTabShowPlannerInput.className = "b3-switch";
        addRow("newTab", "显示「习惯与目标」", "目标进度、今日习惯(可点打卡)、倒数日、当月日历的速览卡片;需先启用「习惯与目标」模块", this.newTabShowPlannerInput);

        this.newTabSectionOrderInput = document.createElement("input");
        this.newTabSectionOrderInput.className = "b3-text-field";
        this.newTabSectionOrderInput.type = "text";
        this.newTabSectionOrderInput.placeholder = "pinned,recent,favorites,planner";
        addRow("newTab", "分区顺序", "逗号分隔调整各分区先后顺序:pinned(固定) / recent(最近打开) / favorites(收藏) / planner(习惯与目标)。未写出的分区补在末尾,隐藏的自动跳过", this.newTabSectionOrderInput);

        this.newTabItemSortSelect = document.createElement("select");
        this.newTabItemSortSelect.className = "b3-select";
        this.newTabItemSortSelect.innerHTML = `
            <option value="time">时间倒序</option>
            <option value="name">按名称</option>
            <option value="type">按类型(扩展名)</option>`;
        addRow("newTab", "条目排序", "固定 / 最近打开 / 收藏区内条目的排序方式;时间倒序为旧行为", this.newTabItemSortSelect);

        this.newTabPlannerOrderInput = document.createElement("input");
        this.newTabPlannerOrderInput.className = "b3-text-field";
        this.newTabPlannerOrderInput.type = "text";
        this.newTabPlannerOrderInput.placeholder = "goals,habits,countdowns,calendar";
        addRow("newTab", "习惯与目标卡片顺序", "逗号分隔:goals(目标) / habits(习惯) / countdowns(倒数日) / calendar(日历);未写出的卡片补在末尾", this.newTabPlannerOrderInput);

        // ---------- 文档属性 ----------
        this.docPropertiesShowInDocInput = document.createElement("input");
        this.docPropertiesShowInDocInput.type = "checkbox";
        this.docPropertiesShowInDocInput.className = "b3-switch";
        addRow("docProperties", "在文档里显示属性面板", "开启后在思源文档标题下方插入可编辑的属性面板(位于标题区、正文之外,不会污染文档内容);关闭后仍可用侧边功能栏的「文档属性」面板。默认关闭", this.docPropertiesShowInDocInput);

        this.docPropertiesSchemaInput = document.createElement("textarea");
        this.docPropertiesSchemaInput.className = "b3-text-field";
        this.docPropertiesSchemaInput.rows = 6;
        this.docPropertiesSchemaInput.placeholder = "status=select:未开始,进行中,完成\ndue=date\npriority=number";
        addRow("docProperties", "属性类型配置", "每行一条:属性名=类型:选项(多个选项用逗号分隔),例「status=select:未开始,进行中,完成」。⚠ 属性名只能用小写英文字母/数字/连字符且以字母开头(思源内核限制),存为 custom-<属性名>。类型:text 文本 / number 数字 / checkbox 复选框 / date 日期 / datetime 日期时间 / tags 标签 / select 下拉 / link 链接。未配置的属性按文本处理;属性名与属性值都有自动补全", this.docPropertiesSchemaInput);

        // ---------- 运行内核 ----------
        // 默认运行内核:代码块(内核模式)/py 文件 ▶ 运行/ipynb 共用的全局兜底环境。
        // 选项含内置内核 + 本机全部 Jupyter kernelspec + conda 环境自动扫描结果
        this.kernelDefaultSelect = document.createElement("select");
        this.kernelDefaultSelect.className = "b3-select";
        this.kernelDefaultSelect.innerHTML = `<option value="syfe">内置 Python 内核</option>`;
        addRow("jupyter", "默认运行内核", "代码块(内核模式)、py 文件的 ▶ 运行、ipynb 在没有单独选过内核时,都用这个环境。conda 环境无需注册 kernelspec(自动扫描,环境需装有 ipykernel);单个文档/笔记本仍可在内核菜单里另行选择,会覆盖此默认", this.kernelDefaultSelect);
        void (async () => {
            // 异步填充动态选项并回显当前全局默认
            try {
                await loadKernelChoices();
                const specs = await listKernelSpecs();
                for (const spec of specs) {
                    const choice = {kind: "jupyter" as const, specName: spec.name, specResourceDir: spec.resourceDir};
                    const opt = document.createElement("option");
                    opt.value = JSON.stringify(choice);
                    const display = spec.displayName || spec.name;
                    opt.textContent = display.startsWith("conda:") ? display : `Jupyter · ${display}`;
                    this.kernelDefaultSelect!.appendChild(opt);
                }
            } catch {
                // 列不出来就只有内置内核一项
            }
            const cur = getKernelChoice(DEFAULT_KERNEL_ID);
            if (cur && cur.kind === "jupyter") {
                for (const opt of Array.from(this.kernelDefaultSelect!.options)) {
                    try {
                        const v = JSON.parse(opt.value);
                        if (v.specName === cur.specName) { this.kernelDefaultSelect!.value = opt.value; break; }
                    } catch {
                        // 忽略非法值
                    }
                }
            }
        })();

        // ---------- 页面注册(树顺序) ----------
        addRowsPage("appearance", "外观");
        addRowsPage("openFiles", "文件与打开");
        addRowsPage("media", "音视频播放器");
        addRowsPage("virtualTree", "虚拟文档树");
        addRowsPage("docBreadcrumb", "文档面包屑");
        addRowsPage("planner", "习惯与目标");
        addRowsPage("tags", "标签");
        addRowsPage("fileTree", "文件树");
        addRowsPage("baiduPan", "百度网盘");
        addRowsPage("gitRepo", "Git 仓库");
        addRowsPage("library", "插件库");
        addRowsPage("terminal", "终端");
        addRowsPage("newTab", "新标签页");
        addRowsPage("docProperties", "文档属性");
        addRowsPage("jupyter", "运行内核");
    }

    // 同步设置面板控件值为当前配置
    private syncSettingUI(): void {
        if (this.closeUnsavedSelect) this.closeUnsavedSelect.value = this.config.closeUnsavedAction || "ask";
        if (this.takeoverSplitOpenInput) this.takeoverSplitOpenInput.checked = this.config.takeoverSplitOpen === true;
        if (this.treeBacklinkIconInput) this.treeBacklinkIconInput.checked = this.config.treeBacklinkIcon !== false;
        if (this.backlinkScanAllTextInput) this.backlinkScanAllTextInput.checked = this.config.filesBacklinkScanAllText !== false;
        if (this.docWikilinkHintInput) this.docWikilinkHintInput.checked = this.config.docWikilinkHint !== false;
        if (this.indexBlacklistInput) this.indexBlacklistInput.value = this.config.indexBlacklist ?? "";
        if (this.indexWhitelistInput) this.indexWhitelistInput.value = this.config.indexWhitelist ?? "";
        if (this.searchMaxSizeInput) {
            this.searchMaxSizeInput.value = String(Math.round(this.config.searchMaxFileSize / 1024));
        }
        if (this.fileTreeRootInput) this.fileTreeRootInput.value = this.config.fileTreeRoot;
        if (this.searchEverythingUrlInput) this.searchEverythingUrlInput.value = this.config.searchEverythingUrl || DEFAULT_CONFIG.searchEverythingUrl;
        if (this.searchAnytxtUrlInput) this.searchAnytxtUrlInput.value = this.config.searchAnytxtUrl || DEFAULT_CONFIG.searchAnytxtUrl;
        if (this.terminalBackendSelect) this.terminalBackendSelect.value = this.config.terminalBackend || "auto";
        if (this.terminalServerUrlInput) this.terminalServerUrlInput.value = this.config.terminalServerUrl;
        if (this.siyuanWorkspacePathInput) this.siyuanWorkspacePathInput.value = this.config.siyuanWorkspacePath;
        if (this.terminalShellSelect) this.terminalShellSelect.value = this.config.terminalShell || "auto";
        if (this.terminalShowStatusBarInput) this.terminalShowStatusBarInput.checked = this.config.terminalShowStatusBar === true;
        if (this.markdownModeSelect) this.markdownModeSelect.value = this.config.markdownDefaultMode || "live";
        if (this.markdownEditorSelect) this.markdownEditorSelect.value = this.config.markdownEditor || "vditor";
        if (this.markdownReadingEngineSelect) this.markdownReadingEngineSelect.value = this.config.markdownReadingEngine || "vditor";
        if (this.cm6CodeBlockMonacoInput) this.cm6CodeBlockMonacoInput.checked = this.config.cm6CodeBlockMonaco !== false;
        if (this.globalReadingModeInput) this.globalReadingModeInput.checked = this.config.globalReadingMode !== false;
        if (this.versionKeepCountInput) this.versionKeepCountInput.value = String(this.config.versionKeepCount ?? 10);
        if (this.deleteModeSelect) this.deleteModeSelect.value = this.config.deleteMode || "plugin";
        // 音视频快捷键:显示规范化串(空 = 禁用)
        if (this.mediaHotkeyMarkInput) this.mediaHotkeyMarkInput.value = formatHotkey(this.config.mediaHotkeyMark);
        if (this.mediaHotkeyInsertInput) this.mediaHotkeyInsertInput.value = formatHotkey(this.config.mediaHotkeyInsert);
        if (this.newTabReplacePlusInput) this.newTabReplacePlusInput.checked = this.config.newTabReplacePlus !== false;
        if (this.marketTopBarIconInput) this.marketTopBarIconInput.checked = this.config.marketTopBarIcon !== false;
        if (this.newTabShowPinnedInput) this.newTabShowPinnedInput.checked = this.config.newTabShowPinned !== false;
        if (this.newTabShowRecentInput) this.newTabShowRecentInput.checked = this.config.newTabShowRecent !== false;
        if (this.newTabShowFavoritesInput) this.newTabShowFavoritesInput.checked = this.config.newTabShowFavorites !== false;
        if (this.newTabShowPlannerInput) this.newTabShowPlannerInput.checked = this.config.newTabShowPlanner !== false;
        if (this.newTabSectionOrderInput) this.newTabSectionOrderInput.value = this.config.newTabSectionOrder || "pinned,recent,favorites,planner";
        if (this.newTabItemSortSelect) this.newTabItemSortSelect.value = this.config.newTabItemSort || "time";
        if (this.newTabPlannerOrderInput) this.newTabPlannerOrderInput.value = this.config.newTabPlannerOrder || "goals,habits,countdowns,calendar";
        if (this.docPropertiesShowInDocInput) this.docPropertiesShowInDocInput.checked = this.config.docPropertiesShowInDoc === true;
        if (this.docPropertiesSchemaInput) this.docPropertiesSchemaInput.value = this.config.docPropertiesSchema || "";
        if (this.importMdSourceAssetInput) this.importMdSourceAssetInput.checked = this.config.importMdSourceAsset === true;
        if (this.docOpenTakeoverSelect) this.docOpenTakeoverSelect.value = this.config.docOpenTakeover || "off";
        if (this.docOpenTakeoverExtsInput) this.docOpenTakeoverExtsInput.value = this.config.docOpenTakeoverExts || "";
        // 「新建思源文档」回填:笔记本下拉选项异步刷新,子路径/同名开关同步
        this.refreshNewDocSettingUI();
        if (this.newDocSubPathInput) this.newDocSubPathInput.value = this.config.newDocSubPath || "";
        if (this.newDocSameNameInput) this.newDocSameNameInput.checked = this.config.newDocSameName !== false;
        if (this.fileMountTargetSelect) this.fileMountTargetSelect.value = this.config.fileMountTarget === "folder" ? "folder" : "file";
        if (this.libraryUnlinkModeSelect) this.libraryUnlinkModeSelect.value = this.config.libraryUnlinkMode || "push";
        // 引用关系设置回填(只回填设置项;collapsed 由面板维护,拖拽顺序在挂载配置里)
        const rel = this.config.mountTreeRelation || DEFAULT_CONFIG.mountTreeRelation;
        if (this.mountTreeRelationEnabledInput) this.mountTreeRelationEnabledInput.checked = rel.enabled === true;
        if (this.mountTreeRelationSortSelect) this.mountTreeRelationSortSelect.value = rel.sortMethod || "name";
        if (this.mountTreeRelationWeightInput) this.mountTreeRelationWeightInput.value = rel.weightAttrName || "weight";
        if (this.mountTreeRelationPhysicalInput) this.mountTreeRelationPhysicalInput.checked = rel.includePhysicalSubtree === true;
        if (this.mountTreeRelationCaseInput) this.mountTreeRelationCaseInput.checked = rel.caseSensitive === true;
        if (this.mountTreeRelationDepthInput) this.mountTreeRelationDepthInput.value = String(rel.maxDepth ?? 8);
        if (this.mountTreeRelationNodesInput) this.mountTreeRelationNodesInput.value = String(rel.maxNodes ?? 500);
        if (this.mountTreeRelationExpandInput) this.mountTreeRelationExpandInput.value = String(rel.defaultExpandLevel ?? 1);
        // 文档面包屑总开关回填
        if (this.fakeDocBreadcrumbEnabledInput) this.fakeDocBreadcrumbEnabledInput.checked = this.config.fakeDocBreadcrumbEnabled !== false;
        // 习惯与目标总开关回填
        if (this.plannerEnabledInput) this.plannerEnabledInput.checked = this.config.plannerEnabled !== false;
        // planner 细分设置回填(模块未加载时 getSettings 也有默认值兜底)
        try {
            const ps = getPlannerSettings() as unknown as Record<string, any>;
            for (const [key, ctl] of Object.entries(this.plannerControls)) {
                const v = key.includes(".") ? key.split(".").reduce<any>((o, k) => (o ? o[k] : undefined), ps) : ps[key];
                if (v === undefined || v === null) continue;
                if (ctl instanceof HTMLInputElement && ctl.type === "checkbox") {
                    ctl.checked = v === true;
                } else {
                    ctl.value = String(v);
                }
            }
        } catch {
            // 模块未就绪时跳过,打开面板时会再同步
        }
        // 文档面包屑细分设置回填(模块未初始化时各键为 null,用默认值兜底)
        const fdbCur = getFakeDocBreadcrumbSettings();
        const fdbDef = getFakeDocBreadcrumbDefaultSettings();
        for (const key of Object.keys(this.fdbControls)) {
            const ctl = this.fdbControls[key];
            const v = fdbCur[key] != null ? fdbCur[key] : fdbDef[key];
            if (ctl instanceof HTMLInputElement && ctl.type === "checkbox") {
                ctl.checked = v === true;
            } else {
                ctl.value = v == null ? "" : String(v);
            }
        }
        // 主题下拉的选项依赖扩展数据,此处仅同步值;选项在 onLayoutReady 后填充
        this.refreshThemeSettingUI();
    }

    // 保存设置
    private async saveSettings(): Promise<void> {
        // 挂载关系配置:customOrder 字段已废弃(自动挂载层顺序在挂载配置),剔除旧值避免误导
        const prevRelation = {...(this.config.mountTreeRelation || {})};
        delete (prevRelation as Record<string, unknown>).customOrder;
        this.config = {
            // 编辑器相关的字段不再由本面板直接编辑(已并入「代码编辑器」分组),
            // 这里从 settings.json 的生效值回写,保证读 plugin.config 的老代码一致
            fontSize: getNumberSetting("editor.fontSize", 14),
            tabSize: getNumberSetting("editor.tabSize", 4),
            wordWrap: (getResolved("editor.wordWrap") === "off" ? "off" : "on") as "on" | "off",
            formatOnSave: getResolved("editor.formatOnSave") === true,
            showMinimap: getResolved("editor.minimap.enabled") !== false,
            searchMaxFileSize: (parseInt(this.searchMaxSizeInput?.value || "1024", 10)) * 1024,
            fileTreeRoot: (this.fileTreeRootInput?.value || "").trim() || "/data",
            searchEverythingUrl: (this.searchEverythingUrlInput?.value || "").trim() || DEFAULT_CONFIG.searchEverythingUrl,
            searchAnytxtUrl: (this.searchAnytxtUrlInput?.value || "").trim() || DEFAULT_CONFIG.searchAnytxtUrl,
            terminalBackend: (this.terminalBackendSelect?.value as "auto" | "builtin" | "server") || "auto",
            terminalShell: (this.terminalShellSelect?.value as string) || "auto",
            terminalServerUrl: (this.terminalServerUrlInput?.value || "").trim() || DEFAULT_TERMINAL_SERVER_URL,
            terminalShowStatusBar: this.terminalShowStatusBarInput?.checked ?? false,
            siyuanWorkspacePath: (this.siyuanWorkspacePathInput?.value || "").trim(),
            colorTheme: this.colorThemeSelect?.value || "",
            iconTheme: this.iconThemeSelect?.value || "",
            marketTopBarIcon: this.marketTopBarIconInput?.checked ?? true,
            markdownDefaultMode: (this.markdownModeSelect?.value as "live" | "source" | "reading") || "live",
            markdownEditor: (this.markdownEditorSelect?.value as "vditor" | "cm6") || "vditor",
            markdownReadingEngine: (this.markdownReadingEngineSelect?.value as "vditor" | "cm6") || "vditor",
            cm6CodeBlockMonaco: this.cm6CodeBlockMonacoInput?.checked ?? true,
            globalReadingMode: this.globalReadingModeInput?.checked ?? true,
            versionKeepCount: Math.max(0, parseInt(this.versionKeepCountInput?.value || "10", 10) || 0),
            deleteMode: ((this.deleteModeSelect?.value || "plugin") as "plugin" | "system"),
            filesBacklinkScanAllText: this.backlinkScanAllTextInput?.checked ?? true,
            docWikilinkHint: this.docWikilinkHintInput?.checked ?? true,
            indexBlacklist: this.indexBlacklistInput?.value ?? "",
            indexWhitelist: this.indexWhitelistInput?.value ?? "",
            mediaHotkeyMark: normalizeHotkeyText(this.mediaHotkeyMarkInput?.value ?? ""),
            mediaHotkeyInsert: normalizeHotkeyText(this.mediaHotkeyInsertInput?.value ?? ""),
            newTabReplacePlus: this.newTabReplacePlusInput?.checked ?? true,
            newTabShowPinned: this.newTabShowPinnedInput?.checked ?? true,
            newTabShowRecent: this.newTabShowRecentInput?.checked ?? true,
            newTabShowFavorites: this.newTabShowFavoritesInput?.checked ?? true,
            newTabShowPlanner: this.newTabShowPlannerInput?.checked ?? true,
            newTabSectionOrder: (this.newTabSectionOrderInput?.value || "").trim() || DEFAULT_CONFIG.newTabSectionOrder,
            newTabItemSort: (this.newTabItemSortSelect?.value as "time" | "name" | "type") || "time",
            newTabPlannerOrder: (this.newTabPlannerOrderInput?.value || "").trim() || DEFAULT_CONFIG.newTabPlannerOrder,
            docPropertiesShowInDoc: this.docPropertiesShowInDocInput?.checked ?? false,
            docPropertiesSchema: this.docPropertiesSchemaInput?.value ?? "",
            importMdSourceAsset: this.importMdSourceAssetInput?.checked ?? false,
            docOpenTakeover: ((this.docOpenTakeoverSelect?.value || "off") as "off" | "exts" | "all"),
            docOpenTakeoverExts: (this.docOpenTakeoverExtsInput?.value || "").trim() || "md,txt",
            newDocNotebook: (this.newDocNotebookSelect?.value || "").trim(),
            newDocSubPath: (this.newDocSubPathInput?.value || "").trim().replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""),
            newDocSameName: this.newDocSameNameInput?.checked ?? true,
            fileMountTarget: ((this.fileMountTargetSelect?.value || "file") as "file" | "folder"),
            libraryUnlinkMode: ((this.libraryUnlinkModeSelect?.value || "push") as "push" | "keep" | "deleteRemote"),
            closeUnsavedAction: ((this.closeUnsavedSelect?.value || "ask") as "ask" | "discard" | "save"),
            takeoverSplitOpen: this.takeoverSplitOpenInput?.checked ?? false,
            treeBacklinkIcon: this.treeBacklinkIconInput?.checked ?? true,
            fakeDocBreadcrumbEnabled: this.fakeDocBreadcrumbEnabledInput?.checked ?? true,
            plannerEnabled: this.plannerEnabledInput?.checked ?? true,
            // 「文件」面板功能已移除(虚拟文档树全面承接);保留配置键兼容旧存储
            showFileTreeDock: false,
            mountTreeRelation: {
                // 保留既有的 collapsed(面板运行时维护,不在这里覆盖)
                ...prevRelation,
                enabled: this.mountTreeRelationEnabledInput?.checked ?? false,
                sortMethod: (this.mountTreeRelationSortSelect?.value as "name" | "weight") || "name",
                weightAttrName: (this.mountTreeRelationWeightInput?.value || "").trim() || "weight",
                includePhysicalSubtree: this.mountTreeRelationPhysicalInput?.checked ?? false,
                caseSensitive: this.mountTreeRelationCaseInput?.checked ?? false,
                maxDepth: Math.max(1, parseInt(this.mountTreeRelationDepthInput?.value || "8", 10) || 8),
                maxNodes: Math.max(10, parseInt(this.mountTreeRelationNodesInput?.value || "500", 10) || 500),
                defaultExpandLevel: parseInt(this.mountTreeRelationExpandInput?.value || "1", 10) || 0,
            },
        };
        // 默认运行内核:写注册表全局默认并持久化;变了就废弃现有内核实例,
        // 让下一次运行直接用新环境(旧实例留着会在旧环境里继续跑,违背"默认"预期)
        try {
            const raw = this.kernelDefaultSelect?.value || "syfe";
            const prev = getGlobalDefaultChoice();
            const choice = raw === "syfe"
                ? ({kind: "syfe"} as import("./utils/kernel/registry").KernelChoice)
                : (JSON.parse(raw) as import("./utils/kernel/registry").KernelChoice);
            const changed = JSON.stringify(prev) !== JSON.stringify(choice);
            setKernelChoice(DEFAULT_KERNEL_ID, choice);
            if (changed && prev) await disposeAllKernels();
        } catch {
            // 解析失败保留原默认
        }
        await saveConfig(this, this.config);
        // 面板值即用户值:回写 settings.json(只写与默认不同的项,与 VS Code 一致)
        syncUserSettingsFromConfig(this.config);
        await flushUserSettings();
        // CM6 代码块渲染开关跟随生效(关时退出编辑态 + 全部活跃视图重建)
        notifyCm6RenderConfigChanged();
        // 版本控制保留条数跟随设置生效(0=关闭并清空历史)
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        // 删除方式跟随设置生效
        setTrashMode(this.config.deleteMode || "plugin");
        // 双链:设置保存后全量失效反链/出链缓存(含文件名索引,扫描范围可能已变)
        clearBacklinkCache(true);
        // Markdown 引擎设置改完立即对已打开的页签生效(实时预览 / 阅读态各自
        // 按当前配置判断,挂对引擎的页签是 no-op)
        const mdTabs = ((this.getOpenedTab?.() ?? {})[MARKDOWN_TAB_TYPE] || []) as unknown as MarkdownTabInstance[];
        for (const mdInst of mdTabs) {
            try {
                mdInst._resyncEngineForConfig?.();
            } catch {
                // 单页签重进失败不影响其余页签
            }
        }
        // 关闭未保存行为跟随设置生效
        setCloseUnsavedAction(this.config.closeUnsavedAction);
        // 文档面包屑细分设置:收集控件值(开关=布尔,数字=夹紧范围,下拉=字符串)写模块设置文件
        // 必须先于总开关 apply:总开关打开时的初始化会从磁盘读刚写入的值
        const fdbPatch: Record<string, string | number | boolean> = {};
        for (const [key, ctl] of Object.entries(this.fdbControls)) {
            if (ctl instanceof HTMLInputElement && ctl.type === "checkbox") {
                fdbPatch[key] = ctl.checked;
            } else if (ctl instanceof HTMLInputElement && ctl.type === "number") {
                const min = ctl.min === "" ? -Infinity : parseFloat(ctl.min);
                const max = ctl.max === "" ? Infinity : parseFloat(ctl.max);
                let n = parseFloat(ctl.value);
                if (isNaN(n)) n = Number(getFakeDocBreadcrumbDefaultSettings()[key] ?? 0) || 0;
                fdbPatch[key] = Math.min(max, Math.max(min, n));
            } else {
                fdbPatch[key] = (ctl as HTMLSelectElement).value;
            }
        }
        saveFakeDocBreadcrumbSettings(fdbPatch);
        // 文档面包屑总开关:关闭立即摘除已插入的面包屑,开启立即注入
        applyFakeDocBreadcrumb(this as any, this.config.fakeDocBreadcrumbEnabled !== false);
        // 习惯与目标总开关:关闭停引擎落盘,开启读档+启动引擎并补注册 Dock
        void applyPlannerEnabled(this as any, this.config.plannerEnabled !== false).then(() => {
            this.ensurePlannerDock();
            this.applyPlannerTopBarIcon();
            // 布局恢复的新标签页早于模块激活,且设置里切换总开关后也要同步:
            // 数据/启用状态就绪后通知新标签页重绘「习惯与目标」速览区
            window.dispatchEvent(new CustomEvent(PLANNER_CHANGED_EVENT));
        });
        // 主题设置立即生效
        this.applyConfiguredThemes();
        // 顶栏「扩展市场」图标显隐立即生效
        this.applyMarketTopBarIcon();
        // 编辑器设置(字体/换行/导航窗格……)对已打开的编辑器立即生效
        applyEditorOptions();
        // 终端状态栏显隐立即对所有已打开的终端页签生效
        applyTerminalStatusBarVisibility(this as any);
        // 新标签页分区顺序 / 条目排序 / 速览卡片顺序:已打开的起始页立即重绘
        window.dispatchEvent(new CustomEvent(START_PAGE_CHANGED_EVENT));
        // 文档属性:文档内显隐重扫 + 所有面板按新 schema 重绘
        notifyDocPropertiesConfigChanged(this as any);
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
