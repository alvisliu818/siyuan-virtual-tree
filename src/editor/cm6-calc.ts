// calc 计算块:源码在左、逐行求值结果在右(Logseq 同款)。
//
// 行为级移植自 Logseq OG(AGPL-3.0):
//   E:/HOME/Code/logseq/og/src/main/frontend/extensions/calc.cljc
//   E:/HOME/Code/logseq/og/src/resources/grammar/calc.bnf
//   E:/HOME/Code/logseq/og/src/main/frontend/extensions/code.cljs (results 渲染)
// 语法(calc.bnf)用递归下降解析器重写,未引入 instaparse/ClojureScript;
// 数值沿用 Logseq 同款 bignumber.js,保证 0.1 + 0.2 = 0.3 这类精确十进制运算。
// 支持:十进制/千分位/科学计数/0x 0o 0b、百分数、带分数、+ - * / mod ^ !、
// 括号、一元负号、11 个数学函数、变量赋值、常量 PI/E 与 last、
// # 注释、:format fix|sci|normal|frac|imp 与 :hex/:oct/:bin/:dec 指令。
//
// 与 Logseq 的差异(环境适配,非功能削减):
//   - 卡片是 CM6 块级 replace widget,编辑态为内嵌 CM6(Logseq 是 CM5 textarea);
//   - 结果列在编辑态仍常驻并随键入实时刷新(见 cm6-render 的 syncFromMonaco);
//   - 语言标签照常显示(Logseq 对 calc 隐藏)。

import BigNumber from "bignumber.js";

// Logseq 未设置 DECIMAL_PLACES,用 bignumber.js 默认 20 位除法精度。
const CONSTANTS: Record<string, BigNumber> = {
    PI: new BigNumber("3.14159265358979323846"),
    E: new BigNumber("2.71828182845904523536"),
};

const FUNCTIONS = new Set([
    "log", "ln", "exp", "sqrt", "abs",
    "sin", "cos", "tan", "asin", "acos", "atan",
]);

class CalcError extends Error {}

type FormatMode = "normal" | "fix" | "sci" | "frac" | "impf";
type NumBase = "dec" | "hex" | "oct" | "bin";

interface CalcEnv {
    vars: Map<string, BigNumber>;
    mode: FormatMode;
    places: number;
    precision: number;
    maxDenominator: number;
    base: NumBase;
}

function newEnv(): CalcEnv {
    return {vars: new Map(), mode: "normal", places: 0, precision: 21, maxDenominator: 4095, base: "dec"};
}

// ---------- 词法 ----------

type TokKind = "num" | "id" | "op" | "lparen" | "rparen" | "assign" | "eof";
interface Token {
    kind: TokKind;
    text: string;
    /** 标识符小写形式(关键字比较用) */
    low?: string;
}

function lex(src: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "#") break; // 行尾注释
        if (/[0-9.]/.test(c)) {
            let raw = "";
            if (c === "0" && /[xXoObB]/.test(src[i + 1] || "")) {
                const b = src[i + 1].toLowerCase();
                const re = b === "x" ? /[0-9a-fA-F,.]/ : b === "o" ? /[0-7,.]/ : /[01,.]/;
                raw = src.slice(i, i + 2);
                i += 2;
                while (i < src.length && re.test(src[i])) { raw += src[i]; i++; }
            } else {
                while (i < src.length && /[0-9,.]/.test(src[i])) { raw += src[i]; i++; }
                if (i < src.length && /[eE]/.test(src[i])) {
                    raw += src[i]; i++;
                    if (i < src.length && /[+-]/.test(src[i])) { raw += src[i]; i++; }
                    while (i < src.length && /[0-9]/.test(src[i])) { raw += src[i]; i++; }
                }
            }
            out.push({kind: "num", text: raw});
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let id = "";
            while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { id += src[i]; i++; }
            out.push({kind: "id", text: id, low: id.toLowerCase()});
            continue;
        }
        if (c === "(" || c === ")") {
            out.push({kind: c === "(" ? "lparen" : "rparen", text: c});
            i++;
            continue;
        }
        if (c === "=") {
            out.push({kind: "assign", text: c});
            i++;
            continue;
        }
        if ("+-*/^!%".includes(c)) {
            out.push({kind: "op", text: c});
            i++;
            continue;
        }
        throw new CalcError();
    }
    out.push({kind: "eof", text: ""});
    return out;
}

