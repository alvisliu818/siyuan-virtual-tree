// 引用关系树:根据文档**首块的引用链接**自动构建一棵关系树
//
// 移植自独立插件 siyuan-virtual-tree(同作者),按 editor 的方式重写:
//   - 去掉独立插件的 Setting 面板/状态管理/命令面板,设置并入 editor 的设置页
//   - 排序支持"自定义(拖拽)",顺序持久化到 editor 的配置里
//   - 关系树是**只读派生视图**:结构不落盘,每次重建都从内核现查,不会产生陈旧数据
//   - 只有「自定义顺序」和折叠状态会持久化(那是用户的显式意图)
//
// 与 mount-tree(手动挂载)的关系:两者共存而非互斥。
// 手动挂载是"用户自己组织的工作区",关系树是"文档之间实际存在的引用结构"。
//
// 核心机制(原插件实测有效的部分,勿轻改):
//   父 = 被引用的文档(def_block_root_id),子 = 发起引用的文档(root_id)。
//   只认**首块**的引用(每个文档取 sort 最小的那个非文档块),否则满树都是噪音。

import {fetchSyncPost} from "siyuan";

/** 关系树设置(并入 editor 设置页,存 EditorConfig) */
export interface RelationTreeOptions {
    // 排序方式:name=按名称 | weight=按文档属性权重 | custom=拖拽自定义
    sortMethod: "name" | "weight" | "custom";
    weightAttrName: string;   // 权重属性名(文档自定义属性,缺失视为 0)
    caseSensitive: boolean;   // 排序是否区分大小写
    maxDepth: number;         // 最大递归深度(防无限递归)
    maxNodes: number;         // 最大节点数(防失控)
    includePhysicalSubtree: boolean; // 是否并入思源原生层级的物理子文档
    defaultExpandLevel: number;      // 默认展开层级:0=全折叠 -1=全展开 N=展开前 N 层
    // 自定义(拖拽)顺序:parentDocId -> 子节点 docId 有序数组;"__root__" 表示根层
    customOrder: Record<string, string[]>;
}

export const DEFAULT_RELATION_OPTIONS: RelationTreeOptions = {
    sortMethod: "name",
    weightAttrName: "weight",
    caseSensitive: false,
    maxDepth: 10,      // 与原插件一致
    maxNodes: 500,
    includePhysicalSubtree: false,
    defaultExpandLevel: -1,  // 与原插件一致:-1 = 默认全部展开
    customOrder: {},
};

export interface RelationDocInfo {
    id: string;
    content: string;
    hpath: string;
    box: string;
    path: string;
}

export interface RelationNode {
    docId: string;
    name: string;
    /** 显示名:同名兄弟会被自动加上祖先路径后缀消歧(见 disambiguateSiblings) */
    displayName: string;
    hpath: string;
    depth: number;
    weight: number;
    /** 该文档在思源原生层级里的**子文档数**(决定图标是 folder 还是 file) */
    subFileCount: number;
    children: RelationNode[];
    /** 消歧阶段临时保存父指针,用完即清(避免序列化时循环引用) */
    __parent?: RelationNode | null;
}

// 关系树里的顶层节点用这个虚拟 id 作为排序容器的 key
export const RELATION_ROOT_KEY = "__root__";

