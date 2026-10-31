// 虚拟文档树/文件树右键「新建思源文档」:
// 在设置指定的笔记本(可带子路径)下创建思源文档。名字默认值:
//   - 右键的是文件且「与文件同名」开启 → 预填文件主名(去扩展名);
//   - 其余(文件夹 / 同名开关关闭)→ 留空由用户填。
// 目标位置在设置里配置(「文件与打开」页:目标笔记本 + 子路径),对话框里只展示与填名。
import {Dialog, showMessage} from "siyuan";
import {createDocWithMd, lsNotebooks, querySQL, getBlockAttrs, setBlockAttrs} from "../api/file";
import {addMountItem} from "../mount-tree";

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

// 来源路径 → 绝对路径:内核路径(/data/...、/conf 等)以工作空间根补全成真实文件系统
// 绝对路径(Windows 反斜杠形态);盘符原生路径原样返回。取不到 workspaceDir 时退回原值。
function toAbsoluteSourcePath(p: string): string {
    const raw = String(p || "").trim();
    if (!raw) return "";
    if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
    if (!raw.startsWith("/")) return raw;
    const ws = String((window as any).siyuan?.config?.system?.workspaceDir || "").trim();
    if (!ws) return raw;
    const norm = (s: string) => s.replace(/[\\/]+$/, "");
    return (norm(ws) + "/" + raw.replace(/^\/+/, "")).replace(/\//g, "\\");
}

// 把来源绝对路径追加为文档别名(alias 逗号分隔多值;已存在则不重复)。失败不抛:
// 别名是附加信息,创建本身已成功,静默降级并返回是否写上。
async function appendSourceAlias(docId: string, absPath: string): Promise<boolean> {
    try {
        const attrs = await getBlockAttrs(docId) || {};
        const existing = String(attrs["alias"] || "");
        const parts = existing.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.includes(absPath)) return true;
        const merged = parts.concat(absPath).join(",");
        await setBlockAttrs(docId, {alias: merged});
        return true;
    } catch {
        return false;
    }
}

export async function openCreateSiyuanDocDialog(
    plugin: any,
    defaultName: string,
    sourcePath?: string,
    // 提供时,创建成功后把新文档挂载到该解析器给出的挂载项下(虚拟文档树右键场景,
    // 落点语义与挂载菜单一致:目录行=该文件夹下,文件行=fileMountTarget 设置决定)。
    // 解析失败/返回 null 时不挂载,创建本身不受影响。
    mountParent?: () => Promise<string | null>,
    // 挂载成功后回调(展开父挂载行让新文档可见;由面板注入)
    onMounted?: (parentUid: string) => void,
): Promise<void> {
    const target = await resolveNewDocTarget(plugin.config);
    if (!target) {
        showMessage("没有已打开的笔记本,无法新建思源文档", 3500, "error");
        return;
    }
    const locText = joinHPath(target.subPath, defaultName || "未命名文档");
    const absPath = toAbsoluteSourcePath(sourcePath || "");
    // 别名 = 绝对路径\文档名:文档名按路径段接在来源路径后(形如文档是它下面的文件),
    // 路径前缀稳定可 LIKE 反查;尾部文档名区分同源多文档
    const aliasHint = absPath ? `${absPath}\\${defaultName || "文档名"}` : "";
    const dialog = new Dialog({
        title: "新建思源文档",
        content: `
            <div class="b3-dialog__content">
                <div style="margin-bottom:6px;">文档名称</div>
                <input class="b3-text-field fn__block" id="syfe-newdoc-name" placeholder="未命名文档" value="${defaultName.replace(/"/g, "&quot;")}" />
                <div style="margin-top:8px;font-size:12px;opacity:.7;">创建到:${target.notebookName} ${target.subPath ? "/ " + target.subPath : ""}(目标位置可在设置 →「文件与打开」→「新建思源文档」中修改)</div>
                <div class="syfe-newdoc__preview" style="margin-top:4px;font-size:12px;opacity:.55;">${locText}</div>
                ${aliasHint ? `<div class="syfe-newdoc__alias" style="margin-top:4px;font-size:12px;opacity:.55;">创建后设置别名:${aliasHint.replace(/"/g, "&quot;")}</div>` : ""}
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
            // 别名 = 绝对路径\文档名(文件/文件夹与思源文档的双向映射);写失败不影响创建结果
            let aliasNote = "";
            if (absPath) {
                const aliasValue = absPath.replace(/[\\/]+$/, "") + "\\" + name;
                aliasNote = (await appendSourceAlias(String(id), aliasValue)) ? ",别名=路径\\文档名" : "(别名写入失败)";
            }
            // 自动挂载到虚拟文档树(落点由右键行的显示父链 + 落点设置决定);失败不影响创建
            let mountNote = "";
            if (mountParent) {
                try {
                    const uid = await mountParent();
                    if (uid) {
                        const added = await addMountItem(plugin, {kind: "doc", name, targetId: String(id)}, uid);
                        if (added) {
                            mountNote = ",已挂载到虚拟文档树";
                            onMounted?.(uid);
                        }
                    }
                } catch {}
            }
            showMessage(`已创建思源文档:${hpath}${aliasNote}${mountNote}`, 3000, "info");
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
