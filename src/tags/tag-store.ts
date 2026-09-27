// 标签存储与查询
// 持久化:插件 saveData/loadData(存到 data/storage/petal/<plugin>/tags.json)
// 支持:多标签、嵌套标签(父标签含子标签)、预设标签库、颜色、图标、按标签筛选
import type {Plugin} from "siyuan";
import {TagData, TagDef, DEFAULT_TAG_DATA, TAG_DATA_VERSION} from "../types";

const STORAGE_KEY = "tags.json";

// 标签数据变化事件(跨面板刷新:标签侧边栏面板订阅后自动重绘)
export const TAGS_CHANGED_EVENT = "syfe:tags-changed";

function dispatchTagsChanged(): void {
    try {
        window.dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT));
    } catch {
        // 非浏览器环境(如单测)忽略
    }
}

// 内存缓存:渲染文件树/菜单时高频读取,避免每次 await
let cached: TagData = {version: TAG_DATA_VERSION, tags: [], fileTags: {}};
let loaded = false;

// 加载标签数据(失败时回退默认预设)
export async function loadTagData(plugin: Plugin): Promise<TagData> {
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        if (data && Array.isArray(data.tags)) {
            cached = {
                version: data.version || TAG_DATA_VERSION,
                tags: data.tags,
                fileTags: data.fileTags && typeof data.fileTags === "object" ? data.fileTags : {},
            };
        } else {
            // 首次使用:写入预设标签
            cached = {...DEFAULT_TAG_DATA, tags: DEFAULT_TAG_DATA.tags.slice(), fileTags: {}};
            await saveTagData(plugin, cached);
        }
    } catch {
        cached = {...DEFAULT_TAG_DATA, tags: DEFAULT_TAG_DATA.tags.slice(), fileTags: {}};
    }
    loaded = true;
    return cached;
}

// 保存标签数据
export async function saveTagData(plugin: Plugin, data?: TagData): Promise<void> {
    const d = data || cached;
    cached = d;
    try {
        await plugin.saveData(STORAGE_KEY, d);
    } catch (e) {
        // 保存失败时仍保留内存数据,避免本次会话丢失
        console.error("[siyuan-file-editor] 保存标签失败:", e);
    }
}

// 获取缓存(未加载时返回默认,避免阻塞渲染)
export function getTagData(): TagData {
    return loaded ? cached : {...DEFAULT_TAG_DATA};
}

export function getAllTags(): TagDef[] {
    return getTagData().tags.slice();
}

export function getTagById(id: string): TagDef | undefined {
    return getTagData().tags.find(t => t.id === id);
}

