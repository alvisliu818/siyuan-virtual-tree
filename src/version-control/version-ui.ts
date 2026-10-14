// 历史版本对话框:列表(时间+大小)+ 预览 + 恢复 + 清空
//
// 恢复语义:把所选版本内容写进当前 model(**不直接落盘**),用户在编辑器里
// 确认后再手动保存 —— 误恢复可以直接关掉标签页放弃,比直接写盘安全。
// 恢复后如果用户再保存,saveModel 会把"磁盘上的旧内容"再快照一条,
// 所以即使误恢复并保存,也能再恢复回来 —— 闭环。

import {Dialog, showMessage} from "siyuan";
import {basename} from "../utils/path";
import {getModel} from "../editor/model-manager";
import {FileVersion, getVersions, clearVersions} from "./file-versions";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtTime(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// 打开历史版本对话框。
// opts.onRestore:恢复写进 model 后的回调(markdown 页签用它重进当前渲染模式,
// Monaco 代码页签不需要 —— model 变了编辑器自动反映)。
export function showVersionHistory(plugin: any, path: string, opts?: {onRestore?: () => void}): void {
    let versions: FileVersion[] = getVersions(path);
    let selected = versions.length > 0 ? 0 : -1;

    const dlg = new Dialog({
        title: `历史版本 · ${basename(path)}`,
        content: `<div class="b3-dialog__content" style="display:flex;flex-direction:column;height:100%;gap:8px;padding:12px 16px;box-sizing:border-box;">
    <div style="font-size:12px;color:var(--b3-theme-on-surface);">每次保存时自动保留修改前的内容(最新 ${versions.length} 条)。恢复会写进编辑器但**不自动落盘**,确认无误后再保存。</div>
    <div style="display:flex;flex:1;min-height:0;gap:8px;">
        <div id="syfe-ver-list" style="width:280px;overflow:auto;border:1px solid var(--b3-border-color);border-radius:4px;flex-shrink:0;"></div>
        <pre id="syfe-ver-preview" style="flex:1;overflow:auto;margin:0;padding:8px;border:1px solid var(--b3-border-color);border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--b3-theme-on-background);"></pre>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="b3-button b3-button--cancel" id="syfe-ver-close">关闭</button>
        <button class="b3-button b3-button--text" id="syfe-ver-clear">清空历史</button>
        <button class="b3-button b3-button--outline" id="syfe-ver-restore">恢复所选版本</button>
    </div>
</div>`,
        width: "760px",
        height: "72vh",
    });

    const listEl = dlg.element.querySelector("#syfe-ver-list") as HTMLElement;
    const previewEl = dlg.element.querySelector("#syfe-ver-preview") as HTMLElement;

    const renderList = () => {
        if (versions.length === 0) {
            listEl.innerHTML = `<div style="padding:12px;color:var(--b3-theme-on-surface);font-size:12px;">暂无历史版本。编辑并保存一次后,这里会出现修改前的内容。</div>`;
            previewEl.textContent = "";
            return;
        }
        listEl.innerHTML = versions.map((v, i) => `
            <div class="syfe-ver-item" data-idx="${i}" style="padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--b3-border-color);font-size:12px;${i === selected ? "background:var(--b3-theme-primary-lightest);" : ""}">
                <div>${fmtTime(v.time)}</div>
                <div style="color:var(--b3-theme-on-surface);">${fmtSize(v.size)}</div>
            </div>`).join("");
    };

    const renderPreview = () => {
        if (selected < 0 || !versions[selected]) {
            previewEl.textContent = "";
            return;
        }
        previewEl.textContent = versions[selected].content;
    };

    listEl.addEventListener("click", (e: MouseEvent) => {
        const item = (e.target as HTMLElement).closest(".syfe-ver-item") as HTMLElement | null;
        if (!item) return;
        selected = parseInt(item.dataset.idx || "0", 10);
        renderList();
        renderPreview();
    });

    (dlg.element.querySelector("#syfe-ver-close") as HTMLElement).addEventListener("click", () => dlg.destroy());

    (dlg.element.querySelector("#syfe-ver-clear") as HTMLElement).addEventListener("click", () => {
        clearVersions(path);
        versions = [];
        selected = -1;
        renderList();
        renderPreview();
        showMessage("已清空该文件的历史版本", 2500, "info");
    });

    (dlg.element.querySelector("#syfe-ver-restore") as HTMLElement).addEventListener("click", () => {
        const v = versions[selected];
        if (!v) {
            showMessage("请先选择一个版本", 2500, "info");
            return;
        }
        void (async () => {
            try {
                const model = await getModel(path);
                model.setValue(v.content);
                dlg.destroy();
                showMessage("已恢复为所选版本(未保存),确认无误后请保存", 3500, "info");
                opts?.onRestore?.();
            } catch (err) {
                showMessage(`恢复失败: ${err}`, 4000, "error");
            }
        })();
    });

    renderList();
    renderPreview();
    void plugin; // plugin 预留(未来版本云端存储等),当前不使用
}
