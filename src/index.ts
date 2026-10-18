import {Plugin, showMessage} from "siyuan";
import {
    WORKSPACE_ROOT,
    DEFAULT_TERMINAL_SERVER_URL,
    DOCK_TYPE,
    RECENT_DOCK_TYPE,
    TAG_DOCK_TYPE,
    MOUNT_TREE_DOCK_TYPE,
    TERMINAL_DOCK_TYPE,
} from "./constants";
import {EditorConfig, DEFAULT_CONFIG} from "./types";
import {setupMonaco, applyTheme, getCurrentMode, disposeMonaco} from "./editor/monaco";
import {disposeAll} from "./editor/model-manager";
import {createEditorTabConfig, openFileTab} from "./tabs/editor-tab";
import {createImageTabConfig, openImageTab} from "./tabs/image-tab";
import {createOfficeTabConfig, openOfficeTab} from "./tabs/office-tab";
import {createMarkdownTabConfig, openMarkdownTab, MarkdownMode} from "./tabs/markdown-tab";
import {createMediaTabConfig, openMediaTab} from "./tabs/media-tab";
import {createNotebookTabConfig} from "./tabs/notebook-tab";
import {createDiffTabConfig} from "./tabs/diff-tab";
import {createStartTabConfig, openStartTab, installNewTabHijack} from "./tabs/start-tab";
import {createTerminalTabConfig, openTerminalTab} from "./tabs/terminal-tab";
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
    registerSettingsJsonSchema,
    syncUserSettingsFromConfig,
} from "./settings/user-settings";
import {buildEditorAllPanel, buildEditorGroupPanel, getEditorSubgroups} from "./settings/editor-settings-ui";
import {createSettingsPanel, settingsRow, SettingsPanel} from "./settings/plugin-settings-dialog";
import {querySQL} from "./api/file";
import {basename} from "./utils/path";
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
import {loadStartPage, itemFromPath, itemFromDoc, toggleInGroup} from "./start-page";
import {isVirtualPath, virtualId, initMountStore, getMountList, dropSyDocMounts} from "./utils/virtual-tree";
import {initBaiduPanStore} from "./api/baidu-pan";
import {openBaiduPanDialog} from "./components/baidu-pan-dialog";
import {registerSlashCommands} from "./protyle/slash-commands";
import {registerLinkReveal} from "./protyle/link-reveal";
import {registerMountMenu} from "./protyle/mount-menu";
import {registerCodeBlockRun, disposeCodeBlockRun} from "./protyle/code-block-run";
import {loadCodeBlockRunData, flushCodeBlockRunData} from "./protyle/code-block-run-store";
import {initMountTree, reloadMountTreeIfChanged, migrateSyDocMounts, SYFE_RELATION_TREE_CHANGED_EVENT} from "./mount-tree";
import {createMountTreeDockConfig} from "./dock/mount-tree-dock";
import {createTerminalDockConfig} from "./dock/terminal-dock";
import {openExtensionMarket} from "./extensions/market-ui";
import {clearAllGrammars} from "./extensions/grammar-loader";
import {clearAllThemes, applyThemeByPreference, getLoadedThemes} from "./extensions/theme-loader";
import {clearAllSnippets} from "./extensions/snippet-loader";
import {clearAllLsp} from "./extensions/lsp-loader";
import {clearAllIconThemes, getIconThemesWithMissingIcons, getLoadedIconThemes, activateIconThemeByPreference, ICON_THEME_CHANGED_EVENT} from "./extensions/icon-theme-loader";
import {setCloseUnsavedAction} from "./utils/close-guard";
import {registerPythonLsp, disposePythonLsp} from "./utils/python-lsp-bridge";
import {disposePythonKernel} from "./utils/python-kernel";
import {disposeAllKernels, disposeAllKernelsSync, getGlobalDefaultChoice, getKernelChoice, loadKernelChoices, registerKernelChoicePersistence, setKernelChoice, DEFAULT_KERNEL_ID} from "./utils/kernel/registry";
import {listKernelSpecs} from "./utils/kernel/interpreter";
import {stopPythonLanguageServer} from "./utils/python-lsp";
// vditor 会用自己的 lute 覆写 window.Lute,使思源之后新建的文档编辑器全部失效。
// 必须在任何 vditor 实例被创建之前装好守卫 —— 所以放在顶层 import 里(模块求值顺序)。
import {installLuteGuard} from "./utils/lute-guard";
import {refreshAllExpanded} from "./components/file-tree";
import {refreshAllTabIcons} from "./utils/tab-icon";
import {destroyCodeRender, initCodeRender, buildCodeRenderSettingPages} from "./code-render";
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
    // 接管思源文档内文件打开:模式下拉 + 扩展名白名单
    private docOpenTakeoverSelect?: HTMLSelectElement;
    private docOpenTakeoverExtsInput?: HTMLInputElement;
    private _unregisterDocOpenTakeover?: () => void;
    // 切换思源文档后刷新文件树的防抖 timer(见 switch-protyle 监听)
    private _docSwitchRefreshTimer?: number;
    // 全局阅读模式:Markdown 默认只读打开
    private globalReadingModeInput?: HTMLInputElement;
    // 版本控制:每文件保留的历史版本条数
    private versionKeepCountInput?: HTMLInputElement;
    // 删除方式:插件回收站 / 系统回收站(没有"直接删除"选项)
    private deleteModeSelect?: HTMLSelectElement;
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
            DOCK_TYPE, RECENT_DOCK_TYPE, TAG_DOCK_TYPE, MOUNT_TREE_DOCK_TYPE, TERMINAL_DOCK_TYPE,
        ];
        // 本插件用过的旧名字(改名前的命名空间,整个都该清)
        const legacyNames = ["siyuan-file-editor"];
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

    onload(): void {
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
        window.addEventListener("beforeunload", () => {
            try { disposeAllKernelsSync(); } catch { /* ignore */ }
            try { stopPythonLanguageServer(); } catch { /* ignore */ }
        });
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

        // 图标主题就绪/切换:文件树、页签头、新标签页都要按新的主题重画。
        // 扩展是异步加载的,它们首屏渲染时常还没有主题(画出来是思源内置图标),
        // 这里补画一次即可保证「一开始就显示虚拟文档树同款图标」。
        window.addEventListener(ICON_THEME_CHANGED_EVENT, () => {
            // 文件树 / 虚拟文档树
            this.refreshFileTrees();
            // 已经打开的插件页签:重刷页签头图标
            refreshAllTabIcons();
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
    async onLayoutReady(): Promise<void> {
        this.config = await loadConfig(this);
        // settings.json(VS Code 风格用户设置):优先级高于 config.json。
        // 读完后把值回写进 config,这样所有读 plugin.config 的既有代码都自动拿到最终值,
        // 不需要在各处再加一层"先查 settings.json"的判断。
        try {
            await initUserSettings(this, this.config);
            applyUserSettingsToConfig(this.config);
            registerSettingsJsonSchema();
        } catch (e) {
            console.error("[siyuan-file-editor] 加载 settings.json 失败:", e);
        }
        // 版本控制保留条数以**磁盘配置**为准 —— onload 里那次跑在 loadConfig 之前,
        // 拿到的是 DEFAULT_CONFIG 的值,改设置后不重启也不会生效,必须在这里补一次
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        // 删除方式同理:以磁盘配置为准
        setTrashMode(this.config.deleteMode || "plugin");
        // 关闭未保存行为跟随磁盘配置生效
        setCloseUnsavedAction(this.config.closeUnsavedAction);
        // 设置面板控件同步当前值
        this.syncSettingUI();
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
        // 代码块渲染:还原被接管的代码块为思源原生高亮
        try {
            destroyCodeRender();
        } catch {
            // ignore
        }
        // 注销文档内文件打开接管的事件监听
        try {
            this._unregisterDocOpenTakeover?.();
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

        // 导入 Markdown 到思源时,是否把源文件作为资源插入文档顶部的引述块
        this.importMdSourceAssetInput = document.createElement("input");
        this.importMdSourceAssetInput.type = "checkbox";
        this.importMdSourceAssetInput.className = "b3-switch";
        addRow("openFiles", "导入 Markdown:插入源文件资源引述块", "导入 .md 到思源后,把源文件上传为资源,并在文档顶部插入一个引述块链接到它(保留出处,便于回溯原文件);仅对单个 Markdown 文件生效,导入文件夹时不处理", this.importMdSourceAssetInput);

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

        // ---------- 百度网盘 ----------
        const bdPanBtn = document.createElement("button");
        bdPanBtn.className = "b3-button b3-button--outline";
        bdPanBtn.textContent = "百度网盘账号…";
        bdPanBtn.addEventListener("click", () => openBaiduPanDialog());
        addRow("baiduPan", "百度网盘", "接入方式:官方 API(推荐,开放平台 AppKey/SecretKey + 设备码授权,未过审仅能访问 /apps/应用名/ 目录)或网页 Cookie(全盘 + 同步空间,非官方)。配置后点击文件树工具栏云图标挂载网盘目录,支持浏览、编辑并保存回网盘", bdPanBtn);

        // ---------- 文件树 ----------
        // 搜索最大文件大小
        this.searchMaxSizeInput = document.createElement("input");
        this.searchMaxSizeInput.className = "b3-text-field";
        this.searchMaxSizeInput.type = "number";
        this.searchMaxSizeInput.min = "100";
        this.searchMaxSizeInput.max = "10240";
        addRow("fileTree", "搜索最大文件大小(KB)", "超过此大小的文件不参与搜索", this.searchMaxSizeInput);

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
            <option value="cmd">命令提示符 (cmd)</option>`;
        addRow("terminal", "终端 Shell", "集成终端使用的 shell 程序,需重启终端 Tab 后生效", this.terminalShellSelect);

        // ---------- 外观 ----------
        this.colorThemeSelect = document.createElement("select");
        this.colorThemeSelect.className = "b3-select";
        this.colorThemeSelect.innerHTML = `<option value="">自动(优先扩展主题)</option>`;
        addRow("appearance", "代码主题", "Monaco 编辑器配色主题。安装主题类扩展(如 One Light)后可在此选择,保存后立即生效", this.colorThemeSelect);

        this.iconThemeSelect = document.createElement("select");
        this.iconThemeSelect.className = "b3-select";
        this.iconThemeSelect.innerHTML = `<option value="">自动(使用第一个图标主题)</option>`;
        addRow("appearance", "图标主题", "文件树与 Tab 的文件/文件夹图标。安装图标类扩展(如 Material Icon Theme)后可在此选择,保存后立即生效", this.iconThemeSelect);

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
        addRowsPage("virtualTree", "虚拟文档树");
        addRowsPage("tags", "标签");
        addRowsPage("fileTree", "文件树");
        addRowsPage("baiduPan", "百度网盘");
        addRowsPage("terminal", "终端");
        addRowsPage("newTab", "新标签页");
        addRowsPage("jupyter", "运行内核");
    }

    // 同步设置面板控件值为当前配置
    private syncSettingUI(): void {
        if (this.closeUnsavedSelect) this.closeUnsavedSelect.value = this.config.closeUnsavedAction || "ask";
        if (this.takeoverSplitOpenInput) this.takeoverSplitOpenInput.checked = this.config.takeoverSplitOpen === true;
        if (this.treeBacklinkIconInput) this.treeBacklinkIconInput.checked = this.config.treeBacklinkIcon !== false;
        if (this.searchMaxSizeInput) {
            this.searchMaxSizeInput.value = String(Math.round(this.config.searchMaxFileSize / 1024));
        }
        if (this.fileTreeRootInput) this.fileTreeRootInput.value = this.config.fileTreeRoot;
        if (this.terminalBackendSelect) this.terminalBackendSelect.value = this.config.terminalBackend || "auto";
        if (this.terminalServerUrlInput) this.terminalServerUrlInput.value = this.config.terminalServerUrl;
        if (this.siyuanWorkspacePathInput) this.siyuanWorkspacePathInput.value = this.config.siyuanWorkspacePath;
        if (this.terminalShellSelect) this.terminalShellSelect.value = this.config.terminalShell || "auto";
        if (this.markdownModeSelect) this.markdownModeSelect.value = this.config.markdownDefaultMode || "live";
        if (this.globalReadingModeInput) this.globalReadingModeInput.checked = this.config.globalReadingMode !== false;
        if (this.versionKeepCountInput) this.versionKeepCountInput.value = String(this.config.versionKeepCount ?? 10);
        if (this.deleteModeSelect) this.deleteModeSelect.value = this.config.deleteMode || "plugin";
        if (this.newTabReplacePlusInput) this.newTabReplacePlusInput.checked = this.config.newTabReplacePlus !== false;
        if (this.newTabShowPinnedInput) this.newTabShowPinnedInput.checked = this.config.newTabShowPinned !== false;
        if (this.newTabShowRecentInput) this.newTabShowRecentInput.checked = this.config.newTabShowRecent !== false;
        if (this.newTabShowFavoritesInput) this.newTabShowFavoritesInput.checked = this.config.newTabShowFavorites !== false;
        if (this.importMdSourceAssetInput) this.importMdSourceAssetInput.checked = this.config.importMdSourceAsset === true;
        if (this.docOpenTakeoverSelect) this.docOpenTakeoverSelect.value = this.config.docOpenTakeover || "off";
        if (this.docOpenTakeoverExtsInput) this.docOpenTakeoverExtsInput.value = this.config.docOpenTakeoverExts || "";
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
            terminalBackend: (this.terminalBackendSelect?.value as "auto" | "builtin" | "server") || "auto",
            terminalShell: (this.terminalShellSelect?.value as string) || "auto",
            terminalServerUrl: (this.terminalServerUrlInput?.value || "").trim() || DEFAULT_TERMINAL_SERVER_URL,
            siyuanWorkspacePath: (this.siyuanWorkspacePathInput?.value || "").trim(),
            colorTheme: this.colorThemeSelect?.value || "",
            iconTheme: this.iconThemeSelect?.value || "",
            markdownDefaultMode: (this.markdownModeSelect?.value as "live" | "source" | "reading") || "live",
            globalReadingMode: this.globalReadingModeInput?.checked ?? true,
            versionKeepCount: Math.max(0, parseInt(this.versionKeepCountInput?.value || "10", 10) || 0),
            deleteMode: ((this.deleteModeSelect?.value || "plugin") as "plugin" | "system"),
            newTabReplacePlus: this.newTabReplacePlusInput?.checked ?? true,
            newTabShowPinned: this.newTabShowPinnedInput?.checked ?? true,
            newTabShowRecent: this.newTabShowRecentInput?.checked ?? true,
            newTabShowFavorites: this.newTabShowFavoritesInput?.checked ?? true,
            importMdSourceAsset: this.importMdSourceAssetInput?.checked ?? false,
            docOpenTakeover: ((this.docOpenTakeoverSelect?.value || "off") as "off" | "exts" | "all"),
            docOpenTakeoverExts: (this.docOpenTakeoverExtsInput?.value || "").trim() || "md,txt",
            closeUnsavedAction: ((this.closeUnsavedSelect?.value || "ask") as "ask" | "discard" | "save"),
            takeoverSplitOpen: this.takeoverSplitOpenInput?.checked ?? false,
            treeBacklinkIcon: this.treeBacklinkIconInput?.checked ?? true,
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
        // 版本控制保留条数跟随设置生效(0=关闭并清空历史)
        setVersionKeepCount(this.config.versionKeepCount ?? 10);
        // 删除方式跟随设置生效
        setTrashMode(this.config.deleteMode || "plugin");
        // 关闭未保存行为跟随设置生效
        setCloseUnsavedAction(this.config.closeUnsavedAction);
        // 主题设置立即生效
        this.applyConfiguredThemes();
        // 编辑器设置(字体/换行/导航窗格……)对已打开的编辑器立即生效
        applyEditorOptions();
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
