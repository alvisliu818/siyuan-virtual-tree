import { openTab, Menu, showMessage, App } from "siyuan";
import { TreeNode, VirtualTreeSettings } from "./types";
import { TreeBuilder } from "./treeBuilder";
import { StateManager } from "./stateManager";
import { getCurrentDocRootId } from "./utils";
import { getNotebookName } from "./api";
import { t } from "./i18n";
import { LOCATE_FLASH_MS, REBUILD_SCHED_MS } from "./constants";

export class VirtualTreePanel {
  private element: HTMLElement;
  private stateManager: StateManager;
  private getSettings: () => VirtualTreeSettings;
  private getApp: () => App;
  private treeRoots: TreeNode[] = [];
  private nodeMap = new Map<string, TreeNode>();
  private treeContainerEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private isFirstBuild = true;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** 聚焦模式：非空时只构建该文档的后代树。临时视图状态，不持久化。 */
  private focusedDocId: string | null = null;

  constructor(
    element: HTMLElement,
    stateManager: StateManager,
    getSettings: () => VirtualTreeSettings,
    getApp: () => App
  ) {
    this.element = element;
    this.stateManager = stateManager;
    this.getSettings = getSettings;
    this.getApp = getApp;
  }

  init(): void {
    this.element.classList.add("virtual-tree-panel");
    this.element.innerHTML = "";

    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "virtual-tree-toolbar block__icons";
    this.element.appendChild(this.toolbarEl);
    this.renderToolbar();

    this.treeContainerEl = document.createElement("div");
    this.treeContainerEl.className = "virtual-tree-container fn__flex-1";
    this.element.appendChild(this.treeContainerEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "virtual-tree-empty fn__flex-1";
    this.element.appendChild(this.emptyEl);

    this.treeContainerEl.addEventListener("click", (e) => this.handleTreeClick(e));
    this.treeContainerEl.addEventListener("contextmenu", (e) => this.handleTreeContextMenu(e));

    this.rebuildTree();
  }

  destroy(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }

  private renderToolbar(): void {
    this.toolbarEl.innerHTML = "";

    const leftArea = document.createElement("div");
    leftArea.className = "block__logo";
    leftArea.innerHTML = `<svg class="block__logoicon"><use xlink:href="#iconList"></use></svg><span class="block__logo-text">${t("dockTitle", "虚拟文档树")}</span>`;
    this.toolbarEl.appendChild(leftArea);

    const spacer = document.createElement("span");
    spacer.className = "fn__flex-1 fn__space";
    this.toolbarEl.appendChild(spacer);

    this.createToolbarButton("iconRefresh", t("refresh", "刷新"), () => this.rebuildTree(true));
    this.createToolbarButton("iconContract", t("collapseAll", "折叠全部"), () => this.collapseAll());
    this.createToolbarButton("iconExpand", t("expandAll", "展开全部"), () => this.expandAll());
    this.createToolbarButton("iconFocus", t("locateCurrent", "定位当前文档"), () => this.locateCurrent());

    const isFocused = this.focusedDocId !== null;
    this.createToolbarButton(
      "iconList",
      isFocused ? t("exitFocus", "退出聚焦") : t("focusCurrent", "聚焦当前文档"),
      () => this.toggleFocus(),
      isFocused
    );
  }

  private createToolbarButton(icon: string, tooltip: string, callback: () => void, active = false): void {
    const btn = document.createElement("span");
    btn.className = "block__icon ariaLabel";
    if (active) btn.classList.add("is-active");
    btn.setAttribute("aria-label", tooltip);
    btn.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      callback();
    });
    this.toolbarEl.appendChild(btn);
  }

  rebuildTree(resetExpand = false): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    if (resetExpand) {
      this.isFirstBuild = true;
    }
    this.rebuildTimer = setTimeout(() => {
      void this.doRebuild();
    }, REBUILD_SCHED_MS);
  }

  private async doRebuild(): Promise<void> {
    const s = this.getSettings();
    const customOrder = this.stateManager.getCustomOrderMap();
    const builder = new TreeBuilder(s, customOrder);

    // 聚焦模式：只构建当前文档的后代树；否则构建全部根文档
    const rootIds = this.focusedDocId
      ? [this.focusedDocId]
      : this.stateManager.getRootDocIds();

    if (rootIds.length === 0) {
      this.treeRoots = [];
      this.renderTree();
      return;
    }

    try {
      this.treeRoots = await builder.buildTree(rootIds);
    } catch (e) {
      console.error("[VirtualTree] Failed to build tree:", e);
      this.treeRoots = [];
    }

    // 非聚焦模式：清理已删除的根文档 ID，避免每次 rebuild 都报警告
    if (!this.focusedDocId) {
      const validRootIds = this.treeRoots.map((n) => n.docId);
      const removed = await this.stateManager.pruneRootDocIds(validRootIds);
      if (removed > 0) {
        console.log(`[VirtualTree] Pruned ${removed} invalid root doc id(s)`);
      }
    }

    this.nodeMap.clear();
    this.buildNodeMap(this.treeRoots);

    if (this.isFirstBuild) {
      await this.applyDefaultExpandLevel();
      this.isFirstBuild = false;
    } else {
      await this.preserveCollapsedState();
    }

    this.renderTree();
  }

  private buildNodeMap(nodes: TreeNode[]): void {
    for (const node of nodes) {
      this.nodeMap.set(node.id, node);
      this.buildNodeMap(node.children);
    }
  }

  private async preserveCollapsedState(): Promise<void> {
    const collapsed = this.stateManager.getCollapsedNodes();
    const currentIds = new Set<string>();
    this.collectAllNodeIds(this.treeRoots, currentIds);
    const validCollapsed = new Set<string>();
    for (const id of collapsed) {
      if (currentIds.has(id)) {
        validCollapsed.add(id);
      }
    }
    await this.stateManager.setCollapsed(validCollapsed);
  }

  private collectAllNodeIds(nodes: TreeNode[], ids: Set<string>): void {
    for (const node of nodes) {
      ids.add(node.id);
      this.collectAllNodeIds(node.children, ids);
    }
  }

  private async applyDefaultExpandLevel(): Promise<void> {
    const level = this.getSettings().defaultExpandLevel;
    const collapsed = this.stateManager.getCollapsedNodes();

    if (level === -1) {
      if (collapsed.size > 0) {
        await this.stateManager.expandAll();
      }
    } else if (level === 0) {
      const allParentIds: string[] = [];
      this.collectParentIds(this.treeRoots, allParentIds);
      await this.stateManager.collapseAll(allParentIds);
    } else {
      const toCollapse: string[] = [];
      this.collectIdsBelowLevel(this.treeRoots, 0, level, toCollapse);
      await this.stateManager.collapseAll(toCollapse);
    }
  }

  private collectParentIds(nodes: TreeNode[], ids: string[]): void {
    for (const node of nodes) {
      if (node.children.length > 0) {
        ids.push(node.id);
        this.collectParentIds(node.children, ids);
      }
    }
  }

  private collectIdsBelowLevel(
    nodes: TreeNode[],
    currentLevel: number,
    maxLevel: number,
    ids: string[]
  ): void {
    for (const node of nodes) {
      if (node.children.length > 0) {
        if (currentLevel >= maxLevel) {
          ids.push(node.id);
        }
        this.collectIdsBelowLevel(node.children, currentLevel + 1, maxLevel, ids);
      }
    }
  }

  private renderTree(): void {
    this.treeContainerEl.innerHTML = "";
    this.emptyEl.innerHTML = "";

    if (this.treeRoots.length === 0) {
      this.treeContainerEl.style.display = "none";
      this.emptyEl.style.display = "flex";
      this.emptyEl.textContent = this.getSettings().placeholderText;
      return;
    }

    this.treeContainerEl.style.display = "block";
    this.emptyEl.style.display = "none";

    const collapsed = this.stateManager.getCollapsedNodes();

    for (const root of this.treeRoots) {
      const el = this.renderNode(root, collapsed, 0);
      this.treeContainerEl.appendChild(el);
    }
  }

  private renderNode(node: TreeNode, collapsed: Set<string>, depth: number): HTMLElement {
    const isCollapsed = collapsed.has(node.id);
    const hasChildren = node.children.length > 0;

    const itemEl = document.createElement("div");
    itemEl.className = "virtual-tree-node tree-item";
    if (isCollapsed && hasChildren) itemEl.classList.add("is-collapsed");
    if (node.isRoot) itemEl.classList.add("is-root");
    itemEl.dataset.nodeId = node.id;
    itemEl.dataset.depth = String(depth);

    const selfEl = document.createElement("div");
    selfEl.className = "tree-item-self is-clickable";
    selfEl.style.paddingLeft = `${depth * 16 + 8}px`;

    // hover 换行显示：第一行 文档名 · id，第二行 笔记本 > 父文档
    // 笔记本名异步获取，首次 hover 时补全 title
    const parentPath = this.getParentHpath(node);
    selfEl.title = `${node.displayName} · ${node.docId}`;
    selfEl.addEventListener("mouseenter", () => {
      void this.fillNotebookTitle(node, selfEl, parentPath);
    });

    const innerEl = document.createElement("span");
    innerEl.className = "tree-item-inner virtual-tree-filename";
    innerEl.textContent = node.displayName;
    selfEl.appendChild(innerEl);

    if (node.weight !== 0) {
      const weightEl = document.createElement("span");
      weightEl.className = "virtual-tree-weight";
      weightEl.textContent = String(node.weight);
      selfEl.appendChild(weightEl);
    }

    const collapseIconEl = document.createElement("span");
    collapseIconEl.className = "tree-item-icon collapse-icon";
    if (hasChildren) {
      collapseIconEl.innerHTML = `<svg><use xlink:href="#iconRight"></use></svg>`;
    }
    selfEl.appendChild(collapseIconEl);

    itemEl.appendChild(selfEl);

    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-item-children";

    if (hasChildren) {
      for (const child of node.children) {
        const childEl = this.renderNode(child, collapsed, depth + 1);
        childrenEl.appendChild(childEl);
      }
    }

    itemEl.appendChild(childrenEl);
    return itemEl;
  }

  private handleTreeClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    const filenameEl = target.closest(".virtual-tree-filename") as HTMLElement | null;
    const selfEl = target.closest(".tree-item-self") as HTMLElement | null;
    if (!selfEl) return;

    const nodeEl = selfEl.closest(".virtual-tree-node") as HTMLElement | null;
    if (!nodeEl) return;

    const nodeId = nodeEl.dataset.nodeId;
    if (!nodeId) return;

    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    e.preventDefault();
    e.stopPropagation();

    if (filenameEl) {
      this.openNode(node);
    } else if (node.children.length > 0) {
      void this.toggleNode(node.id);
    }
  }

  private handleTreeContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const selfEl = target.closest(".tree-item-self") as HTMLElement | null;
    if (!selfEl) return;

    const nodeEl = selfEl.closest(".virtual-tree-node") as HTMLElement | null;
    if (!nodeEl) return;

    const nodeId = nodeEl.dataset.nodeId;
    if (!nodeId) return;

    const node = this.nodeMap.get(nodeId);
    if (!node) return;

    e.preventDefault();
    this.showContextMenu(node, e);
  }

  private openNode(node: TreeNode): void {
    openTab({
      app: this.getApp(),
      doc: {
        id: node.docId,
      },
    });
  }

  private async toggleNode(nodeId: string): Promise<void> {
    await this.stateManager.toggleCollapsed(nodeId);
    this.renderTree();
  }

  private showContextMenu(node: TreeNode, event: MouseEvent): void {
    const menu = new Menu("virtual-tree-context");

    menu.addItem({
      icon: "iconEdit",
      label: t("openDoc", "打开文档"),
      click: () => this.openNode(node),
    });

    menu.addItem({
      icon: "iconFile",
      label: t("openInNewTab", "在新标签页打开"),
      click: () => {
        openTab({
          app: this.getApp(),
          doc: { id: node.docId },
        });
      },
    });

    if (node.isRoot) {
      menu.addSeparator();
      menu.addItem({
        icon: "iconTrashcan",
        label: t("removeRoot", "从虚拟树移除"),
        click: async () => {
          await this.stateManager.removeRootDoc(node.docId);
          this.rebuildTree();
        },
      });
    }

    menu.open({ x: event.clientX, y: event.clientY });
  }

  async collapseAll(): Promise<void> {
    const allParentIds: string[] = [];
    this.collectParentIds(this.treeRoots, allParentIds);
    await this.stateManager.collapseAll(allParentIds);
    this.renderTree();
  }

  async expandAll(): Promise<void> {
    await this.stateManager.expandAll();
    this.renderTree();
  }

  /**
   * 切换聚焦模式：
   * - 未聚焦 → 聚焦当前激活文档（只显示其后代树）
   * - 已聚焦 → 退出聚焦，恢复完整虚拟树
   */
  async toggleFocus(): Promise<void> {
    if (this.focusedDocId) {
      this.focusedDocId = null;
    } else {
      const rootId = getCurrentDocRootId();
      if (!rootId) {
        showMessage(t("openDocFirst", "请先打开一个文档"));
        return;
      }
      this.focusedDocId = rootId;
    }
    // 进入/退出聚焦都是视图切换，重置展开状态
    this.isFirstBuild = true;
    this.renderToolbar();
    this.rebuildTree();
  }

  async locateCurrent(): Promise<void> {
    const rootId = getCurrentDocRootId();
    if (!rootId) {
      showMessage(t("openDocFirst", "请先打开一个文档"));
      return;
    }

    // 文档可能在虚拟树中多处出现，查找全部匹配节点
    const matches = this.findAllNodesByDocId(this.treeRoots, rootId);
    if (matches.length === 0) {
      showMessage(t("locateNotFound", "当前文档不在虚拟文档树中"));
      return;
    }

    // 展开所有匹配节点的祖先路径，确保至少一处可见
    const allAncestorIds = new Set<string>();
    for (const match of matches) {
      for (const id of this.getAncestorIds(match)) {
        allAncestorIds.add(id);
      }
    }
    await this.stateManager.expandToNode(matches[0].id, Array.from(allAncestorIds));
    this.renderTree();

    // 双 rAF 确保 DOM 布局完成后再滚动，比 setTimeout 更可靠
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const nodeEl = this.treeContainerEl.querySelector(
          `[data-node-id="${CSS.escape(matches[0].id)}"]`
        );
        if (nodeEl) {
          nodeEl.scrollIntoView({ behavior: "smooth", block: "center" });
          nodeEl.classList.add("virtual-tree-locate-flash");
          setTimeout(() => {
            nodeEl.classList.remove("virtual-tree-locate-flash");
          }, LOCATE_FLASH_MS);
        }
      });
    });
  }

  private findAllNodesByDocId(nodes: TreeNode[], docId: string): TreeNode[] {
    const results: TreeNode[] = [];
    const walk = (list: TreeNode[]): void => {
      for (const node of list) {
        if (node.docId === docId) results.push(node);
        if (node.children.length > 0) walk(node.children);
      }
    };
    walk(nodes);
    return results;
  }

  private getAncestorIds(node: TreeNode): string[] {
    const ids: string[] = [];
    let current = node.parent;
    while (current) {
      ids.push(current.id);
      current = current.parent;
    }
    return ids;
  }

  /**
   * 取文档物理父路径：hpath 形如 "/父/当前文档"，去掉最后一段得到 "/父"。
   * 根文档 hpath 通常为 "/当前文档"，去掉后为空。
   */
  private getParentHpath(node: TreeNode): string {
    const idx = node.hpath.lastIndexOf("/");
    return idx > 0 ? node.hpath.slice(0, idx) : "";
  }

  /**
   * 首次 hover 时异步补全笔记本名，组装两行 title：
   * 第一行：文档名 · docId
   * 第二行：笔记本 > 父文档路径
   */
  private async fillNotebookTitle(
    node: TreeNode,
    el: HTMLElement,
    parentPath: string
  ): Promise<void> {
    if (el.dataset.titleReady === "1") return;
    el.dataset.titleReady = "1";
    const notebookName = await getNotebookName(node.box);
    const location = notebookName
      ? `${notebookName}${parentPath ? " > " + parentPath : ""}`
      : parentPath;
    el.title = `${node.displayName} · ${node.docId}\n${location}`;
  }
}
