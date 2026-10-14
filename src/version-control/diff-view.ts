// 版本比较的视图层:取两侧内容 → 算差异 → 渲染(并排/内联)
//
// 比较的两侧都用 SideId 表示:
//   "current" = 编辑器里/磁盘上的当前内容(动态,每次比较重新取)
//   number    = 某条历史版本的时间戳(版本列表里 time 唯一,比下标稳:
//               新快照 unshift 进列表也不会让页签里选中的版本错位)
//
// 渲染共用:历史版本对话框(version-ui.ts)与独立比较页签(tabs/diff-tab.ts)
// 都调这里,保证两处看到的差异完全一致。

import {readTextFile} from "../api/file";
import {peekModel} from "../editor/model-manager";
import {getVersions} from "./file-versions";
import {diffText, toSideBySide, toInline, diffStats, type DiffOp, type DiffRow, type DiffInlineRow} from "./diff";

export type SideId = number | "current";
export type DiffMode = "inline" | "side";

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fmtTime(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// 下拉选项:当前内容 + 全部历史版本(最新在前)
export interface VersionOption {
    id: SideId;
    label: string;
}

export function versionOptions(path: string): VersionOption[] {
    const opts: VersionOption[] = [{id: "current", label: "当前内容"}];
    for (const v of getVersions(path)) {
        opts.push({id: v.time, label: `${fmtTime(v.time)} · ${fmtSize(v.size)}`});
    }
    return opts;
}

// 取一侧内容。"current" 优先取编辑器里的模型(含未保存修改),文件没打开才读盘
export async function loadSide(path: string, id: SideId): Promise<string> {
    if (id === "current") {
        const model = peekModel(path);
        if (model) return model.getValue();
        try {
            return await readTextFile(path);
        } catch {
            return "";
        }
    }
    const v = getVersions(path).find(x => x.time === id);
    return v ? v.content : "";
}

// 单侧内容的标题(下拉里已选中项的短标签,给页签标题/提示用)
export function sideLabel(path: string, id: SideId): string {
    if (id === "current") return "当前内容";
    const v = getVersions(path).find(x => x.time === id);
    return v ? fmtTime(v.time) : "已删除的版本";
}

export interface DiffResult {
    ops: DiffOp[];
    added: number;
    removed: number;
    blocks: number;
    leftEmpty: boolean;
    rightEmpty: boolean;
}

// 算差异(两侧内容都在这里取,调用方不需要关心来源)
export async function computeDiff(path: string, left: SideId, right: SideId): Promise<DiffResult> {
    const [a, b] = await Promise.all([loadSide(path, left), loadSide(path, right)]);
    const ops = diffText(a, b);
    const st = diffStats(ops);
    return {
        ops,
        added: st.added,
        removed: st.removed,
        blocks: st.blocks,
        leftEmpty: a.length === 0,
        rightEmpty: b.length === 0,
    };
}

// 一次渲染的最大行数:超大文件的 DOM 会把思源拖垮,超了就截断并提示
const MAX_RENDER_ROWS = 4000;

function rowTextCell(no: number, text: string, type: string): string {
    return `<span class="syfe-diff__no">${no || ""}</span><span class="syfe-diff__text">${escapeHTML(text)}</span>`;
}

function sideRowHTML(rows: DiffRow[]): string {
    return rows.map(r => {
        const l = r.left;
        const rr = r.right;
        const leftCls = l ? `syfe-diff__cell syfe-diff__cell--${l.type}` : "syfe-diff__cell syfe-diff__cell--empty";
        const rightCls = rr ? `syfe-diff__cell syfe-diff__cell--${rr.type}` : "syfe-diff__cell syfe-diff__cell--empty";
        const lText = l ? rowTextCell(l.no, l.text, l.type) : "";
        const rText = rr ? rowTextCell(rr.no, rr.text, rr.type) : "";
        return `<div class="syfe-diff__row"><div class="${leftCls}">${lText}</div><div class="${rightCls}">${rText}</div></div>`;
    }).join("");
}

function inlineRowHTML(rows: DiffInlineRow[]): string {
    return rows.map(r => {
        const sign = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
        return `<div class="syfe-diff__row syfe-diff__row--${r.type}"><span class="syfe-diff__sign">${sign}</span>${rowTextCell(r.no, r.text, r.type)}</div>`;
    }).join("");
}

// 把差异渲染进容器。
// onlyChanges = 只看改动行(equal 行整段滤掉),大文件定位改动时很有用。
// 返回被截断的行数(0 = 完整渲染),调用方据此提示用户。
export function renderDiff(
    container: HTMLElement,
    res: DiffResult,
    mode: DiffMode,
    onlyChanges: boolean,
): number {
    const ops = onlyChanges ? res.ops.filter(o => o.type !== "equal") : res.ops;
    let truncated = 0;
    if (mode === "side") {
        let rows = toSideBySide(ops);
        if (rows.length > MAX_RENDER_ROWS) {
            truncated = rows.length - MAX_RENDER_ROWS;
            rows = rows.slice(0, MAX_RENDER_ROWS);
        }
        container.innerHTML = `<div class="syfe-diff syfe-diff--side">${sideRowHTML(rows)}</div>`;
    } else {
        let rows = toInline(ops);
        if (rows.length > MAX_RENDER_ROWS) {
            truncated = rows.length - MAX_RENDER_ROWS;
            rows = rows.slice(0, MAX_RENDER_ROWS);
        }
        container.innerHTML = `<div class="syfe-diff syfe-diff--inline">${inlineRowHTML(rows)}</div>`;
    }
    return truncated;
}

// 统计文案:"共 3 处改动(+5 -2)"
export function statsText(res: DiffResult): string {
    if (res.blocks === 0) return "两侧内容一致";
    return `共 ${res.blocks} 处改动(+${res.added} -${res.removed})`;
}
