// 主题加载器
// 解析 VSCode 主题 JSON 并映射到 Monaco defineTheme
// VSCode 主题 JSON 结构:
//   {
//     "name": "Dark+",
//     "type": "dark",
//     "colors": {"editor.background": "#1e1e1e", ...},
//     "tokenColors": [{"scope": ["comment"], "settings": {"foreground": "#6A9955"}}, ...]
//   }
import * as monaco from "monaco-editor";
import {InstalledExtension, ThemeContribution} from "./types";
import {setGlobalCodeTheme} from "../editor/monaco-block";

// 已加载的主题列表(供 UI 选择)
export interface LoadedTheme {
    extensionId: string;
    label: string;
    base: "vs" | "vs-dark";
    name: string; // monaco theme name
}

const loadedThemes: LoadedTheme[] = [];

// 当前激活的主题名(供编辑器创建时使用,避免硬编码主题覆盖扩展主题)
let activeThemeName: string | null = null;

// themeName → 原始主题 JSON(供 CM6 代码块 TextMate 高亮取 tokenColors 用;
// convertThemeToMonaco 只落成 Monaco 规则,原始数据从这里取)
const themeDataByName = new Map<string, any>();
// themeName → 解析后的 tokenColors 规则(惰性解析,结果缓存)
const parsedRulesByName = new Map<string, TmTokenRule[]>();

// 主题切换监听(CM6 编辑器收到通知后重建代码块高亮)
const themeChangeListeners: Array<() => void> = [];
export function onCodeThemeChanged(cb: () => void): () => void {
    themeChangeListeners.push(cb);
    return () => {
        const i = themeChangeListeners.indexOf(cb);
        if (i >= 0) themeChangeListeners.splice(i, 1);
    };
}

function notifyThemeChanged(): void {
    for (const cb of [...themeChangeListeners]) {
        try {
            cb();
        } catch {
            // 单个监听器异常不影响其他监听器
        }
    }
}

// 思源配色回退主题切换(siyuan-light ↔ siyuan-dark,monaco.ts applyTheme)后由其调用,
// 让 CM6 代码块重取主题(回退签名随明暗变化)。扩展主题路径走 safeSetTheme 内部通知。
export function notifyCodeThemeChanged(): void {
    notifyThemeChanged();
}

/** CM6 代码块 TextMate 高亮用的 token 规则(选择器按点分段) */
export interface TmTokenRule {
    segments: string[];
    foreground: string;
    fontStyle?: string;
}

/** 当前激活的代码主题(tokenColors 解析结果;CM6 代码块高亮取色用) */
export interface ActiveCodeTheme {
    /** 主题名(Monaco theme name;作签名/缓存键) */
    name: string;
    rules: TmTokenRule[];
}

// 获取当前激活的扩展主题名;无扩展主题时返回 null(调用方回退到思源配色主题)
export function getActiveThemeName(): string | null {
    return activeThemeName;
}

// 当前激活主题的 tokenColors 解析结果;无扩展主题时返回 null(调用方回退内置配色)
export function getActiveCodeTheme(): ActiveCodeTheme | null {
    if (!activeThemeName) return null;
    const themeData = themeDataByName.get(activeThemeName);
    if (!themeData) return null;
    let rules = parsedRulesByName.get(activeThemeName);
    if (!rules) {
        rules = parseTokenRules(themeData);
        parsedRulesByName.set(activeThemeName, rules);
    }
    return {name: activeThemeName, rules};
}

// 加载扩展的主题贡献
export function loadThemes(extension: InstalledExtension): number {
    const contributes = extension.contributes;
    if (!contributes?.themes || contributes.themes.length === 0) return 0;

    let count = 0;
    for (const themeContribution of contributes.themes) {
        try {
            const content = extension.files[normalizePath(themeContribution.path)];
            if (!content) {
                console.warn(`[siyuan-file-editor] 主题文件未找到: ${themeContribution.path}`);
                continue;
            }
            const themeData = JSON.parse(content);
            const themeName = `ext-${extension.id}-${themeContribution.label}`.replace(/[^a-zA-Z0-9-]/g, "-");
            const base = (themeContribution.uiTheme === "vs" || themeData.type === "light") ? "vs" : "vs-dark";

            convertThemeToMonaco(themeData, themeName, base);
            // 保留原始数据供 CM6 代码块高亮取 tokenColors(getActiveCodeTheme)
            themeDataByName.set(themeName, themeData);
            loadedThemes.push({
                extensionId: extension.id,
                label: themeContribution.label,
                base,
                name: themeName,
            });
            count++;
        } catch (e) {
            console.error(`[siyuan-file-editor] 加载主题失败 ${themeContribution.path}:`, e);
        }
    }
    return count;
}

