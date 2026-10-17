/**
 * 零依赖 SQL 美化：关键字大写、主要子句换行、SELECT 列表与 WHERE 条件逐项缩进。
 * 基于词法结果重建空白，因此不会破坏字符串与注释内容。
 */
import { MAJOR_CLAUSES, tokenizeSql, type Token, type TokenType } from "./tokenizer";
import { isKnownFunction } from "./tokenizer";

export interface FormatOptions {
    /** 一级缩进空格数 */
    indent?: number;
    /** 关键字转大写 */
    upperKeywords?: boolean;
    /** SELECT 字段逐个换行 */
    breakSelectList?: boolean;
    /** WHERE / ON / HAVING 里的 AND / OR 换行 */
    breakConditions?: boolean;
}

const CONDITION_CLAUSES = new Set(["WHERE", "ON", "HAVING"]);

function needSpace(prev: Token | null, next: Token): boolean {
    if (!prev) return false;
    if (next.type === "punct") {
        if ([",", ")", ";", "."].includes(next.value)) return false;
        if (next.value === "(") {
            // 内置函数与类型紧贴：COUNT(*) / VARCHAR(64)
            // 关键字、普通标识符留空：IN (1,2) / VALUES (..) / INTO t (a,b)
            // 注意 tokenizer 会把「标识符 + 左括号」统一记成 function，
            // 所以这里再用内置函数表筛一次，否则表名也会被贴上去。
            if (prev.type === "function") return !isKnownFunction(prev.upper || prev.value.toUpperCase());
            if (prev.type === "type") return false;
            return prev.type === "keyword" || prev.type === "ident";
        }
    }
    if (prev.type === "punct") {
        if (["(", "."].includes(prev.value)) return false;
        if (prev.value === ")") return next.type !== "punct" || !["(", ")"].includes(next.value);
    }
    if (prev.type === "operator" || next.type === "operator") return true;
    return true;
}

