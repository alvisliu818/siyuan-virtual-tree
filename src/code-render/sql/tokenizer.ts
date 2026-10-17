/**
 * 零依赖 SQL 词法分析器：把 SQL 切成 token，供高亮与格式化共用。
 * 只做词法不做语法，因此容错性很好——非法 SQL 也能安全着色。
 */

export type TokenType =
    | "ws"
    | "comment"
    | "string"
    | "quoted" // 反引号标识符 / 双引号标识符
    | "number"
    | "keyword"
    | "type"
    | "function"
    | "variable"
    | "operator"
    | "punct"
    | "ident";

export interface Token {
    type: TokenType;
    /** 原始文本 */
    value: string;
    /** 关键字/函数/类型的大写形式，便于格式化与比较 */
    upper?: string;
}

const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "XOR", "IN", "IS", "LIKE", "RLIKE", "REGEXP", "BETWEEN",
    "INSERT", "REPLACE", "INTO", "VALUES", "VALUE", "UPDATE", "SET", "DELETE", "TRUNCATE", "MERGE",
    "CREATE", "DROP", "ALTER", "RENAME", "TABLE", "DATABASE", "SCHEMA", "VIEW", "TRIGGER", "PROCEDURE",
    "FUNCTION", "INDEX", "KEY", "UNIQUE", "FULLTEXT", "SPATIAL", "PRIMARY", "FOREIGN", "REFERENCES",
    "CONSTRAINT", "CHECK", "DEFAULT", "NULL", "AUTO_INCREMENT", "COMMENT", "ENGINE", "CHARSET", "COLLATE",
    "CHARACTER", "ADD", "MODIFY", "CHANGE", "COLUMN", "AFTER", "FIRST", "LAST", "RENAME",
    "AS", "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "STRAIGHT_JOIN", "NATURAL",
    "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "DISTINCTROW",
    "CASE", "WHEN", "THEN", "ELSE", "END", "IF", "ELSEIF", "LOOP", "WHILE", "LEAVE", "ITERATE",
    "EXISTS", "PARTITION", "WITH", "RECURSIVE", "RETURNING", "OVER", "WINDOW", "LATERAL",
    "BEGIN", "COMMIT", "ROLLBACK", "START", "TRANSACTION", "SAVEPOINT", "LOCK", "UNLOCK", "TABLES",
    "GRANT", "REVOKE", "USE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "ANALYZE", "OPTIMIZE",
    "ASC", "DESC_ORDER", "IGNORE", "DUPLICATE", "DELAYED", "LOW_PRIORITY", "HIGH_PRIORITY", "QUICK",
    "UNSIGNED", "SIGNED", "ZEROFILL", "GLOBAL", "SESSION", "LOCAL", "CASCADE", "RESTRICT",
    "TRUE", "FALSE", "UNKNOWN", "INTERVAL", "BINARY", "COLLATE_KW", "ESCAPE", "DIV", "MOD",
    "FOR", "SHARE", "OF", "NOWAIT", "SKIP", "LOCKED", "ROWS", "ROW", "ONLY", "FETCH", "NEXT",
]);

const TYPES = new Set([
    "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT", "DECIMAL", "DEC", "NUMERIC", "FLOAT",
    "DOUBLE", "REAL", "BIT", "BOOLEAN", "BOOL", "SERIAL",
    "DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR",
    "CHAR", "VARCHAR", "BINARY", "VARBINARY", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB",
    "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "ENUM", "SET_T", "JSON", "GEOMETRY", "POINT",
    "LINESTRING", "POLYGON", "UUID",
]);

const FUNCTIONS = new Set([
    "COUNT", "SUM", "AVG", "MIN", "MAX", "GROUP_CONCAT", "CONCAT", "CONCAT_WS", "SUBSTRING", "SUBSTR",
    "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER", "LENGTH", "CHAR_LENGTH", "LOCATE", "REPLACE",
    "LEFT", "RIGHT", "LPAD", "RPAD", "REVERSE", "ROUND", "FLOOR", "CEIL", "CEILING", "ABS",
    "MOD", "POW", "POWER", "SQRT", "RAND", "NOW", "CURDATE", "CURTIME", "CURRENT_DATE",
    "CURRENT_TIME", "CURRENT_TIMESTAMP", "UNIX_TIMESTAMP", "FROM_UNIXTIME", "DATE_FORMAT", "STR_TO_DATE",
    "DATE_ADD", "DATE_SUB", "DATEDIFF", "TIMESTAMPDIFF", "YEAR_FN", "MONTH", "DAY", "HOUR", "MINUTE",
    "SECOND", "WEEK", "QUARTER", "DAYNAME", "MONTHNAME", "IFNULL", "NULLIF", "COALESCE", "CAST",
    "CONVERT", "JSON_EXTRACT", "JSON_OBJECT", "JSON_ARRAY", "JSON_UNQUOTE", "JSON_LENGTH",
    "ROW_NUMBER", "RANK", "DENSE_RANK", "LEAD", "LAG", "FIRST_VALUE", "LAST_VALUE", "NTILE",
    "LAST_INSERT_ID", "FOUND_ROWS", "ROW_COUNT", "DATABASE", "USER", "VERSION", "UUID_FN", "MD5", "SHA1", "SHA2",
]);

