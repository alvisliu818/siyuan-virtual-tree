import { TreeNode, VirtualTreeSettings } from "./types";

export function sortChildren(
  children: TreeNode[],
  settings: VirtualTreeSettings,
  customOrder: string[]
): void {
  switch (settings.sortMethod) {
    case "name":
      sortByName(children, settings.caseSensitive);
      break;
    case "weight":
      sortByWeight(children, settings.caseSensitive);
      break;
    case "custom":
      sortByCustom(children, customOrder, settings.caseSensitive);
      break;
  }
}

function sortByName(children: TreeNode[], caseSensitive: boolean): void {
  children.sort((a, b) => {
    if (caseSensitive) {
      return a.displayName.localeCompare(b.displayName);
    }
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}

function sortByWeight(children: TreeNode[], caseSensitive: boolean): void {
  children.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (caseSensitive) {
      return a.displayName.localeCompare(b.displayName);
    }
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}

function sortByCustom(children: TreeNode[], customOrder: string[], caseSensitive: boolean): void {
  const orderMap = new Map<string, number>();
  customOrder.forEach((id, index) => orderMap.set(id, index));

  children.sort((a, b) => {
    const orderA = orderMap.has(a.docId) ? orderMap.get(a.docId)! : Infinity;
    const orderB = orderMap.has(b.docId) ? orderMap.get(b.docId)! : Infinity;

    if (orderA !== orderB) return orderA - orderB;

    if (caseSensitive) {
      return a.displayName.localeCompare(b.displayName);
    }
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}
