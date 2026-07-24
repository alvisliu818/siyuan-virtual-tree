import { fetchSyncPost } from "siyuan";

export interface BlockInfo {
  id: string;
  root_id: string;
  content: string;
  type: string;
  hpath: string;
  box: string;
  path: string;
}

export interface ParentChildRelation {
  parentId: string;
  childId: string;
}

/** 调试开关：开启后输出 SQL 策略与批量结果。 */
const DEBUG = false;

function log(...args: unknown[]): void {
  if (DEBUG) console.log("[VirtualTree]", ...args);
}

/**
 * 转义 SQLite 单引号字符串字面量，避免拼接 SQL 时注入/出错。
 * SiYuan 的 /api/query/sql 不支持参数化绑定，只能手动转义。
 */
function sqlStr(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** 将一组 ID 拼成 SQL IN 列表：('id1','id2') */
function sqlInList(ids: string[]): string {
  return "(" + ids.map((id) => sqlStr(id)).join(",") + ")";
}

export async function sqlQuery<T = BlockInfo>(stmt: string): Promise<T[]> {
  const response = await fetchSyncPost("/api/query/sql", { stmt });
  if (response.code !== 0) {
    console.error("[VirtualTree] SQL error:", response.msg, "\nQuery:", stmt);
    return [];
  }
  return (response.data || []) as T[];
}

export async function getBlockAttrs(id: string): Promise<Record<string, string>> {
  const response = await fetchSyncPost("/api/attr/getBlockAttrs", { id });
  if (response.code !== 0) return {};
  return (response.data || {}) as Record<string, string>;
}

const notebookNameCache = new Map<string, string>();

/** 获取笔记本名，带缓存。boxId 找不到时返回空字符串。 */
export async function getNotebookName(boxId: string): Promise<string> {
  const cached = notebookNameCache.get(boxId);
  if (cached !== undefined) return cached;
  try {
    const resp = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    const notebooks = (resp?.data?.notebooks || []) as { id: string; name: string }[];
    for (const nb of notebooks) {
      notebookNameCache.set(nb.id, nb.name);
    }
  } catch {
    // ignore
  }
  return notebookNameCache.get(boxId) ?? "";
}

export async function getDocInfo(docId: string): Promise<BlockInfo | null> {
  const results = await sqlQuery<BlockInfo>(
    `SELECT id, root_id, content, type, hpath, box, path FROM blocks WHERE id = ${sqlStr(docId)} AND type = 'd'`
  );
  return results.length > 0 ? results[0] : null;
}

/**
 * 批量获取所有"首块引用"构成的 parent→child 关系。
 * 合并 4 套 SQL 策略的结果（UNION 语义去重），避免短路：
 * 策略 1（顶层首块）可能漏掉首块在容器块内的文档，
 * 策略 2-4 放宽限制可补回。合并保证不丢关系。
 */
export async function getFirstBlockRefs(): Promise<ParentChildRelation[]> {
  const strategies: { name: string; run: () => Promise<{ parent_id: string; child_id: string }[]> }[] = [
    { name: "CTE + parent_id=root_id", run: tryStrategy1 },
    { name: "CTE no parent_id filter", run: tryStrategy2 },
    { name: "subquery + MIN(sort)", run: tryStrategy3 },
    { name: "NOT EXISTS correlated", run: tryStrategy4 },
  ];

  const merged = new Map<string, ParentChildRelation>();
  for (const strategy of strategies) {
    const results = await strategy.run();
    log(`Strategy ${strategy.name}: ${results.length} rows`);
    for (const r of results) {
      const key = r.parent_id + "->" + r.child_id;
      if (!merged.has(key)) {
        merged.set(key, { parentId: r.parent_id, childId: r.child_id });
      }
    }
  }

  log(`Merged relations: ${merged.size} unique`);
  if (merged.size === 0) {
    console.warn("[VirtualTree] All batch strategies returned 0 results, will use per-doc fallback.");
  }
  return Array.from(merged.values());
}

async function tryStrategy1(): Promise<{ parent_id: string; child_id: string }[]> {
  return sqlQuery<{ parent_id: string; child_id: string }>(`
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
    WHERE r.def_block_root_id != r.root_id
  `);
}

async function tryStrategy2(): Promise<{ parent_id: string; child_id: string }[]> {
  return sqlQuery<{ parent_id: string; child_id: string }>(`
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
    WHERE r.def_block_root_id != r.root_id
  `);
}

async function tryStrategy3(): Promise<{ parent_id: string; child_id: string }[]> {
  return sqlQuery<{ parent_id: string; child_id: string }>(`
    SELECT DISTINCT r.def_block_root_id AS parent_id, r.root_id AS child_id
    FROM refs r
    WHERE r.block_id IN (
      SELECT b.id FROM blocks b
      INNER JOIN (
        SELECT root_id, MIN(sort) AS min_sort
        FROM blocks
        WHERE type != 'd'
        GROUP BY root_id
      ) first ON b.root_id = first.root_id AND b.sort = first.min_sort
      WHERE b.type != 'd'
    )
    AND r.def_block_root_id != r.root_id
  `);
}

async function tryStrategy4(): Promise<{ parent_id: string; child_id: string }[]> {
  return sqlQuery<{ parent_id: string; child_id: string }>(`
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
    AND r.def_block_root_id != r.root_id
  `);
}

/**
 * 单文档回退：查询"首块引用了 docId 的文档"作为 docId 的子节点。
 * 方向与 batch 模式 getFirstBlockRefs 一致（被引用方=父，引用方=子）。
 */
export async function getChildrenForDoc(docId: string): Promise<string[]> {
  // 与 batch 模式 getFirstBlockRefs 方向一致：
  // "首块引用了 docId 的文档"是 docId 的子文档（被引用方=父，引用方=子）
  const rows = await sqlQuery<{ root_id: string }>(`
    SELECT DISTINCT r.root_id AS child_id
    FROM refs r
    WHERE r.def_block_root_id = ${sqlStr(docId)}
      AND r.root_id != r.def_block_root_id
      AND r.block_id IN (
        SELECT b.id
        FROM blocks b
        INNER JOIN (
          SELECT root_id, MIN(sort) AS min_sort
          FROM blocks WHERE type != 'd' GROUP BY root_id
        ) f ON b.root_id = f.root_id AND b.sort = f.min_sort
        WHERE b.type != 'd'
      )
  `);
  return rows.map((r) => r.root_id);
}

/**
 * 批量获取所有文档的物理父子关系（思源原生文档层级）。
 * 通过 path 前缀匹配：子文档的 path 以父文档 path（去掉 .sy）+ "/" 开头，
 * 且不再有更深一层的 "/"，确保只取直接子文档。
 */
export async function getPhysicalChildRelations(): Promise<ParentChildRelation[]> {
  const rows = await sqlQuery<{ parent_id: string; child_id: string }>(`
    SELECT p.id AS parent_id, c.id AS child_id
    FROM blocks p
    INNER JOIN blocks c ON c.box = p.box
      AND c.path LIKE substr(p.path, 1, length(p.path) - 3) || '/%'
      AND c.path NOT LIKE substr(p.path, 1, length(p.path) - 3) || '/%/%'
    WHERE p.type = 'd' AND c.type = 'd'
  `);
  log(`Physical relations: ${rows.length} rows`);
  return rows.map((r) => ({ parentId: r.parent_id, childId: r.child_id }));
}

/**
 * 单文档物理子文档回退查询。
 * 通过文档的 box 和 path 查询同笔记本下的直接子文档。
 */
export async function getPhysicalChildren(docId: string): Promise<string[]> {
  const docInfo = await getDocInfo(docId);
  if (!docInfo) return [];
  const dir = docInfo.path.slice(0, -3); // 去掉 .sy 后缀
  const rows = await sqlQuery<{ id: string }>(`
    SELECT id FROM blocks
    WHERE type = 'd'
    AND box = ${sqlStr(docInfo.box)}
    AND path LIKE ${sqlStr(dir + "/%")}
    AND path NOT LIKE ${sqlStr(dir + "/%/%")}
  `);
  return rows.map((r) => r.id);
}

export async function getWeightAttr(docId: string, weightAttrName: string): Promise<number> {
  const attrs = await getBlockAttrs(docId);
  const val = attrs[weightAttrName];
  if (val === undefined || val === null) return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
}

export async function batchGetDocInfo(docIds: string[]): Promise<Map<string, BlockInfo>> {
  const map = new Map<string, BlockInfo>();
  if (docIds.length === 0) return map;

  const results = await sqlQuery<BlockInfo>(
    `SELECT id, root_id, content, type, hpath, box, path FROM blocks WHERE id IN ${sqlInList(docIds)} AND type = 'd'`
  );
  log(`batchGetDocInfo requested=${docIds.length} found=${results.length}`);
  for (const doc of results) {
    map.set(doc.id, doc);
  }
  return map;
}

export async function batchGetWeightAttrs(
  docIds: string[],
  weightAttrName: string
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (docIds.length === 0) return map;

  const results = await sqlQuery<{ id: string; value: string }>(
    `SELECT id, value FROM attributes WHERE root_id IN ${sqlInList(docIds)} AND name = ${sqlStr(weightAttrName)} AND type = 'd'`
  );
  for (const r of results) {
    const num = Number(r.value);
    map.set(r.id, isNaN(num) ? 0 : num);
  }
  // 未命中 attribute 的文档，权重视为 0
  for (const id of docIds) {
    if (!map.has(id)) {
      map.set(id, 0);
    }
  }
  return map;
}
