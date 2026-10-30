// 虚拟文档树/文件树右键「新建思源文档」:
// 在设置指定的笔记本(可带子路径)下创建思源文档。名字默认值:
//   - 右键的是文件且「与文件同名」开启 → 预填文件主名(去扩展名);
//   - 其余(文件夹 / 同名开关关闭)→ 留空由用户填。
// 目标位置在设置里配置(「文件与打开」页:目标笔记本 + 子路径),对话框里只展示与填名。
import {Dialog, showMessage} from "siyuan";
import {createDocWithMd, lsNotebooks, querySQL} from "../api/file";

// 文件主名:去最后一个扩展名(".lock" 这类点开头隐藏文件整名保留)
export function fileBaseName(p: string): string {
    const b = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(0, i) : b;
}

export interface NewDocTarget {
    notebook: string;
    notebookName: string;
    subPath: string;
}

// 解析设置里的目标位置:指定笔记本不存在(已删/已关)时回退第一个未关闭笔记本。
// 返回 null = 没有任何可用笔记本。
export async function resolveNewDocTarget(config: any): Promise<NewDocTarget | null> {
    let list: any[] = [];
    try {
        list = (await lsNotebooks()) || [];
    } catch {
        list = [];
    }
    const open = list.filter((n: any) => n && n.id && !n.closed);
    if (open.length === 0) return null;
    const conf = config || {};
    const picked = open.find((n: any) => n.id === conf.newDocNotebook) || open[0];
    // 子路径:剥两端斜杠,保留用户写的 "a/b" 形态(内核 hpath 按段拼接)
    const sub = String(conf.newDocSubPath || "").replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
    return {notebook: picked.id, notebookName: String(picked.name || picked.id), subPath: sub};
}

// hpath = 笔记本内人类可读路径,如 "/journal/读书笔记";subPath 为空时直接 "/名字"
function joinHPath(subPath: string, name: string): string {
    return "/" + (subPath ? subPath + "/" : "") + name;
}

// 逐级确保 subPath 的父级文档存在,返回最深父级 id(空串 = 直接建在笔记本根)。
// 为什么不用内核 createDocWithMd 的嵌套 hpath 自动建父级:3.8.9 内核该路径会撞上
// "document metadata is not ready"(上游 regression,父级不存在时才触发;单段创建
// 与 parentID 链式创建都正常)。逐级查存在→缺了才建,顺带避免内核生成 "xxx-1" 重名父级。
async function ensureParentChain(notebook: string, subPath: string): Promise<string> {
    let parentID = "";
    let hpath = "";
    for (const seg of subPath.split("/").map(s => s.trim()).filter(Boolean)) {
        hpath += "/" + seg;
        const esc = hpath.replace(/'/g, "''");
        let rows: any[] = [];
        try {
            rows = (await querySQL(`SELECT id FROM blocks WHERE type='d' AND box_id='${notebook.replace(/'/g, "''")}' AND hpath='${esc}'`)) || [];
        } catch {
            rows = [];
        }
        const hit = Array.isArray(rows) ? rows.find(r => r && r.id) : null;
        if (hit) {
            parentID = String(hit.id);
            continue;
        }
        const created = await createDocWithMd(notebook, hpath, "", parentID || undefined);
        if (!created) throw new Error(`无法创建父级文档 ${hpath}`);
        parentID = created;
    }
    return parentID;
}

export async function openCreateSiyuanDocDialog(plugin: any, defaultName: string): Promise<void> {
    const target = await resolveNewDocTarget(plugin.config);
    if (!target) {
        showMessage("没有已打开的笔记本,无法新建思源文档", 3500, "error");
        return;
    }
    const locText = joinHPath(target.subPath, defaultName || "未命名文档");
    const dialog = new Dialog({
        title: "新建思源文档",
        content: `
            <div class="b3-dialog__content">
                <div style="margin-bottom:6px;">文档名称</div>
                <input class="b3-text-field fn__block" id="syfe-newdoc-name" placeholder="未命名文档" value="${defaultName.replace(/"/g, "&quot;")}" />
                <div style="margin-top:8px;font-size:12px;opacity:.7;">创建到:${target.notebookName} ${target.subPath ? "/ " + target.subPath : ""}(目标位置可在设置 →「文件与打开」→「新建思源文档」中修改)</div>
                <div class="syfe-newdoc__preview" style="margin-top:4px;font-size:12px;opacity:.55;">${locText}</div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-newdoc-cancel">取消</button>
                <button class="b3-button b3-button--text" id="syfe-newdoc-ok">创建</button>
            </div>`,
        width: "480px",
    });
    const inputEl = dialog.element.querySelector("#syfe-newdoc-name") as HTMLInputElement;
    const previewEl = dialog.element.querySelector(".syfe-newdoc__preview") as HTMLElement;
    const close = () => dialog.destroy();

    const submit = async () => {
        const name = inputEl.value.trim();
        if (!name) {
            showMessage("请填写文档名称", 2000, "error");
            return;
        }
        const hpath = joinHPath(target.subPath, name);
        try {
            // 先逐级确保父级存在(见 ensureParentChain 注释),再以 parentID 挂到最深父级下
            const parentID = await ensureParentChain(target.notebook, target.subPath);
            const id = await createDocWithMd(target.notebook, "/" + name, "", parentID || undefined);
            close();
            if (!id) {
                showMessage(`创建失败:内核未返回文档 id(${hpath})`, 3500, "error");
                return;
            }
            showMessage(`已创建思源文档:${hpath}`, 3000, "info");
        } catch (e) {
            showMessage(`创建思源文档失败: ${e}`, 3500, "error");
        }
    };

    // 名字变化时同步预览路径
    inputEl.addEventListener("input", () => {
        const name = inputEl.value.trim() || "未命名文档";
        previewEl.textContent = joinHPath(target.subPath, name);
    });
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void submit();
        }
    });
    dialog.element.querySelector("#syfe-newdoc-ok")!.addEventListener("click", () => void submit());
    dialog.element.querySelector("#syfe-newdoc-cancel")!.addEventListener("click", close);
    inputEl.focus();
    // 有默认名时全选,直接输入即覆盖
    if (defaultName) inputEl.select();
}
