import { Plugin, showMessage } from "siyuan";
import type {
  IWebSocketData,
  IEventBusMap,
  Custom,
  MobileCustom,
} from "siyuan";
import { VirtualTreeSettings, DEFAULT_SETTINGS } from "./types";
import { StateManager } from "./stateManager";
import { VirtualTreePanel } from "./panel";
import { VirtualTreeSettingsPanel } from "./settings";
import { initI18n, t } from "./i18n";
import { addRootManagementItems, debounce, getCurrentDocRootId } from "./utils";
import {
  DOCK_TYPE,
  COMMAND_ADD_CURRENT_AS_ROOT,
  COMMAND_LOCATE_CURRENT_DOC,
  WS_REBUILD_DEBOUNCE_MS,
} from "./constants";
import "./index.scss";

export default class VirtualTreePlugin extends Plugin {
  private stateManager!: StateManager;
  private panel!: VirtualTreePanel;
  settings: VirtualTreeSettings = { ...DEFAULT_SETTINGS };

  // 稳定的事件处理器引用，确保 eventBus.off 能真正解绑
  private onWsMain = (e: CustomEvent<IWebSocketData>): void => {
    this.handleWsEvent(e);
  };
  private onDocTreeMenu = (e: CustomEvent<IEventBusMap["open-menu-doctree"]>): void => {
    this.handleDocTreeContextMenu(e);
  };
  private onEditorTitleMenu = (e: CustomEvent<IEventBusMap["click-editortitleicon"]>): void => {
    this.handleEditorTitleContextMenu(e);
  };

  private debouncedRebuild = debounce(
    () => this.rebuildTree(),
    WS_REBUILD_DEBOUNCE_MS
  );

  async onload(): Promise<void> {
    initI18n(this.i18n);

    this.stateManager = new StateManager(this);
    await this.stateManager.load();
    this.settings = this.stateManager.getSettings();

    this.addDock({
      config: {
        position: "LeftBottom",
        size: { width: 250, height: 0 },
        icon: "iconList",
        title: t("dockTitle", "虚拟文档树"),
      },
      data: {},
      type: DOCK_TYPE,
      init: (dock: Custom | MobileCustom) => {
        this.panel = new VirtualTreePanel(
          dock.element as HTMLElement,
          this.stateManager,
          () => this.stateManager.getSettings(),
          () => this.app
        );
        this.panel.init();
      },
    });

    const settingsPanel = new VirtualTreeSettingsPanel(
      this.stateManager,
      () => this.rebuildTree(true)
    );
    this.setting = settingsPanel.create();

    this.addCommand({
      langKey: COMMAND_ADD_CURRENT_AS_ROOT,
      hotkey: "",
      callback: () => this.addCurrentAsRoot(),
    });

    this.addCommand({
      langKey: COMMAND_LOCATE_CURRENT_DOC,
      hotkey: "",
      callback: () => this.locateCurrent(),
    });

    this.eventBus.on("ws-main", this.onWsMain);
    this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.on("click-editortitleicon", this.onEditorTitleMenu);
  }

  onLayoutReady(): void {
    // layout ready
  }

  onunload(): void {
    this.eventBus.off("ws-main", this.onWsMain);
    this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.off("click-editortitleicon", this.onEditorTitleMenu);
    this.debouncedRebuild.cancel();
    if (this.panel) {
      this.panel.destroy();
    }
  }

  async addCurrentAsRoot(): Promise<void> {
    const rootId = getCurrentDocRootId();
    if (!rootId) {
      showMessage(t("openDocFirst", "请先打开一个文档"));
      return;
    }

    const success = await this.stateManager.addRootDoc(rootId);
    showMessage(
      success
        ? t("addRootSuccess", "已添加为根节点")
        : t("addRootDuplicate", "该文档已是根节点")
    );
    if (success) this.rebuildTree();
  }

  locateCurrent(): void {
    if (this.panel) {
      void this.panel.locateCurrent();
    }
  }

  rebuildTree(resetExpand = false): void {
    if (this.panel) {
      this.panel.rebuildTree(resetExpand);
    }
  }

  private handleWsEvent(e: CustomEvent<IWebSocketData>): void {
    const tasks = (e.detail?.data?.tasks || []) as Array<{ action?: string }>;
    const needRebuild = tasks.some(
      (op) =>
        op.action === "add" ||
        op.action === "delete" ||
        op.action === "update" ||
        op.action === "move"
    );
    if (needRebuild) {
      this.debouncedRebuild();
    }
  }

  private handleDocTreeContextMenu(
    e: CustomEvent<IEventBusMap["open-menu-doctree"]>
  ): void {
    const detail = e.detail;
    if (!detail || !detail.menu) return;

    const elements = Array.from(detail.elements || []) as HTMLElement[];
    if (elements.length === 0) return;

    // 命中笔记本节点时不注入菜单
    if (elements.some((el) => el.getAttribute("data-type") === "navigation-root")) return;

    const docId = elements[0].getAttribute("data-node-id");
    if (!docId) return;

    addRootManagementItems(detail.menu, docId, this.stateManager, () => this.rebuildTree());
  }

  private handleEditorTitleContextMenu(
    e: CustomEvent<IEventBusMap["click-editortitleicon"]>
  ): void {
    const detail = e.detail;
    if (!detail || !detail.menu || !detail.protyle) return;

    const rootId = detail.protyle.block?.rootID;
    if (!rootId) return;

    addRootManagementItems(detail.menu, rootId, this.stateManager, () => this.rebuildTree());
  }
}
