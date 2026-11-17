// CM6 Markdown 表格可视化编辑:单元格级导航 + 行列结构操作 + 管道对齐。
//
// 语义参考:
//  - Obsidian Table Editor:Tab/Enter 在单元格间移动、行尾 Tab/末行 Enter 自动加行;
//    结构操作整表重排(按列宽对齐管道),单事务一步撤销。
//  - SilverBullet(源码↔渲染切换):光标进表格 → 源码态编辑,出表格 → 卡片渲染
//    (源码态恢复在 cm6-render.ts 的表格分支,本文件只提供导航与结构操作)。
//  - Logseq shui table v2:焦点环绕规则只作视觉参考,这里按 Obsidian 惯例实现。
//
// 编辑模型:单元格编辑永远是普通文本事务(不做 widget 编辑态),结构操作 =
// 解析整表 → 改单元格矩阵 → 按列宽对齐重排 → 单事务整表替换。
//
// 语法层(与 cm6-render.ts 的 renderGfmTable 同一语义,保证导航与渲染一致):
//  - `\|` 转义管道不是分隔符;
//  - 反引号行内码内的 `|` 不是分隔符;
//  - 行内公式($…$ / $$…$$ / \(…\))内的 `|` 不是分隔符
//    (货币误判防护同 renderGfmTable:闭合符后不能紧跟字母数字)。
//
// 定位入口:结构命令均支持 at?(行内任意位置)——行菜单对指定行操作时传入该行,
// 键位命令不传(用当前光标)。

import {EditorSelection, EditorState, Extension, Prec} from "@codemirror/state";
import {EditorView, keymap} from "@codemirror/view";

const RE_TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;

// ===== 表格块定位 =====

export interface TableBlock {
    /** 首行/末行行号(1-based,含) */
    fromLine: number;
    toLine: number;
    from: number;
    to: number;
}

/** 光标/指定位置所在的顶层表格块(与 cm6-render 的块扫描同语义:首行 0 缩进 + 连续管道行) */
export function tableAt(state: EditorState, pos: number): TableBlock | null {
    const doc = state.doc;
    const ln = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
    if (!RE_TABLE_ROW.test(ln.text)) return null;
    let head = ln.number;
    while (head > 1 && RE_TABLE_ROW.test(doc.line(head - 1).text)) head--;
    let tail = ln.number;
    while (tail + 1 <= doc.lines && RE_TABLE_ROW.test(doc.line(tail + 1).text)) tail++;
    // 与渲染器一致:首行必须 0 缩进,否则那张"表"不会被渲染成卡片,编辑也不该接管
    if (/^\s{1,}/.test(doc.line(head).text)) return null;
    return {fromLine: head, toLine: tail, from: doc.line(head).from, to: doc.line(tail).to};
}

/** 行内公式闭合位置(带货币误判防护,语义对齐 cm6-render 的 findMathClose) */
function findMathCloseIdx(text: string, from: number, close: string): number {
    let at = from;
    while ((at = text.indexOf(close, at)) >= 0) {
        const tex = text.slice(from, at).trim();
        const after = text[at + close.length] ?? "";
        if (tex && !/[\w]/.test(after)) return at;
        at += close.length;
    }
    return -1;
}

export interface CellRange {
    /** 原始片段区间(行内偏移,含首尾空格) */
    start: number;
    end: number;
    /** trim 后内容的区间(导航落点用) */
    cStart: number;
    cEnd: number;
    /** trim 后的原始文本(含转义/定界符,写回时不二次处理) */
    text: string;
}

/**
 * 单行表格行的单元格区间(行内偏移)。管道语义:排除 `\|` 转义、反引号行内码、
 * 行内公式($…$ / $$…$$ / \(…\));真分隔管道不足一对 → null(不是表格行)。
 */
