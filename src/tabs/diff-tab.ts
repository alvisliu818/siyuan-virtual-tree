// 版本比较页签:把「历史版本 ↔ 当前内容」或「两个历史版本」的并排/内联差异
// 做成常驻页签,可长时间停留比对,并能直接把任意一侧恢复进编辑器。
//
// 与对话框(版本历史里的「差异比较」)共用 diff-view / diff 两层,两处结果一致;
// 对话框里的「在页签中打开」会把当前左右选择带过来(见 openDiffTab)。

import {openTab, showMessage} from "siyuan";
import {DIFF_TAB_TYPE} from "../constants";
import {basename} from "../utils/path";
import {getModel} from "../editor/model-manager";
import {
    computeDiff,
    loadSide,
    renderDiff,
    statsText,
    versionOptions,
    sideLabel,
    type SideId,
    type DiffMode,
} from "../version-control/diff-view";

export interface IPluginForDiffTab {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

interface DiffTabInstance {
    element: HTMLElement;
    data: { path?: string; left?: SideId; right?: SideId; mode?: DiffMode };
    _leftSel?: HTMLSelectElement;
    _rightSel?: HTMLSelectElement;
    _diffEl?: HTMLElement;
    _statsEl?: HTMLElement;
    _onlyChk?: HTMLInputElement;
    _busy?: symbol;
    _apply?: (left: SideId, right: SideId, mode?: DiffMode) => void;
}

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 打开(或复用)某文件的比较页签。同一文件只开一个,重复调用会更新左右选择。
export function openDiffTab(
    plugin: IPluginForDiffTab,
    path: string,
    left: SideId,
    right: SideId,
    mode: DiffMode = "side",
): void {
    const opened = plugin.getOpenedTab()[DIFF_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.path === path);
    if (existing) {
        if (typeof (existing as DiffTabInstance)._apply === "function") {
            (existing as DiffTabInstance)._apply!(left, right, mode);
        }
        const tab = (existing as any).parent;
        if (tab?.headElement) (tab.headElement as HTMLElement).click();
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + DIFF_TAB_TYPE,
            icon: "iconHistory",
            title: `比较 · ${basename(path)}`,
            data: {path, left, right, mode},
        },
    } as any);
}

