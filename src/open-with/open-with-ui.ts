// 自定义「打开方式」的管理界面
// 入口:设置 → 文件 → 「管理打开方式…」
//
// 为什么做成对话框而不是设置面板里的固定字段:这一项是个**列表**
// (数量不定、可增删),设置面板的 addItem 是单控件布局,塞不进动态列表。
// 范式照抄 tags/tag-ui.ts 的标签管理对话框。
import {Dialog, showMessage, confirm} from "siyuan";
import type {Plugin} from "siyuan";
import type {OpenWithItem} from "../types";
import {
    getOpenWithItems, addOpenWith, updateOpenWith, removeOpenWith, resetOpenWith,
} from "./open-with-store";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// args 是数组,表单里用一个字符串表示,约定用空格分隔。
// 为什么不用 JSON:用户手写 JSON 要注意引号与逗号,空格分隔的容错高得多,
// 而且这个字段的实际用法就是 "-g" / "--new-window" 这类短参数。
function argsToText(args?: string[]): string {
    return (args || []).join(" ");
}

function textToArgs(text: string): string[] {
    return text.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

// 单条编辑对话框(新建 / 编辑共用)
function openOpenWithEditDialog(plugin: Plugin, item: OpenWithItem | null, onDone?: () => void): void {
    const isNew = item === null;
    const dlg = new Dialog({
        title: isNew ? "新建打开方式" : "编辑打开方式",
        content: `<div class="b3-dialog__content syfe-ow-dialog">
    <div class="syfe-ow-field">
  <div class="syfe-ow-field__label">显示名称</div>
                <input class="b3-text-field fn__block" id="syfe-ow-label" value="${escapeHTML(item?.label || "")}" placeholder="如:用 VS Code 打开" />
            </div>
    <div class="syfe-ow-field">
                <div class="syfe-ow-field__label">命令</div>
                <input class="b3-text-field fn__block" id="syfe-ow-cmd" value="${escapeHTML(item?.command || "")}" placeholder="如:code / C:\\Program Files\\...\\Code.exe" />
  <div class="syfe-ow-field__hint">填命令名(如 code)时会在 PATH 与常见安装目录里查找;也可直接填可执行文件的完整路径。</div>
            </div>
  <div class="syfe-ow-field">
     <div class="syfe-ow-field__label">参数(空格分隔,可选)</div>
                <input class="b3-text-field fn__block" id="syfe-ow-args" value="${escapeHTML(argsToText(item?.args))}" placeholder="如:-g 或 --new-window" />
                <div class="syfe-ow-field__hint">留空时目标路径自动追加到末尾。需要放到中间就用占位符 <code>{file}</code>(如 <code>-r {file} --wait</code>)。</div>
            </div>
          <div class="syfe-ow-field">
                <div class="syfe-ow-field__label">适用对象</div>
       <select class="b3-select fn__block" id="syfe-ow-kind">
    <option value="both"${!item || item.kind === "both" ? " selected" : ""}>文件与文件夹</option>
           <option value="file"${item?.kind === "file" ? " selected" : ""}>仅文件</option>
   <option value="dir"${item?.kind === "dir" ? " selected" : ""}>仅文件夹</option>
       </select>
    </div>
            <div class="syfe-ow-field">
         <div class="syfe-ow-field__label">限定扩展名(可选)</div>
            <input class="b3-text-field fn__block" id="syfe-ow-ext" value="${escapeHTML((item?.extensions || []).join(" "))}" placeholder="如:.py .ipynb(留空 = 不限)" />
         <div class="syfe-ow-field__hint">用空格分隔,点开头即可。限定后只有这些扩展名的文件才会出现这一项。</div>
        </div>
        </div>
        <div class="b3-dialog__action">
       <button class="b3-button b3-button--cancel" id="syfe-ow-cancel">取消</button>
       ${isNew || item?.builtin ? "" : `<button class="b3-button b3-button--outline" id="syfe-ow-delete">删除</button>`}
            <button class="b3-button b3-button--text" id="syfe-ow-ok">${isNew ? "创建" : "保存"}</button>
        </div>`,
        width: "480px",
    });

    const labelEl = dlg.element.querySelector("#syfe-ow-label") as HTMLInputElement;
    const cmdEl = dlg.element.querySelector("#syfe-ow-cmd") as HTMLInputElement;
    const argsEl = dlg.element.querySelector("#syfe-ow-args") as HTMLInputElement;
    const kindEl = dlg.element.querySelector("#syfe-ow-kind") as HTMLSelectElement;
    const extEl = dlg.element.querySelector("#syfe-ow-ext") as HTMLInputElement;
    (labelEl.value.trim() ? cmdEl : labelEl).focus();

    const close = () => dlg.destroy();
    const submit = async () => {
        const command = cmdEl.value.trim();
  if (!command) {
       showMessage("请填写命令", 2500, "error");
     return;
        }
        const patch = {
label: labelEl.value.trim() || command,
   command,
    args: textToArgs(argsEl.value),
    kind: kindEl.value as OpenWithItem["kind"],
     extensions: extEl.value.split(/[\s,]+/).map(s => s.trim().toLowerCase())
       .filter(Boolean)
    .map(s => (s.startsWith(".") ? s : "." + s)),
   };
        if (isNew) {
 await addOpenWith(plugin, patch);
        } else {
      await updateOpenWith(plugin, item!.id, patch);
        }
        close();
        onDone?.();
    };

    dlg.element.querySelector("#syfe-ow-ok")!.addEventListener("click", () => void submit());
    dlg.element.querySelector("#syfe-ow-cancel")!.addEventListener("click", close);
    const delBtn = dlg.element.querySelector("#syfe-ow-delete");
    if (delBtn) {
        delBtn.addEventListener("click", async () => {
        await removeOpenWith(plugin, item!.id);
     close();
  onDone?.();
     });
    }
    cmdEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
    e.preventDefault();
 void submit();
        }
    });
}