// 应用主题时的安全包装,捕获 Monaco 延迟校验颜色的错误
function safeSetTheme(themeName: string): boolean {
    const prev = activeThemeName;
    try {
        // 全局主题切换统一走 monaco-block 的入口(记账 + colorize 缓存失效 + 通知)
        setGlobalCodeTheme(themeName);
        activeThemeName = themeName;
        if (activeThemeName !== prev) notifyThemeChanged();
        return true;
    } catch (e) {
        console.error(`[siyuan-file-editor] 应用主题失败 ${themeName}:`, e);
        // 回退到内置主题
        activeThemeName = null;
        if (activeThemeName !== prev) notifyThemeChanged();
        try {
            setGlobalCodeTheme("vs-dark");
        } catch {
            // 忽略
        }
        return false;
    }
}

// ===== 语义 token 规则(LSP semanticTokens → 主题颜色) =====
//
// 背景:LSP(basedpyright) 下发"语义 token"(类型如 parameter/function/variable),
// Monaco 拿语义 token 字符串(类型 + '.' + 修饰符,如 "parameter.declaration")
// 走与 TextMate **同一个** ThemeTrie 匹配(standaloneThemeService.js:139 实锤:
// getTokenStyleMetadata = tokenTheme._match([type].concat(modifiers).join('.')))。
// 主题 tokenColors 里没有 'parameter' 这种顶层选择器,所以要做一层换算:
// 按 VS Code 官方 tokenClassificationRegistry 的规则,把语义类型映射成
// TextMate 探测 scope,再到主题 tokenColors 里取色,落成 Monaco 规则。
// (VS Code 编辑器里 Pylance 的参数名橙色就是这么来的;原版 pyright 没有该
// 能力 —— 这是换装 basedpyright 的原因。)
//
// 探测算法(VS Code colorThemeData 实测语义):
//   - 主题规则 scope 是探测 scope 的"点分段前缀"才命中:rule "variable" 匹配
//     scope "variable.parameter";rule "variable.parameter.function" **不**匹配
//     scope "variable.parameter"(选择器不能比 scope 长)。
//   - 多个命中取最长选择器:variable → 探测 "variable.other.readwrite" 时,
//     规则 "variable.other"(2 段)胜过 "variable"(1 段)。
//   - 带 modifier 的默认规则只在修饰符为子集时命中,最具体的胜出
//     (如 variable+readonly → variable.other.constant,不是普通变量色)。
//   - 探测不到 → 不生成规则 → Monaco 里该语义 token 无样式(NOT_STYLING)
//     → 回退 TextMate 语法着色,与 VS Code 行为一致(如 selfParameter)。

