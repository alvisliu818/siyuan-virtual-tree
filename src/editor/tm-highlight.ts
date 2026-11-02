// CM6 代码块 TextMate 高亮
// 复用 Monaco 代码文件编辑器那套基础设施(用户诉求「代码块高亮用代码文件的主题高亮」):
//   语法 = vscode-textmate(grammar-loader 的注册表,内置 + 扩展语法)
//   颜色 = VS Code 主题 tokenColors(theme-loader 保留的原始主题数据)
// 产出带内联 color 的 HTML,交给 cm6-render 的 CodeBlockWidget 渲染成代码卡片。
// 没有激活扩展主题时回退内置 VS Code Dark+/Light+ 核心配色(按思源明暗模式选)。
import {IGrammar, INITIAL, StateStack} from "vscode-textmate";
import {getTmGrammar, getTmGrammarSync} from "../extensions/grammar-loader";
import {ActiveCodeTheme, TmTokenRule, getActiveCodeTheme} from "../extensions/theme-loader";

// ===== 内置回退主题(VS Code Dark+ / Light+ 核心规则) =====
// selector → 颜色;匹配逻辑与真实主题同一套(点分段前缀)
const DARK_FALLBACK: Record<string, string> = {
    comment: "#6a9955",
    string: "#ce9178",
    "constant.numeric": "#b5cea8",
    "constant.language": "#569cd6",
    "constant.regexp": "#d16969",
    keyword: "#569cd6",
    "keyword.control": "#c586c0",
    "keyword.operator": "#d4d4d4",
    storage: "#569cd6",
    "entity.name.function": "#dcdcaa",
    "entity.name.method": "#dcdcaa",
    "support.function": "#dcdcaa",
    "entity.name.type": "#4ec9b0",
    "support.type": "#4ec9b0",
    "support.class": "#4ec9b0",
    "entity.name.tag": "#569cd6",
    "entity.other.attribute-name": "#9cdcfe",
    variable: "#9cdcfe",
    "variable.parameter": "#9cdcfe",
};

const LIGHT_FALLBACK: Record<string, string> = {
    comment: "#008000",
    string: "#a31515",
    "constant.numeric": "#098658",
    "constant.language": "#0000ff",
    "constant.regexp": "#811f3f",
    keyword: "#0000ff",
    "keyword.control": "#af00db",
    storage: "#0000ff",
    "entity.name.function": "#795e26",
    "support.function": "#795e26",
    "entity.name.type": "#267f99",
    "support.type": "#267f99",
    "support.class": "#267f99",
    "entity.name.tag": "#800000",
    "entity.other.attribute-name": "#e50000",
    variable: "#001080",
};

// 思源明暗检测(body.dark 是思源的暗色标记)
function isDarkMode(): boolean {
    try {
        return document.body.classList.contains("dark");
    } catch {
        return false;
    }
}

function fallbackTableToRules(table: Record<string, string>): TmTokenRule[] {
    return Object.entries(table).map(([selector, foreground]) => ({
        segments: selector.split("."),
        foreground,
    }));
}

// 稳定的回退主题对象(WeakMap 缓存键需要稳定身份,不能每次现造)
const FALLBACK_THEMES = {
    dark: {name: "builtin-dark", rules: fallbackTableToRules(DARK_FALLBACK)},
    light: {name: "builtin-light", rules: fallbackTableToRules(LIGHT_FALLBACK)},
};

// ===== 主题匹配 =====

interface TmStyle {
    foreground: string;
    fontStyle?: string;
}

type RuleMap = Map<string, TmStyle>;

const ruleMapCache = new WeakMap<ActiveCodeTheme, RuleMap>();

// 选择器 → 样式;同一选择器多条规则时后者覆盖前者(VS Code 顺序语义)
function getRuleMap(theme: ActiveCodeTheme): RuleMap {
    let m = ruleMapCache.get(theme);
    if (!m) {
        m = new Map();
        for (const rule of theme.rules) {
            m.set(rule.segments.join("."), {foreground: rule.foreground, fontStyle: rule.fontStyle});
        }
        ruleMapCache.set(theme, m);
    }
    return m;
}

