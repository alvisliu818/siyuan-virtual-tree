import {Plugin, Setting, showMessage} from "siyuan";
import {DOCK_TYPE, WORKSPACE_ROOT, DEFAULT_TERMINAL_SERVER_URL} from "./constants";
import {EditorConfig, DEFAULT_CONFIG} from "./types";
import {setupMonaco, applyTheme, getCurrentMode, disposeMonaco} from "./editor/monaco";
import {disposeAll, disposeAllModels} from "./editor/model-manager";
import {createEditorTabConfig, openFileTab} from "./tabs/editor-tab";
import {createImageTabConfig} from "./tabs/image-tab";
import {createOfficeTabConfig} from "./tabs/office-tab";
import {createTerminalTabConfig, openTerminalTab} from "./tabs/terminal-tab";
import {createFileTreeDockConfig} from "./dock/file-tree-dock";
import {createSearchTabConfig, openSearchTab} from "./components/search-panel";
import {loadConfig, saveConfig} from "./utils/config";
import {loadAllExtensions} from "./extensions/extension-manager";
import {openExtensionMarket} from "./extensions/market-ui";
import {clearAllGrammars} from "./extensions/grammar-loader";
import {clearAllThemes, applyThemeByPreference, getLoadedThemes} from "./extensions/theme-loader";
import {clearAllSnippets} from "./extensions/snippet-loader";
import {clearAllLsp} from "./extensions/lsp-loader";
import {clearAllIconThemes, getIconThemesWithMissingIcons, getLoadedIconThemes, activateIconThemeByPreference} from "./extensions/icon-theme-loader";
import {refreshAllExpanded} from "./components/file-tree";
import "./index.scss";

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

    onload(): void {
        setupMonaco(this.name);

        // 注册 Tab 类型
        this.addTab(createEditorTabConfig(this as any));
        this.addTab(createImageTabConfig(this as any));
        this.addTab(createOfficeTabConfig(this as any));
        this.addTab(createSearchTabConfig(this as any));
        this.addTab(createTerminalTabConfig(this as any));

        // 注册 Dock
        this.addDock(createFileTreeDockConfig(this as any));

        // 顶栏图标 → 切换 Dock
        this.addTopBar({
            icon: "iconFolder",
            title: "文件管理器",
            position: "right",
            callback: () => {
                const dockItem = document.querySelector(
                    `.dock__item[data-type="${DOCK_TYPE}"]`,
                ) as HTMLElement;
                if (dockItem) {
                    dockItem.click();
                } else {
                    showMessage("请从侧边栏打开文件管理器", 3000, "info");
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

    async onLayoutReady(): Promise<void> {
        this.config = await loadConfig(this);
        // 设置面板控件同步当前值
        this.syncSettingUI();
        // 加载已安装的 VSCode 扩展
        try {
            const results = await loadAllExtensions(this);
            const loaded = results.filter(r => r.status === "loaded");
            if (loaded.length > 0) {
                const total = loaded.reduce((acc, r) => acc + r.loadedGrammars + r.loadedThemes + r.loadedSnippets + r.loadedIconThemes, 0);
                showMessage(`已加载 ${loaded.length} 个扩展(${total} 项贡献)`, 3000, "info");
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

    onunload(): void {
        disposeAll();
        // 清理扩展系统
        clearAllGrammars();
        clearAllThemes();
        clearAllSnippets();
        clearAllLsp();
        clearAllIconThemes();
        disposeMonaco();
        this.themeObserver?.disconnect();
    }

    // 打开文件编辑 Tab
    openFile(path: string): void {
        openFileTab(this as any, path);
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
        this.fileTreeRootInput.placeholder = "/data";
        this.setting!.addItem({
            title: "文件树根目录",
            description: "文件管理器 Dock 默认打开的目录路径(如 /data 或 /data/public)",
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
        };
        await saveConfig(this, this.config);
        // 主题设置立即生效
        this.applyConfiguredThemes();
        this.refreshFileTrees();
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