/** 带分数 "1 1/2" → "(1 + 1 / 2)"(calc.bnf 的 mixed-number) */
function preprocess(s: string): string {
    return s.replace(/(?<![\d./])(\d+)\s+(\d+)\s*\/\s*(\d+)/g, "($1 + $2 / $3)");
}

function numberValue(raw: string): BigNumber {
    const s = raw.replace(/,/g, "");
    if (/^0[xX]/.test(s)) return new BigNumber(s);
    if (/^0[oO]/.test(s)) return new BigNumber(parseInt(s.slice(2), 8));
    if (/^0[bB]/.test(s)) return new BigNumber(parseInt(s.slice(2), 2));
    if (!/[0-9]/.test(s)) throw new CalcError();
    const n = new BigNumber(s);
    if (n.isNaN()) throw new CalcError();
    return n;
}

// ---------- 语法 ----------

class Parser {
    private i = 0;
    private readonly ts: Token[];

    constructor(src: string, private readonly env: CalcEnv) {
        this.ts = lex(preprocess(src));
    }

    private peek(): Token { return this.ts[this.i]; }
    private next(): Token { return this.ts[this.i++]; }
    private isOp(t: Token, op: string): boolean { return t.kind === "op" && t.text === op; }

    parseAll(): BigNumber {
        const v = this.parseAddSub();
        if (this.peek().kind !== "eof") throw new CalcError();
        return v;
    }

    private parseAddSub(): BigNumber {
        let left = this.parseMulDiv();
        for (;;) {
            const t = this.peek();
            if (!this.isOp(t, "+") && !this.isOp(t, "-")) break;
            this.next();
            const right = this.parseMulDiv();
            left = t.text === "+" ? left.plus(right) : left.minus(right);
        }
        return left;
    }

    private parseMulDiv(): BigNumber {
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            const isMod = t.kind === "id" && t.low === "mod";
            if (!this.isOp(t, "*") && !this.isOp(t, "/") && !isMod) break;
            this.next();
            const right = this.parseUnary();
            if (isMod) left = left.modulo(right);
            else if (t.text === "*") left = left.times(right);
            else left = left.div(right);
        }
        return left;
    }

    private parseUnary(): BigNumber {
        if (this.isOp(this.peek(), "-")) {
            this.next();
            return this.parsePower().negated();
        }
        return this.parsePower();
    }

    private parsePower(): BigNumber {
        const base = this.parsePostfix();
        if (!this.isOp(this.peek(), "^")) return base;
        this.next();
        const exp = this.parseUnary(); // 右结合 + 允许负指数
        return powOf(base, exp);
    }

    private parsePostfix(): BigNumber {
        let v = this.parsePrimary();
        for (;;) {
            const t = this.peek();
            if (this.isOp(t, "!")) {
                this.next();
                v = factorialOf(v);
            } else if (this.isOp(t, "%")) {
                this.next();
                v = v.div(100);
            } else {
                break;
            }
        }
        return v;
    }

    private parsePrimary(): BigNumber {
        const t = this.next();
        if (t.kind === "num") return numberValue(t.text);
        if (t.kind === "lparen") {
            const v = this.parseAddSub();
            if (this.next().kind !== "rparen") throw new CalcError();
            return v;
        }
        if (t.kind === "id") {
            if (t.low && FUNCTIONS.has(t.low) && this.peek().kind === "lparen") {
                this.next();
                const arg = this.parseAddSub();
                if (this.next().kind !== "rparen") throw new CalcError();
                return applyFunction(t.low, arg);
            }
            return resolveVar(this.env, t.text);
        }
        throw new CalcError();
    }
}

function powOf(a: BigNumber, b: BigNumber): BigNumber {
    if (b.isInteger() && b.abs().isLessThanOrEqualTo(10000)) {
        try {
            return a.exponentiatedBy(b.toNumber());
        } catch {
            // 极端指数回落双精度(与 Logseq 对非整数指数的处理一致)
        }
    }
    return new BigNumber(Math.pow(a.toNumber(), b.toNumber()));
}