// 取色(VS Code 语义):token 的 scope 链从最内层往外层找,
// 每个 scope 取最长「点分段前缀」命中的规则(Shiki 同款算法)
function matchRule(ruleMap: RuleMap, scopes: string[]): TmStyle | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
        const segs = scopes[i].split(".");
        for (let len = segs.length; len > 0; len--) {
            const hit = ruleMap.get(segs.slice(0, len).join("."));
            if (hit) return hit;
        }
    }
    return null;
}

// ===== 渲染 =====

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fontStyleCss(fontStyle?: string): string {
    if (!fontStyle) return "";
    let css = "";
    if (fontStyle.includes("bold")) css += "font-weight:bold;";
    if (fontStyle.includes("italic")) css += "font-style:italic;";
    if (fontStyle.includes("underline")) css += "text-decoration:underline;";
    if (fontStyle.includes("strikethrough")) css += "text-decoration:line-through;";
    return css;
}

// ===== 对外 API =====

export interface TmHighlightResult {
    /** 高亮 HTML(按行 join "\n";文本已转义) */
    html: string;
    /** 主题签名(与 tmThemeSignature 一致;widget 缓存/eq 用) */
    theme: string;
}

/** 单个 token 的行内区间(start/end 为行内偏移;css 为完整内联样式,空串 = 无样式) */
export interface TmTokenSpan {
    start: number;
    end: number;
    css: string;
}

/** 分词结果:按行的 token 区间;第 i 行文本 = code 去掉结尾换行后的第 i 行 */
export interface TmTokenResult {
    theme: string;
    lines: TmTokenSpan[][];
}

// 当前主题签名(widget eq 用;主题切换 → 签名变化 → 重建 DOM 重取色)
export function tmThemeSignature(): string {
    return getActiveCodeTheme()?.name ?? (isDarkMode() ? FALLBACK_THEMES.dark.name : FALLBACK_THEMES.light.name);
}

// ===== 结果缓存(token 级,HTML 由 token 惰性派生) =====
// 键 = 主题签名 + 语言 + 代码。一套 token 缓存喂两个消费方:
//   卡片态 → renderTokensToHtml(CodeBlockWidget 首帧同步,未就绪异步补)
//   编辑态 → cm6-render 的 mark decorations(同步分词,只对光标所在块)
interface CacheEntry {
    code: string;
    tokens: TmTokenResult;
    html?: string;
}
const resultCache = new Map<string, CacheEntry | null>();   // null = 语言不支持,缓存避免反复重试
const pendingTokens = new Map<string, Promise<TmTokenResult | null>>();
const CACHE_LIMIT = 128;

function cacheKey(lang: string, code: string): string {
    return `${tmThemeSignature()}\u0000${lang}\u0000${code}`;
}

function trimCache(): void {
    if (resultCache.size > CACHE_LIMIT) resultCache.clear();
}

// 当前主题(每次 tokenize 现取;主题切换 → cacheKey 变化 → 自然重新取色)
function activeTheme(): ActiveCodeTheme {
    return getActiveCodeTheme() ?? (isDarkMode() ? FALLBACK_THEMES.dark : FALLBACK_THEMES.light);
}

// 核心:用已就绪的 grammar 同步分词(token 区间 + 主题色)
function tokenizeWithGrammar(grammar: IGrammar, code: string): TmTokenResult {
    const theme = activeTheme();
    const ruleMap = getRuleMap(theme);
    // code 是首尾围栏行之间的内容,常带一个尾换行;按行切分逐行推进状态栈
    const src = code.endsWith("\n") ? code.slice(0, -1) : code;
    let stack: StateStack = INITIAL;
    const lines: TmTokenSpan[][] = [];
    for (const line of src.split("\n")) {
        const r = grammar.tokenizeLine(line, stack);
        stack = r.ruleStack;
        const spans: TmTokenSpan[] = [];
        for (let i = 0; i < r.tokens.length; i++) {
            const t = r.tokens[i];
            const end = i + 1 < r.tokens.length ? r.tokens[i + 1].startIndex : line.length;
            if (end <= t.startIndex) continue;
            const style = matchRule(ruleMap, t.scopes);
            spans.push({
                start: t.startIndex,
                end,
                css: style ? `color:${style.foreground};${fontStyleCss(style.fontStyle)}` : "",
            });
        }
        lines.push(spans);
    }
    return {theme: theme.name, lines};
}