export function cellRanges(line: string): CellRange[] | null {
    const n = line.length;
    const seps: number[] = [];
    let i = 0;
    let codeTicks = 0; // 0=不在行内码;否则为开启定界符的反引号长度
    let mathClose: string | null = null;
    while (i < n) {
        if (mathClose) {
            if (line.startsWith(mathClose, i)) { i += mathClose.length; mathClose = null; continue; }
            i++;
            continue;
        }
        const ch = line[i];
        if (ch === "\\") { i += 2; continue; } // 转义连同伴字符整体跳过(\|、\$、\\)
        if (ch === "`") {
            let len = 1;
            while (line[i + len] === "`") len++;
            if (!codeTicks) { codeTicks = len; }
            else if (len === codeTicks) { codeTicks = 0; }
            i += len;
            continue;
        }
        if (ch === "$") {
            const closer = line.startsWith("$$", i) ? "$$" : "$";
            const close = findMathCloseIdx(line, i + closer.length, closer);
            if (close >= 0) { mathClose = closer; i = i + closer.length; continue; }
            i += closer.length;
            continue;
        }
        if (line.startsWith("\\(", i)) {
            const close = line.indexOf("\\)", i + 2);
            if (close >= 0) { i = close + 2; continue; }
        }
        if (ch === "|") seps.push(i);
        i++;
    }
    if (seps.length < 2) return null;
    const out: CellRange[] = [];
    for (let k = 0; k + 1 < seps.length; k++) {
        const start = seps[k] + 1;
        const end = seps[k + 1];
        const raw = line.slice(start, end);
        const cutL = raw.length - raw.trimStart().length;
        const cutR = raw.length - raw.trimEnd().length;
        out.push({start, end, cStart: start + cutL, cEnd: end - cutR, text: raw.trim()});
    }
    return out.length ? out : null;
}

// ===== 表格模型 =====

type Align = "left" | "center" | "right" | null;

interface TableModel {
    /** 单元格文本矩阵(第 0 行 = 表头;分隔行不在矩阵里) */
    rows: string[][];
    /** 列对齐(来自分隔行) */
    aligns: Align[];
    /** 表行前导缩进(顶层表格为空串) */
    indent: string;
    /** 原 sep 行是否有首/尾管道(写回时保持习惯) */
    sepLeadPipe: boolean;
    sepTrailPipe: boolean;
}

function parseAlignCell(s: string): Align {
    const t = s.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    if (t.startsWith(":")) return "left";
    return null;
}

function parseTableModel(lines: string[]): TableModel | null {
    if (lines.length < 2) return null;
    const header = cellRanges(lines[0]);
    const sep = cellRanges(lines[1]);
    if (!header || !sep) return null;
    const cols = header.length;
    const aligns: Align[] = [];
    for (let c = 0; c < cols; c++) aligns.push(parseAlignCell(sep[c]?.text || "---"));
    const rows: string[][] = [header.map((c) => c.text)];
    for (let r = 2; r < lines.length; r++) {
        const cr = cellRanges(lines[r]);
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) cells.push(cr?.[c]?.text ?? "");
        rows.push(cells);
    }
    const sepTrim = lines[1].trim();
    const indentM = /^(\s*)/.exec(lines[0]);
    return {
        rows,
        aligns,
        indent: indentM ? indentM[1] : "",
        sepLeadPipe: sepTrim.startsWith("|"),
        sepTrailPipe: sepTrim.endsWith("|") && !sepTrim.endsWith("\\|"),
    };
}

