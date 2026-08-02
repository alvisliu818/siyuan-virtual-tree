import {Plugin, Setting, showMessage} from "siyuan";
import {DOCK_TYPE, WORKSPACE_ROOT} from "./constants";
import {EditorConfig, DEFAULT_CONFIG} from "./types";
import {setupMonaco, applyTheme, getCurrentMode, disposeMonaco} from "./editor/monaco";
import {disposeAllModels} from "./editor/model-manager";
import {createEditorTabConfig, openFileTab} from "./tabs/editor-tab";
import {createFileTreeDockConfig} from "./dock/file-tree-dock";
import {createSearchTabConfig, openSearchTab} from "./components/search-panel";
import {loadConfig, saveConfig} from "./utils/config";
import "./index.scss";

export default class FileEditorPlugin extends Plugin {
    public config: EditorConfig = DEFAULT_CONFIG;
    private themeObserver?: MutationObserver;
    private fontSizeInput?: HTMLInputElement;
    private tabSizeInput?: HTMLInputElement;
    private wordWrapSelect?: HTMLSelectElement;
    private formatOnSaveInput?: HTMLInputElement;
    private searchMaxSizeInput?: HTMLInputElement;

    onload(): void {
        setupMonaco(this.name);

        // 注册 Tab 类型
        this.addTab(createEditorTabConfig(this as any));
        this.addTab(createSearchTabConfig(this as any));

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
    }

    onunload(): void {
        disposeAll();
        disposeMonaco();
        this.themeObserver?.disconnect();
    }

    // 打开文件编辑 Tab
    openFile(path: string): void {
        openFileTab(this as any, path);
    }

    // 打开搜索面板
    openSearch(rootPath?: string): void {
        openSearchTab(this as any, rootPath || WORKSPACE_ROOT);
    }

    // 主题同步:观察 data-theme 属性变化
    private startThemeSync(): void {
        this.themeObserver = new MutationObserver(() => {
            applyTheme(getCurrentMode());
        });
        this.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });
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
    }

    // 保存设置
    private async saveSettings(): Promise<void> {
        this.config = {
            fontSize: parseInt(this.fontSizeInput?.value || "14", 10),
            tabSize: parseInt(this.tabSizeInput?.value || "4", 10),
            wordWrap: (this.wordWrapSelect?.value as "on" | "off") || "off",
            formatOnSave: this.formatOnSaveInput?.checked ?? false,
            searchMaxFileSize: (parseInt(this.searchMaxSizeInput?.value || "1024", 10)) * 1024,
        };
        await saveConfig(this, this.config);
        showMessage("设置已保存", 2000, "info");
    }
}
