// 历史版本对话框:列表(时间+大小)+ 预览 / 差异比较 + 恢复 + 清空
//
// 恢复语义:把所选版本内容写进当前 model(**不直接落盘**),用户在编辑器里
// 确认后再手动保存 —— 误恢复可以直接关掉标签页放弃,比直接写盘安全。
// 恢复后如果用户再保存,saveModel 会把"磁盘上的旧内容"再快照一条,
// 所以即使误恢复并保存,也能再恢复回来 —— 闭环。
//
// 差异比较:右侧面板可切到「差异比较」,左侧下拉选一个版本、右侧下拉选
// 「当前内容」或另一个版本,并排/内联两种视图;需要长时间比对时点
// 「在页签中打开」,同样的选择会带进独立的比较页签(tabs/diff-tab.ts)。

import {Dialog, showMessage} from "siyuan";
import {basename} from "../utils/path";
import {getModel} from "../editor/model-manager";
import {FileVersion, getVersions, clearVersions} from "./file-versions";
import {
    computeDiff,
    renderDiff,
    statsText,
    versionOptions,
    sideLabel,
    type SideId,
    type DiffMode,
    type DiffResult,
} from "./diff-view";
import {openDiffTab} from "../tabs/diff-tab";

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
    // 比较状态:左 = 列表选中的版本,右 = 当前内容
    let leftId: SideId = versions.length > 0 ? versions[0].time : "current";
    let rightId: SideId = "current";
    let mode: DiffMode = "side";
    let onlyChanges = false;
    let view: "preview" | "diff" = "preview";
    let diffToken = Symbol();

    const dlg = new Dialog({
        title: `历史版本 · ${basename(path)}`,
        content: `<div class="b3-dialog__content syfe-ver" style="display:flex;flex-direction:column;height:100%;gap:8px;padding:12px 16px;box-sizing:border-box;">
    <div class="syfe-ver__hint">每次保存时自动保留修改前的内容(最新 ${versions.length} 条)。恢复会写进编辑器但<b>不自动落盘</b>,确认无误后再保存。</div>
    <div class="syfe-ver__body" style="display:flex;flex:1;min-height:0;gap:8px;">
        <div id="syfe-ver-list" class="syfe-ver__list"></div>
        <div class="syfe-ver__right" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;">
            <div class="syfe-ver__tabs" id="syfe-ver-tabs">
                <button class="syfe-ver__tab syfe-ver__tab--on" data-view="preview">预览</button>
                <button class="syfe-ver__tab" data-view="diff">差异比较</button>
            </div>
            <div class="syfe-ver__diffbar" id="syfe-ver-diffbar" style="display:none;">
                <span class="syfe-ver__lb">左</span>
                <select class="b3-select" id="syfe-ver-left"></select>
                <button class="b3-button b3-button--text" id="syfe-ver-swap" title="交换左右两侧">⇄</button>
                <span class="syfe-ver__lb">右</span>
                <select class="b3-select" id="syfe-ver-right"></select>
                <button class="b3-button b3-button--text" id="syfe-ver-mode" title="切换并排 / 内联视图"></button>
                <label class="syfe-ver__chk"><input type="checkbox" id="syfe-ver-only" /> 只看改动</label>
                <span class="syfe-ver__stats" id="syfe-ver-stats"></span>
            </div>
            <div class="syfe-ver__content" style="flex:1;min-height:0;overflow:auto;">
                <pre id="syfe-ver-preview" class="syfe-ver__preview"></pre>
                <div id="syfe-ver-diff" style="display:none;"></div>
            </div>
        </div>
    </div>
    <div class="syfe-ver__footer">
        <button class="b3-button b3-button--cancel" id="syfe-ver-close">关闭</button>
        <button class="b3-button b3-button--text" id="syfe-ver-clear">清空历史</button>
        <button class="b3-button b3-button--outline" id="syfe-ver-open-tab">在页签中打开比较</button>
        <button class="b3-button b3-button--outline" id="syfe-ver-restore">恢复所选版本</button>
    </div>
</div>`,
        width: "900px",
        height: "78vh",
    });

    const listEl = dlg.element.querySelector("#syfe-ver-list") as HTMLElement;
    const previewEl = dlg.element.querySelector("#syfe-ver-preview") as HTMLElement;
    const diffEl = dlg.element.querySelector("#syfe-ver-diff") as HTMLElement;
    const diffBarEl = dlg.element.querySelector("#syfe-ver-diffbar") as HTMLElement;
    const tabsEl = dlg.element.querySelector("#syfe-ver-tabs") as HTMLElement;
    const leftSel = dlg.element.querySelector("#syfe-ver-left") as HTMLSelectElement;
    const rightSel = dlg.element.querySelector("#syfe-ver-right") as HTMLSelectElement;
    const modeBtn = dlg.element.querySelector("#syfe-ver-mode") as HTMLElement;
    const onlyChk = dlg.element.querySelector("#syfe-ver-only") as HTMLInputElement;
    const statsEl = dlg.element.querySelector("#syfe-ver-stats") as HTMLElement;

    const renderList = () => {
        if (versions.length === 0) {
            listEl.innerHTML = `<div class="syfe-ver__empty">暂无历史版本。编辑并保存一次后,这里会出现修改前的内容。</div>`;
            return;
        }
        listEl.innerHTML = versions.map((v, i) => `
            <div class="syfe-ver-item${i === selected ? " syfe-ver-item--on" : ""}" data-idx="${i}">
                <div>${fmtTime(v.time)}</div>
                <div class="syfe-ver-item__size">${fmtSize(v.size)}</div>
            </div>`).join("");
    };

    const renderPreview = () => {
        if (selected < 0 || !versions[selected]) {
            previewEl.textContent = "";
            return;
        }
        previewEl.textContent = versions[selected].content;
    };

    // 下拉:当前内容 + 全部版本
    const renderSelects = () => {
        const opts = versionOptions(path);
        const fill = (sel: HTMLSelectElement, cur: SideId) => {
            sel.innerHTML = opts.map(o => {
                const val = o.id === "current" ? "current" : String(o.id);
                return `<option value="${val}"${o.id === cur ? " selected" : ""}>${escapeHTML(o.label)}</option>`;
            }).join("");
        };
        fill(leftSel, leftId);
        fill(rightSel, rightId);
        modeBtn.textContent = mode === "side" ? "并排视图" : "内联视图";
    };

    const parseSide = (raw: string): SideId => (raw === "current" ? "current" : Number(raw));

    const runDiff = async () => {
        const myToken = Symbol();
        diffToken = myToken;
        statsEl.textContent = "比较中...";
        diffEl.innerHTML = `<div class="syfe-ver__empty">比较中...</div>`;
        let res: DiffResult;
        try {
            res = await computeDiff(path, leftId, rightId);
        } catch (err) {
            if (diffToken !== myToken) return;
            diffEl.innerHTML = `<div class="syfe-ver__empty">比较失败: ${escapeHTML(String(err))}</div>`;
            statsEl.textContent = "";
            return;
        }
        if (diffToken !== myToken) return;
        const truncated = renderDiff(diffEl, res, mode, onlyChanges);
        let text = statsText(res);
        if (truncated > 0) text += ` · 仅显示前 ${res.ops.length - truncated} 行`;
        statsEl.textContent = text;
        if (!diffEl.firstElementChild || !diffEl.querySelector(".syfe-diff__row")) {
            diffEl.innerHTML = `<div class="syfe-ver__empty">${escapeHTML(statsText(res))}</div>`;
        }
    };

    const switchView = (next: "preview" | "diff") => {
        view = next;
        tabsEl.querySelectorAll(".syfe-ver__tab").forEach(b => {
            b.classList.toggle("syfe-ver__tab--on", (b as HTMLElement).dataset.view === next);
        });
        const isDiff = next === "diff";
        diffBarEl.style.display = isDiff ? "" : "none";
        previewEl.style.display = isDiff ? "none" : "";
        diffEl.style.display = isDiff ? "" : "none";
        if (isDiff) {
            renderSelects();
            void runDiff();
        }
    };

    listEl.addEventListener("click", (e: MouseEvent) => {
        const item = (e.target as HTMLElement).closest(".syfe-ver-item") as HTMLElement | null;
        if (!item) return;
        selected = parseInt(item.dataset.idx || "0", 10);
        // 差异视图下点列表 = 把该版本放到左侧与右侧(默认当前内容)比较,
        // 符合"挑一个旧版本看看改了什么"的直觉
        if (view === "diff" && versions[selected]) {
            leftId = versions[selected].time;
            renderSelects();
            void runDiff();
        }
        renderList();
        renderPreview();
    });

    tabsEl.addEventListener("click", (e: MouseEvent) => {
        const btn = (e.target as HTMLElement).closest("[data-view]") as HTMLElement | null;
        if (!btn) return;
        switchView(btn.dataset.view === "diff" ? "diff" : "preview");
    });

    const onSelChange = () => {
        leftId = parseSide(leftSel.value);
        rightId = parseSide(rightSel.value);
        void runDiff();
    };
    leftSel.addEventListener("change", onSelChange);
    rightSel.addEventListener("change", onSelChange);

    (dlg.element.querySelector("#syfe-ver-swap") as HTMLElement).addEventListener("click", () => {
        const t = leftId;
        leftId = rightId;
        rightId = t;
        renderSelects();
        void runDiff();
    });

    modeBtn.addEventListener("click", () => {
        mode = mode === "side" ? "inline" : "side";
        modeBtn.textContent = mode === "side" ? "并排视图" : "内联视图";
        void runDiff();
    });

    onlyChk.addEventListener("change", () => {
        onlyChanges = onlyChk.checked;
        void runDiff();
    });

    (dlg.element.querySelector("#syfe-ver-close") as HTMLElement).addEventListener("click", () => dlg.destroy());

    (dlg.element.querySelector("#syfe-ver-open-tab") as HTMLElement).addEventListener("click", () => {
        if (versions.length === 0) {
            showMessage("暂无历史版本,无法比较", 2500, "info");
            return;
        }
        const l = leftId;
        const r = rightId;
        dlg.destroy();
        openDiffTab(plugin, path, l, r, mode);
    });

    (dlg.element.querySelector("#syfe-ver-clear") as HTMLElement).addEventListener("click", () => {
        clearVersions(path);
        versions = [];
        selected = -1;
        leftId = "current";
        rightId = "current";
        diffToken = Symbol();
        renderList();
        renderPreview();
        renderSelects();
        if (view === "diff") {
            diffEl.innerHTML = `<div class="syfe-ver__empty">历史已清空,没有可比较的版本。</div>`;
            statsEl.textContent = "";
        }
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
                showMessage(`已恢复为 ${sideLabel(path, v.time)}(未保存),确认无误后请保存`, 3500, "info");
                opts?.onRestore?.();
            } catch (err) {
                showMessage(`恢复失败: ${err}`, 4000, "error");
            }
        })();
    });

    renderList();
    renderPreview();
    renderSelects();
}