function sqlStr(value: string): string {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function sqlInList(ids: string[]): string {
    return "(" + ids.map((id) => sqlStr(id)).join(",") + ")";
}

async function sqlQuery<T>(stmt: string): Promise<T[]> {
    try {
        const res = await fetchSyncPost("/api/query/sql", {stmt});
        if (res.code !== 0) return [];
        return (res.data || []) as T[];
    } catch {
        return [];
    }
}

// ===== 首块引用关系 =====

// 「每个文档的首块」:取 sort 最小的非文档块。
// 注意不能只取 parent_id = root_id 的顶层块 —— 首块常被包在容器块里,
// 那样会漏掉一大类文档(原插件 4 套策略正是为覆盖这个而写)。
const SQL_REF_TOP_LEVEL = `
    WITH min_sorts AS (
      SELECT root_id, MIN(sort) AS min_sort
      FROM blocks
      WHERE type != 'd' AND parent_id = root_id
      GROUP BY root_id
    ),
    first_blocks AS (
      SELECT b.root_id, b.id
      FROM blocks b
      INNER JOIN min_sorts ms ON b.root_id = ms.root_id AND b.sort = ms.min_sort
      WHERE b.type != 'd' AND b.parent_id = b.root_id
    )
    SELECT DISTINCT r.def_block_root_id AS parent_id, r.root_id AS child_id
    FROM refs r
    INNER JOIN first_blocks fb ON r.block_id = fb.id
    WHERE r.def_block_root_id != r.root_id`;

// 放宽到任意首块(首块嵌在容器块内的文档靠这条补回)
const SQL_REF_ANY_FIRST_BLOCK = `
    WITH min_sorts AS (
      SELECT root_id, MIN(sort) AS min_sort
      FROM blocks
      WHERE type != 'd'
      GROUP BY root_id
    ),
    first_blocks AS (
      SELECT b.root_id, b.id
      FROM blocks b
      INNER JOIN min_sorts ms ON b.root_id = ms.root_id AND b.sort = ms.min_sort
      WHERE b.type != 'd'
    )
    SELECT DISTINCT r.def_block_root_id AS parent_id, r.root_id AS child_id
    FROM refs r
    INNER JOIN first_blocks fb ON r.block_id = fb.id
    WHERE r.def_block_root_id != r.root_id`;

// NOT EXISTS 相关子查询(与前两条语义等价,互为兜底)
const SQL_REF_NOT_EXISTS = `
    SELECT DISTINCT r.def_block_root_id AS parent_id, r.root_id AS child_id
    FROM refs r
    INNER JOIN blocks b ON r.block_id = b.id
    WHERE b.type != 'd'
    AND NOT EXISTS (
      SELECT 1 FROM blocks b2
      WHERE b2.root_id = b.root_id
      AND b2.type != 'd'
      AND (b2.sort < b.sort OR (b2.sort = b.sort AND b2.id < b.id))
    )
    AND r.def_block_root_id != r.root_id`;

// 思源原生层级里的直接子文档(仅在 includePhysicalSubtree 开启时用)
const SQL_PHYSICAL_CHILD = `
    SELECT p.id AS parent_id, c.id AS child_id
    FROM blocks p
    INNER JOIN blocks c ON c.box = p.box
      AND c.path LIKE substr(p.path, 1, length(p.path) - 3) || '/%'
      AND c.path NOT LIKE substr(p.path, 1, length(p.path) - 3) || '/%/%'
    WHERE p.type = 'd' AND c.type = 'd'`;

async function fetchRefRelations(): Promise<Map<string, string[]>> {
    // parentId -> childIds(去重)
    const relations = new Map<string, string[]>();
    const addRows = (rows: {parent_id: string; child_id: string}[]) => {
        for (const r of rows) {
            if (!r.parent_id || !r.child_id) continue;
            const list = relations.get(r.parent_id) || [];
            if (!list.includes(r.child_id)) list.push(r.child_id);
            relations.set(r.parent_id, list);
        }
    };
    // 逐套策略合并,任一套拿到结果即继续下一套(取并集,不短路,避免漏关系)
    for (const stmt of [SQL_REF_TOP_LEVEL, SQL_REF_ANY_FIRST_BLOCK, SQL_REF_NOT_EXISTS]) {
        addRows(await sqlQuery<{parent_id: string; child_id: string}>(stmt));
    }
    return relations;
}

async function fetchAllDocIds(): Promise<string[]> {
    const rows = await sqlQuery<{id: string}>(`SELECT id FROM blocks WHERE type = 'd'`);
    return rows.map((r) => r.id);
}

async function batchDocInfo(docIds: string[]): Promise<Map<string, RelationDocInfo>> {
    const map = new Map<string, RelationDocInfo>();
    if (docIds.length === 0) return map;
    // SQLite IN 列表有长度上限,分批查
    const CHUNK = 200;
    for (let i = 0; i < docIds.length; i += CHUNK) {
        const chunk = docIds.slice(i, i + CHUNK);
        const rows = await sqlQuery<RelationDocInfo>(
            `SELECT id, content, hpath, box, path FROM blocks WHERE id IN ${sqlInList(chunk)} AND type = 'd'`
        );
        for (const r of rows) map.set(r.id, r);
    }
    return map;
}

/**
 * 批量查每个文档的**直接子文档数**(思源原生层级)。
 * 只用于选图标(folder / file),与引用关系无关 —— 这点很关键:
 * 早先按"有没有引用者"选图标,导致同一篇文档在关系树和原生文档树里图标不一样。
 */
async function batchSubFileCounts(docIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (docIds.length === 0) return map;
    const CHUNK = 200;
    for (let i = 0; i < docIds.length; i += CHUNK) {
        const chunk = docIds.slice(i, i + CHUNK);
        const rows = await sqlQuery<{parent_id: string; n: number}>(
            `SELECT parent_id, COUNT(*) AS n FROM blocks
             WHERE type = 'd' AND parent_id IN ${sqlInList(chunk)}
             GROUP BY parent_id`
        );
        for (const r of rows) map.set(r.parent_id, Number(r.n) || 0);
    }
    return map;
}

async function batchWeights(docIds: string[], attrName: string): Promise<Map<string, number>> {    const map = new Map<string, number>();
    if (docIds.length === 0 || !attrName) return map;
    const CHUNK = 200;
    for (let i = 0; i < docIds.length; i += CHUNK) {
        const chunk = docIds.slice(i, i + CHUNK);
        const rows = await sqlQuery<{root_id: string; value: string}>(
            `SELECT root_id, value FROM attributes WHERE root_id IN ${sqlInList(chunk)} AND name = ${sqlStr(attrName)} AND type = 'd'`
        );
        for (const r of rows) {
            const n = Number(r.value);
            if (!isNaN(n)) map.set(r.root_id, n);
        }
    }
    return map;
}

/**
 * 自动挑根:引用了别人、但没被任何文档引用的文档。
 * 这就是关系森林的自然根 —— 用户什么都不用配,打开就有内容。
 */
function pickRoots(allDocIds: string[], relations: Map<string, string[]>): string[] {
    const docIdSet = new Set(allDocIds);
    const hasParent = new Set<string>();
    for (const children of relations.values()) {
        for (const c of children) hasParent.add(c);
    }
    const roots: string[] = [];
    for (const parentId of relations.keys()) {
        if (!docIdSet.has(parentId)) continue;
        if (!hasParent.has(parentId)) roots.push(parentId);
    }
    // 全部文档都在环里(互相引用)时,退回所有有子节点的文档,避免空树
    if (roots.length === 0) {
        for (const parentId of relations.keys()) {
            if (docIdSet.has(parentId)) roots.push(parentId);
        }
    }
    return roots;
}

// ===== 排序 =====

function sortNodes(
    nodes: RelationNode[],
    parentKey: string,
    opts: RelationTreeOptions,
): void {
    const byName = (a: RelationNode, b: RelationNode) =>
        opts.caseSensitive
            ? a.name.localeCompare(b.name)
            : a.name.localeCompare(b.name, undefined, {sensitivity: "base"});

    if (opts.sortMethod === "weight") {
        nodes.sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : byName(a, b)));
        return;
    }
    if (opts.sortMethod === "custom") {
        const order = opts.customOrder?.[parentKey];
        if (order && order.length) {
            const rank = new Map<string, number>();
            order.forEach((id, i) => rank.set(id, i));
            nodes.sort((a, b) => {
                const ra = rank.has(a.docId) ? rank.get(a.docId)! : Number.MAX_SAFE_INTEGER;
                const rb = rank.has(b.docId) ? rank.get(b.docId)! : Number.MAX_SAFE_INTEGER;
                if (ra !== rb) return ra - rb;
                return byName(a, b);
            });
            return;
        }
    }
    nodes.sort(byName);
}

