/**
 * 零依赖 DDL 解析：把 CREATE TABLE 语句解析成结构化的表/字段/索引定义。
 * 只做文本层面的状态机扫描，不依赖完整 SQL 语法，坏语句也能给出部分结果。
 */

export interface ColumnDef {
    name: string;
    /** 完整类型串，含长度与 unsigned 等修饰符 */
    type: string;
    nullable: boolean;
    defaultValue: string;
    autoInc: boolean;
    comment: string;
    /** 行内声明的主键 */
    primary: boolean;
    /** 其他修饰（ON UPDATE / CHARACTER SET / COLLATE 等） */
    extra: string[];
}

export type IndexKind = "PRIMARY" | "UNIQUE" | "INDEX" | "FULLTEXT" | "FOREIGN";

export interface IndexDef {
    name: string;
    kind: IndexKind;
    columns: string[];
    reference?: { table: string; columns: string[] };
    /** ON DELETE / ON UPDATE 等 */
    extra?: string;
}

export interface TableDef {
    name: string;
    comment: string;
    engine: string;
    charset: string;
    collation: string;
    autoIncrement: string;
    columns: ColumnDef[];
    indexes: IndexDef[];
}

/** 按顶层分隔符切分，忽略字符串 / 注释 / 括号内的分隔符 */
export function splitTopLevel(text: string, sep = ","): string[] {
    const out: string[] = [];
    let buf = "";
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const c = text[i];

        // 行注释
        if ((c === "-" && text[i + 1] === "-") || c === "#") {
            while (i < text.length && text[i] !== "\n") {
                buf += text[i];
                i++;
            }
            continue;
        }
        // 块注释
        if (c === "/" && text[i + 1] === "*") {
            buf += text.slice(i, i + 2);
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
                buf += text[i];
                i++;
            }
            buf += text.slice(i, i + 2);
            i += 2;
            continue;
        }
        // 引号
        if (c === "'" || c === '"' || c === "`") {
            const q = c;
            buf += c;
            i++;
            while (i < text.length) {
                if (text[i] === "\\" && i + 1 < text.length) {
                    buf += text[i] + text[i + 1];
                    i += 2;
                    continue;
                }
                if (text[i] === q) {
                    if (text[i + 1] === q) {
                        buf += q + q;
                        i += 2;
                        continue;
                    }
                    buf += q;
                    i++;
                    break;
                }
                buf += text[i];
                i++;
            }
            continue;
        }
        if (c === "(") {
            depth++;
            buf += c;
            i++;
            continue;
        }
        if (c === ")") {
            depth--;
            buf += c;
            i++;
            continue;
        }
        if (c === sep && depth === 0) {
            out.push(buf);
            buf = "";
            i++;
            continue;
        }
        buf += c;
        i++;
    }
    if (buf.trim()) out.push(buf);
    return out;
}

