import { Plugin } from "siyuan";
import { PluginData, DEFAULT_DATA, DEFAULT_SETTINGS, VirtualTreeSettings } from "./types";
import { STORAGE_NAME } from "./constants";

export class StateManager {
  private plugin: Plugin;
  private data: PluginData;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.data = { ...DEFAULT_DATA };
  }

  async load(): Promise<void> {
    try {
      const loaded = await this.plugin.loadData(STORAGE_NAME);
      if (loaded) {
        this.data = {
          settings: { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) },
          rootDocIds: loaded.rootDocIds || [],
          collapsedNodes: loaded.collapsedNodes || [],
          customOrder: loaded.customOrder || {},
        };
      } else {
        this.data = { ...DEFAULT_DATA };
      }
    } catch (e) {
      console.error("Failed to load plugin data:", e);
      this.data = { ...DEFAULT_DATA };
    }
  }

  async save(): Promise<void> {
    try {
      await this.plugin.saveData(STORAGE_NAME, this.data);
    } catch (e) {
      console.error("Failed to save plugin data:", e);
    }
  }

  getSettings(): VirtualTreeSettings {
    return this.data.settings;
  }

  async updateSettings(partial: Partial<VirtualTreeSettings>): Promise<void> {
    this.data.settings = { ...this.data.settings, ...partial };
    await this.save();
  }

  getRootDocIds(): string[] {
    return [...this.data.rootDocIds];
  }

  async addRootDoc(docId: string): Promise<boolean> {
    if (this.data.rootDocIds.includes(docId)) return false;
    this.data.rootDocIds.push(docId);
    await this.save();
    return true;
  }

  async removeRootDoc(docId: string): Promise<boolean> {
    const idx = this.data.rootDocIds.indexOf(docId);
    if (idx === -1) return false;
    this.data.rootDocIds.splice(idx, 1);
    await this.save();
    return true;
  }

  /**
   * 清理无效根文档 ID（文档已被删除但 ID 仍残留在数据中）。
   * 保留 validIds 中存在的根，移除其余。返回被移除的数量。
   */
  async pruneRootDocIds(validIds: string[]): Promise<number> {
    const validSet = new Set(validIds);
    const before = this.data.rootDocIds.length;
    this.data.rootDocIds = this.data.rootDocIds.filter((id) => validSet.has(id));
    const removed = before - this.data.rootDocIds.length;
    if (removed > 0) await this.save();
    return removed;
  }

  isRootDoc(docId: string): boolean {
    return this.data.rootDocIds.includes(docId);
  }

  getCollapsedNodes(): Set<string> {
    return new Set(this.data.collapsedNodes);
  }

  async setCollapsed(collapsed: Set<string>): Promise<void> {
    this.data.collapsedNodes = Array.from(collapsed);
    await this.save();
  }

  async toggleCollapsed(nodeId: string): Promise<boolean> {
    const set = this.getCollapsedNodes();
    if (set.has(nodeId)) {
      set.delete(nodeId);
    } else {
      set.add(nodeId);
    }
    await this.setCollapsed(set);
    return set.has(nodeId);
  }

  async collapseAll(nodeIds: string[]): Promise<void> {
    const set = this.getCollapsedNodes();
    for (const id of nodeIds) {
      set.add(id);
    }
    await this.setCollapsed(set);
  }

  async expandAll(): Promise<void> {
    await this.setCollapsed(new Set());
  }

  async expandToNode(nodeId: string, ancestorIds: string[]): Promise<void> {
    const set = this.getCollapsedNodes();
    for (const id of ancestorIds) {
      set.delete(id);
    }
    await this.setCollapsed(set);
  }

  getCustomOrder(parentId: string): string[] {
    return this.data.customOrder[parentId] || [];
  }

  getCustomOrderMap(): Record<string, string[]> {
    return { ...this.data.customOrder };
  }

  async setCustomOrder(parentId: string, childIds: string[]): Promise<void> {
    this.data.customOrder[parentId] = childIds;
    await this.save();
  }
}