/**
 * 构建引用关系森林。
 * 返回的节点带 depth,由调用方扁平化渲染。
 */
export async function buildRelationForest(opts: RelationTreeOptions): Promise<RelationNode[]> {
    const options: RelationTreeOptions = {...DEFAULT_RELATION_OPTIONS, ...opts};
    const relations = await fetchRefRelations();
    if (relations.size === 0) return [];

    // 并入物理子文档(可选)
    if (options.includePhysicalSubtree) {
        const rows = await sqlQuery<{parent_id: string; child_id: string}>(SQL_PHYSICAL_CHILD);
        for (const r of rows) {
            if (!r.parent_id || !r.child_id) continue;
            const list = relations.get(r.parent_id) || [];
            if (!list.includes(r.child_id)) list.push(r.child_id);
            relations.set(r.parent_id, list);
        }
    }

    const allDocIds = await fetchAllDocIds();
    if (allDocIds.length === 0) return [];
    const docIdSet = new Set(allDocIds);
    const rootIds = pickRoots(allDocIds, relations);
    if (rootIds.length === 0) return [];

    // 预取涉及的全部文档信息与权重(递归收集,受 maxNodes 约束)
    const involved = new Set<string>();
    const collect = (docId: string, depth: number, seen: Set<string>) => {
        if (depth > options.maxDepth || involved.size >= options.maxNodes || seen.has(docId)) return;
        seen.add(docId);
        involved.add(docId);
        for (const childId of relations.get(docId) || []) {
            if (docIdSet.has(childId)) collect(childId, depth + 1, seen);
        }
    };
    for (const r of rootIds) collect(r, 0, new Set());
    const involvedIds = Array.from(involved);
    const infoMap = await batchDocInfo(involvedIds);
    const subFileCountMap = await batchSubFileCounts(involvedIds);
    const weightMap = options.sortMethod === "weight"
        ? await batchWeights(involvedIds, options.weightAttrName)
        : new Map<string, number>();

    let nodeCount = 0;
    const build = (docId: string, depth: number, ancestors: Set<string>): RelationNode | null => {
        if (nodeCount >= options.maxNodes) return null;
        const info = infoMap.get(docId);
        if (!info) return null;
        nodeCount++;
        const node: RelationNode = {
            docId,
            name: info.content || "(无标题)",
            displayName: info.content || "(无标题)",
            hpath: info.hpath,
            depth,
            weight: weightMap.get(docId) ?? 0,
            subFileCount: subFileCountMap.get(docId) ?? 0,
            children: [],
        };
        if (depth >= options.maxDepth) return node;

        ancestors.add(docId);
        for (const childId of relations.get(docId) || []) {
            if (!docIdSet.has(childId)) continue;
            if (ancestors.has(childId)) continue; // 环检测:引用成环时不再深入
            const child = build(childId, depth + 1, new Set(ancestors));
            if (child) node.children.push(child);
        }
        sortNodes(node.children, docId, options);
        return node;
    };

    const roots: RelationNode[] = [];
    for (const rootId of rootIds) {
        const node = build(rootId, 0, new Set());
        if (node) roots.push(node);
    }
    sortNodes(roots, RELATION_ROOT_KEY, options);
    // 同名兄弟消歧:思源允许不同目录存在同名文档,不消歧界面上会出现多行一模一样的内容
    disambiguateSiblings(roots);
    return roots;
}