/** 找到与 startIdx 处 '(' 配对的 ')' 下标；找不到返回 -1 */
function matchParen(text: string, startIdx: number): number {
    let depth = 0;
    let i = startIdx;
    while (i < text.length) {
        const c = text[i];
        if ((c === "-" && text[i + 1] === "-") || c === "#") {
            while (i < text.length && text[i] !== "\n") i++;
            continue;
        }
        if (c === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        if (c === "'" || c === '"' || c === "`") {
            const q = c;
            i++;
            while (i < text.length) {
                if (text[i] === "\\" && i + 1 < text.length) {
                    i += 2;
                    continue;
                }
                if (text[i] === q) {
                    if (text[i + 1] === q) {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return -1;
}

function unquote(name: string): string {
    const t = name.trim();
    if ((t.startsWith("`") && t.endsWith("`")) || (t.startsWith('"') && t.endsWith('"'))) {
        return t.slice(1, -1).replace(/(``|"")/g, (m) => m[0]);
    }
    return t;
}

function stripComments(s: string): string {
    return s
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .replace(/#[^\n]*/g, " ");
}

function parseNameList(inner: string): string[] {
    return splitTopLevel(inner)
        .map((p) => unquote(p.trim()))
        .map((p) => p.replace(/\s+(ASC|DESC)$/i, "").replace(/\(\d+\)$/, "").trim())
        .filter(Boolean);
}

function parseColumn(segment: string): ColumnDef | null {
    const seg = stripComments(segment).trim();
    if (!seg) return null;

    // 字段名
    const nameMatch = seg.match(/^([`"'][^`"']+[`"']|[A-Za-z_$][\w$]*)/);
    if (!nameMatch) return null;
    const name = unquote(nameMatch[1]);
    let rest = seg.slice(nameMatch[0].length).trim();

    // 类型：名称后到下一个修饰关键字之前，允许带括号（decimal(10,2) / enum('a','b')）
    const typeStop = rest.search(
        /\b(NOT\s+NULL|NULL\b|DEFAULT\b|AUTO_INCREMENT\b|COMMENT\b|ON\s+UPDATE\b|UNIQUE\b|PRIMARY\b|CHARACTER\s+SET\b|COLLATE\b|CHECK\b|REFERENCES\b|GENERATED\b|STORED\b|VIRTUAL\b|SERIAL\b)/i
    );
    let typeText = (typeStop >= 0 ? rest.slice(0, typeStop) : rest).trim();
    if (typeStop >= 0) rest = rest.slice(typeStop).trim();
    else rest = "";

    // 类型里的括号要完整保留（splitTopLevel 已保证不会切断）
    typeText = typeText.replace(/,$/, "").trim();

    const nullable = !/\bNOT\s+NULL\b/i.test(rest);
    const autoInc = /\bAUTO_INCREMENT\b/i.test(rest);
    const primary = /\bPRIMARY\s+KEY\b/i.test(rest);

    const defaultValue = extractDefault(rest);

    const commentMatch = rest.match(/\bCOMMENT\s+('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*")/i);
    const comment = commentMatch ? unquoteLiteral(commentMatch[1]) : "";

    const extra: string[] = [];
    const onUpdate = rest.match(/\bON\s+UPDATE\s+([^,]+)/i);
    if (onUpdate) extra.push("ON UPDATE " + onUpdate[1].trim());
    const charset = rest.match(/\bCHARACTER\s+SET\s+([\w-]+)/i);
    if (charset) extra.push("CHARSET " + charset[1]);
    const collate = rest.match(/\bCOLLATE\s+([\w-]+)/i);
    if (collate) extra.push("COLLATE " + collate[1]);
    if (/\bUNSIGNED\b/i.test(rest) && !/\bUNSIGNED\b/i.test(typeText)) extra.push("UNSIGNED");
    if (/\bUNIQUE\b/i.test(rest)) extra.push("UNIQUE");

    return { name, type: typeText, nullable, defaultValue, autoInc, comment, primary, extra };
}

/** 修饰关键字边界：DEFAULT 取值遇到它们就停止，避免把 COMMENT 当成默认值的一部分 */
const ATTR_STOP = /\b(NOT\s+NULL|NULL|AUTO_INCREMENT|COMMENT|ON\s+UPDATE|ON\s+DELETE|UNIQUE|PRIMARY\s+KEY|CHECK|COLLATE|CHARACTER\s+SET|REFERENCES|GENERATED|STORED|VIRTUAL|SERIAL|INVISIBLE|DEFAULT)\b/i;

/**
 * 提取 DEFAULT 后的取值：先吃掉第一个完整 token（字符串 / 函数调用 / 数字 / 关键字），
 * 再在下一个修饰关键字处截断。
 */
function extractDefault(rest: string): string {
    const m = rest.match(/\bDEFAULT\s+([\s\S]*)$/i);
    if (!m) return "";
    let ad = m[1].trim();
    if (!ad) return "";

    // 第一个 token 的长度：引号串要整段吃掉，否则按空白切
    let headLen: number;
    if (ad.startsWith("'")) {
        const q = ad.match(/^'(?:[^'\\]|\\.|'')*'/);
        headLen = q ? q[0].length : ad.length;
    } else if (ad.startsWith('"')) {
        const q = ad.match(/^"(?:[^"\\]|\\.)*"/);
        headLen = q ? q[0].length : ad.length;
    } else {
        const sp = ad.search(/\s/);
        headLen = sp >= 0 ? sp : ad.length;
    }

    const stop = ad.slice(headLen).search(ATTR_STOP);
    ad = (stop >= 0 ? ad.slice(0, headLen + stop) : ad).trim();
    return unquoteLiteral(ad);
}

function unquoteLiteral(s: string): string {
    const t = s.trim();
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
        return t.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
    }
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        return t.slice(1, -1).replace(/""/g, '"');
    }
    return t;
}

function parseIndex(segment: string): IndexDef | null {
    const seg = stripComments(segment).trim();
    if (!seg) return null;

    const fkMatch = seg.match(
        /^(?:CONSTRAINT\s+(?:[`"'][^`"']+[`"']|[\w$]+)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([`"']?[\w$.]+[`"']?)\s*\(([^)]*)\)([\s\S]*)$/i
    );
    if (fkMatch) {
        const nameMatch = seg.match(/^CONSTRAINT\s+([`"'][^`"']+[`"']|[\w$]+)/i);
        return {
            name: nameMatch ? unquote(nameMatch[1]) : "",
            kind: "FOREIGN",
            columns: parseNameList(fkMatch[1]),
            reference: { table: unquote(fkMatch[2]), columns: parseNameList(fkMatch[3]) },
            extra: fkMatch[4]?.trim() || "",
        };
    }

    const idxMatch = seg.match(/^((?:PRIMARY\s+KEY)|(?:UNIQUE\s+(?:KEY|INDEX)?)|(?:FULLTEXT\s+(?:KEY|INDEX)?)|(?:KEY)|(?:INDEX))\s*([\s\S]*)$/i);
    if (!idxMatch) return null;

    const head = idxMatch[1].toUpperCase().replace(/\s+/g, " ");
    let remainder = idxMatch[2].trim();
    let kind: IndexKind = "INDEX";
    if (head.startsWith("PRIMARY")) kind = "PRIMARY";
    else if (head.startsWith("UNIQUE")) kind = "UNIQUE";
    else if (head.startsWith("FULLTEXT")) kind = "FULLTEXT";

    let name = "";
    const nameMatch = remainder.match(/^([`"'][^`"']+[`"']|[A-Za-z_$][\w$]*)\s*/);
    if (nameMatch && !/^(USING|BTREE|HASH)$/i.test(nameMatch[1])) {
        name = unquote(nameMatch[1]);
        remainder = remainder.slice(nameMatch[0].length).trim();
    }

    const parenStart = remainder.indexOf("(");
    if (parenStart < 0) return null;
    const parenEnd = matchParen(remainder, parenStart);
    if (parenEnd < 0) return null;
    const columns = parseNameList(remainder.slice(parenStart + 1, parenEnd));

    return { name: name || (kind === "PRIMARY" ? "PRIMARY" : ""), kind, columns };
}

function parseTableOptions(text: string): Pick<TableDef, "engine" | "charset" | "collation" | "comment" | "autoIncrement"> {
    const clean = stripComments(text);
    const pick = (re: RegExp): string => {
        const m = clean.match(re);
        return m ? unquoteLiteral(m[1]) : "";
    };
    return {
        engine: pick(/\bENGINE\s*=\s*([\w.-]+)/i),
        charset: pick(/(?:DEFAULT\s+)?\bCHARSET\s*=\s*([\w-]+)/i) || pick(/(?:DEFAULT\s+)?\bCHARACTER\s+SET\s*=?\s*([\w-]+)/i),
        collation: pick(/(?:DEFAULT\s+)?\bCOLLATE\s*=?\s*([\w-]+)/i),
        comment: pick(/\bCOMMENT\s*=?\s*('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*")/i),
        autoIncrement: pick(/\bAUTO_INCREMENT\s*=\s*([\w]+)/i),
    };
}

/** 解析一段 SQL 中的所有 CREATE TABLE 语句 */
export function parseCreateTables(sql: string): TableDef[] {
    const tables: TableDef[] = [];
    const statements = splitTopLevel(stripComments(sql), ";");

    for (const raw of statements) {
        const stmt = raw.trim();
        const head = stmt.match(/^CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"'][^`"']+[`"']|[\w$.]+)/i);
        if (!head) continue;

        // 用原始（带注释）的 raw 定位括号，保证列注释里的括号不被误判
        const parenStart = raw.indexOf("(", head[0].length - 1);
        if (parenStart < 0) continue;
        const parenEnd = matchParen(raw, parenStart);
        if (parenEnd < 0) continue;

        const body = raw.slice(parenStart + 1, parenEnd);
        const tail = raw.slice(parenEnd + 1);

        const table: TableDef = {
            name: unquote(head[1]),
            comment: "",
            engine: "",
            charset: "",
            collation: "",
            autoIncrement: "",
            columns: [],
            indexes: [],
        };

        for (const segment of splitTopLevel(body)) {
            const seg = segment.trim();
            if (!seg) continue;
            const stripped = stripComments(seg).trim();
            if (!stripped) continue;
            const isIndex = /^(PRIMARY\s+KEY|UNIQUE|KEY|INDEX|FULLTEXT|CONSTRAINT|CHECK)\b/i.test(stripped);
            if (isIndex) {
                const idx = parseIndex(seg);
                if (idx) table.indexes.push(idx);
                continue;
            }
            const col = parseColumn(seg);
            if (col) table.columns.push(col);
        }

        // 行内主键也补进索引列表，便于统一展示
        const inlinePk = table.columns.filter((c) => c.primary).map((c) => c.name);
        if (inlinePk.length && !table.indexes.some((i) => i.kind === "PRIMARY")) {
            table.indexes.unshift({ name: "PRIMARY", kind: "PRIMARY", columns: inlinePk });
        }

        const opts = parseTableOptions(tail);
        table.engine = opts.engine;
        table.charset = opts.charset;
        table.collation = opts.collation;
        table.comment = opts.comment;
        table.autoIncrement = opts.autoIncrement;

        tables.push(table);
    }

    return tables;
}
