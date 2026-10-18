// settings.json —— VS Code 风格的用户设置文件。
//
// 设计要点:
//  1. 落在插件存储目录 data/storage/petal/<插件名>/settings.json —— 与 VS Code 一样是
//     一个**真实文件**:可以用本插件的编辑器打开(带 JSON Schema 补全/校验),Ctrl+S 保存即生效;
//     也可以在思源之外的编辑器里改(下次打开会读到)。
//  2. 只存"用户显式设过的值",没写过的键走注册表默认值 —— 文件保持精简。
//  3. 优先级:settings.json > 插件 config.json。config.json 里的同义字段由
//     applyUserSettingsToConfig 回写,保证既有代码读 plugin.config 依然正确(老代码零改动)。
//  4. GUI 与文件是同一个东西的两张皮:面板里改 = 改这个文件;文件里改 = 面板值跟着变。
import * as monaco from "monaco-editor";
import {showMessage} from "siyuan";
import {EditorConfig} from "../types";
import {insertJsonText, patchJsonText, removeJsonKey, stripJsonComments} from "./jsonc";
import {
    ALL_DEFS,
    EDITOR_DEFS,
    PLUGIN_DEFS,
    SettingDef,
    buildSettingsJsonSchema,
    defByKey,
    monacoKeyOf,
    normalizeValue,
    parseNumberList,
    setNested,
} from "./setting-defs";

/** 存储文件名(插件存储目录内) */
export const SETTINGS_FILE = "settings.json";

const SCHEMA_URI = "https://siyuan-note.github.io/syfe-user-settings.json";

// 存储路径(工作空间内路径,可直接用本插件编辑器打开)
let storagePath = "";
let storageUri = "";
let pluginRef: any = null;
let saver: ((name: string, data: any) => Promise<any>) | null = null;

/** 用户显式设置过的键值 */
let values: Record<string, unknown> = {};
/** 文件里的原始文本(保留注释用) */
let rawText = "";
/** 上一次解析是否成功(解析失败时不覆盖内存值,避免把用户设置清空) */
let parseOk = true;
let flushTimer: number | undefined;

function hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------- JSONC 处理(允许注释,与 VS Code 的 settings.json 一致) ----------

/** 整份重新序列化(兜底:会丢注释) */
function serializeAll(): string {
    const header = [
        "{",
        "  // 虚拟文档树 —— 用户设置(键名与 VS Code 一致)",
        "  // 这个文件与设置面板是同一份数据:面板里改完会写回来,这里改完 Ctrl+S 立即生效。",
        "  // 全部可用键见设置面板的「代码编辑器」分组;只保留你改过的键即可。",
    ];
    const entries: string[] = [];
    const push = (key: string, value: unknown) => {
        entries.push(`    "${key}": ${JSON.stringify(value)}`);
    };
    for (const d of ALL_DEFS) {
        if (hasOwn(values, d.key)) push(d.key, values[d.key]);
    }
    // 本表之外的键(用户自己加的、或未来新增的)原样保留在后面
    for (const key of Object.keys(values)) {
        if (!defByKey(key)) push(key, values[key]);
    }
    const body = entries.length ? entries.join(",\n") + "\n" : "";
    return header.join("\n") + "\n" + body + "}";
}

// ---------- 读写 ----------

async function readRawText(): Promise<string | null> {
    if (!storagePath) return "";
    try {
        // 为什么不走 plugin.loadData:内核把 /api/file/getFile 响应标成 application/json,
        // 而 fetchPost 对 JSON 头会 response.json() 解析文件内容 —— settings.json 是
        // JSONC(带 // 注释)不是合法 JSON,解析必抛 → failCallback → loadData 静默
        // resolve 空串(实测 2026-10-18,每次读取必失败,与竞态无关;无注释的文件都正常)。
        // 所以这里用原生 fetch 直读原文,文本不走 JSON 解析。
        const w = window as any;
        const token = w?.siyuan?.config?.system?.conf?.api?.token;
        const resp = await fetch("/api/file/getFile", {
            method: "POST",
            headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
            body: JSON.stringify({path: storagePath}),
        });
        // 202 = 内核明确表示"文件没有正常读取"(不存在等);403/404 时 resp.ok 为 false
        if (resp.status === 202) return "";
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return new TextDecoder("utf-8").decode(new Uint8Array(await resp.arrayBuffer()));
    } catch (e) {
        // 读取失败(内核瞬时异常/页面卸载竞态)≠ 文件不存在。
        // 返回 null 让调用方跳过解析 —— 绝不能把"读不到"当成"空文件"去写,
        // 否则会把用户的 settings.json 用默认值整个覆盖掉(实测踩过:字体设置丢失)。
        console.warn("[siyuan-file-editor] settings.json 读取失败,本次跳过初始化(不写文件):", e);
        return null;
    }
}

