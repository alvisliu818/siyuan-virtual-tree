// 思源文档属性:数据层。
//
// 属性本体存内核 attributes 表(/api/attr/getBlockAttrs|setBlockAttrs);自定义属性
// 沿用思源 UI 的 custom- 前缀,内置 tags/alias/memo 直接读写。底层值全是字符串,
// 「类型」不落内核,由插件设置里的全局 schema(属性名 → 类型/选项)决定。
import {getBlockAttrs, setBlockAttrs, querySQL} from "../api/file";

export const DOC_PROPERTIES_CHANGED_EVENT = "syfe:doc-properties-changed";
export const CUSTOM_PREFIX = "custom-";

/** 内核校验(kernel/api/attr.go):属性名只能小写英文字母/数字/连字符,且以字母开头。
 *  中文键会被整单拒绝,连同一请求里的合法属性也写不进去,故入口先拦。 */
export function isValidPropName(name: string): boolean {
    return /^[a-z][a-z0-9-]*$/.test(name);
}

export type PropType = "text" | "number" | "checkbox" | "date" | "datetime" | "tags" | "select" | "link";

export const PROP_TYPES: PropType[] = [
    "text", "number", "checkbox", "date", "datetime", "tags", "select", "link",
];

export const PROP_TYPE_LABELS: Record<PropType, string> = {
    text: "文本", number: "数字", checkbox: "复选框", date: "日期",
    datetime: "日期时间", tags: "标签", select: "下拉", link: "链接",
};

/** 面板固定显示的思源内置属性(内核自建的 id/title/type/updated 不展示) */
export const BUILTIN_PROPS: Array<{key: string; name: string; type: PropType}> = [
    {key: "tags", name: "标签", type: "tags"},
    {key: "alias", name: "别名", type: "tags"},
    {key: "memo", name: "备注", type: "text"},
];

export interface PropSchema {
    name: string;
    type: PropType;
    options: string[];
}

export interface PropEntry {
    key: string;        // 写入内核的实际属性名
    name: string;       // 展示名(自定义属性去掉 custom- 前缀)
    type: PropType;
    value: string;
    options: string[];  // select 类型的候选项
    builtin: boolean;
}

/**
 * 设置页文本框的语法:每行 `名称=类型:选项1,选项2`。
 * 省略类型 = text,# 开头为注释,中文逗号同样可分隔选项,非法类型回落 text。
 * 例:状态=select:未开始,进行中,完成 / 截止=date / 优先级=number
 */
export function parseSchema(text: string): PropSchema[] {
    const map = new Map<string, PropSchema>();
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        const name = (eq < 0 ? line : line.slice(0, eq)).trim();
        if (!name) continue;
        const rest = eq < 0 ? "text" : line.slice(eq + 1).trim();
        const colon = rest.indexOf(":");
        const typeRaw = (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase();
        const type: PropType = (PROP_TYPES as string[]).includes(typeRaw) ? typeRaw as PropType : "text";
        const options = colon < 0
            ? []
            : rest.slice(colon + 1).split(/[,，]/).map(s => s.trim()).filter(Boolean);
        map.set(name, {name, type, options});
    }
    return [...map.values()];
}

export function schemaFor(schemas: PropSchema[], name: string): PropSchema | undefined {
    return schemas.find(s => s.name === name);
}

/** 读取一个文档的全部可展示属性(内置三行恒显示,方便直接填标签/别名/备注)。 */
export async function loadEntries(docId: string, schemas: PropSchema[]): Promise<PropEntry[]> {
    const attrs = await getBlockAttrs(docId) || {};
    const out: PropEntry[] = BUILTIN_PROPS.map(b => ({
        key: b.key, name: b.name, type: b.type,
        value: String(attrs[b.key] ?? ""), options: [], builtin: true,
    }));
    for (const [key, val] of Object.entries(attrs)) {
        if (!key.startsWith(CUSTOM_PREFIX)) continue;
        const name = key.slice(CUSTOM_PREFIX.length);
        const s = schemaFor(schemas, name);
        out.push({
            key, name, type: s?.type || "text", value: String(val ?? ""),
            options: s?.options || [], builtin: false,
        });
    }
    return out;
}

export async function saveEntry(docId: string, key: string, value: string): Promise<void> {
    await setBlockAttrs(docId, {[key]: value});
}

/** 内核把 null / 空串都转成 "" 并从 IAL 移除该属性(kernel/api/attr.go:75)。 */
export async function removeEntry(docId: string, key: string): Promise<void> {
    await setBlockAttrs(docId, {[key]: null as any});
}

export function customKey(name: string): string {
    return CUSTOM_PREFIX + name.trim();
}

function sqlStr(s: string): string {
    return s.replace(/'/g, "''");
}

/** 属性名候选:全局 schema + 内置名 + 全库已用过的 custom-* 名。 */
export async function suggestNames(schemas: PropSchema[], extra: string[] = []): Promise<string[]> {
    const out = new Set<string>([
        ...schemas.map(s => s.name).filter(isValidPropName),
        ...BUILTIN_PROPS.map(b => b.name), ...extra,
    ]);
    try {
        const rows = await querySQL("SELECT DISTINCT name FROM attributes WHERE name LIKE 'custom-%' LIMIT 300");
        for (const r of (rows || [])) {
            const n = String(r?.name || "");
            if (n.startsWith(CUSTOM_PREFIX)) out.add(n.slice(CUSTOM_PREFIX.length));
        }
    } catch {
        // 索引查询失败不影响手工输入
    }
    return [...out].filter(Boolean).slice(0, 200);
}

/** 属性值候选:按类型给(下拉选项 / 全库标签 / 文档标题 / 同名属性历史值)。 */
export async function suggestValues(entry: PropEntry): Promise<string[]> {
    if (entry.type === "select") return entry.options;
    if (entry.type === "checkbox" || entry.type === "date" || entry.type === "datetime") return [];
    if (entry.type === "link") {
        try {
            const rows = await querySQL(
                "SELECT DISTINCT content FROM blocks WHERE type = 'd' AND content <> '' LIMIT 80");
            return (rows || []).map(r => String(r?.content || "")).filter(Boolean);
        } catch {
            return [];
        }
    }
    if (entry.type === "tags") {
        try {
            const rows = await querySQL(
                "SELECT DISTINCT value FROM attributes WHERE name IN ('tags','alias') AND value <> '' LIMIT 100");
            const out = new Set<string>();
            for (const r of (rows || [])) {
                for (const v of String(r?.value || "").split(/[,，]/)) {
                    const t = v.trim();
                    if (t) out.add(t);
                }
            }
            return [...out].slice(0, 100);
        } catch {
            return [];
        }
    }
    try {
        const rows = await querySQL(
            `SELECT DISTINCT value FROM attributes WHERE name = '${sqlStr(entry.key)}' AND value <> '' LIMIT 60`);
        return (rows || []).map(r => String(r?.value || "")).filter(Boolean);
    } catch {
        return [];
    }
}
