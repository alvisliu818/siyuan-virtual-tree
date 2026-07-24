import { TreeNode, VirtualTreeSettings } from "./types";
import {
  getFirstBlockRefs,
  getChildrenForDoc,
  getPhysicalChildRelations,
  getPhysicalChildren,
  batchGetDocInfo,
  batchGetWeightAttrs,
  getDocInfo,
  getWeightAttr,
  ParentChildRelation,
  BlockInfo,
} from "./api";
import { sortChildren } from "./sorter";
import { disambiguateSiblings } from "./disambiguator";

/**
 * 子节点来源抽象。batch 与 fallback 两条路径各提供一个实现，
 * 让上层 buildSubtree 不关心数据是预取还是按需拉取。
 */
interface ChildSource {
  getDocInfo(docId: string): Promise<BlockInfo | null>;
  getChildren(docId: string): Promise<ChildEntry[]>;
  getWeight(docId: string): Promise<number>;
}

interface ChildEntry {
  childId: string;
  docInfo: BlockInfo | null;
}

/** 批量预取实现：所有关系与文档信息一次性查完，查询时纯内存查找。 */
class BatchChildSource implements ChildSource {
  constructor(
    private relations: ParentChildRelation[],
    private docInfoMap: Map<string, BlockInfo>,
    private weightMap: Map<string, number>
  ) {}

  async getDocInfo(docId: string): Promise<BlockInfo | null> {
    return this.docInfoMap.get(docId) ?? null;
  }

  async getChildren(docId: string): Promise<ChildEntry[]> {
    return this.relations
      .filter((r) => r.parentId === docId)
      .map((r) => ({ childId: r.childId, docInfo: this.docInfoMap.get(r.childId) ?? null }));
  }

  async getWeight(docId: string): Promise<number> {
    return this.weightMap.get(docId) ?? 0;
  }
}

/** 按需拉取实现：带本地缓存，命中即返回，否则发起请求。 */
class FallbackChildSource implements ChildSource {
  private docCache: Map<string, BlockInfo>;
  private relationCache = new Map<string, string[]>();
  private weightCache = new Map<string, number>();
  private weightAttrName: string;
  private includePhysical: boolean;

  constructor(weightAttrName: string, seedDocs: Map<string, BlockInfo>, includePhysical: boolean) {
    this.weightAttrName = weightAttrName;
    this.docCache = new Map(seedDocs);
    this.includePhysical = includePhysical;
  }

  async getDocInfo(docId: string): Promise<BlockInfo | null> {
    if (this.docCache.has(docId)) return this.docCache.get(docId) ?? null;
    const info = await getDocInfo(docId);
    if (info) this.docCache.set(docId, info);
    return info;
  }

  async getChildren(docId: string): Promise<ChildEntry[]> {
    if (!this.relationCache.has(docId)) {
      const refChildren = await getChildrenForDoc(docId);
      // 合并物理子文档并去重
      const physicalChildren = this.includePhysical
        ? await getPhysicalChildren(docId)
        : [];
      const seen = new Set(refChildren);
      const merged = [...refChildren];
      for (const id of physicalChildren) {
        if (!seen.has(id)) {
          seen.add(id);
          merged.push(id);
        }
      }
      this.relationCache.set(docId, merged);
    }
    const childIds = this.relationCache.get(docId) ?? [];
    const entries: ChildEntry[] = [];
    for (const childId of childIds) {
      const docInfo = await this.getDocInfo(childId);
      entries.push({ childId, docInfo });
    }
    return entries;
  }

  async getWeight(docId: string): Promise<number> {
    if (!this.weightCache.has(docId)) {
      this.weightCache.set(docId, await getWeightAttr(docId, this.weightAttrName));
    }
    return this.weightCache.get(docId) ?? 0;
  }
}

export class TreeBuilder {
  private settings: VirtualTreeSettings;
  private customOrder: Record<string, string[]>;
  private nodeCount: number;

  constructor(settings: VirtualTreeSettings, customOrder: Record<string, string[]>) {
    this.settings = settings;
    this.customOrder = customOrder;
    this.nodeCount = 0;
  }