// token 区间 → 高亮 HTML(与旧版逐行渲染同构:有样式包 span,无样式裸文本)
function renderTokensToHtml(code: string, tokens: TmTokenResult): string {
    const src = code.endsWith("\n") ? code.slice(0, -1) : code;
    const lines = src.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let s = "";
        for (const span of tokens.lines[i] ?? []) {
            const text = escapeHtml(line.slice(span.start, span.end));
            if (!text) continue;
            s += span.css ? `<span style="${span.css}">${text}</span>` : text;
        }
        out.push(s);
    }
    return out.join("\n");
}

// 同步读 token 缓存:undefined = 未分词过,null = 语言不支持,TmTokenResult = 就绪
export function getCachedTmTokens(lang: string, code: string): TmTokenResult | null | undefined {
    const key = cacheKey(lang, code);
    if (!resultCache.has(key)) return undefined;
    return resultCache.get(key)?.tokens ?? null;
}

// 同步分词(语法已就绪才生效,否则返回 null 且不缓存 —— 异步路径就绪后会补)。
// 编辑态每个键击对光标所在块调用一次;块级缓存保证未变化块零成本。
export function tmTokenizeSync(lang: string, code: string): TmTokenResult | null {
    if (!code) return null;
    const grammar = getTmGrammarSync(lang);
    if (!grammar) return null;
    try {
        const tokens = tokenizeWithGrammar(grammar, code);
        resultCache.set(cacheKey(lang, code), {code, tokens});
        trimCache();
        return tokens;
    } catch {
        return null;
    }
}

// 异步分词(语法未就绪会触发加载);结果进缓存,失败/不支持缓存 null
export function tmTokenize(lang: string, code: string): Promise<TmTokenResult | null> {
    const key = cacheKey(lang, code);
    const hit = resultCache.get(key);
    if (hit) return Promise.resolve(hit.tokens);
    let pending = pendingTokens.get(key);
    if (!pending) {
        pending = (async () => {
            if (!code) return null;
            const grammar = await getTmGrammar(lang);
            if (!grammar) return null;
            return tokenizeWithGrammar(grammar, code);
        })().then(
            (res) => {
                resultCache.set(key, res ? {code, tokens: res} : null);
                pendingTokens.delete(key);
                trimCache();
                return res;
            },
            () => {
                resultCache.set(key, null);
                pendingTokens.delete(key);
                return null;
            },
        );
        pendingTokens.set(key, pending);
    }
    return pending;
}

// 同步取缓存 HTML(toDOM 首帧用;未分词过返回 undefined)
export function getCachedTmHighlight(lang: string, code: string): TmHighlightResult | null | undefined {
    const entry = resultCache.get(cacheKey(lang, code));
    if (entry === undefined) return undefined;
    if (!entry) return null;
    if (!entry.html) entry.html = renderTokensToHtml(entry.code, entry.tokens);
    return {html: entry.html, theme: entry.tokens.theme};
}

// 高亮一段代码;语法未加载/语言不支持时 resolve null(调用方回退纯文本)
export async function tmHighlightToHtml(lang: string, code: string): Promise<TmHighlightResult | null> {
    const tokens = await tmTokenize(lang, code);
    if (!tokens) return null;
    const entry = resultCache.get(cacheKey(lang, code));
    if (!entry) return null;
    if (!entry.html) entry.html = renderTokensToHtml(entry.code, entry.tokens);
    return {html: entry.html, theme: entry.tokens.theme};
}
