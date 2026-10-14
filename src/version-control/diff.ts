// 行级文本差异(版本比较的基础)
//
// 算法分三层,按输入规模自动选择,目的是**在插件里永远不卡死**:
//   1. 先削掉首尾公共行(最常见的"改了几行"场景直接收敛);
//   2. 剩余规模在阈值内 → LCS 动态规划,结果是最小编辑脚本(最优解);
//   3. 规模超阈值(大文件)→ patience 锚点分治:取"在两侧都唯一出现的行"做锚点,
//      用 LIS 串成公共骨架,再对骨架之间的区间递归。最坏情况退化成整段替换,
//      但不会像全量 DP 那样吃掉几百 MB 内存。
//
// 输出是扁平的 DiffOp 序列(del 块恒在紧随的 add 块之前),渲染层再按
// 「并排 / 内联」两种视图各自组装 —— 见 toSideBySide。

export type DiffType = "equal" | "add" | "del";

export interface DiffOp {
    type: DiffType;
    text: string;
    /** 左侧(旧)行号,1-based;新增行为 0 */
    aLine: number;
    /** 右侧(新)行号,1-based;删除行为 0 */
    bLine: number;
}

// 并排视图的一行:左右两格各自可有可无(缺的一侧用占位空行撑住对齐)
export interface DiffRow {
    left?: {no: number; text: string; type: DiffType};
    right?: {no: number; text: string; type: DiffType};
}

// 内联视图的一行
export interface DiffInlineRow {
    no: number;      // 行号(add 用新行号,del 用旧行号,equal 两者相同)
    text: string;
    type: DiffType;
}

// LCS DP 的规模上限(a 行数 × b 行数):超过就走 patience 分治。
// 100 万格 × 4 字节 = 4MB,回溯也是同量级,实时交互无感。
const LCS_CELL_LIMIT = 1_000_000;
// 递归深度兜底:极端输入(几万行全不同)不至于把调用栈打满
const MAX_RECURSION = 64;

// 统一换行:Windows/Mac 老换行都归一成 \n,避免整文件被判为"全改"
export function splitLines(text: string): string[] {
    return String(text || "").replace(/\r\n?/g, "\n").split("\n");
}

// 对外入口:两个字符串 → 差异序列
export function diffText(a: string, b: string): DiffOp[] {
    return diffLines(splitLines(a), splitLines(b));
}

export function diffLines(aIn: string[], bIn: string[]): DiffOp[] {
    return diffRange(aIn, bIn, 0, aIn.length, 0, bIn.length, 0);
}

// 区间差异:a[aStart, aEnd) vs b[bStart, bEnd)
// 注意:削掉的公共前后缀也是结果的一部分(它们是 equal 行),必须一并输出
function diffRange(
    a: string[], b: string[],
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
    depth: number,
): DiffOp[] {
    const head: DiffOp[] = [];
    // 削公共前缀
    while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
        head.push({type: "equal", text: a[aStart], aLine: aStart + 1, bLine: bStart + 1});
        aStart++;
        bStart++;
    }
    // 削公共后缀(倒着收集,最后回正)
    const tail: DiffOp[] = [];
    while (aEnd > aStart && bEnd > bStart && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
        tail.push({type: "equal", text: a[aEnd], aLine: aEnd + 1, bLine: bEnd + 1});
    }
    tail.reverse();

    const mid = diffMiddle(a, b, aStart, aEnd, bStart, bEnd, depth);
    return head.concat(mid, tail);
}

