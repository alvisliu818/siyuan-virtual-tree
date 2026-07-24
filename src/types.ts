export interface VirtualTreeSettings {
  weightAttrName: string;
  defaultExpandLevel: number;
  sortMethod: "name" | "weight" | "custom";
  maxDepth: number;
  maxNodes: number;
  placeholderText: string;
  caseSensitive: boolean;
  includePhysicalSubtree: boolean;
}

export const DEFAULT_SETTINGS: VirtualTreeSettings = {
  weightAttrName: "weight",
  defaultExpandLevel: -1,
  sortMethod: "name",
  maxDepth: 10,
  maxNodes: 500,
  placeholderText: "暂无内容，请添加根节点",
  caseSensitive: false,
  includePhysicalSubtree: false,
};

export interface PluginData {
  settings: VirtualTreeSettings;
  rootDocIds: string[];
  collapsedNodes: string[];
  customOrder: Record<string, string[]>;
}

export const DEFAULT_DATA: PluginData = {
  settings: { ...DEFAULT_SETTINGS },
  rootDocIds: [],
  collapsedNodes: [],
  customOrder: {},
};

export interface TreeNode {
  id: string;
  docId: string;
  displayName: string;
  name: string;
  hpath: string;
  box: string;
  children: TreeNode[];
  parent: TreeNode | null;
  weight: number;
  isRoot: boolean;
}