/** 是否为内置函数名（仅内置函数才在格式化时转大写，避免把表名/自定义函数误改） */
export function isKnownFunction(up: string): boolean {
    return FUNCTIONS.has(up);
}

/** 需要在其前换行的子句关键字（格式化用） */
export const MAJOR_CLAUSES = new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION",
    "INSERT", "REPLACE", "VALUES", "UPDATE", "DELETE", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "JOIN",
]);

const MULTI_OPS = ["<=>", "<<", ">>", "<=", ">=", "<>", "!=", "&&", "||", "::", "->", "->>"];

function isIdentStart(c: string): boolean {
    return /[A-Za-z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c);
}
function isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
}

/**
 * 切分 SQL。空白也作为 token 保留，便于格式化时按原始间距重建。
 */
export function tokenizeSql(sql: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = sql.length;

    const push = (type: TokenType, value: string, upper?: string) => {
        if (!value) return;
        tokens.push(upper === undefined ? { type, value } : { type, value, upper });
    };

    while (i < n) {
        const c = sql[i];

        // 空白
        if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
            let j = i;
            while (j < n && /\s/.test(sql[j])) j++;
            push("ws", sql.slice(i, j));
            i = j;
            continue;
        }

        // 行注释
        if ((c === "-" && sql[i + 1] === "-") || c === "#") {
            let j = i;
            while (j < n && sql[j] !== "\n") j++;
            push("comment", sql.slice(i, j));
            i = j;
            continue;
        }

        // 块注释
        if (c === "/" && sql[i + 1] === "*") {
            let j = i + 2;
            while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
            j = Math.min(j + 2, n);
            push("comment", sql.slice(i, j));
            i = j;
            continue;
        }

        // 单引号字符串（支持 '' 与 \ 转义）
        if (c === "'" || c === '"') {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "\\" && j + 1 < n) {
                    j += 2;
                    continue;
                }
                if (sql[j] === quote) {
                    if (sql[j + 1] === quote) {
                        j += 2;
                        continue;
                    }
                    j++;
                    break;
                }
                j++;
            }
            push("string", sql.slice(i, j));
            i = j;
            continue;
        }

        // 反引号标识符
        if (c === "`") {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === "`") {
                    if (sql[j + 1] === "`") {
                        j += 2;
                        continue;
                    }
                    j++;
                    break;
                }
                j++;
            }
            push("quoted", sql.slice(i, j));
            i = j;
            continue;
        }

        // 变量 @x @@x :name ?（预处理占位）
        if (c === "@" || c === "?" || (c === ":" && isIdentStart(sql[i + 1] || ""))) {
            if (c === "?") {
                push("variable", "?");
                i++;
                continue;
            }
            let j = i + 1;
            if (c === "@" && sql[j] === "@") j++;
            while (j < n && isIdentPart(sql[j])) j++;
            push("variable", sql.slice(i, j));
            i = j;
            continue;
        }

        // 数字（含 .5 / 1e10 / 0x1f）
        if (isDigit(c) || (c === "." && isDigit(sql[i + 1] || ""))) {
            let j = i;
            if (c === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
                j = i + 2;
                while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++;
            } else {
                while (j < n && (isDigit(sql[j]) || sql[j] === ".")) j++;
                if (sql[j] === "e" || sql[j] === "E") {
                    let k = j + 1;
                    if (sql[k] === "+" || sql[k] === "-") k++;
                    if (isDigit(sql[k] || "")) {
                        while (k < n && isDigit(sql[k])) k++;
                        j = k;
                    }
                }
            }
            push("number", sql.slice(i, j));
            i = j;
            continue;
        }

        // 标识符 / 关键字 / 函数 / 类型
        if (isIdentStart(c)) {
            let j = i;
            while (j < n && isIdentPart(sql[j])) j++;
            const raw = sql.slice(i, j);
            const up = raw.toUpperCase();

            // 函数调用：identifier 后紧跟 (
            let k = j;
            while (k < n && /\s/.test(sql[k])) k++;
            const isCall = sql[k] === "(";

            // SET('a','b') / ENUM(...) 这类「带括号的类型」优先判为类型，
            // 否则 SET 会被当成 UPDATE 的 SET 关键字着色。
            if (up === "SET" && isCall) {
                push("type", raw, up);
            } else if (FUNCTIONS.has(up) || (isCall && !KEYWORDS.has(up) && !TYPES.has(up))) {
                push("function", raw, up);
            } else if (TYPES.has(up)) {
                push("type", raw, up);
            } else if (KEYWORDS.has(up)) {
                push("keyword", raw, up);
            } else {
                push("ident", raw, up);
            }
            i = j;
            continue;
        }

        // 多字符操作符
        let matched = "";
        for (const op of MULTI_OPS) {
            if (sql.startsWith(op, i)) {
                matched = op;
                break;
            }
        }
        if (matched) {
            push("operator", matched);
            i += matched.length;
            continue;
        }

        if ("+-*/%<>=!&|^~".includes(c)) {
            push("operator", c);
            i++;
            continue;
        }

        if ("(),;.[]{}".includes(c)) {
            push("punct", c);
            i++;
            continue;
        }

        push("ident", c);
        i++;
    }

    return tokens;
}