/** 官方默认规则(createDefaultTokenClassificationRegistry 全表) */
const SEMANTIC_DEFAULT_RULES: Array<{selector: string; scopes: string[]}> = [
    {selector: "comment", scopes: ["comment"]},
    {selector: "string", scopes: ["string"]},
    {selector: "keyword", scopes: ["keyword.control"]},
    {selector: "number", scopes: ["constant.numeric"]},
    {selector: "regexp", scopes: ["constant.regexp"]},
    {selector: "operator", scopes: ["keyword.operator"]},
    {selector: "namespace", scopes: ["entity.name.namespace"]},
    {selector: "type", scopes: ["entity.name.type", "support.type"]},
    {selector: "struct", scopes: ["entity.name.type.struct"]},
    {selector: "class", scopes: ["entity.name.type.class", "support.class"]},
    {selector: "interface", scopes: ["entity.name.type.interface"]},
    {selector: "enum", scopes: ["entity.name.type.enum"]},
    {selector: "typeParameter", scopes: ["entity.name.type.parameter"]},
    {selector: "function", scopes: ["entity.name.function", "support.function"]},
    {selector: "method", scopes: ["entity.name.function.member", "support.function"]},
    {selector: "macro", scopes: ["entity.name.function.preprocessor"]},
    {selector: "variable", scopes: ["variable.other.readwrite", "entity.name.variable"]},
    {selector: "parameter", scopes: ["variable.parameter"]},
    {selector: "property", scopes: ["variable.other.property"]},
    {selector: "enumMember", scopes: ["variable.other.enummember"]},
    {selector: "event", scopes: ["variable.other.event"]},
    {selector: "decorator", scopes: ["entity.name.decorator", "entity.name.function"]},
    // label 无默认 scope,不注册
    // 带 modifier 的默认规则(只有 readonly/defaultLibrary 影响 scope 探测)
    {selector: "variable.readonly", scopes: ["variable.other.constant"]},
    {selector: "property.readonly", scopes: ["variable.other.constant.property"]},
    {selector: "type.defaultLibrary", scopes: ["support.type"]},
    {selector: "class.defaultLibrary", scopes: ["support.class"]},
    {selector: "interface.defaultLibrary", scopes: ["support.class"]},
    {selector: "variable.defaultLibrary", scopes: ["support.variable", "support.other.variable"]},
    {selector: "variable.defaultLibrary.readonly", scopes: ["support.constant"]},
    {selector: "property.defaultLibrary", scopes: ["support.variable.property"]},
    {selector: "property.defaultLibrary.readonly", scopes: ["support.constant.property"]},
    {selector: "function.defaultLibrary", scopes: ["support.function"]},
    {selector: "member.defaultLibrary", scopes: ["support.function"]},
];

/** 主题 tokenColors 解析结果:scope 按点分段 + 颜色(TmTokenRule 的别名) */
type ParsedTokenRule = TmTokenRule;

/** 解析主题 tokenColors 为可探测的规则表(语义规则与 CM6 代码块高亮共用) */
function parseTokenRules(themeData: any): TmTokenRule[] {
    const parsed: TmTokenRule[] = [];
    for (const tokenColor of themeData.tokenColors || []) {
        const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
        const settings = tokenColor.settings || {};
        const foreground = settings.foreground ? normalizeHex(settings.foreground) : "";
        if (!foreground) continue;
        for (const rawScope of rawScopes) {
            if (typeof rawScope !== "string") continue;
            for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
                parsed.push({segments: scope.split("."), foreground, fontStyle: settings.fontStyle});
            }
        }
    }
    return parsed;
}

/** 探测:找"点分段前缀"命中的主题规则,取最长选择器 */
function probeTokenColor(parsed: ParsedTokenRule[], scopeSegments: string[]): ParsedTokenRule | null {
    let best: ParsedTokenRule | null = null;
    let bestLen = 0;
    for (const rule of parsed) {
        if (rule.segments.length > scopeSegments.length) continue;  // 选择器比 scope 长
        if (rule.segments.length <= bestLen) continue;              // 只找更长的
        let ok = true;
        for (let i = 0; i < rule.segments.length; i++) {
            if (rule.segments[i] !== scopeSegments[i]) { ok = false; break; }
        }
        if (ok) {
            best = rule;
            bestLen = rule.segments.length;
        }
    }
    return best;
}

/**
 * 生成语义 token 规则并追加到 rules。
 * 生成的规则 key 是语义类型/类型.修饰符(如 "parameter"、"variable.readonly"),
 * 与 Monaco 语义 token 字符串(type+modifiers 拼接)在同一 ThemeTrie 里前缀匹配:
 *   - 无修饰符/修饰符不影响取色的 token("variable.declaration")命中裸类型规则;
 *   - readonly/defaultLibrary 组合命中对应的具体规则(更长的前缀胜出)。
 * 生成规则对 TextMate 语法着色无副作用:裸类型规则的颜色 = 主题对同名 scope
 * 的既有匹配结果,对以它为前缀的语法 scope 而言是重复/更弱的匹配。
 */
// 语义规则表缓存(themeName → 语义类型 → 样式)。defineTheme 追加与
// resolveSemanticTokenStyle(块内 colorize 的语义覆盖取色)共用一份。
const semanticRulesCache = new Map<string, Map<string, {foreground: string; fontStyle?: string}>>();