// 已削掉公共前后缀后的"纯差异中段"
function diffMiddle(
    a: string[], b: string[],
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
    depth: number,
): DiffOp[] {
    const out: DiffOp[] = [];
    if (aStart === aEnd && bStart === bEnd) return out;
    if (aStart === aEnd) {
        for (let j = bStart; j < bEnd; j++) out.push({type: "add", text: b[j], aLine: 0, bLine: j + 1});
        return out;
    }
    if (bStart === bEnd) {
        for (let i = aStart; i < aEnd; i++) out.push({type: "del", text: a[i], aLine: i + 1, bLine: 0});
        return out;
    }

    const n = aEnd - aStart;
    const m = bEnd - bStart;

    if (n * m <= LCS_CELL_LIMIT) {
        return lcsRange(a, b, aStart, aEnd, bStart, bEnd);
    }
    if (depth >= MAX_RECURSION) {
        // 兜底:整段视为替换(先全删后全加)
        for (let i = aStart; i < aEnd; i++) out.push({type: "del", text: a[i], aLine: i + 1, bLine: 0});
        for (let j = bStart; j < bEnd; j++) out.push({type: "add", text: b[j], aLine: 0, bLine: j + 1});
        return out;
    }
    return patienceRange(a, b, aStart, aEnd, bStart, bEnd, depth);
}

// LCS 动态规划(区间内)
function lcsRange(
    a: string[], b: string[],
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
): DiffOp[] {
    const n = aEnd - aStart;
    const m = bEnd - bStart;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        const ai = a[aStart + i];
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = ai === b[bStart + j]
                ? dp[(i + 1) * w + j + 1] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const out: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[aStart + i] === b[bStart + j]) {
            // 公共行之前可能还压着 del/add,先按 del 优先吐出
            out.push({type: "equal", text: a[aStart + i], aLine: aStart + i + 1, bLine: bStart + j + 1});
            i++;
            j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            out.push({type: "del", text: a[aStart + i], aLine: aStart + i + 1, bLine: 0});
            i++;
        } else {
            out.push({type: "add", text: b[bStart + j], aLine: 0, bLine: bStart + j + 1});
            j++;
        }
    }
    while (i < n) {
        out.push({type: "del", text: a[aStart + i], aLine: aStart + i + 1, bLine: 0});
        i++;
    }
    while (j < m) {
        out.push({type: "add", text: b[bStart + j], aLine: 0, bLine: bStart + j + 1});
        j++;
    }
    // del 优先的双 while 可能产出 "add 后紧跟 del" 的相邻块,
    // 并排配对要求 del 块在前,这里做一次局部规整(只交换相邻的异类块)
    return normalizeOrder(out);
}

// 把相邻出现的 [add..., del...] 规整成 [del..., add...](渲染配对依赖这个顺序)
function normalizeOrder(ops: DiffOp[]): DiffOp[] {
    const out: DiffOp[] = [];
    let i = 0;
    while (i < ops.length) {
        if (ops[i].type !== "add") {
            out.push(ops[i]);
            i++;
            continue;
        }
        let j = i;
        while (j < ops.length && ops[j].type === "add") j++;
        let k = j;
        while (k < ops.length && ops[k].type === "del") k++;
        if (k === j) {
            // 后面不是 del,原样输出
            for (let t = i; t < j; t++) out.push(ops[t]);
        } else {
            for (let t = j; t < k; t++) out.push(ops[t]);   // del 先
            for (let t = i; t < j; t++) out.push(ops[t]);   // add 后
        }
        i = k > j ? k : j;
    }
    return out;
}

// patience 锚点分治(大文件)
function patienceRange(
    a: string[], b: string[],
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
    depth: number,
): DiffOp[] {
    // b 区间内出现次数为 1 的行 → 行号
    const countB = new Map<string, number>();
    for (let j = bStart; j < bEnd; j++) {
        countB.set(b[j], (countB.get(b[j]) || 0) + 1);
    }
    const uniqB = new Map<string, number>();
    for (let j = bStart; j < bEnd; j++) {
        if (countB.get(b[j]) === 1) uniqB.set(b[j], j);
    }
    // a 区间内命中"唯一行"的行 → 候选锚点(值 = 对应 b 下标)
    const seq: number[] = [];
    const ais: number[] = [];
    for (let i = aStart; i < aEnd; i++) {
        const j = uniqB.get(a[i]);
        if (j !== undefined) {
            seq.push(j);
            ais.push(i);
        }
    }
    if (seq.length === 0) {
        const out: DiffOp[] = [];
        for (let i = aStart; i < aEnd; i++) out.push({type: "del", text: a[i], aLine: i + 1, bLine: 0});
        for (let j = bStart; j < bEnd; j++) out.push({type: "add", text: b[j], aLine: 0, bLine: j + 1});
        return out;
    }
    // LIS(严格递增):锚点骨架
    const lisIdx = longestIncreasingSubsequence(seq);
    const out: DiffOp[] = [];
    let pa = aStart;
    let pb = bStart;
    for (const k of lisIdx) {
        const ai = ais[k];
        const bj = seq[k];
        out.push(...diffRange(a, b, pa, ai, pb, bj, depth + 1));
        out.push({type: "equal", text: a[ai], aLine: ai + 1, bLine: bj + 1});
        pa = ai + 1;
        pb = bj + 1;
    }
    out.push(...diffRange(a, b, pa, aEnd, pb, bEnd, depth + 1));
    return out;
}

