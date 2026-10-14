// 虚拟文档树挂载项的内容搜索源
//
// 全局搜索原本只递归真实目录(readDir),虚拟文档树里挂载的思源文档/笔记本/块
// 参与不了。这里把它们摊平成"可搜索内容项"列表:
//   doc/notebook → 文档自身 + 全部子文档(内容走内核 exportMdContent,Markdown 原文)
//   block        → 块自身 + 全部子孙块(内容走 blocks 表的 markdown 字段)
//   file         → 挂载的真实文件(文件夹则递归其中的文本文件,与目录搜索同一套规则)
//
// 上限 MAX_ITEMS:思源内核接口是逐个文档取的,一个笔记本可能上千篇,全量拉会
// 把搜索拖成"转圈几分钟"。超出上限就停止枚举并在结果里提示用户缩小范围
// (把大笔记本换成挂载具体文档)。

import {exportMdContent, querySQL, readTextFile, readDir} from "../api/file";
import {getRoots, MountItem} from "../mount-tree";
import {virtualListDir} from "../utils/virtual-tree";
import {listChildBlocks} from "../utils/blocks";
import {TEXT_EXTENSIONS} from "../constants";
import {joinPath, extname} from "../utils/path";
import {isBaiduPath} from "../utils/baidu-path";

// 一次搜索最多枚举多少个内容项
export const MAX_ITEMS = 300;
// 子文档/子块递归深度上限(防异常数据导致的无限展开)
const MAX_DEPTH = 12;

export interface MountSearchItem {
    /** 定位用 id:doc=文档 id,block=块 id,file=真实路径 */
    id: string;
    title: string;
    /** 副标题(人类可读路径 / 目录),结果里灰字显示 */
    subtitle: string;
    kind: "doc" | "block" | "file";
}

// 枚举虚拟文档树里全部可搜索内容项(去重;深度/数量有上限)
export async function enumerateMountItems(): Promise<{items: MountSearchItem[]; truncated: boolean}> {
    const items: MountSearchItem[] = [];
    const seen = new Set<string>();
    let truncated = false;

    const push = (it: MountSearchItem): boolean => {
        const key = it.kind + ":" + it.id;
        if (seen.has(key)) return true;
        if (items.length >= MAX_ITEMS) {
            truncated = true;
            return false;
        }
        seen.add(key);
        items.push(it);
        return true;
    };

    // 文档子树:docId → 自身 + 全部子文档
    const walkDoc = async (docId: string, title: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        if (!push({id: docId, title, subtitle: "思源文档", kind: "doc"})) return;
        let children;
        try {
            children = await virtualListDir("sydoc://" + docId);
        } catch {
            return; // 文档已删除/无权限:跳过子树
        }
        for (const c of children) {
            const childId = String(c.path || "").replace(/^sydoc:\/\//, "");
            if (!childId) continue;
            if (items.length >= MAX_ITEMS) {
                truncated = true;
                return;
            }
            await walkDoc(childId, String(c.name || childId), depth + 1);
        }
    };

    // 块子树:blockId → 自身 + 全部子孙块
    const walkBlock = async (blockId: string, title: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        if (!push({id: blockId, title, subtitle: "思源块", kind: "block"})) return;
        const children = await listChildBlocks(blockId);
        for (const c of children) {
            if (items.length >= MAX_ITEMS) {
                truncated = true;
                return;
            }
            await walkBlock(c.id, c.content.slice(0, 40) || c.id, depth + 1);
        }
    };

    // 真实文件/文件夹
    const walkFile = async (path: string, isDir: boolean, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        if (isDir) {
            let entries;
            try {
                entries = await readDir(path);
            } catch {
                return;
            }
            for (const e of entries) {
                if (items.length >= MAX_ITEMS) {
                    truncated = true;
                    return;
                }
                const full = joinPath(path, e.name);
                await walkFile(full, !!e.isDir, depth + 1);
            }
            return;
        }
        // 网盘文件不参与(逐个下载代价过高)
        if (isBaiduPath(path)) return;
        if (!TEXT_EXTENSIONS.has(extname(path))) return;
        push({id: path, title: path.split("/").pop() || path, subtitle: path, kind: "file"});
    };

    for (const root of getRoots()) {
        if (truncated) break;
        await walkMountItem(root, walkDoc, walkBlock, walkFile);
        // 嵌套挂载的子项也要带上(它们没有"自动子项",是显式挂上去的)
        for (const child of root.children || []) {
            if (truncated) break;
            await walkMountItem(child, walkDoc, walkBlock, walkFile);
        }
    }
    return {items, truncated};
}

async function walkMountItem(
    item: MountItem,
    walkDoc: (id: string, title: string, depth: number) => Promise<void>,
    walkBlock: (id: string, title: string, depth: number) => Promise<void>,
    walkFile: (path: string, isDir: boolean, depth: number) => Promise<void>,
): Promise<void> {
    if (item.kind === "notebook" && item.targetId) {
        let docs;
        try {
            docs = await virtualListDir("sydoc://nb/" + item.targetId);
        } catch {
            return;
        }
        for (const d of docs) {
            const docId = String(d.path || "").replace(/^sydoc:\/\//, "");
            if (docId) await walkDoc(docId, String(d.name || docId), 1);
        }
        return;
    }
    if (item.kind === "doc" && item.targetId) {
        await walkDoc(item.targetId, item.name || item.targetId, 0);
        return;
    }
    if (item.kind === "block" && item.targetId) {
        await walkBlock(item.targetId, item.name || item.targetId, 0);
        return;
    }
    if (item.kind === "file" && item.path) {
        await walkFile(item.path, item.isDir !== false, 0);
    }
}

// 取内容:doc 走内核导出 Markdown;block 取 markdown 原文(退回 content);file 读盘
export async function loadMountContent(item: MountSearchItem): Promise<string> {
    if (item.kind === "file") {
        try {
            return await readTextFile(item.id);
        } catch {
            return "";
        }
    }
    if (item.kind === "doc") {
        try {
            const r = await exportMdContent(item.id);
            return String(r?.content || "");
        } catch {
            return "";
        }
    }
    // block:markdown 字段是原始标记文本(比 content 更适合搜索展示)
    try {
        const id = item.id.replace(/'/g, "''");
        const rows = await querySQL(`SELECT markdown, content FROM blocks WHERE id = '${id}' LIMIT 1`);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return "";
        return String(row.markdown || row.content || "");
    } catch {
        return "";
    }
}
