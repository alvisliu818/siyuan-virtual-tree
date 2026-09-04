import "x-data-spreadsheet/dist/xspreadsheet.css";
import {readBinaryFile, readTextFile, writeBinaryFile, writeFile} from "../api/file";
import {getExt} from "../constants";
import {OfficeEngine} from "./types";

// 表格引擎:内嵌 x-data-spreadsheet 做单元格级编辑,
// 用 SheetJS 做 .xlsx / .csv / .tsv 的双向转换。

// x-spreadsheet 的 sheet 数据是稀疏表(带 len 字段),用 any 承载
type SheetData = any;

// Excel 工作表名限制:≤31 字符,且不能含 \ / ? * [ ] :
function safeSheetName(raw: string, index: number, used: string[]): string {
    let n = (raw || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
    if (!n) n = `Sheet${index + 1}`;
    let candidate = n;
    let k = 2;
    while (used.indexOf(candidate) >= 0) {
        candidate = `${n.slice(0, 28)}_${k++}`;
    }
    used.push(candidate);
    return candidate;
}

// SheetJS workbook → x-spreadsheet 的 sheets 数组
function workbookToSheetData(XLSX: any, wb: any): SheetData[] {
    const names: string[] = wb.SheetNames || [];
    const sheets: SheetData[] = [];
    for (const name of names) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        // blankrows 必须为 true:否则空行会被跳过,导致行号整体上移、
        // 保存时数据错位(实测 A1/空/A3 会被写成 A1/A2)。
        const aoa = XLSX.utils.sheet_to_json(ws, {
            header: 1,
            raw: false, // 取格式化后的显示值,避免日期/数字显示为原始序列值
            defval: "",
            blankrows: true,
        }) as any[][];
        const rows: any = {len: Math.max(aoa.length, 200)};
        let maxCol = -1;
        aoa.forEach((rowArr, ri) => {
            const cells: any = {};
            let has = false;
            (rowArr || []).forEach((v, ci) => {
                if (v === undefined || v === null || v === "") return;
                cells[ci] = {text: String(v)};
                has = true;
                if (ci > maxCol) maxCol = ci;
            });
            if (has) rows[ri] = {cells};
        });
        const cols: any = {len: Math.max(maxCol + 1, 26)};
        sheets.push({name, rows, cols, merges: [], styles: []});
    }
    if (sheets.length === 0) {
        sheets.push({name: "Sheet1", rows: {len: 200}, cols: {len: 26}, merges: [], styles: []});
    }
    return sheets;
}

// x-spreadsheet 的 sheets 数组 → SheetJS workbook
function sheetDataToWorkbook(XLSX: any, sheets: SheetData[]): any {
    const wb = XLSX.utils.book_new();
    const used: string[] = [];
    const list = sheets && sheets.length ? sheets : [{name: "Sheet1", rows: {len: 1}, cols: {len: 1}, merges: [], styles: []}];
    list.forEach((sh, i) => {
        const rows = sh.rows || {};
        const rowKeys = Object.keys(rows)
            .filter(k => k !== "len")
            .map(Number)
            .sort((a, b) => a - b);
        const maxRow = rowKeys.length ? rowKeys[rowKeys.length - 1] : -1;
        const aoa: any[][] = [];
        // 逐行展开(缺失行补空数组,保持行号位置)
        for (let ri = 0; ri <= maxRow; ri++) {
            const cells = (rows[ri] && rows[ri].cells) || {};
            const ciKeys = Object.keys(cells).map(Number);
            const maxCi = ciKeys.length ? Math.max(...ciKeys) : -1;
            const arr: any[] = [];
            for (let ci = 0; ci <= maxCi; ci++) {
                const c = cells[ci];
                arr.push(c && c.text !== undefined && c.text !== null ? c.text : "");
            }
            aoa.push(arr);
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [[""]]);
        XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sh.name, i, used));
    });
    return wb;
}

export async function createSpreadsheetEngine(
    path: string,
    onDirtyChange: (dirty: boolean) => void,
): Promise<OfficeEngine> {
    const ext = getExt(path);
    const isCsv = ext === ".csv" || ext === ".tsv";

    const XLSX = await import("xlsx");

    // 读取并解析为 workbook
    let wb: any;
    if (isCsv) {
        const text = await readTextFile(path);
        wb = XLSX.read(text, {type: "string", FS: ext === ".tsv" ? "\t" : ","});
    } else {
        const buf = await readBinaryFile(path);
        wb = XLSX.read(new Uint8Array(buf), {type: "array"});
    }
    const sheets = workbookToSheetData(XLSX, wb);

    // 加载表格组件:该 bundle 无 UMD 导出,执行后把构造函数挂到 window.x_spreadsheet
    await import("x-data-spreadsheet/dist/xspreadsheet.js");
    const SpreadsheetCtor: any = (window as any).x_spreadsheet;
    if (typeof SpreadsheetCtor !== "function") {
        throw new Error("表格组件加载失败(window.x_spreadsheet 未定义)");
    }

    const root = document.createElement("div");
    root.className = "syfe-office syfe-office--sheet";
    const mount = document.createElement("div");
    mount.className = "syfe-office__sheet-mount";
    root.appendChild(mount);

    const sheet = new SpreadsheetCtor(mount, {
        mode: "edit",
        showToolbar: true,
        showBottomBar: true,
        showContextMenu: true,
        view: {
            height: () => mount.clientHeight,
            width: () => mount.clientWidth,
        },
        row: {len: 200, height: 25},
        col: {len: 26, width: 110, indexWidth: 60, minWidth: 60},
    });

    let dirty = false;
    let loading = true;
    // loadData 过程可能触发 change,加载期间忽略
    sheet.loadData(sheets);
    sheet.change(() => {
        if (loading) return;
        if (!dirty) {
            dirty = true;
            onDirtyChange(true);
        }
    });
    loading = false;

    return {
        root,
        editable: true,
        isDirty: () => dirty,
        onDirtyChange: () => {},
        async save() {
            const data = sheet.getData() as SheetData[];
            const outWb = sheetDataToWorkbook(XLSX, data);
            if (isCsv) {
                // csv/tsv 为单表格式,多工作表时只导出第一张
                // 注:FS 字段在 xlsx 0.18.5 的 WritingOptions 类型定义中缺失,但运行时有效
                const text = XLSX.write(outWb, {
                    bookType: "csv",
                    type: "string",
                    FS: ext === ".tsv" ? "\t" : ",",
                } as any);
                await writeFile(path, text);
            } else {
                const out = XLSX.write(outWb, {
                    bookType: ext === ".xlsm" ? "xlsm" : "xlsx",
                    type: "array",
                }) as ArrayBuffer;
                await writeBinaryFile(path, out);
            }
            dirty = false;
            onDirtyChange(false);
        },
        resize() {
            try {
                sheet.reRender();
            } catch {
                // 忽略渲染失败
            }
        },
        dispose() {
            mount.innerHTML = "";
        },
    };
}
