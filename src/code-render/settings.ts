import type { DataSource, RenderRule, Settings } from "./types";

export const SETTINGS_NAME = "settings.json";

export function uid(prefix = "r"): string {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 内置渲染器 id（见 renderers/mysql.ts） */
export const RENDERER_MYSQL = "mysql";
export const MODE_PRETTY = "pretty";
export const MODE_SCHEMA = "schema";
export const MODE_RUN = "run";

function defaultRules(): RenderRule[] {
    return [
        {
            id: "builtin-mysql",
            lang: "mysql",
            rendererId: RENDERER_MYSQL,
            modeId: MODE_PRETTY,
            enabled: true,
            // 默认只做就地高亮，面板由用户点按钮展开，避免打开文档就铺开一大块
            autoOpen: false,
        },
    ];
}

function defaultDataSources(): DataSource[] {
    return [
        {
            id: "builtin-siyuan",
            name: "思源内置数据库",
            type: "siyuan-sqlite",
            readOnly: true,
        },
    ];
}

export const DEFAULT_SETTINGS: Settings = {
    enabled: true,
    rules: defaultRules(),
    dataSources: defaultDataSources(),
    defaultDataSourceId: "builtin-siyuan",
    renderTarget: "both",
    autoRender: true,
    showToolbarButton: true,
    maxRows: 200,
    theme: "auto",
};

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

function normalizeRules(raw: unknown): RenderRule[] {
    if (!Array.isArray(raw)) return defaultRules();
    const out: RenderRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Partial<RenderRule>;
        if (typeof r.lang !== "string" || !r.lang.trim()) continue;
        out.push({
            id: typeof r.id === "string" && r.id ? r.id : uid(),
            lang: r.lang.trim().toLowerCase(),
            rendererId: typeof r.rendererId === "string" && r.rendererId ? r.rendererId : RENDERER_MYSQL,
            modeId: typeof r.modeId === "string" && r.modeId ? r.modeId : MODE_PRETTY,
            enabled: r.enabled !== false,
            autoOpen: r.autoOpen === true,
        });
    }
    return out.length ? out : defaultRules();
}

function normalizeDataSources(raw: unknown): DataSource[] {
    if (!Array.isArray(raw)) return defaultDataSources();
    const out: DataSource[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const d = item as Partial<DataSource>;
        if (typeof d.name !== "string" || !d.name.trim()) continue;
        out.push({
            id: typeof d.id === "string" && d.id ? d.id : uid("ds"),
            name: d.name.trim(),
            type: d.type === "http" ? "http" : "siyuan-sqlite",
            url: typeof d.url === "string" ? d.url : "",
            token: typeof d.token === "string" ? d.token : "",
            readOnly: d.readOnly !== false,
        });
    }
    return out;
}

/**
 * 深合并默认值：存储里残留的 {} / 旧版本不完整对象会把字段抹成 undefined，
 * 因此每个字段都要单独兜底，绝不能整体覆盖。
 */
export function mergeSettings(stored: unknown): Settings {
    const s = (stored && typeof stored === "object" ? stored : {}) as Partial<Settings>;
    const rules = normalizeRules(s.rules);
    const dataSources = normalizeDataSources(s.dataSources);
    const defaultDataSourceId =
        typeof s.defaultDataSourceId === "string" && dataSources.some((d) => d.id === s.defaultDataSourceId)
            ? s.defaultDataSourceId
            : dataSources[0]?.id || "";
    return {
        enabled: s.enabled !== false,
        rules,
        dataSources,
        defaultDataSourceId,
        renderTarget:
            s.renderTarget === "inplace" || s.renderTarget === "panel" || s.renderTarget === "both"
                ? s.renderTarget
                : "both",
        autoRender: s.autoRender !== false,
        showToolbarButton: s.showToolbarButton !== false,
        maxRows: typeof s.maxRows === "number" && s.maxRows > 0 ? Math.floor(s.maxRows) : DEFAULT_SETTINGS.maxRows,
        theme: s.theme === "light" || s.theme === "dark" ? s.theme : "auto",
    };
}

let current: Settings = clone(DEFAULT_SETTINGS);
let persistFn: ((s: Settings) => void) | null = null;

export function getSettings(): Settings {
    return current;
}

export function bindPersist(fn: (s: Settings) => void): void {
    persistFn = fn;
}

export function replaceSettings(next: Settings): void {
    current = next;
    persistFn?.(current);
}

export function updateSettings(patch: Partial<Settings>): void {
    current = { ...current, ...patch };
    persistFn?.(current);
}

/**
 * 深色判定：设置里显式指定优先，auto 时跟随思源外观模式（1 = 深色）。
 * engine（面板）与 inplace（就地）共用同一套判定，避免两处配色打架。
 */
export function isDarkTheme(): boolean {
    const theme = getSettings().theme;
    if (theme === "dark") return true;
    if (theme === "light") return false;
    try {
        return (window as any)?.siyuan?.config?.appearance?.mode === 1;
    } catch {
        return false;
    }
}

export function getDataSource(id?: string): DataSource | undefined {
    const s = getSettings();
    return s.dataSources.find((d) => d.id === (id || s.defaultDataSourceId)) || s.dataSources[0];
}