// ===== 同名兄弟消歧(移植自 siyuan-virtual-tree 的 disambiguator.ts)=====
// 思源里不同笔记本/不同目录可以存在同名文档,关系树里并排出现会完全分不清。
// 原插件的做法:逐级加祖先名前缀(名<父<祖父),直到兄弟间唯一;祖先链也相同
// (同名同路径)时追加 docId 短后缀兜底。**这步不能省**,否则界面上会出现多行一模一样的内容。

/** 取祖先名链(由近及远);没有 parent 指针时从 hpath 反推 */
function ancestorNamesOf(node: RelationNode, byDocId: Map<string, RelationNode>): string[] {
    const names: string[] = [];
    let cur = node.__parent;
    while (cur) {
        names.push(cur.name);
        cur = cur.__parent;
    }
    if (names.length === 0 && node.hpath) {
        const parts = node.hpath.split("/").filter((p) => p.length > 0);
        if (parts.length > 1) names.push(...parts.slice(0, -1).reverse());
    }
    void byDocId;
    return names;
}

function resolveAmbiguousNames(nodes: RelationNode[]): void {
    const ancestorNamesList = nodes.map((n) => ancestorNamesOf(n, new Map()));
    let prefixLevel = 1;
    const maxLevel = Math.max(...ancestorNamesList.map((a) => a.length), 0);

    while (prefixLevel <= maxLevel) {
        const displayNames = nodes.map((node, i) => {
            const ancestors = ancestorNamesList[i];
            const suffixParts: string[] = [];
            for (let j = 0; j < Math.min(prefixLevel, ancestors.length); j++) suffixParts.push(ancestors[j]);
            return suffixParts.length > 0 ? `${node.name}<${suffixParts.join("<")}` : node.name;
        });
        const nameSet = new Set<string>();
        let dup = false;
        for (const n of displayNames) {
            if (nameSet.has(n)) {
                dup = true;
                break;
            }
            nameSet.add(n);
        }
        if (!dup) {
            nodes.forEach((n, i) => (n.displayName = displayNames[i]));
            return;
        }
        prefixLevel++;
    }

    // 兜底:全祖先拼接
    nodes.forEach((node, i) => {
        const ancestors = ancestorNamesList[i];
        if (ancestors.length > 0) node.displayName = `${node.name}<${ancestors.join("<")}`;
    });
    // 仍重名(同名同路径)→ 追加 docId 短后缀,保证兄弟间唯一
    const groups = new Map<string, RelationNode[]>();
    for (const node of nodes) {
        const list = groups.get(node.displayName) || [];
        list.push(node);
        groups.set(node.displayName, list);
    }
    for (const [, group] of groups) {
        if (group.length <= 1) continue;
        for (const node of group) {
            node.displayName = `${node.displayName} (${node.docId.slice(-6)})`;
        }
    }
}