function buildSemanticRules(themeName: string, themeData: any): Map<string, {foreground: string; fontStyle?: string}> {
    const cached = semanticRulesCache.get(themeName);
    if (cached) return cached;
    const byToken = new Map<string, {foreground: string; fontStyle?: string}>();
    // 主题声明不支持语义高亮时为空表(与 VS Code semanticHighlighting 开关一致;
    // resolveSemanticTokenStyle 取不到色 → 调用方回落 TextMate 着色)
    if (themeData.semanticHighlighting !== false) {
        // 解析主题 tokenColors 为可探测的规则表
        const parsed = parseTokenRules(themeData);

        // semanticTokenColors:键 "variable" / "variable.readonly",值为颜色字符串
        // 或 TokenStyle 对象。优先级高于默认规则(VS Code 同序)。
        const putRule = (token: string, foreground: string, fontStyle?: string): void => {
            byToken.set(token, {foreground, fontStyle});
        };
        const stc = themeData.semanticTokenColors || {};
        for (const key of Object.keys(stc)) {
            if (key.includes(":")) continue;  // 语言限定键(type:python)不处理
            const value = stc[key];
            let foreground = "";
            let fontStyle: string | undefined;
            if (typeof value === "string") {
                foreground = value;
            } else if (value && typeof value === "object") {
                foreground = value.foreground || "";
                fontStyle = value.fontStyle;
            }
            foreground = normalizeHex(foreground);
            if (foreground) putRule(key, foreground, fontStyle);
        }

        // 默认规则表:每条 selector 解析一次颜色
        for (const dr of SEMANTIC_DEFAULT_RULES) {
            if (byToken.has(dr.selector)) continue;  // semanticTokenColors 已覆盖
            let resolved: ParsedTokenRule | null = null;
            // 依次尝试各探测 scope(官方顺序),首个探到颜色的生效
            for (const scope of dr.scopes) {
                resolved = probeTokenColor(parsed, scope.split("."));
                if (resolved) break;
            }
            if (resolved) putRule(dr.selector, resolved.foreground, resolved.fontStyle);
        }
    }
    semanticRulesCache.set(themeName, byToken);
    return byToken;
}

function appendSemanticRules(themeName: string, themeData: any, rules: monaco.editor.ITokenThemeRule[]): void {
    for (const [token, style] of buildSemanticRules(themeName, themeData)) {
        rules.push({token, foreground: style.foreground, fontStyle: style.fontStyle as any});
    }
}

/**
 * 语义 token 字符串(type + "." + modifiers,如 "function.declaration")→ 主题色。
 * 与 Monaco 的 ThemeTrie 同款最长前缀匹配:全串不命中再逐段去尾回退。
 * 供块内 colorize 的语义覆盖(python-lsp-bridge)取色;非扩展主题(思源配色)
 * 没有 tokenColors 数据 → 返回 null,调用方保持 TextMate 着色(与文件编辑器
 * 在思源主题下语义层本就无色可施的行为一致)。
 */
export function resolveSemanticTokenStyle(
    themeName: string,
    typeWithModifiers: string,
): {foreground: string; fontStyle?: string} | null {
    const themeData = themeDataByName.get(themeName);
    if (!themeData) return null;
    const map = buildSemanticRules(themeName, themeData);
    const segs = typeWithModifiers.split(".");
    for (let i = segs.length; i >= 1; i--) {
        const hit = map.get(segs.slice(0, i).join("."));
        if (hit) return hit;
    }
    return null;
}