  async buildTree(rootDocIds: string[]): Promise<TreeNode[]> {
    this.nodeCount = 0;
    if (rootDocIds.length === 0) return [];

    const refRelations = await getFirstBlockRefs();

    // 开启物理子树时，合并物理父子关系并按 (parentId, childId) 去重
    let allRelations = refRelations;
    if (this.settings.includePhysicalSubtree) {
      const physicalRelations = await getPhysicalChildRelations();
      const seen = new Set(refRelations.map((r) => r.parentId + "->" + r.childId));
      allRelations = [...refRelations];
      for (const r of physicalRelations) {
        const key = r.parentId + "->" + r.childId;
        if (!seen.has(key)) {
          seen.add(key);
          allRelations.push(r);
        }
      }
    }

    const source = await this.resolveSource(rootDocIds, allRelations);

    const roots: TreeNode[] = [];
    for (const rootId of rootDocIds) {
      if (this.nodeCount >= this.settings.maxNodes && roots.length > 0) break;

      const docInfo = (await source.getDocInfo(rootId)) ?? (await getDocInfo(rootId));
      if (!docInfo) {
        console.warn("[VirtualTree] Root doc not found:", rootId);
        continue;
      }

      const rootNode = await this.buildSubtree(
        rootId,
        docInfo,
        source,
        new Set<string>(),
        null,
        rootId,
        0
      );
      rootNode.isRoot = true;
      roots.push(rootNode);
    }

    disambiguateSiblings(roots);
    return roots;
  }

  /**
   * 优先用批量预取的 BatchChildSource；关系为空或文档信息全 miss 时回退到 FallbackChildSource。
   */
  private async resolveSource(
    rootDocIds: string[],
    allRelations: ParentChildRelation[]
  ): Promise<ChildSource> {
    if (allRelations.length === 0) {
      return this.buildFallbackSource(rootDocIds);
    }

    const allDocIds = new Set<string>(rootDocIds);
    this.collectChildDocIds(rootDocIds, allRelations, allDocIds, 0);

    const docInfoMap = await batchGetDocInfo(Array.from(allDocIds));
    if (docInfoMap.size === 0) {
      return this.buildFallbackSource(rootDocIds);
    }

    const weightMap = await batchGetWeightAttrs(
      Array.from(allDocIds),
      this.settings.weightAttrName
    );
    return new BatchChildSource(allRelations, docInfoMap, weightMap);
  }

  private async buildFallbackSource(rootDocIds: string[]): Promise<FallbackChildSource> {
    const seedDocs = new Map<string, BlockInfo>();
    for (const rootId of rootDocIds) {
      const info = await getDocInfo(rootId);
      if (info) seedDocs.set(rootId, info);
    }
    return new FallbackChildSource(
      this.settings.weightAttrName,
      seedDocs,
      this.settings.includePhysicalSubtree
    );
  }

  private collectChildDocIds(
    parentIds: string[],
    relations: ParentChildRelation[],
    collected: Set<string>,
    depth: number
  ): void {
    if (depth >= this.settings.maxDepth) return;

    for (const parentId of parentIds) {
      const childIds = relations
        .filter((r) => r.parentId === parentId)
        .map((r) => r.childId);

      for (const childId of childIds) {
        if (collected.has(childId)) continue;
        if (collected.size >= this.settings.maxNodes) return;
        collected.add(childId);
      }

      this.collectChildDocIds(childIds, relations, collected, depth + 1);
    }
  }

  private async buildSubtree(
    docId: string,
    docInfo: BlockInfo,
    source: ChildSource,
    ancestors: Set<string>,
    parent: TreeNode | null,
    nodeId: string,
    depth: number
  ): Promise<TreeNode> {
    this.nodeCount++;

    const node: TreeNode = {
      id: nodeId,
      docId,
      displayName: docInfo.content,
      name: docInfo.content,
      hpath: docInfo.hpath,
      box: docInfo.box,
      children: [],
      parent,
      weight: await source.getWeight(docId),
      isRoot: false,
    };

    if (depth >= this.settings.maxDepth || this.nodeCount >= this.settings.maxNodes) {
      return node;
    }

    ancestors.add(docId);
    const entries = await source.getChildren(docId);

    for (const { childId, docInfo: childDocInfo } of entries) {
      if (ancestors.has(childId)) continue;
      if (this.nodeCount >= this.settings.maxNodes) break;
      if (!childDocInfo) continue;

      const childAncestors = new Set(ancestors);
      const childNodeId = nodeId + "::" + childId;
      const childNode = await this.buildSubtree(
        childId,
        childDocInfo,
        source,
        childAncestors,
        node,
        childNodeId,
        depth + 1
      );
      node.children.push(childNode);
    }

    // 在每一层就地排序（含根节点的直接子节点），无需在 buildTree 中重复排序
    sortChildren(node.children, this.settings, this.customOrder[node.id] || []);
    return node;
  }
}
