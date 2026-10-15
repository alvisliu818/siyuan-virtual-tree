// 回收站对话框:查看插件回收站内容,恢复到原位置 / 彻底删除 / 清空。
//
// 只管「插件回收站」;「系统回收站」由操作系统管理,对话框里给出指引即可。
// 数据来自 utils/trash.ts 的 index.json(条目记录原始路径/镜像路径/删除时间),
// 文件已被手动从磁盘清理掉的条目不再展示。

import {Dialog, confirm, showMessage} from "siyuan";
import {
    listTrashItems,
    restoreFromTrash,
    purgeTrashItem,
    emptyPluginTrash,
    revealPluginTrash,
    getTrashMode,
} from "../utils/trash";

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTime(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface IPluginForTrash {
    refreshFileTrees(): void;
}

export function openTrashDialog(plugin: IPluginForTrash): void {
    const refreshTrees = () => {
        try {
            plugin?.refreshFileTrees();
        } catch {
            // 插件实例不可用时忽略(仅影响文件树即时刷新)
        }
    };

    const renderBody = (bodyEl: HTMLElement, listEl: HTMLElement, emptyEl: HTMLElement, statsEl: HTMLElement): void => {
        const items = listTrashItems();
        statsEl.textContent = items.length > 0 ? `共 ${items.length} 项(按原路径镜像存放)` : "";
        if (items.length === 0) {
            listEl.innerHTML = "";
            emptyEl.style.display = "";
            return;
        }
        emptyEl.style.display = "none";
        listEl.innerHTML = items.map(it => `
            <div class="syfe-trash-item" data-id="${escapeHTML(it.id)}">
                <div class="syfe-trash-item__main">
                    <div class="syfe-trash-item__origin">${it.isDir ? "📁 " : ""}${escapeHTML(it.origin)}</div>
                    <div class="syfe-trash-item__time">删除于 ${fmtTime(it.time)}${it.isDir ? " · 文件夹" : ""}</div>
                </div>
                <div class="syfe-trash-item__ops">
                    <button class="b3-button b3-button--text syfe-trash-restore" data-id="${escapeHTML(it.id)}">恢复</button>
                    <button class="b3-button b3-button--text syfe-trash-purge" data-id="${escapeHTML(it.id)}">彻底删除</button>
                </div>
            </div>`).join("");
    };

    const dlg = new Dialog({
        title: "回收站(插件)",
        content: `<div class="b3-dialog__content syfe-trash" style="display:flex;flex-direction:column;height:100%;gap:8px;padding:12px 16px;box-sizing:border-box;">
    <div class="syfe-trash__bar">
        <span class="syfe-trash__stats" id="syfe-trash-stats"></span>
        <span class="fn__flex-1"></span>
        <button class="b3-button b3-button--text" id="syfe-trash-reveal" title="在系统文件管理器中打开回收站目录">打开目录</button>
        <button class="b3-button b3-button--text" id="syfe-trash-empty">清空回收站</button>
        <button class="b3-button b3-button--cancel" id="syfe-trash-close">关闭</button>
    </div>
    <div class="syfe-trash__hint">「恢复」把文件移回原位置;原位置已有同名文件时恢复为「xxx (恢复 时间)」,不会覆盖任何现有文件。</div>
    <div class="syfe-trash__list fn__flex-1" id="syfe-trash-list"></div>
    <div class="syfe-trash__empty" id="syfe-trash-empty" style="display:none;">回收站是空的。删除文件/文件夹后会按原路径镜像存放在这里,可随时恢复。</div>
</div>`,
        width: "720px",
        height: "64vh",
    });

    const bodyEl = dlg.element.querySelector(".syfe-trash") as HTMLElement;
    const listEl = dlg.element.querySelector("#syfe-trash-list") as HTMLElement;
    const emptyEl = dlg.element.querySelector("#syfe-trash-empty") as HTMLElement;
    const statsEl = dlg.element.querySelector("#syfe-trash-stats") as HTMLElement;

    const rerender = () => renderBody(bodyEl, listEl, emptyEl, statsEl);

    (dlg.element.querySelector("#syfe-trash-close") as HTMLElement).addEventListener("click", () => dlg.destroy());

    (dlg.element.querySelector("#syfe-trash-reveal") as HTMLElement).addEventListener("click", () => {
        try {
            revealPluginTrash();
        } catch (e) {
            showMessage(`打开回收站目录失败: ${(e as Error)?.message || e}`, 4000, "error");
        }
    });

    (dlg.element.querySelector("#syfe-trash-empty") as HTMLElement).addEventListener("click", () => {
        confirm(
            "清空回收站",
            "确定清空插件回收站吗?其中所有内容将从磁盘永久删除,无法再恢复。",
            () => {
                try {
                    emptyPluginTrash();
                    rerender();
                    showMessage("回收站已清空", 2500, "info");
                } catch (e) {
                    showMessage(`清空失败: ${(e as Error)?.message || e}`, 4000, "error");
                }
            },
            () => {},
        );
    });

    listEl.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const restoreBtn = target.closest(".syfe-trash-restore") as HTMLElement | null;
        const purgeBtn = target.closest(".syfe-trash-purge") as HTMLElement | null;
        if (restoreBtn) {
            try {
                const r = restoreFromTrash(restoreBtn.dataset.id || "");
                showMessage(`已恢复到 ${r.restoredAs}`, 4000, "info");
                rerender();
                refreshTrees();
            } catch (e) {
                showMessage(`恢复失败: ${(e as Error)?.message || e}`, 4000, "error");
            }
            return;
        }
        if (purgeBtn) {
            confirm(
                "彻底删除",
                "确定从磁盘永久删除该条目吗?此操作不可恢复。",
                () => {
                    try {
                        purgeTrashItem(purgeBtn.dataset.id || "");
                        rerender();
                    } catch (e) {
                        showMessage(`删除失败: ${(e as Error)?.message || e}`, 4000, "error");
                    }
                },
                () => {},
            );
        }
    });

    rerender();
    // 模式提示:当前用的是系统回收站时,对话框里没有内容属正常现象
    if (getTrashMode() === "system") {
        showMessage("当前删除方式为「系统回收站」,本对话框只管理插件回收站;恢复系统回收站内容请到系统回收站操作", 4500, "info");
    }
}