// 将 VSCode 主题转换为 Monaco 主题
function convertThemeToMonaco(
    themeData: any,
    themeName: string,
    base: "vs" | "vs-dark",
): void {
    const colors: Record<string, string> = {};
    const rules: monaco.editor.ITokenThemeRule[] = [];

    // 转换 editor 颜色(过滤掉 normalizeHex 返回的空值)
    // 编辑器颜色走 Monaco 的 CSS 生成路径,支持带 alpha 的 8 位 hex
    // (主题常用半透明叠加,如 lineHighlightBackground=#383A420C,截断会变纯黑)
    if (themeData.colors) {
        const setColor = (key: string, vscodeKey: string) => {
            const v = themeData.colors[vscodeKey];
            if (v) {
                const normalized = normalizeHex(v, true);
                if (normalized) colors[key] = normalized;
            }
        };
        setColor("editor.background", "editor.background");
        setColor("editor.foreground", "editor.foreground");
        setColor("editor.selectionBackground", "editor.selectionBackground");
        setColor("editor.lineHighlightBackground", "editor.lineHighlightBackground");
    }

    // 转换 token 颜色
    if (themeData.tokenColors) {
        for (const tokenColor of themeData.tokenColors) {
            const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : [tokenColor.scope];
            const settings = tokenColor.settings || {};
            const foreground = settings.foreground ? normalizeHex(settings.foreground) : "";
            const fontStyle = settings.fontStyle;
            for (const rawScope of rawScopes) {
                if (!rawScope || typeof rawScope !== "string") continue;
                // scope 可能是逗号或空格分隔的多个选择器(如 "comment markup.link")。
                // TextMate 里空格分隔表示嵌套选择器,Monaco 不支持,
                // 拆成独立的 scope 分别注册(近似匹配)
                for (const scope of rawScope.split(/[\s,]+/).filter(Boolean)) {
                    // 跳过空前景色(如 transparent)
                    if (foreground) {
                        rules.push({
                            token: scope,
                            foreground,
                            fontStyle: fontStyle as any,
                        });
                    }
                }
            }
        }
    }

    // 语义 token 规则(LSP semanticTokens 的类型 → 主题颜色换算)
    appendSemanticRules(themeName, themeData, rules);

    // 排查观测(与 obsidian 侧 [lgp-tm] 同款):语义着色"数据到达但 DOM 黑"时,
    // 第一件事就是确认语义规则是否真的进了 defineTheme 的 rules
    const semTokens = ["method", "function", "variable", "parameter", "property", "class", "type"];
    console.info(`[syfe-semantic] defineTheme ${themeName}: rules=${rules.length} 语义规则=${rules.filter(r => semTokens.some(t => r.token === t)).length} semanticHighlighting=${themeData.semanticHighlighting}`);

    monaco.editor.defineTheme(themeName, {
        base,
        inherit: true,
        rules,
        colors,
        // 关键开关:monaco standalone 编辑器的 semanticHighlighting 默认
        // "configureByTheme" —— 主题对象不声明 true 时,语义 token 的请求
        // 与渲染整体关闭(与 LSP/basedpyright 能否解析无关,症状是所有
        // 语义 token 缺失、只剩 TextMate 颜色)。主题 JSON 显式声明 false
        // 时尊重之,与 VS Code 行为一致。
        semanticHighlighting: themeData.semanticHighlighting !== false,
    });
}

// 规范化颜色为 hex(#222 → #222222, white → #ffffff)
// allowAlpha=false(默认,token 规则用):输出 6 位 hex,丢弃 alpha——
//   Monaco 的 token 前景色只接受 #RRGGBB
// allowAlpha=true(editor 颜色用):输出 6 或 8 位 hex,保留 alpha——
//   Monaco 编辑器颜色走 CSS 生成路径,支持 #RRGGBBAA(主题常用半透明叠加,
//   如 lineHighlightBackground=#383A420C,截断 alpha 会变成不透明深色)
function normalizeHex(color: string, allowAlpha: boolean = false): string {
    if (!color) return color;
    const c = color.trim().toLowerCase();
    // 6 位 hex #rrggbb
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    // 3 位 hex #rgb → #rrggbb
    if (/^#[0-9a-f]{3}$/.test(c)) {
        return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    // 8 位 hex #rrggbbaa(带 alpha)
    if (/^#[0-9a-f]{8}$/.test(c)) {
        return allowAlpha ? c : c.slice(0, 7);
    }
    // 4 位 hex #rgba
    if (/^#[0-9a-f]{4}$/.test(c)) {
        if (allowAlpha) {
            // #rgba → #rrggbbaa
            return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] + c[4] + c[4];
        }
        return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    // rgb()/rgba() → 转 hex(带 alpha 且允许时输出 8 位)
    const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+%?))?\)/);
    if (m) {
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
        if (allowAlpha && m[4] !== undefined) {
            let a = parseFloat(m[4]);
            if (m[4].endsWith("%")) a = a / 100;
            a = Math.round(Math.min(1, Math.max(0, a)) * 255);
            if (a < 255) return hex + a.toString(16).padStart(2, "0");
        }
        return hex;
    }
    // hsl()/hsla() → 转 hex
    const hsl = c.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/);
    if (hsl) {
        const h = parseInt(hsl[1], 10);
        const s = parseInt(hsl[2], 10) / 100;
        const l = parseInt(hsl[3], 10) / 100;
        return hslToHex(h, s, l);
    }
    // CSS 颜色名称映射(常见主题会用 white/black/transparent 等)
    if (NAMED_COLORS[c]) return NAMED_COLORS[c];
    // transparent 等无法映射的值 → 返回空,调用方需过滤
    if (c === "transparent" || c === "inherit" || c === "currentcolor") return "";
    // 无法识别的格式 → 返回原值(可能触发 Monaco 报错,调用方需 try-catch)
    return c;
}