/** 写回时的单元格文本清洗:换行压成空格、管道转义(单元格是单行实体) */
function cellOut(text: string): string {
    return String(text || "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function serializeTable(m: TableModel, pad: boolean): string[] {
    const cols = m.aligns.length;
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
        let w = 3;
        for (const row of m.rows) w = Math.max(w, cellOut(row[c]).length);
        widths.push(w);
    }
    const padCell = (text: string, c: number): string => {
        const t = cellOut(text);
        if (!pad) return t;
        const a = m.aligns[c];
        if (a === "right") return t.padStart(widths[c]);
        if (a === "center") {
            const total = widths[c];
            const l = Math.floor((total - t.length) / 2);
            return " ".repeat(l) + t + " ".repeat(total - t.length - l);
        }
        return t.padEnd(widths[c]);
    };
    const lines: string[] = [];
    for (let r = 0; r < m.rows.length; r++) {
        lines.push(m.indent + "| " + m.rows[r].map((_, c) => padCell(m.rows[r][c], c)).join(" | ") + " |");
        if (r === 0) {
            // 分隔行:对齐符按列宽展开(保证 ≥3 个连字符)
            const sepCells = m.aligns.map((a, c) => {
                const w = Math.max(3, widths[c]);
                if (a === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
                if (a === "right") return "-".repeat(Math.max(2, w - 1)) + ":";
                if (a === "left") return ":" + "-".repeat(Math.max(2, w - 1));
                return "-".repeat(w);
            });
            const lead = m.sepLeadPipe ? "|" : "";
            const trail = m.sepTrailPipe ? "|" : "";
            lines.push(m.indent + lead + sepCells.join("|") + trail);
        }
    }
    return lines;
}

// ===== 单元格定位 =====

/** 指定行(物理行号)的矩阵行序:0=header,1..n=body(跳过 sep 行) */
function matrixRowOf(tb: TableBlock, lineNo: number): number {
    if (lineNo === tb.fromLine) return 0;
    return lineNo - tb.fromLine - 1;
}

/** 逻辑行(跳过 sep)物理行号列表:0=header,1..=body */
function logicalRows(tb: TableBlock): number[] {
    const out: number[] = [tb.fromLine];
    for (let n = tb.fromLine + 2; n <= tb.toLine; n++) out.push(n);
    return out;
}

/** 光标/指定位置所在单元格 (row, col) 与内容区间(doc 坐标) */
function locateCell(state: EditorState, tb: TableBlock, pos: number): {row: number; col: number; cStart: number; cEnd: number} | null {
    const doc = state.doc;
    const ln = doc.lineAt(pos);
    const cells = cellRanges(ln.text);
    if (!cells) return null;
    const off = pos - ln.from;
    let col = cells.findIndex((c) => off >= c.start && off <= c.end);
    if (col < 0) {
        // 光标落在管道分隔符上:按其后半格归属
        col = Math.max(0, cells.findIndex((c) => off < c.start) - 1);
    }
    return {
        row: matrixRowOf(tb, ln.number),
        col,
        cStart: ln.from + cells[col].cStart,
        cEnd: ln.from + cells[col].cEnd,
    };
}

/** 某逻辑行(row:0=header,1..=body)某列的内容起点 doc 坐标;不可用返回 -1 */
export function cellSourcePos(state: EditorState, tb: TableBlock, row: number, col: number): number {
    const doc = state.doc;
    const lineNo = row === 0 ? tb.fromLine : tb.fromLine + row + 1;
    if (lineNo < tb.fromLine || lineNo > tb.toLine) return -1;
    const line = doc.line(lineNo);
    const cells = cellRanges(line.text);
    if (!cells) return -1;
    const idx = Math.min(Math.max(0, col), cells.length - 1);
    return line.from + cells[idx].cStart;
}

function moveCursor(view: EditorView, anchor: number): void {
    view.dispatch({selection: EditorSelection.single(anchor), scrollIntoView: true});
}

function linesOf(state: EditorState, tb: TableBlock): string[] {
    const out: string[] = [];
    for (let n = tb.fromLine; n <= tb.toLine; n++) out.push(state.doc.line(n).text);
    return out;
}

/** 整表替换 + 光标落到新矩阵 (row, col) 格内容起点 */
function replaceTable(view: EditorView, tb: TableBlock, model: TableModel, pad: boolean, target?: {row: number; col: number}): void {
    const lines = serializeTable(model, pad);
    const oldDoc = view.state.doc;
    const from = oldDoc.line(tb.fromLine).from;
    const to = oldDoc.line(tb.toLine).to;
    view.dispatch({
        changes: {from, to, insert: lines.join("\n")},
        selection: EditorSelection.single(to), // 占位:下方按新文档重算
        scrollIntoView: true,
        userEvent: "input",
    });
    if (target) {
        // 替换后表格首行行号不变;物理行 = header(0) → fromLine,body r → fromLine + r + 1(sep 在其后)
        const lineNo = target.row === 0 ? tb.fromLine : tb.fromLine + target.row + 1;
        const nl = view.state.doc.line(Math.min(lineNo, view.state.doc.lines));
        const cells = cellRanges(nl.text);
        const idx = Math.min(Math.max(0, target.col), (cells?.length ?? 1) - 1);
        const anchor = nl.from + (cells?.[idx]?.cStart ?? nl.text.length);
        view.dispatch({selection: EditorSelection.single(anchor), scrollIntoView: true});
    } else {
        view.dispatch({selection: EditorSelection.single(view.state.doc.line(tb.fromLine).from), scrollIntoView: true});
    }
}

// ===== 导航命令(键位;用当前光标) =====

/** Tab:下一单元格;行末格 → 下一行首格;末行末格 → 追加一行再进入 */
export function tableTabCommand(view: EditorView): boolean {
    const state = view.state;
    if (!state.selection.main.empty) return false;
    const tb = tableAt(state, state.selection.main.head);
    if (!tb || tb.toLine - tb.fromLine < 1) return false;
    const cur = locateCell(state, tb, state.selection.main.head);
    if (!cur) return false;
    const doc = state.doc;
    const line = doc.lineAt(state.selection.main.head);
    const cells = cellRanges(line.text);
    if (!cells) return false;
    const isSep = line.number === tb.fromLine + 1;
    const logical = logicalRows(tb);
    const rowIdx = isSep ? 0 : logical.indexOf(line.number);
    // 同行右移
    if (!isSep && cur.col + 1 < cells.length) {
        moveCursor(view, cells[cur.col + 1].cStart);
        return true;
    }
    // 下一行首格
    if (rowIdx + 1 < logical.length) {
        const target = doc.line(logical[rowIdx + 1]);
        const tc = cellRanges(target.text);
        if (tc) { moveCursor(view, target.from + tc[0].cStart); return true; }
    }
    // 末行:追加一行并进入首格
    return appendRow(view, state, tb, cur.col);
}

/** Shift+Tab:上一单元格(内容尾);行首格 → 上一行末格;表头首格吞键 */
export function tableShiftTabCommand(view: EditorView): boolean {
    const state = view.state;
    if (!state.selection.main.empty) return false;
    const tb = tableAt(state, state.selection.main.head);
    if (!tb || tb.toLine - tb.fromLine < 1) return false;
    const cur = locateCell(state, tb, state.selection.main.head);
    if (!cur) return false;
    const doc = state.doc;
    const line = doc.lineAt(state.selection.main.head);
    const cells = cellRanges(line.text);
    if (!cells) return false;
    const isSep = line.number === tb.fromLine + 1;
    const logical = logicalRows(tb);
    const rowIdx = isSep ? 0 : logical.indexOf(line.number);
    if (!isSep && cur.col > 0) {
        moveCursor(view, cells[cur.col - 1].cEnd);
        return true;
    }
    if (rowIdx > 0) {
        const target = doc.line(logical[rowIdx - 1]);
        const tc = cellRanges(target.text);
        if (tc) { moveCursor(view, target.from + tc[tc.length - 1].cEnd); return true; }
    }
    return true; // 表头首格:吞键(避免回落到列表缩进误伤表格)
}

/** Enter:同列下一行;末行 → 追加一行。选区非空不接管 */
export function tableEnterCommand(view: EditorView): boolean {
    const state = view.state;
    if (!state.selection.main.empty) return false;
    const tb = tableAt(state, state.selection.main.head);
    if (!tb || tb.toLine - tb.fromLine < 1) return false;
    const cur = locateCell(state, tb, state.selection.main.head);
    if (!cur) return false;
    const doc = state.doc;
    const line = doc.lineAt(state.selection.main.head);
    const isSep = line.number === tb.fromLine + 1;
    const logical = logicalRows(tb);
    const rowIdx = isSep ? 0 : logical.indexOf(line.number);
    if (rowIdx + 1 < logical.length) {
        const target = doc.line(logical[rowIdx + 1]);
        const tc = cellRanges(target.text);
        if (tc) {
            const c = tc[Math.min(cur.col, tc.length - 1)];
            moveCursor(view, target.from + c.cStart);
            return true;
        }
    }
    return appendRow(view, state, tb, cur.col);
}

/** 表尾追加空行,光标落到第 col 格内容起点 */
function appendRow(view: EditorView, state: EditorState, tb: TableBlock, col: number): boolean {
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const rows = [...model.rows, new Array(model.aligns.length).fill("")];
    const lines = serializeTable({...model, rows}, true);
    const newLineText = lines[lines.length - 1];
    const insertFrom = state.doc.line(tb.toLine).to;
    view.dispatch({
        changes: {from: insertFrom, insert: "\n" + newLineText},
        selection: EditorSelection.single(insertFrom + 1 + newLineText.length - 2),
        scrollIntoView: true,
        userEvent: "input",
    });
    return true;
}

/** 方向键上/下:同列移动(按单元格列号,保留列内相对偏移);表格边界 return false */
function tableArrowCommand(view: EditorView, dir: -1 | 1): boolean {
    const state = view.state;
    if (!state.selection.main.empty) return false;
    const tb = tableAt(state, state.selection.main.head);
    if (!tb || tb.toLine - tb.fromLine < 1) return false;
    const cur = locateCell(state, tb, state.selection.main.head);
    if (!cur) return false;
    const doc = state.doc;
    const line = doc.lineAt(state.selection.main.head);
    const isSep = line.number === tb.fromLine + 1;
    const logical = logicalRows(tb);
    const rowIdx = isSep ? 0 : logical.indexOf(line.number);
    const nextIdx = rowIdx + dir;
    if (nextIdx < 0 || nextIdx >= logical.length) return false; // 表格边界:交给默认行为
    const target = doc.line(logical[nextIdx]);
    const tc = cellRanges(target.text);
    if (!tc) return false;
    const col = Math.min(cur.col, tc.length - 1);
    const cell = tc[col];
    const curCells = cellRanges(line.text);
    const curCell = curCells?.[Math.min(cur.col, (curCells?.length ?? 1) - 1)];
    const rel = curCell ? state.selection.main.head - curCell.cStart : 0;
    const offset = Math.max(cell.cStart, Math.min(cell.cEnd, cell.cStart + Math.max(0, rel)));
    moveCursor(view, target.from + offset);
    return true;
}

export function tableArrowUpCommand(view: EditorView): boolean {
    return tableArrowCommand(view, -1);
}

export function tableArrowDownCommand(view: EditorView): boolean {
    return tableArrowCommand(view, 1);
}

// ===== 结构命令(整表重排;at 指定操作锚点行,缺省用光标) =====

function cmdPos(state: EditorState, at?: number): number {
    if (at !== undefined) return at;
    return state.selection.main.head;
}

export function tableInsertColumnLeft(view: EditorView, at?: number): boolean {
    return newColumn(view, -1, at);
}

export function tableInsertColumnRight(view: EditorView, at?: number): boolean {
    return newColumn(view, 1, at);
}

function newColumn(view: EditorView, side: -1 | 1, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const cur = locateCell(state, tb, pos);
    const col = Math.max(0, Math.min((cur?.col ?? 0) + (side === 1 ? 1 : 0), model.aligns.length - 1));
    const insertAt = side === 1 ? col + 1 : col;
    const rows = model.rows.map((r) => {
        const nr = [...r];
        nr.splice(insertAt, 0, "");
        return nr;
    });
    const aligns = [...model.aligns];
    aligns.splice(insertAt, 0, null);
    replaceTable(view, tb, {...model, rows, aligns}, true, {row: matrixRowOf(tb, state.doc.lineAt(pos).number), col: insertAt});
    return true;
}

export function tableDeleteColumn(view: EditorView, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    if (model.aligns.length <= 1) return false; // 只剩一列:不可删
    const cur = locateCell(state, tb, pos);
    const col = Math.max(0, Math.min(cur?.col ?? 0, model.aligns.length - 1));
    const rows = model.rows.map((r) => r.filter((_, c) => c !== col));
    const aligns = model.aligns.filter((_, c) => c !== col);
    replaceTable(view, tb, {...model, rows, aligns}, true);
    return true;
}

export function tableMoveColumnLeft(view: EditorView, at?: number): boolean {
    return moveColumn(view, -1, at);
}

export function tableMoveColumnRight(view: EditorView, at?: number): boolean {
    return moveColumn(view, 1, at);
}

function moveColumn(view: EditorView, dir: -1 | 1, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const cur = locateCell(state, tb, pos);
    const col = Math.max(0, Math.min(cur?.col ?? 0, model.aligns.length - 1));
    const swap = col + dir;
    if (swap < 0 || swap >= model.aligns.length) return false;
    const rows = model.rows.map((r) => {
        const nr = [...r];
        [nr[col], nr[swap]] = [nr[swap], nr[col]];
        return nr;
    });
    const aligns = [...model.aligns];
    [aligns[col], aligns[swap]] = [aligns[swap], aligns[col]];
    replaceTable(view, tb, {...model, rows, aligns}, true, {row: matrixRowOf(tb, state.doc.lineAt(pos).number), col: swap});
    return true;
}

export function tableInsertRowAbove(view: EditorView, at?: number): boolean {
    return insertRow(view, -1, at);
}

export function tableInsertRowBelow(view: EditorView, at?: number): boolean {
    return insertRow(view, 1, at);
}

function insertRow(view: EditorView, side: -1 | 1, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const mRow = matrixRowOf(tb, state.doc.lineAt(pos).number);
    if (mRow === 0 && side === -1) return false; // 表头上不可插行
    const insertAt = mRow === 0 ? 1 : mRow + (side === 1 ? 1 : 0);
    const rows = [...model.rows];
    rows.splice(insertAt, 0, new Array(model.aligns.length).fill(""));
    replaceTable(view, tb, {...model, rows}, true, {row: insertAt, col: 0});
    return true;
}

export function tableDeleteRow(view: EditorView, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const mRow = matrixRowOf(tb, state.doc.lineAt(pos).number);
    if (mRow === 0) return false; // 表头不可删(删整表走卡片菜单)
    const rows = model.rows.filter((_, r) => r !== mRow);
    replaceTable(view, tb, {...model, rows}, true, mRow - 1 >= 0 ? {row: mRow - 1, col: 0} : undefined);
    return true;
}

export function tableMoveRowUp(view: EditorView, at?: number): boolean {
    return moveRow(view, -1, at);
}

export function tableMoveRowDown(view: EditorView, at?: number): boolean {
    return moveRow(view, 1, at);
}

function moveRow(view: EditorView, dir: -1 | 1, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    const mRow = matrixRowOf(tb, state.doc.lineAt(pos).number);
    const swap = mRow + dir;
    if (mRow <= 0 || swap <= 0 || swap >= model.rows.length) return false; // 表头固定
    const rows = [...model.rows];
    [rows[mRow], rows[swap]] = [rows[swap], rows[mRow]];
    replaceTable(view, tb, {...model, rows}, true, {row: swap, col: 0});
    return true;
}

/** 整表按列宽对齐重排(对齐符语义保留;SilverBullet Table: Format 同款行为) */
export function tableFormatCommand(view: EditorView, at?: number): boolean {
    const state = view.state;
    const pos = cmdPos(state, at);
    const tb = tableAt(state, pos);
    if (!tb) return false;
    const model = parseTableModel(linesOf(state, tb));
    if (!model) return false;
    replaceTable(view, tb, model, true);
    return true;
}

/** 插入表格骨架。at = 行号时插在该行后;否则插在光标处。光标落表头首格 */
export function tableInsertCommand(view: EditorView, at?: number): boolean {
    const state = view.state;
    const skeleton = ["| 列 1 | 列 2 | 列 3 |", "| --- | --- | --- |", "|  |  |  |", "|  |  |  |"];
    let from: number;
    let lead: string;
    if (at !== undefined) {
        const line = state.doc.line(at);
        from = line.to;
        lead = "\n";
    } else {
        const line = state.doc.lineAt(state.selection.main.head);
        from = state.selection.main.head;
        lead = line.text.trim() === "" ? "" : "\n";
    }
    view.dispatch({
        changes: {from, insert: lead + skeleton.join("\n")},
        selection: EditorSelection.single(from + lead.length + 2),
        scrollIntoView: true,
        userEvent: "input",
    });
    return true;
}

// ===== 扩展装配 =====

/** 粘贴 HTML 表格 / TSV(Excel、网页表格)→ markdown 管道表。光标在表格内时不接管 */
function pasteAsTable(view: EditorView, event: ClipboardEvent): boolean {
    const state = view.state;
    if (state.readOnly) return false;
    if (tableAt(state, state.selection.main.head)) return false;
    const dt = event.clipboardData;
    if (!dt) return false;
    const html = dt.getData("text/html") || "";
    const plain = dt.getData("text/plain") || "";
    let rows: string[][] | null = null;
    if (/<table[\s>]/i.test(html)) {
        try {
            const dom = new DOMParser().parseFromString(html, "text/html");
            const trs = Array.from(dom.querySelectorAll("tr"));
            const parsed = trs
                .map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent || "").replace(/\s*\n\s*/g, " ").trim()))
                .filter((cells) => cells.length > 0);
            const cols = Math.max(0, ...parsed.map((r) => r.length));
            if (parsed.length >= 1 && cols >= 2) {
                rows = parsed.map((r) => {
                    const out = r.slice(0, cols);
                    while (out.length < cols) out.push("");
                    return out;
                });
            }
        } catch { /* HTML 解析失败回落纯文本 */ }
    }
    if (!rows) {
        // TSV:有 tab 且 ≥2 列(Excel/Sheets 复制是 tab 分隔)
        const lines = plain.replace(/\r/g, "").split("\n").filter((l) => l !== "");
        if (lines.length >= 1 && lines.some((l) => l.includes("\t"))) {
            const parsed = lines.map((l) => l.split("\t").map((c) => c.trim()));
            const cols = Math.max(0, ...parsed.map((r) => r.length));
            if (cols >= 2) {
                rows = parsed.map((r) => {
                    const out = r.slice(0, cols);
                    while (out.length < cols) out.push("");
                    return out;
                });
            }
        }
    }
    if (!rows) return false;
    const aligns: Align[] = rows[0].map(() => null);
    const model: TableModel = {rows, aligns, indent: "", sepLeadPipe: true, sepTrailPipe: true};
    const tableLines = serializeTable(model, false);
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const atLineEnd = pos >= line.to;
    const lead = line.text.trim() === "" ? "" : "\n";
    const insert = lead + tableLines.join("\n") + (atLineEnd ? "" : "\n");
    view.dispatch({
        changes: {from: pos, insert},
        selection: EditorSelection.single(pos + lead.length + 2),
        scrollIntoView: true,
        userEvent: "input.paste",
    });
    return true;
}

/** 表格可视化编辑扩展:单元格导航键位 + 粘贴表格转换。只读态命令自然穿透 */
export function cm6TableKeymap(): Extension {
    return [
        Prec.high(keymap.of([
            {key: "Tab", run: tableTabCommand},
            {key: "Shift-Tab", run: tableShiftTabCommand},
            {key: "Enter", run: tableEnterCommand},
            {key: "ArrowUp", run: tableArrowUpCommand},
            {key: "ArrowDown", run: tableArrowDownCommand},
        ])),
        EditorView.domEventHandlers({
            paste: (event, view) => pasteAsTable(view, event),
        }),
    ];
}