export function createDiffTabConfig(plugin: IPluginForDiffTab) {
    return {
        type: DIFF_TAB_TYPE,
        init(this: DiffTabInstance) {
            const path = this.data?.path || "";
            let left: SideId = this.data?.left ?? "current";
            let right: SideId = this.data?.right ?? "current";
            let mode: DiffMode = this.data?.mode === "inline" ? "inline" : "side";
            let onlyChanges = false;

            this.element.classList.add("syfe-difftab", "fn__flex-column");
            this.element.innerHTML = `
                <div class="syfe-difftab__bar">
                    <span class="syfe-difftab__file" title="${escapeHTML(path)}">${escapeHTML(basename(path))}</span>
                    <span class="syfe-difftab__lb">左</span>
                    <select class="b3-select" id="syfe-difftab-left"></select>
                    <button class="b3-button b3-button--text" id="syfe-difftab-swap" title="交换左右两侧">⇄</button>
                    <span class="syfe-difftab__lb">右</span>
                    <select class="b3-select" id="syfe-difftab-right"></select>
                    <button class="b3-button b3-button--text" id="syfe-difftab-mode"></button>
                    <label class="syfe-difftab__chk"><input type="checkbox" id="syfe-difftab-only" /> 只看改动</label>
                    <span class="syfe-difftab__stats" id="syfe-difftab-stats"></span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--outline" id="syfe-difftab-restore-left">恢复左侧</button>
                    <button class="b3-button b3-button--outline" id="syfe-difftab-restore-right">恢复右侧</button>
                </div>
                <div class="syfe-difftab__body fn__flex-1" id="syfe-difftab-body"></div>`;

            const leftSel = this.element.querySelector("#syfe-difftab-left") as HTMLSelectElement;
            const rightSel = this.element.querySelector("#syfe-difftab-right") as HTMLSelectElement;
            const modeBtn = this.element.querySelector("#syfe-difftab-mode") as HTMLElement;
            const onlyChk = this.element.querySelector("#syfe-difftab-only") as HTMLInputElement;
            const statsEl = this.element.querySelector("#syfe-difftab-stats") as HTMLElement;
            const bodyEl = this.element.querySelector("#syfe-difftab-body") as HTMLElement;
            this._leftSel = leftSel;
            this._rightSel = rightSel;
            this._diffEl = bodyEl;
            this._statsEl = statsEl;
            this._onlyChk = onlyChk;

            if (!path) {
                bodyEl.innerHTML = `<div class="syfe-difftab__empty">未指定文件路径</div>`;
                return;
            }

            const renderSelects = () => {
                const opts = versionOptions(path);
                const fill = (sel: HTMLSelectElement, cur: SideId) => {
                    sel.innerHTML = opts.map(o => {
                        const val = o.id === "current" ? "current" : String(o.id);
                        return `<option value="${val}"${o.id === cur ? " selected" : ""}>${escapeHTML(o.label)}</option>`;
                    }).join("");
                };
                fill(leftSel, left);
                fill(rightSel, right);
                modeBtn.textContent = mode === "side" ? "并排视图" : "内联视图";
            };

            const runDiff = async () => {
                const myToken = Symbol();
                this._busy = myToken;
                statsEl.textContent = "比较中...";
                bodyEl.innerHTML = `<div class="syfe-difftab__empty">比较中...</div>`;
                try {
                    const res = await computeDiff(path, left, right);
                    if (this._busy !== myToken) return;
                    const truncated = renderDiff(bodyEl, res, mode, onlyChanges);
                    let text = statsText(res);
                    if (truncated > 0) text += " · 已截断显示";
                    statsEl.textContent = text;
                    if (!bodyEl.querySelector(".syfe-diff__row")) {
                        bodyEl.innerHTML = `<div class="syfe-difftab__empty">${escapeHTML(statsText(res))}</div>`;
                    }
                } catch (err) {
                    if (this._busy !== myToken) return;
                    bodyEl.innerHTML = `<div class="syfe-difftab__empty">比较失败: ${escapeHTML(String(err))}</div>`;
                    statsEl.textContent = "";
                }
            };

            const parseSide = (raw: string): SideId => (raw === "current" ? "current" : Number(raw));
            const onSelChange = () => {
                left = parseSide(leftSel.value);
                right = parseSide(rightSel.value);
                void runDiff();
            };
            leftSel.addEventListener("change", onSelChange);
            rightSel.addEventListener("change", onSelChange);

            (this.element.querySelector("#syfe-difftab-swap") as HTMLElement).addEventListener("click", () => {
                const t = left;
                left = right;
                right = t;
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

            // 恢复:与历史版本对话框一致 —— 写进编辑器 model,**不落盘**,
            // 用户确认后再手动保存(误操作可以直接关页签放弃)
            const restore = async (side: SideId) => {
                try {
                    const content = await loadSide(path, side);
                    const model = await getModel(path);
                    model.setValue(content);
                    showMessage(`已把 ${sideLabel(path, side)} 恢复到编辑器(未保存),确认无误后请保存`, 3500, "info");
                } catch (err) {
                    showMessage(`恢复失败: ${err}`, 4000, "error");
                }
            };
            (this.element.querySelector("#syfe-difftab-restore-left") as HTMLElement)
                .addEventListener("click", () => void restore(left));
            (this.element.querySelector("#syfe-difftab-restore-right") as HTMLElement)
                .addEventListener("click", () => void restore(right));

            // 供 openDiffTab 复用页签时更新选择
            this._apply = (l: SideId, r: SideId, m?: DiffMode) => {
                left = l;
                right = r;
                if (m) mode = m;
                renderSelects();
                void runDiff();
            };

            renderSelects();
            void runDiff();
        },
        destroy(this: DiffTabInstance) {
            // 让进行中的比较失效(取内容/算差异都是异步的,页签关了不该再写 DOM)
            this._busy = Symbol();
        },
    };
}