function parseInto(text: string): boolean {
    if (!text.trim()) {
        values = {};
        rawText = text;
        parseOk = true;
        return true;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch {
        // 解析失败:保留内存里的既有值,交由调用方提示用户
        rawText = text;
        parseOk = false;
        return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        parseOk = false;
        return false;
    }
    // 历史遗留:这个文件早先被 code-render 模块占用过(现已改名),形状不对时不认
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rules) && Array.isArray(obj.dataSources)) {
        values = {};
        rawText = "";
        parseOk = true;
        return true;
    }
    values = obj;
    rawText = text;
    parseOk = true;
    return true;
}

/** 从存储重新加载(settings.json 被外部改过 / 编辑器里保存后调用) */
export async function reloadUserSettings(): Promise<boolean> {
    const text = await readRawText();
    return parseInto(text);
}

/**
 * 探测 settings.json 在内核侧是否真实存在(readDir 列 petal 目录,不依赖 loadData)。
 * - "yes":文件在 → loadData 返回空串必然是读取失败,应重试
 * - "no": 目录/文件不存在 → 真实首次使用,走默认值即可
 * - "unknown":HTTP 层失败(内核未就绪)→ 当作可能存在,允许重试
 */
async function probeSettingsFileExists(petalDir: string): Promise<"yes" | "no" | "unknown"> {
    try {
        const w = window as any;
        const token = w?.siyuan?.config?.system?.conf?.api?.token;
        const resp = await fetch("/api/file/readDir", {
            method: "POST",
            headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Token ${token}`} : {})},
            body: JSON.stringify({path: petalDir}),
        });
        if (!resp.ok) return "unknown";
        const json = await resp.json();
        if (json.code !== 0) return "no";
        const has = (json.data?.files || []).some((f: any) => f.name === SETTINGS_FILE && !f.isDir);
        return has ? "yes" : "no";
    } catch {
        return "unknown";
    }
}

/**
 * 初始化:算出存储路径、读文件。只读不写 —— 读不到(不存在/失败)时什么都不写,
 * 设置走注册表默认值,文件由用户首次在面板改设置时创建。
 * 必须在 loadConfig 之后调用。
 */
export async function initUserSettings(plugin: any): Promise<void> {
    pluginRef = plugin;
    const name = String(plugin?.name || "");
    const petalDir = `/data/storage/petal/${name}`;
    storagePath = `${petalDir}/settings.json`;
    storageUri = "siyuan://file" + storagePath;
    saver = (n: string, d: any) => plugin.saveData(n, d);

    // 读取用 readRawText(原生 fetch 直读,见其注释:loadData 对 JSONC 文件必失败)。
    // 写入仍走 plugin.saveData —— putFile 的响应是合法 JSON,不受影响。
    //
    // 读不到(文件不存在/请求失败)时什么都不写,一切键走注册表默认值,
    // 文件由用户首次在面板改设置时创建;读到空串则用 readDir 确认文件是否真的
    // 存在,在就重试(每 800ms,最多 6 轮 ≈ 5s,覆盖内核未就绪窗口),不存在立即放弃。
    // 绝不写文件/seed —— 读到什么就是什么,写只能由用户在面板/编辑器里触发。
    let text = await readRawText();
    let retried = false;
    for (let i = 0; i < 6 && (text === null || !text.trim()); i++) {
        const probe = await probeSettingsFileExists(petalDir);
        if (probe === "no") break; // 文件根本不存在:真实首次使用,走默认值
        if (!retried) {
            retried = true;
            console.warn("[siyuan-file-editor] settings.json 首次读取为空但文件存在,重试中…(loadData 竞态)");
        }
        await new Promise(r => setTimeout(r, 800));
        text = await readRawText();
    }
    if (text !== null) {
        parseInto(text);
    }
    if (retried) {
        if (text && text.trim()) {
            console.info("[siyuan-file-editor] settings.json 重试读取成功");
        } else {
            console.warn("[siyuan-file-editor] settings.json 重试 6 轮仍为空,本会话走默认值(文件未写,下次加载再试)");
        }
    }

    // settings.json 在编辑器里被保存后,立刻重新加载并生效
    void (async () => {
        try {
            const {onDidSaveModel} = await import("../editor/model-manager");
            onDidSaveModel((path: string) => {
                if (path !== storagePath) return;
                void handleSettingsFileSaved();
            });
        } catch {
            // 钩子不可用不影响其它功能
        }
    })();
}

export function getSettingsPath(): string {
    return storagePath;
}

export function getSettingsUri(): string {
    return storageUri;
}

async function writeNow(): Promise<void> {
    if (!saver) return;
    try {
        await saver(SETTINGS_FILE, rawText);
    } catch (e) {
        console.warn("[siyuan-file-editor] 写入 settings.json 失败:", e);
    }
}

function scheduleFlush(): void {
    if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
        flushTimer = undefined;
        void writeNow();
    }, 400);
}

/** 立即落盘(设置面板保存时用) */
export async function flushUserSettings(): Promise<void> {
    if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
        flushTimer = undefined;
    }
    await writeNow();
}

// ---------- 取值 ----------

export function isUserSet(key: string): boolean {
    return hasOwn(values, key);
}

/** 取生效值:用户设过用用户的,否则用注册表默认值 */
export function getSetting(key: string): any {
    if (hasOwn(values, key)) return values[key];
    const d = defByKey(key);
    return d ? d.default : undefined;
}

/** 取生效值(按类型规整过) */
export function getResolved(key: string): any {
    const d = defByKey(key);
    if (!d) return hasOwn(values, key) ? values[key] : undefined;
    return normalizeValue(d, getSetting(key));
}

export function getAllUserValues(): Record<string, unknown> {
    return {...values};
}

/**
 * 写一个值。
 * 值等于默认值时从文件里删掉这一项(与 VS Code 一致:文件里只留"改过的"),
 * 否则 GUI 把值改回默认时,文件里会残留旧值再次反压配置。
 */
export function setUserValue(key: string, raw: unknown): void {
    const d = defByKey(key);
    const value = d ? normalizeValue(d, raw) : raw;
    if (d && isSameValue(value, d.default)) {
        delete values[key];
        // 从文本里移除这一行(保留其它注释)
        rawText = removeJsonKey(rawText, key);
    } else {
        values[key] = value;
        const patched = patchJsonText(rawText, key, value);
        if (patched !== null) {
            rawText = patched;
        } else {
            const inserted = insertJsonText(rawText, key, value);
            rawText = inserted !== null ? inserted : serializeAll();
        }
    }
    scheduleFlush();
}

export function removeUserValue(key: string): void {
    if (!hasOwn(values, key)) return;
    delete values[key];
    const filtered = rawText
        .split("\n")
        .filter(l => !new RegExp("^\\s*\"" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"\\s*:").test(l))
        .join("\n");
    rawText = filtered;
    scheduleFlush();
}

/** 把某一组(如全部 editor.*)恢复默认 */
export function resetGroup(defs: SettingDef[]): void {
    for (const d of defs) removeUserValue(d.key);
}

function isSameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return a === b;
}

// ---------- 应用到编辑器 ----------

/** 把 editor.* 的生效值转成 Monaco 的编辑器选项(嵌套对象) */
export function buildEditorOptions(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const d of EDITOR_DEFS) {
        const dotted = monacoKeyOf(d);
        if (!dotted) continue;
        const value = getResolved(d.key);
        if (value === undefined) continue;
        setNested(out, dotted, d.toMonaco ? d.toMonaco(value) : value);
    }
    return out;
}

/** 对当前所有打开的编辑器立即生效(含 notebook 单元格等 monaco 实例) */
export function applyEditorOptions(): void {
    try {
        const opts = buildEditorOptions();
        monaco.editor.getEditors().forEach(ed => ed.updateOptions(opts as any));
    } catch (e) {
        console.warn("[siyuan-file-editor] 应用编辑器设置失败:", e);
    }
}

// ---------- 与 config.json 的双向同步 ----------

/** settings.json → config.json(加载时 / settings.json 保存后) */
export function applyUserSettingsToConfig(cfg: EditorConfig): EditorConfig {
    for (const d of PLUGIN_DEFS) {
        if (!hasOwn(values, d.key) || !d.set) continue;
        try {
            d.set(cfg, normalizeValue(d, values[d.key]));
        } catch {
            // 单项出错不影响其它项
        }
    }
    // 编辑器相关的旧字段(老代码还读它们)按 settings.json 回写
    if (hasOwn(values, "editor.fontSize")) cfg.fontSize = Number(getResolved("editor.fontSize")) || cfg.fontSize;
    if (hasOwn(values, "editor.tabSize")) cfg.tabSize = Number(getResolved("editor.tabSize")) || cfg.tabSize;
    if (hasOwn(values, "editor.wordWrap")) cfg.wordWrap = getResolved("editor.wordWrap") === "off" ? "off" : "on";
    if (hasOwn(values, "editor.minimap.enabled")) cfg.showMinimap = getResolved("editor.minimap.enabled") !== false;
    if (hasOwn(values, "editor.formatOnSave")) cfg.formatOnSave = getResolved("editor.formatOnSave") === true;
    return cfg;
}

/** config.json → settings.json(设置面板保存后:面板值即用户值) */
export function syncUserSettingsFromConfig(cfg: EditorConfig): void {
    for (const d of PLUGIN_DEFS) {
        if (!d.get) continue;
        let v: any;
        try {
            v = d.get(cfg);
        } catch {
            continue;
        }
        if (v === undefined) continue;
        const normalized = normalizeValue(d, v);
        if (isSameValue(normalized, d.default)) setUserValue(d.key, d.default); // 删掉这一项
        else setUserValue(d.key, normalized);
    }
}

// ---------- settings.json 文件被保存后的处理 ----------

let onSettingsChanged: Array<() => void> = [];

/** 注册"设置变了"的回调(设置面板用来回显) */
export function registerSettingsChangedHandler(fn: () => void): void {
    onSettingsChanged.push(fn);
}

async function handleSettingsFileSaved(): Promise<void> {
    const ok = await reloadUserSettings();
    if (!ok) {
        showMessage("settings.json 解析失败,已保留上一次的设置", 4000, "error");
        return;
    }
    // config 内存值同步(老代码都读 plugin.config)
    if (pluginRef?.config) {
        applyUserSettingsToConfig(pluginRef.config);
        try {
            const {saveConfig} = await import("../utils/config");
            await saveConfig(pluginRef, pluginRef.config);
        } catch {
            // 落盘失败不影响当次生效
        }
    }
    applyEditorOptions();
    onSettingsChanged.forEach(fn => {
        try {
            fn();
        } catch {
            // 单个回调出错不影响其它
        }
    });
    showMessage("settings.json 已保存并生效", 2500, "info");
}

// ---------- 打开 settings.json ----------

/** 用本插件的编辑器打开 settings.json(带 JSON Schema 补全/校验) */
export async function openSettingsJsonFile(): Promise<void> {
    if (!pluginRef || !storagePath) return;
    try {
        const {readTextFile, writeFile} = await import("../api/file");
        // 文件可能被删过:不存在就先写一份空的(编辑器打开空文件也允许新建后保存)
        let exists = true;
        try {
            await readTextFile(storagePath);
        } catch {
            exists = false;
        }
        if (!exists) {
            await writeFile(storagePath, rawText || serializeAll());
        }
        const {openFileTab} = await import("../tabs/editor-tab");
        openFileTab(pluginRef, storagePath);
    } catch (e) {
        showMessage(`打开 settings.json 失败: ${e}`, 4000, "error");
    }
}

// ---------- JSON Schema(补全 / 校验 / 悬停) ----------

export function registerSettingsJsonSchema(): void {
    try {
        const json = (monaco.languages as any)?.json?.jsonDefaults;
        if (!json) return;
        const prev = (json as any).diagnosticsOptions || {};
        const schemas = Array.isArray(prev.schemas) ? prev.schemas.filter((s: any) => s?.uri !== SCHEMA_URI) : [];
        schemas.push({
            uri: SCHEMA_URI,
            fileMatch: storageUri ? [storageUri] : [],
            schema: buildSettingsJsonSchema(),
        });
        json.setDiagnosticsOptions({
            validate: true,
            allowComments: true,
            enableSchemaRequest: false,
            trailingCommas: "ignore",
            ...prev,
            schemas,
        });
    } catch (e) {
        console.warn("[siyuan-file-editor] 注册 settings.json schema 失败:", e);
    }
}

// ---------- 给 UI 用的小工具 ----------

export function getRawText(): string {
    return rawText;
}

export function isParseOk(): boolean {
    return parseOk;
}

/** 供外部(如设置面板)读取当前生效的编辑器数值 */
export function getNumberSetting(key: string, fallback: number): number {
    const v = Number(getResolved(key));
    return Number.isFinite(v) ? v : fallback;
}

export function getBoolSetting(key: string, fallback: boolean): boolean {
    const v = getResolved(key);
    return typeof v === "boolean" ? v : fallback;
}

/** 逗号分隔的标尺列文本 → 数组 */
export function getRulerText(): string {
    const v = getResolved("editor.rulers");
    return Array.isArray(v) ? v.join(",") : "";
}

export function setRulerText(text: string): void {
    setUserValue("editor.rulers", parseNumberList(text));
}
