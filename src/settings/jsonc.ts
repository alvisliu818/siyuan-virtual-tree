// JSONC 文本处理:让 settings.json 可以带注释(与 VS Code 一致),
// 并且"面板改一个值"时尽量只动那一行,保住用户写的注释与格式。
//
// 只做文本层的活,不依赖 monaco / siyuan,方便单独验证。

/** 去掉 // 与 /* *\/ 注释(字符串内的不算) */
export function stripJsonComments(text: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const n = text[i + 1];
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === "\"") inString = false;
            continue;
        }
        if (c === "\"") {
            inString = true;
            out += c;
            continue;
        }
        if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
            continue;
        }
        if (c === "/" && n === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keyLineRe(key: string): RegExp {
    return new RegExp("^(\\s*)\"" + escapeRe(key) + "\"\\s*:\\s*(.*)$");
}

/**
 * 就地改一个顶层键的值,保住行尾注释。
 * 只处理"值写在单行"的常见情况(模板与 VS Code 习惯都是这样);
 * 处理不了返回 null,由调用方回退到整体重新序列化。
 */
export function patchJsonText(text: string, key: string, value: unknown): string | null {
    const body = text || "";
    const lines = body.split("\n");
    const re = keyLineRe(key);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        const indent = m[1];
        let rest = m[2];
        // 取出行尾注释(值本身是字符串且含 // 的概率极低,不做严格扫描)
        let comment = "";
        const cm = rest.match(/\/\/.*$/);
        if (cm) {
            comment = " " + cm[0].trim();
            rest = rest.slice(0, cm.index);
        }
        rest = rest.replace(/\s+$/, "");
        const comma = rest.endsWith(",") ? "," : "";
        lines[i] = `${indent}"${key}": ${JSON.stringify(value)}${comma}${comment}`;
        return lines.join("\n");
    }
    return null;
}

/** 键不存在时,在结尾的 } 前插入一行;插入不了返回 null */
export function insertJsonText(text: string, key: string, value: unknown): string | null {
    const lines = (text || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim().startsWith("}")) continue;
        const indent = (lines[i].match(/^\s*/) || [""])[0];
        const inner = indent + "  ";
        // 上一条有效内容若不以 , 或 { 结尾,先补逗号
        for (let j = i - 1; j >= 0; j--) {
            const prev = lines[j].trim();
            if (!prev || prev.startsWith("//") || prev.startsWith("/*")) continue;
            if (!prev.endsWith(",") && !prev.endsWith("{")) {
                lines[j] = lines[j].replace(/\s*$/, "") + ",";
            }
            break;
        }
        lines.splice(i, 0, `${inner}"${key}": ${JSON.stringify(value)}`);
        return lines.join("\n");
    }
    return null;
}

/**
 * 删掉一个顶层键(整行移除)。
 * 末项善后:删的是最后一项时,前一行会留下尾逗号(`"a": 1,` 直接接 `}`),
 * JSON.parse 对尾逗号必抛错 → 之后每次启动 settings.json 解析全炸、设置静默回默认
 * (实测踩过:字体/主题全丢)。所以删完检查最后一个数据行,是"逗号+}"就去掉逗号。
 */
export function removeJsonKey(text: string, key: string): string {
    const re = new RegExp("^\\s*\"" + escapeRe(key) + "\"\\s*:");
    const lines = (text || "").split("\n").filter(l => !re.test(l));
    const isSkippable = (l: string) => {
        const t = l.trim();
        return !t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
    };
    for (let i = lines.length - 1; i >= 0; i--) {
        if (isSkippable(lines[i])) continue;
        // 找到最后一个数据行:若以 , 结尾且其后紧跟 },去掉逗号
        if (lines[i].trimEnd().endsWith(",")) {
            for (let j = i + 1; j < lines.length; j++) {
                if (isSkippable(lines[j])) continue;
                if (lines[j].trim().startsWith("}")) {
                    lines[i] = lines[i].replace(/\s*,\s*$/, "");
                }
                break;
            }
        }
        break;
    }
    return lines.join("\n");
}