// 最长严格递增子序列(返回原数组下标)
function longestIncreasingSubsequence(values: number[]): number[] {
    const n = values.length;
    // tails[k] = 长度为 k+1 的递增子序列的**最小末尾值**所在下标
    const tails: number[] = [];
    const prev: number[] = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        let lo = 0;
        let hi = tails.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (values[tails[mid]] < values[i]) lo = mid + 1;
            else hi = mid - 1;
        }
        if (lo > 0) prev[i] = tails[lo - 1];
        if (lo < tails.length) tails[lo] = i;
        else tails.push(i);
    }
    const out: number[] = [];
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (k >= 0) {
        out.push(k);
        k = prev[k];
    }
    return out.reverse();
}

// 差异序列 → 并排行对:把相邻的 del 块与 add 块配成对,左右各占一格
export function toSideBySide(ops: DiffOp[]): DiffRow[] {
    const rows: DiffRow[] = [];
    let i = 0;
    while (i < ops.length) {
        const op = ops[i];
        if (op.type === "equal") {
            rows.push({
                left: {no: op.aLine, text: op.text, type: "equal"},
                right: {no: op.bLine, text: op.text, type: "equal"},
            });
            i++;
            continue;
        }
        // 收集一段非 equal 块
        const dels: DiffOp[] = [];
        const adds: DiffOp[] = [];
        let j = i;
        while (j < ops.length && ops[j].type === "del") dels.push(ops[j++]);
        while (j < ops.length && ops[j].type === "add") adds.push(ops[j++]);
        // patience/LCS 都可能产出 add 块后紧跟 del 块(下一个改动区),
        // 这种情况下当前块只有 add
        if (dels.length === 0 && adds.length === 0) {
            // 理论不可达(非 equal 必属两者之一);防死循环
            i = j + 1;
            continue;
        }
        const len = Math.max(dels.length, adds.length);
        for (let k = 0; k < len; k++) {
            const d = dels[k];
            const ad = adds[k];
            rows.push({
                ...(d ? {left: {no: d.aLine, text: d.text, type: "del"}} : {}),
                ...(ad ? {right: {no: ad.bLine, text: ad.text, type: "add"}} : {}),
            });
        }
        i = j;
    }
    return rows;
}

// 差异序列 → 内联行
export function toInline(ops: DiffOp[]): DiffInlineRow[] {
    return ops.map(op => ({
        no: op.type === "del" ? op.aLine : op.bLine,
        text: op.text,
        type: op.type,
    }));
}

// 统计:新增行数 / 删除行数 / 变更块数(给 UI 显示"共 N 处改动")
export function diffStats(ops: DiffOp[]): {added: number; removed: number; blocks: number} {
    let added = 0;
    let removed = 0;
    let blocks = 0;
    let inBlock = false;
    for (const op of ops) {
        if (op.type === "equal") {
            inBlock = false;
            continue;
        }
        if (op.type === "add") added++;
        else removed++;
        if (!inBlock) {
            blocks++;
            inBlock = true;
        }
    }
    return {added, removed, blocks};
}
