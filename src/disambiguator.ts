import { TreeNode } from "./types";

export function disambiguateSiblings(nodes: TreeNode[]): void {
  disambiguateLevel(nodes);
  for (const node of nodes) {
    if (node.children.length > 0) {
      disambiguateSiblings(node.children);
    }
  }
}

function disambiguateLevel(nodes: TreeNode[]): void {
  const nameGroups = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const list = nameGroups.get(node.name) || [];
    list.push(node);
    nameGroups.set(node.name, list);
  }

  for (const [, group] of nameGroups) {
    if (group.length <= 1) continue;
    resolveAmbiguousNames(group);
  }
}

function getAncestorNames(node: TreeNode): string[] {
  const ancestors: string[] = [];
  let current = node.parent;
  while (current) {
    ancestors.push(current.name);
    current = current.parent;
  }

  if (ancestors.length === 0 && node.hpath) {
    const parts = node.hpath.split("/").filter((p) => p.length > 0);
    if (parts.length > 1) {
      const parentParts = parts.slice(0, -1);
      ancestors.push(...parentParts.reverse());
    }
  }

  return ancestors;
}

function resolveAmbiguousNames(nodes: TreeNode[]): void {
  const ancestorNamesList = nodes.map((node) => getAncestorNames(node));

  let prefixLevel = 1;
  const maxLevel = Math.max(...ancestorNamesList.map((a) => a.length), 0);

  while (prefixLevel <= maxLevel) {
    const displayNames = nodes.map((node, i) => {
      const ancestors = ancestorNamesList[i];
      const suffixParts: string[] = [];
      for (let j = 0; j < Math.min(prefixLevel, ancestors.length); j++) {
        suffixParts.push(ancestors[j]);
      }
      if (suffixParts.length > 0) {
        return node.name + "<" + suffixParts.join("<");
      }
      return node.name;
    });

    const nameSet = new Set<string>();
    let hasDuplicate = false;
    for (const name of displayNames) {
      if (nameSet.has(name)) {
        hasDuplicate = true;
        break;
      }
      nameSet.add(name);
    }

    if (!hasDuplicate) {
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].displayName = displayNames[i];
      }
      return;
    }

    prefixLevel++;
  }

  // 兜底：全祖先拼接
  for (let i = 0; i < nodes.length; i++) {
    const ancestors = ancestorNamesList[i];
    if (ancestors.length > 0) {
      nodes[i].displayName = nodes[i].name + "<" + ancestors.join("<");
    }
  }

  // 最终保证：祖先链也重名时，追加 docId 短后缀确保兄弟间 displayName 唯一
  ensureUniqueByDocId(nodes);
}

/**
 * 对仍重名的节点追加 docId 短后缀。
 * 仅在祖先链完全相同（无法用名字消歧）的极端情况下触发，
 * 保证用户在 UI 上能区分两个重名文档。
 */
function ensureUniqueByDocId(nodes: TreeNode[]): void {
  const groups = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const list = groups.get(node.displayName) || [];
    list.push(node);
    groups.set(node.displayName, list);
  }
  for (const [, group] of groups) {
    if (group.length <= 1) continue;
    for (const node of group) {
      node.displayName = node.displayName + " (" + node.docId.slice(-6) + ")";
    }
  }
}
