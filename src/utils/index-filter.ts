// 双链文件名索引的白名单/黑名单规则(纯函数,不依赖项目其它模块,便于离线测试)。
//
// 规则文本:每行一条,空行与 # 开头的行为注释。三种写法:
//   /pattern/flags   → 正则(flags 去掉 g/y,避免 test 的 lastIndex 串味)
//   含正则元字符     → 按正则(默认 i,不区分大小写)
//   其它普通文本     → 按字面子串(自动转义,默认 i)
// 非法正则自动回退成字面子串,不让一条坏规则把整个索引搞挂。
//
// 匹配对象 = 文件/目录的完整路径(正斜杠) + 每一级目录名 + 文件名,
// 所以 `node_modules` 这类规则既能命中路径段,也能命中目录名。
//
// 语义:黑名单命中即排除(目录命中会跳过整棵子树);白名单非空时**只筛文件**
// (目录不受白名单限制,否则永远走不进目标目录)。黑名单优先于白名单。

// 内置默认忽略清单(可编辑):依赖/版本控制/系统噪声目录 + 思源 data 系统目录。
// 用精确边界正则而非裸子串,避免误伤 "my-node_modules-notes.md" 这类名字。
const BUILTIN_SKIP = "(^|/)(node_modules|\\.git|\\.svn|\\.hg|\\.Trash|\\$RECYCLE\\.BIN|System Volume Information)(/|$)";
const SIYUAN_DATA_SKIP = "(^|/)data/(plugins|widgets|themes|icons|snippets|remnants|history|temp|push|storage|conf)(/|$)";

export const DEFAULT_INDEX_BLACKLIST = [
    "# 每行一条规则;# 开头为注释。支持 /正则/flags、裸正则、普通子串(不区分大小写)",
    "# 匹配对象:完整路径 + 每一级目录名 + 文件名;目录命中会跳过整棵子树",
    "# 默认忽略:依赖/版本控制/系统噪声目录(可删改)",
    BUILTIN_SKIP,
    "# 思源工作空间 data 下的系统目录",
    SIYUAN_DATA_SKIP,
].join("\n");

export const DEFAULT_INDEX_WHITELIST = "";

export interface CompiledRule {
    re: RegExp;
    label: string;   // 原始行(诊断用)
}

export interface IndexFilter {
    black: CompiledRule[];
    white: CompiledRule[];
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RE_META = /[.*+?^${}()|[\]\\]/;
const SLASH_RE = /^\/(.*)\/([a-z]*)$/;

/** 把多行规则文本编译成正则数组(纯函数) */
export function parseRuleLines(text: string): CompiledRule[] {
    const out: CompiledRule[] = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        let source = line;
        let flags = "i";
        const slash = SLASH_RE.exec(line);
        if (slash) {
            // /pattern/flags 形式:尊重用户给的 flags(只去掉 g/y)
            source = slash[1];
            flags = (slash[2] || "").replace(/[gy]/g, "");
            if (!flags) flags = "";
        } else if (RE_META.test(line)) {
            // 裸正则:默认大小写不敏感
            source = line;
        } else {
            // 普通文本:转义成字面子串
            source = escapeRe(line);
        }
        try {
            out.push({re: new RegExp(source, flags), label: line});
        } catch {
            // 非法正则(如孤立的 "["):退化成字面量,不阻断索引
            out.push({re: new RegExp(escapeRe(line), "i"), label: line});
        }
    }
    return out;
}

/** 路径 → 待匹配的文本集合(完整路径 + 各段名) */
export function haystacksFor(path: string): string[] {
    const p = String(path || "").replace(/\\/g, "/");
    const out = [p];
    for (const seg of p.split("/").filter(Boolean)) out.push(seg);
    return out;
}

/** 是否有任意规则命中路径 */
export function ruleMatches(rules: CompiledRule[], haystacks: string[]): boolean {
    for (const r of rules) {
        r.re.lastIndex = 0;
        if (haystacks.some(h => r.re.test(h))) return true;
    }
    return false;
}

export function compileFilter(whiteText: string, blackText: string): IndexFilter {
    return {
        white: parseRuleLines(whiteText),
        black: parseRuleLines(blackText),
    };
}

/**
 * 路径是否可进索引。isDir=true 时只过黑名单(白名单不能挡目录),
 * isDir=false 时黑名单 + 白名单都要过。
 */
export function isPathIndexable(path: string, isDir: boolean, filter: IndexFilter): boolean {
    const hay = haystacksFor(path);
    if (ruleMatches(filter.black, hay)) return false;
    if (!isDir && filter.white.length > 0 && !ruleMatches(filter.white, hay)) return false;
    return true;
}