// 管理对话框:列出所有打开方式
export function openOpenWithManagerDialog(plugin: Plugin, onChanged?: () => void): void {
    const renderRows = () => {
        const items = getOpenWithItems();
        if (items.length === 0) {
            return `<div class="syfe-ow-empty">还没有配置打开方式</div>`;
  }
        return items.map(it => {
            const scope = it.kind === "file" ? "仅文件" : it.kind === "dir" ? "仅文件夹" : "文件与文件夹";
            const ext = it.extensions?.length ? ` · 限定 ${it.extensions.join(" ")}` : "";
         const args = it.args?.length ? ` ${argsToText(it.args)}` : "";
            return `
  <div class="syfe-ow-row" data-id="${escapeHTML(it.id)}">
          <span class="syfe-ow-row__name">${escapeHTML(it.label)}${it.builtin ? `<span class="syfe-ow-row__tag">内置</span>` : ""}</span>
     <span class="syfe-ow-row__cmd" title="${escapeHTML(it.command + " " + args)}">${escapeHTML(it.command + args)}</span>
         <span class="syfe-ow-row__scope">${scope}${escapeHTML(ext)}</span>
        <span class="fn__flex-1"></span>
   <button class="b3-button b3-button--text syfe-ow-edit" data-id="${escapeHTML(it.id)}">编辑</button>
         ${it.builtin ? "" : `<button class="b3-button b3-button--text syfe-ow-del" data-id="${escapeHTML(it.id)}">删除</button>`}
 </div>`;
        }).join("");
    };

    const dialog = new Dialog({
        title: "自定义打开方式",
        content: `<div class="b3-dialog__content syfe-ow-manager">
    <div class="syfe-ow-manager__tip">配置后,文件与文件夹的右键「打开方式」里会出现对应的条目。命令填 <code>code</code> 这类命令名即可,找不到时会自动去常见安装目录里找。</div>
     <div class="syfe-ow-manager__list" id="syfe-ow-list">${renderRows()}</div>
      </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel" id="syfe-owmgr-close">关闭</button>
   <button class="b3-button b3-button--text" id="syfe-owmgr-reset">恢复默认</button>
            <button class="b3-button b3-button--text" id="syfe-owmgr-new">新建</button>
      </div>`,
        width: "640px",
        height: "62%",
    });

    const listEl = dialog.element.querySelector("#syfe-ow-list") as HTMLElement;
    const refresh = () => {
        listEl.innerHTML = renderRows();
    };

    listEl.addEventListener("click", (ev) => {
        const el = ev.target as HTMLElement;
        if (el.classList.contains("syfe-ow-edit")) {
      const it = getOpenWithItems().find(x => x.id === el.dataset.id);
            if (it) openOpenWithEditDialog(plugin, it, () => {
      refresh();
    onChanged?.();
       });
        } else if (el.classList.contains("syfe-ow-del")) {
        const it = getOpenWithItems().find(x => x.id === el.dataset.id);
    if (it) {
        void removeOpenWith(plugin, it.id).then(() => {
         refresh();
   onChanged?.();
       });
 }
  }
    });

    dialog.element.querySelector("#syfe-owmgr-close")!.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector("#syfe-owmgr-new")!.addEventListener("click", () => {
        openOpenWithEditDialog(plugin, null, () => {
 refresh();
    onChanged?.();
      });
    });
    dialog.element.querySelector("#syfe-owmgr-reset")!.addEventListener("click", () => {
   confirm("恢复默认打开方式", "会丢掉所有自定义项(内置项也会恢复成默认命令),确定吗?",
    () => {
            void resetOpenWith(plugin).then(() => {
             refresh();
  onChanged?.();
            });
        }, () => {});
    });
}