// HSL → Hex 转换
function hslToHex(h: number, s: number, l: number): string {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// 常见 CSS 命名颜色(仅列出主题中可能出现的)
const NAMED_COLORS: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    gray: "#808080",
    grey: "#808080",
    silver: "#c0c0c0",
    maroon: "#800000",
    olive: "#808000",
    navy: "#000080",
    purple: "#800080",
    teal: "#008080",
    orange: "#ffa500",
    pink: "#ffc0cb",
    brown: "#a52a2a",
    lime: "#00ff00",
    indigo: "#4b0082",
    violet: "#ee82ee",
    gold: "#ffd700",
    "lightgray": "#d3d3d3",
    "lightgrey": "#d3d3d3",
    "darkgray": "#a9a9a9",
    "darkgrey": "#a9a9a9",
    "dimgray": "#696969",
    "dimgrey": "#696969",
};

function normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

// 获取所有已加载的主题
export function getLoadedThemes(): LoadedTheme[] {
    return loadedThemes;
}

// 应用指定主题
export function applyExtensionTheme(themeName: string): boolean {
    const exists = loadedThemes.some(t => t.name === themeName);
    if (exists) {
        return safeSetTheme(themeName);
    }
    return false;
}

// 自动应用第一个匹配当前明暗模式的扩展主题
// isDark: true=暗色模式, false=亮色模式
// 返回是否成功应用了扩展主题
export function applyFirstExtensionTheme(isDark: boolean): boolean {
    if (loadedThemes.length === 0) return false;
    // 优先匹配明暗模式
    const targetBase = isDark ? "vs-dark" : "vs";
    const matched = loadedThemes.find(t => t.base === targetBase) || loadedThemes[0];
    const ok = safeSetTheme(matched.name);
    if (ok) {
        console.log(`[siyuan-file-editor] 已应用扩展主题: ${matched.label} (${matched.base})`);
    }
    return ok;
}

// 是否有扩展主题已加载
export function hasExtensionThemes(): boolean {
    return loadedThemes.length > 0;
}

// 按用户偏好应用代码主题
// pref: "" = 自动(优先扩展主题);"__siyuan__" = 思源配色(不使用扩展主题);其他 = 主题 name
// 返回 false 表示调用方需回退到思源配色主题
export function applyThemeByPreference(pref: string, isDark: boolean): boolean {
    if (pref === "__siyuan__") {
        if (activeThemeName !== null) {
            activeThemeName = null;
            notifyThemeChanged();
        }
        return false;
    }
    if (pref) {
        const matched = loadedThemes.find(t => t.name === pref);
        if (matched) {
            return safeSetTheme(matched.name);
        }
        // 指定的主题已不存在(扩展被卸载)→ 回退自动
    }
    return applyFirstExtensionTheme(isDark);
}

// 移除扩展的主题(卸载时调用)
export function removeExtensionThemes(extensionId: string): void {
    for (let i = loadedThemes.length - 1; i >= 0; i--) {
        if (loadedThemes[i].extensionId === extensionId) {
            themeDataByName.delete(loadedThemes[i].name);
            parsedRulesByName.delete(loadedThemes[i].name);
            semanticRulesCache.delete(loadedThemes[i].name);
            loadedThemes.splice(i, 1);
        }
    }
    // 若激活主题属于被移除的扩展,清空记录(调用方负责重新应用回退主题)
    if (activeThemeName && !loadedThemes.some(t => t.name === activeThemeName)) {
        activeThemeName = null;
        notifyThemeChanged();
    }
}

// 清理所有主题
export function clearAllThemes(): void {
    loadedThemes.length = 0;
    themeDataByName.clear();
    parsedRulesByName.clear();
    semanticRulesCache.clear();
    if (activeThemeName !== null) {
        activeThemeName = null;
        notifyThemeChanged();
    }
}