function factorialOf(a: BigNumber): BigNumber {
    // Logseq:非正整数或 ≥254 返回 NaN
    if (!a.isInteger() || !a.isPositive() || !a.isLessThan(254)) return new BigNumber(NaN);
    let r = new BigNumber(1);
    const n = a.toNumber();
    for (let i = 2; i <= n; i++) r = r.times(i);
    return r;
}

function applyFunction(name: string, x: BigNumber): BigNumber {
    switch (name) {
        case "abs": return x.abs();
        case "sqrt": return x.sqrt();
        case "exp": return new BigNumber(Math.exp(x.toNumber()));
        case "ln": return new BigNumber(Math.log(x.toNumber()));
        case "log": return new BigNumber(Math.log10(x.toNumber()));
        case "sin": return new BigNumber(Math.sin(x.toNumber()));
        case "cos": return new BigNumber(Math.cos(x.toNumber()));
        case "tan": return new BigNumber(Math.tan(x.toNumber()));
        case "asin": return new BigNumber(Math.asin(x.toNumber()));
        case "acos": return new BigNumber(Math.acos(x.toNumber()));
        case "atan": return new BigNumber(Math.atan(x.toNumber()));
        default: throw new CalcError();
    }
}

function resolveVar(env: CalcEnv, name: string): BigNumber {
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
    const v = env.vars.get(name);
    if (v) return v;
    throw new CalcError();
}

// ---------- 格式化(对齐 calc.cljc 的 format-val) ----------

function formatNormal(env: CalcEnv, val: BigNumber): string {
    const p = env.precision;
    const display = val.precision(p, BigNumber.ROUND_HALF_UP);
    // BigNumber.e 对 NaN/Infinity 为 null;formatVal 已挡下非有限值,这里兜底
    const exp = display.e ?? 0;
    return exp < p && display.shiftedBy(p + 1).isInteger()
        ? display.toFixed()
        : display.toExponential();
}

function canFix(val: BigNumber, places: number): boolean {
    if (val.isZero()) return true;
    const mag = val.abs();
    const lower = new BigNumber("0.5").shiftedBy(-places);
    return mag.isGreaterThanOrEqualTo(lower) && mag.isLessThan(new BigNumber("1e21"));
}

function formatBase(val: BigNumber, base: NumBase): string {
    const sign = val.isNegative() ? "-" : "";
    const prefix = base === "hex" ? "0x" : base === "oct" ? "0o" : "0b";
    const radix = base === "hex" ? 16 : base === "oct" ? 8 : 2;
    return sign + prefix + val.abs().toString(radix);
}

function formatFraction(env: CalcEnv, val: BigNumber): string {
    const [n, d] = val.toFraction(env.maxDenominator);
    const num = new BigNumber(n);
    const den = new BigNumber(d);
    const delta = num.div(den).minus(val);
    const de = delta.e ?? 0;
    if (!delta.isZero() && !(de < -16)) return formatNormal(env, val);
    if (!den.isGreaterThan(1)) return formatNormal(env, num);
    const whole = num.dividedToIntegerBy(den);
    if (env.mode === "impf" || whole.isZero()) return `${num}/${den}`;
    return `${whole} ${num.modulo(den).abs()}/${den}`;
}

function formatVal(env: CalcEnv, val: BigNumber): string {
    if (!val.isFinite()) return val.toString();
    if (env.base !== "dec") return formatBase(val, env.base);
    switch (env.mode) {
        case "fix": return canFix(val, env.places) ? val.toFixed(env.places) : val.toExponential(env.places);
        case "sci": return val.toExponential(env.places);
        case "frac":
        case "impf": return formatFraction(env, val);
        default: return formatNormal(env, val);
    }
}

// ---------- 逐行求值 ----------

function stripComment(line: string): string {
    const i = line.indexOf("#");
    return i < 0 ? line : line.slice(0, i);
}