// 生成新标签 id
export function newTagId(): string {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 新增标签
export async function addTag(plugin: Plugin, def: Omit<TagDef, "id"> & {id?: string}): Promise<TagDef> {
    const tag: TagDef = {id: def.id || newTagId(), name: def.name, ...(def.parentId ? {parentId: def.parentId} : {}), ...(def.color ? {color: def.color} : {}), ...(def.icon ? {icon: def.icon} : {})};
    const data = getTagData();
    data.tags.push(tag);
    await saveTagData(plugin, data);
    dispatchTagsChanged();
    return tag;
}

// 更新标签(名称/颜色/图标/父级)
export async function updateTag(plugin: Plugin, id: string, patch: Partial<TagDef>): Promise<void> {
    const data = getTagData();
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return;
    if (patch.name !== undefined) tag.name = patch.name;
    if (patch.color !== undefined) tag.color = patch.color;
    if (patch.icon !== undefined) tag.icon = patch.icon;
    // 父级不能指向自身或自己的后代,否则成环
    if (patch.parentId !== undefined) {
        if (patch.parentId !== id && !isDescendant(data.tags, patch.parentId, id)) {
            tag.parentId = patch.parentId || undefined;
        }
    }
    await saveTagData(plugin, data);
    dispatchTagsChanged();
}

// 删除标签:从文件上摘除,子标签上提到被删标签的父级
export async function removeTag(plugin: Plugin, id: string): Promise<void> {
    const data = getTagData();
    const tag = data.tags.find(t => t.id === id);
    if (!tag) return;
    const parentId = tag.parentId;
    for (const t of data.tags) {
        if (t.parentId === id) {
            if (parentId) t.parentId = parentId;
            else delete t.parentId;
        }
    }
    data.tags = data.tags.filter(t => t.id !== id);
    for (const key of Object.keys(data.fileTags)) {
        const ids = (data.fileTags[key] || []).filter(x => x !== id);
        if (ids.length) data.fileTags[key] = ids;
        else delete data.fileTags[key];
    }
    await saveTagData(plugin, data);
    dispatchTagsChanged();
}

// 判断 maybeChild 是否为 ancestorId 的后代(用于防环)
function isDescendant(tags: TagDef[], maybeChild: string | undefined, ancestorId: string): boolean {
    let cur = maybeChild;
    let guard = 0;
    while (cur && guard++ < 50) {
        if (cur === ancestorId) return true;
        cur = tags.find(t => t.id === cur)?.parentId;
    }
    return false;
}

// 获取某路径的标签(多标签)
export function getTagsForPath(path: string): TagDef[] {
    const data = getTagData();
    const ids = data.fileTags[path] || [];
    return ids.map(id => data.tags.find(t => t.id === id)).filter(Boolean) as TagDef[];
}

// 给路径加标签(去重)
export async function addTagToPath(plugin: Plugin, path: string, tagId: string): Promise<void> {
    const data = getTagData();
    const list = data.fileTags[path] || [];
    if (!list.includes(tagId)) {
        list.push(tagId);
        data.fileTags[path] = list;
        await saveTagData(plugin, data);
        dispatchTagsChanged();
    }
}

// 移除路径上的标签
export async function removeTagFromPath(plugin: Plugin, path: string, tagId: string): Promise<void> {
    const data = getTagData();
    const list = data.fileTags[path] || [];
    const next = list.filter(x => x !== tagId);
    if (next.length) data.fileTags[path] = next;
    else delete data.fileTags[path];
    await saveTagData(plugin, data);
    dispatchTagsChanged();
}

// 清空路径上的所有标签
export async function clearTagsForPath(plugin: Plugin, path: string): Promise<void> {
    const data = getTagData();
    delete data.fileTags[path];
    await saveTagData(plugin, data);
    dispatchTagsChanged();
}

// 展开标签:选中父标签时包含其所有后代(嵌套筛选)
export function expandWithDescendants(ids: string[]): Set<string> {
    const data = getTagData();
    const out = new Set<string>();
    const walk = (id: string) => {
        if (out.has(id)) return;
        out.add(id);
        for (const t of data.tags) {
            if (t.parentId === id) walk(t.id);
        }
    };
    for (const id of ids) walk(id);
    return out;
}

// 路径是否命中筛选(含后代标签)
export function pathMatchesFilter(path: string, filterIds: Set<string>): boolean {
    if (filterIds.size === 0) return true;
    const ids = getTagData().fileTags[path] || [];
    return ids.some(id => filterIds.has(id));
}

// 路径是否被打了任意标签(用于"全部已打标签"筛选,不指定具体标签)
export function pathHasAnyTag(path: string): boolean {
    const ids = getTagData().fileTags[path] || [];
    return ids.length > 0;
}

// === 反查:标签 → 路径(供标签侧边栏面板列出某标签下的条目) ===

// 所有被打过标签的路径
export function getAllTaggedPaths(): string[] {
    const data = getTagData();
    return Object.keys(data.fileTags).filter(p => (data.fileTags[p] || []).length > 0);
}

// 被打上指定标签集合中任一个的路径(ids 应已用 expandWithDescendants 展开后代)
export function getPathsForTagIds(ids: Set<string>): string[] {
    const data = getTagData();
    if (ids.size === 0) return [];
    return Object.keys(data.fileTags).filter(p => (data.fileTags[p] || []).some(id => ids.has(id)));
}

// 某标签下的条目数(含后代标签,便于父标签显示总数)
export function countForTag(id: string): number {
    return getPathsForTagIds(expandWithDescendants([id])).length;
}

// 标签全路径名(嵌套显示:"父 / 子")
export function tagFullName(id: string): string {
    const data = getTagData();
    const parts: string[] = [];
    let cur: string | undefined = id;
    let guard = 0;
    while (cur && guard++ < 50) {
        const t = data.tags.find(x => x.id === cur);
        if (!t) break;
        parts.unshift(t.name);
        cur = t.parentId;
    }
    return parts.join(" / ");
}

// 某标签的直接子标签(按名称排序);parentId 为 undefined 时返回一级标签
// 供标签侧边栏按树形逐级渲染(默认全部展开)
export function getChildTags(parentId?: string): TagDef[] {
    return getTagData().tags
        .filter(t => (t.parentId || undefined) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name));
}

// 按父子关系把标签排成树(一层在前,子紧跟父)
export function sortTagsTree(): TagDef[] {
    const data = getTagData();
    const out: TagDef[] = [];
    const walk = (parentId?: string) => {
        const children = data.tags
            .filter(t => (t.parentId || undefined) === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const c of children) {
            out.push(c);
            walk(c.id);
        }
    };
    walk(undefined);
    return out;
}

// 标签深度(用于缩进展示)
export function tagDepth(id: string): number {
    const data = getTagData();
    let depth = 0;
    let cur = data.tags.find(t => t.id === id)?.parentId;
    let guard = 0;
    while (cur && guard++ < 50) {
        depth++;
        cur = data.tags.find(t => t.id === cur)?.parentId;
    }
    return depth;
}