/** 递归对每层兄弟做消歧 */
export function disambiguateSiblings(roots: RelationNode[]): void {
    if (roots.length === 0) return;
    // 先按 parent 指针收集祖先链(建树时维护的 __parent 用完即清)
    const linkParents = (nodes: RelationNode[], parent: RelationNode | null) => {
        for (const n of nodes) {
            n.__parent = parent;
            if (n.children.length) linkParents(n.children, n);
        }
    };
    linkParents(roots, null);

    const disambiguateLevel = (nodes: RelationNode[]) => {
        const groups = new Map<string, RelationNode[]>();
        for (const n of nodes) {
            const list = groups.get(n.name) || [];
            list.push(n);
            groups.set(n.name, list);
        }
        for (const [, group] of groups) {
            if (group.length > 1) resolveAmbiguousNames(group);
        }
    };

    const walk = (nodes: RelationNode[]) => {
        disambiguateLevel(nodes);
        for (const n of nodes) {
            if (n.children.length) walk(n.children);
            n.__parent = undefined; // 用完即清,避免 JSON 化时出现循环引用
        }
    };
    walk(roots);
}

/** 把关系树扁平化成渲染用的行(深度优先) */
export function flattenRelationForest(roots: RelationNode[]): RelationNode[] {
    const rows: RelationNode[] = [];
    const walk = (nodes: RelationNode[]) => {
        for (const n of nodes) {
            rows.push(n);
            if (n.children.length) walk(n.children);
        }
    };
    walk(roots);
    return rows;
}

/**
 * 按展开状态扁平化 —— 渲染必须用这个,不能用 flattenRelationForest。
 * 折叠的节点**不输出它的后代**,否则"折叠"只是箭头变了样子,子节点照样铺在列表里。
 * 顶层根节点始终输出(否则折叠后连根都看不到)。
 */
export function flattenVisibleRelationForest(
    roots: RelationNode[],
    isExpanded: (docId: string) => boolean,
): RelationNode[] {
    const rows: RelationNode[] = [];
    const walk = (nodes: RelationNode[]) => {
        for (const n of nodes) {
            rows.push(n);
            if (n.children.length && isExpanded(n.docId)) walk(n.children);
        }
    };
    walk(roots);
    return rows;
}