/** :format / :base 指令;返回被重新格式化的 last 值 */
function parseDirective(text: string, env: CalcEnv): BigNumber | null {
    const rest = text.replace(/^\s*:\s*/, "").trim();
    const low = rest.toLowerCase();
    if (low === "hex" || low === "hexadecimal") env.base = "hex";
    else if (low === "oct" || low === "octal") env.base = "oct";
    else if (low === "bin" || low === "binary") env.base = "bin";
    else if (low === "dec" || low === "decimal") env.base = "dec";
    else {
        const m = /^(?:format|fmt)\s+(fix(?:ed)?|sci(?:entific)?|norm(?:al)?|frac(?:tions?)?|imp(?:roper)?)\s*(\d*)/i.exec(rest);
        if (!m) throw new CalcError();
        const n = m[2] ? parseInt(m[2], 10) : 0;
        const kind = m[1].toLowerCase();
        if (kind.startsWith("fix")) { env.mode = "fix"; env.places = n; }
        else if (kind.startsWith("sci")) { env.mode = "sci"; env.places = n; }
        else if (kind.startsWith("norm")) { env.mode = "normal"; env.precision = n || 21; }
        else if (kind.startsWith("frac")) { env.mode = "frac"; env.maxDenominator = n || 4095; }
        else { env.mode = "impf"; env.maxDenominator = n || 4095; }
    }
    return env.vars.get("last") ?? null;
}

function evalLine(raw: string, env: CalcEnv): BigNumber | null {
    const text = stripComment(raw);
    if (!text.trim()) return null;
    if (/^\s*:/.test(text)) return parseDirective(text, env);
    const am = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
    if (am) {
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, am[1])) throw new CalcError();
        const val = new Parser(am[2], env).parseAll();
        env.vars.set(am[1], val);
        return val;
    }
    return new Parser(text, env).parseAll();
}

export interface CalcRow {
    source: string;
    /** 结果文本;空行/纯注释为 "";解析或求值失败为 "?" */
    result: string;
    error: boolean;
}

/** Logseq calc/eval-lines 的等价实现:env 跨行延续(变量/格式指令/last) */
export function evalCalcLines(code: string): CalcRow[] {
    const env = newEnv();
    return code.split(/\r?\n/).map(source => {
        if (!source.trim()) return {source, result: "", error: false};
        try {
            const val = evalLine(source, env);
            if (val === null) return {source, result: "", error: false};
            env.vars.set("last", val);
            return {source, result: formatVal(env, val), error: false};
        } catch {
            return {source, result: "?", error: true};
        }
    });
}

// ---------- DOM ----------

function buildSourceRows(el: HTMLElement, rows: CalcRow[]): void {
    el.replaceChildren();
    const widthCh = String(Math.max(rows.length, 1)).length + 1;
    for (let i = 0; i < rows.length; i++) {
        const row = document.createElement("div");
        row.className = "syfe-cm-cl";
        const n = document.createElement("span");
        n.className = "syfe-cm-cl-n";
        n.style.width = `${widthCh}ch`;
        n.textContent = String(i + 1);
        const c = document.createElement("span");
        c.className = "syfe-cm-cl-c";
        c.textContent = rows[i].source;
        row.append(n, c);
        el.appendChild(row);
    }
}

function buildResultRows(el: HTMLElement, rows: CalcRow[]): void {
    el.replaceChildren();
    for (const r of rows) {
        const out = document.createElement("div");
        out.className = "syfe-cm-calc-out-line" + (r.error ? " is-error" : r.result ? "" : " is-empty");
        out.textContent = r.result;
        el.appendChild(out);
    }
}

/** 渲染整块(阅读态)。结果列可选中复制,故阻断 mousedown 冒泡(Logseq 同款) */
export function renderCalc(sourceEl: HTMLElement, resultEl: HTMLElement, code: string): void {
    const rows = evalCalcLines(code);
    buildSourceRows(sourceEl, rows);
    buildResultRows(resultEl, rows);
}

/** 编辑态逐键刷新:源码行由内嵌 CM6 自己显示,只重建结果列 */
export function refreshCalcResults(resultEl: HTMLElement, code: string): void {
    buildResultRows(resultEl, evalCalcLines(code));
}

export function isCalcLang(lang: string): boolean {
    return String(lang || "").trim().toLowerCase() === "calc";
}