const CLASS_MAP: Record<TokenType, string> = {
    ws: "",
    comment: "cr-cmt",
    string: "cr-str",
    quoted: "cr-quo",
    number: "cr-num",
    keyword: "cr-kw",
    type: "cr-typ",
    function: "cr-fn",
    variable: "cr-var",
    operator: "cr-op",
    punct: "cr-pun",
    ident: "cr-id",
};

/**
 * 就地渲染专用类名表：直接复用 highlight.js 的 token 类名。
 * 这样代码块的着色由**用户自己选的思源代码主题**决定，浅色/深色自动跟随，
 * 和原生 sql 代码块视觉完全一致，插件不需要维护第二套配色。
 */
const HLJS_CLASS_MAP: Record<TokenType, string> = {
    ws: "",
    comment: "hljs-comment",
    string: "hljs-string",
    quoted: "hljs-attr",
    number: "hljs-number",
    keyword: "hljs-keyword",
    type: "hljs-type",
    function: "hljs-built_in",
    variable: "hljs-variable",
    operator: "hljs-operator",
    punct: "hljs-punctuation",
    ident: "",
};

function renderTokens(sql: string, map: Record<TokenType, string>): string {
    let out = "";
    for (const tk of tokenizeSql(sql)) {
        const cls = map[tk.type];
        const text = escapeHtml(tk.value);
        out += cls ? `<span class="${cls}">${text}</span>` : text;
    }
    return out;
}

/** 生成高亮 HTML（面板用，配色走插件自带 cr-* 类）。已转义，可安全插入 innerHTML。 */
export function highlightSql(sql: string): string {
    return renderTokens(sql, CLASS_MAP);
}

/**
 * 逐行生成高亮 HTML：token 内部的换行会正确切分行，
 * 因此块注释 / 多行字符串跨行时既能保持着色，又能对齐行号。
 */
export function highlightSqlLines(sql: string): string[] {
    const lines: string[] = [];
    let cur = "";
    for (const tk of tokenizeSql(sql)) {
        const cls = CLASS_MAP[tk.type];
        const parts = tk.value.split("\n");
        parts.forEach((part, idx) => {
            if (idx > 0) {
                lines.push(cur);
                cur = "";
            }
            if (!part) return;
            cur += cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
        });
    }
    lines.push(cur);
    return lines;
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * 就地渲染用：直接写进代码块内容区的 HTML，用 hljs 类名让用户的代码主题接管配色。
 *
 * 不变量：**去掉所有标签后必须与入参逐字相同**。行号交给思源自己画
 * （内核 lineNumberRender 按 textContent 数行，我们不动文本它就能算对），
 * 插件绝不自绘行号，否则会和原生行号叠成两列。
 */
export function highlightSqlInplace(sql: string): string {
    return renderTokens(sql, HLJS_CLASS_MAP);
}

/** 去掉首尾空白与注释后再判断是否为空 */
export function isBlankSql(sql: string): boolean {
    for (const tk of tokenizeSql(sql)) {
        if (tk.type !== "ws" && tk.type !== "comment") return false;
    }
    return true;
}