/** 关系树规模概览,给面板头部显示 */
export function relationForestSummary(roots: RelationNode[]): {docs: number; roots: number} {
    let docs = 0;
    const walk = (nodes: RelationNode[]) => {
        for (const n of nodes) {
            docs++;
            if (n.children.length) walk(n.children);
        }
    };
    walk(roots);
    return {docs, roots: roots.length};
}

/**
 * 拖拽后重排同级顺序,返回新的 customOrder(不改动入参)。
 * parentKey: 同级容器的 key(顶层用 RELATION_ROOT_KEY,否则用父文档 docId)。
 */
export function reorderCustomOrder(
    customOrder: Record<string, string[]>,
    parentKey: string,
    orderedIds: string[],
): Record<string, string[]> {
    const next = {...customOrder};
    const prev = next[parentKey] || [];
    // 保留容器里原本存在、但当前视图没渲染出来的 id(例如被 maxNodes 截断的),
    // 追加到末尾,避免下次渲染时它们"掉队"
    const tail = prev.filter((id) => !orderedIds.includes(id));
    next[parentKey] = [...orderedIds, ...tail];
    return next;
}

/** 判断两个节点是否同级(拖拽时只允许同级排序) */
export function sameParentInForest(
    roots: RelationNode[],
    aDocId: string,
    bDocId: string,
): boolean {
    const findParentKey = (docId: string): string | null => {
        if (roots.some((r) => r.docId === docId)) return RELATION_ROOT_KEY;
        const dfs = (nodes: RelationNode[]): string | null => {
            for (const n of nodes) {
                if (n.children.some((c) => c.docId === docId)) return n.docId;
                const hit = dfs(n.children);
                if (hit) return hit;
            }
            return null;
        };
        return dfs(roots);
    };
    const ka = findParentKey(aDocId);
    return ka !== null && ka === findParentKey(bDocId);
}

/** 在森林里按 docId 找节点(含自身) */
export function findRelationNode(roots: RelationNode[], docId: string): RelationNode | null {
    const dfs = (nodes: RelationNode[]): RelationNode | null => {
        for (const n of nodes) {
            if (n.docId === docId) return n;
            const hit = dfs(n.children);
            if (hit) return hit;
        }
        return null;
    };
    return dfs(roots);
}

/** 取出以某节点为根的子树(「聚焦当前文档」用) */
export function subtreeOf(roots: RelationNode[], docId: string): RelationNode | null {
    const hit = findRelationNode(roots, docId);
    if (!hit) return null;
    // 克隆一份并把 depth 归零,聚焦视图里它是根
    const clone = (n: RelationNode, depth: number): RelationNode => ({
        ...n,
        depth,
        children: n.children.map((c) => clone(c, depth + 1)),
    });
    return clone(hit, 0);
}

/**
 * 找出从根到目标节点的路径(「定位当前文档」时用来自动展开沿途节点)。
 * 返回路径上的 docId(含根与目标自身),不在树里则返回空数组。
 */
export function pathToNode(roots: RelationNode[], docId: string): string[] {
    const dfs = (nodes: RelationNode[], trail: string[]): string[] | null => {
        for (const n of nodes) {
            const next = [...trail, n.docId];
            if (n.docId === docId) return next;
            const hit = dfs(n.children, next);
            if (hit) return hit;
        }
        return null;
    };
    return dfs(roots, []) || [];
}

/** 按默认展开层级算出初始展开集合:0=全折叠,-1=全展开,N=展开前 N 层 */
export function initialExpandedSet(roots: RelationNode[], level: number): Set<string> {
    const set = new Set<string>();
    if (level === 0) return set;
    const dfs = (nodes: RelationNode[], depth: number) => {
        if (level > 0 && depth >= level) return;
        for (const n of nodes) {
            if (!n.children.length) continue;
            set.add(n.docId);
            dfs(n.children, depth + 1);
        }
    };
    dfs(roots, 0);
    return set;
}