export function formatSql(sql: string, options: FormatOptions = {}): string {
    const unit = options.indent ?? 2;
    const upper = options.upperKeywords !== false;
    const breakList = options.breakSelectList !== false;
    const breakCond = options.breakConditions !== false;

    const tokens = tokenizeSql(sql).filter((t) => t.type !== "ws");
    const lines: string[] = [];
    let cur = "";
    let depth = 0;

    // SELECT 列表状态：记录进入时的括号深度，遇到同深度的 FROM 才结束
    let inSelectList = false;
    let selectDepth = 0;
    // 当前主子句，用于决定 AND / OR 是否换行
    let clause = "";
    let prevMeaningful: Token | null = null;
    // 已输出的有意义 token，用于判断「),( 」这类元组边界
    const sigs: Token[] = [];
    // 每个括号层是否需要「闭合括号另起一行」（子查询为 true，IN (1,2) 为 false）
    const parenBreaks: boolean[] = [];
    // SELECT 之后的第一个字段需要换行缩进
    let pendingFieldBreak = false;
    // VALUES 之后的元组列表缩进层级（-1 表示当前不在 VALUES 里）
    let tupleIndent = -1;

    const pad = (level: number) => " ".repeat(Math.max(0, level) * unit);
    const flush = () => {
        const text = cur.replace(/\s+$/, "");
        if (text.trim()) lines.push(text);
        cur = "";
    };
    const startLine = (level: number) => {
        flush();
        cur = pad(level);
    };
    /**
     * 输出一个 token。**必须传真实 type**：间距规则（尤其「函数/类型后左括号紧贴」）
     * 依赖它判断，早期版本这里硬编码成 ident，导致 COUNT( / VARCHAR( 都被塞进空格。
     */
    const emit = (text: string, type: TokenType = "ident") => {
        if (cur && needSpace(prevMeaningful, { type, value: text })) {
            if (!/\s$/.test(cur)) cur += " ";
        }
        cur += text;
    };

    const nextMeaningful = (from: number): Token | null => {
        for (let k = from + 1; k < tokens.length; k++) {
            if (tokens[k].type !== "comment") return tokens[k];
        }
        return null;
    };

    for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        const up = tk.upper || tk.value.toUpperCase();

        if (tk.type === "comment") {
            if (tk.value.startsWith("--") || tk.value.startsWith("#")) {
                startLine(depth);
                cur += tk.value;
                flush();
            } else if (!cur.trim()) {
                startLine(depth);
                cur += tk.value;
                flush();
            } else {
                emit(tk.value, "comment");
            }
            continue;
        }

        if (tk.type === "punct" && tk.value === "(") {
            // 元组分隔：前一个有意义 token 是 ")"（允许中间隔一个逗号）时另起一行
            const last = sigs[sigs.length - 1];
            const prev = sigs[sigs.length - 2];
            const tupleBoundary =
                last?.value === ")" || (last?.value === "," && prev?.value === ")");
            if (tupleBoundary || tupleIndent >= 0) {
                startLine(tupleIndent >= 0 ? tupleIndent : depth);
            }

            const nxt = nextMeaningful(i);
            const subQuery = !!nxt && nxt.type === "keyword" && ["SELECT", "WITH"].includes(nxt.upper || "");
            emit("(", "punct");
            depth++;
            parenBreaks.push(subQuery);
            if (subQuery) startLine(depth);
            prevMeaningful = tk;
            sigs.push(tk);
            continue;
        }

        if (tk.type === "punct" && tk.value === ")") {
            depth--;
            const breakBefore = parenBreaks.pop() ?? false;
            if (breakBefore && cur.trim() && !cur.trimEnd().endsWith("(")) {
                flush();
                cur = pad(depth) + ")";
            } else {
                cur = cur.replace(/\s+$/, "") + ")";
            }
            prevMeaningful = tk;
            sigs.push(tk);
            continue;
        }

        if (tk.type === "punct" && tk.value === ",") {
            cur = cur.replace(/\s+$/, "") + ",";
            if (breakList && inSelectList && depth === selectDepth) {
                startLine(depth + 1);
            }
            prevMeaningful = tk;
            sigs.push(tk);
            continue;
        }

        if (tk.type === "punct" && tk.value === ";") {
            cur = cur.replace(/\s+$/, "") + ";";
            flush();
            tupleIndent = -1;
            prevMeaningful = tk;
            sigs.push(tk);
            continue;
        }

        if (tk.type === "keyword") {
            const isMajor = MAJOR_CLAUSES.has(up);
            const isCond = CONDITION_CLAUSES.has(up);

            if (isMajor) {
                startLine(depth);
            } else if (isCond) {
                emit(upper ? up : tk.value, "keyword");
                prevMeaningful = tk;
                clause = up;
                continue;
            } else if ((up === "AND" || up === "OR") && breakCond && CONDITION_CLAUSES.has(clause)) {
                startLine(depth + 1);
            } else if (up === "SET" && (clause === "UPDATE" || clause === "INSERT")) {
                startLine(depth);
            }

            const text = upper ? up : tk.value;
            emit(text, "keyword");

            if (up === "SELECT") {
                inSelectList = true;
                selectDepth = depth;
                clause = "SELECT";
                pendingFieldBreak = true;
            } else if (up === "FROM") {
                inSelectList = false;
                pendingFieldBreak = false;
                clause = "FROM";
            } else if (MAJOR_CLAUSES.has(up)) {
                clause = up;
                if (up === "VALUES") tupleIndent = depth + 1;
            }
            // GROUP BY / ORDER BY 的 BY 紧跟不换行
            prevMeaningful = tk;
            sigs.push(tk);
            continue;
        }

        // SELECT 之后的第一个字段另起一行；DISTINCT / * 与关键字保持同行
        if (pendingFieldBreak) {
            if (tk.type === "punct") {
                // 括号表达式跟在 SELECT 后不换行
                pendingFieldBreak = false;
            } else if (tk.value === "*") {
                pendingFieldBreak = false;
            } else if (tk.type !== "keyword") {
                startLine(depth + 1);
                pendingFieldBreak = false;
            }
        }

        // 元组之间换行：VALUES (..),(..)
        const text =
            (upper && tk.type === "type") || (upper && tk.type === "function" && isKnownFunction(up))
                ? tk.value.toUpperCase()
                : tk.value;
        emit(text, tk.type);
        prevMeaningful = tk;
        sigs.push(tk);
    }

    flush();
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
