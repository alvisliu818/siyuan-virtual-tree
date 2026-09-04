import {openTab, confirm, showMessage} from "siyuan";
import {OFFICE_TAB_TYPE, getOfficeKind} from "../constants";
import {basename} from "../utils/path";
import {openWithExternalApp} from "../utils/external-app";
import {OfficeEngine} from "../office/types";

// Office 文档 Tab:统一承载表格 / 文档 / 演示文稿 / 旧版兜底四类引擎

export interface IPluginForOfficeTab {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

interface OfficeTabInstance {
    element: HTMLElement;
    data: { path?: string };
    parent?: {updateTitle?: (t: string) => void; headElement?: HTMLElement; close?: () => void};
    _path?: string;
    _engine?: OfficeEngine | null;
    _dirty?: boolean;
    _saving?: boolean;
    _closing?: boolean;
    _onKey?: (e: KeyboardEvent) => void;
    _reload?: () => void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const KIND_LABEL: Record<string, string> = {
    spreadsheet: "表格",
    document: "文档",
    presentation: "演示文稿",
    legacy: "旧版文档",
};

// 打开 Office 文档 Tab(同文件去重,聚焦已有 Tab)
export function openOfficeTab(plugin: IPluginForOfficeTab, path: string): void {
    const opened = plugin.getOpenedTab()[OFFICE_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.path === path);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + OFFICE_TAB_TYPE,
            icon: "iconFile",
            title: basename(path),
            data: {path},
        },
    } as any);
}

// 创建 Office Tab 的 addTab 配置(捕获 plugin 闭包)
export function createOfficeTabConfig(_plugin: IPluginForOfficeTab) {
    return {
        type: OFFICE_TAB_TYPE,
        init(this: OfficeTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定文件路径</div>`;
                return;
            }
            this._path = path;
            this._dirty = false;
            this._saving = false;
            this._closing = false;
            this.element.classList.add("syfe-office-tab");

            const kind = getOfficeKind(path) || "document";
            const name = basename(path);
            this.element.innerHTML = `
                <div class="syfe-office__bar">
                    <span class="syfe-office__kind">${KIND_LABEL[kind] || "文档"}</span>
                    <span class="syfe-office__name" title="${escapeHTML(path)}">${escapeHTML(name)}</span>
                    <span class="syfe-office__dirty" style="display:none;">●</span>
                    <span class="syfe-office__actions">
                        <span class="syfe-office__extra"></span>
                        <button class="b3-button b3-button--text" data-act="save">保存</button>
                        <button class="b3-button b3-button--text" data-act="reload">重载</button>
                        <button class="b3-button b3-button--text" data-act="external">外部应用打开</button>
                    </span>
                </div>
                <div class="syfe-office__body"><div class="syfe-office__loading">正在加载…</div></div>`;

            const barEl = this.element.querySelector(".syfe-office__bar") as HTMLElement;
            const bodyEl = this.element.querySelector(".syfe-office__body") as HTMLElement;
            const dirtyEl = this.element.querySelector(".syfe-office__dirty") as HTMLElement;
            const extraEl = this.element.querySelector(".syfe-office__extra") as HTMLElement;
            const saveBtn = this.element.querySelector("[data-act='save']") as HTMLElement | null;
            const self = this;

            const setDirty = (d: boolean) => {
                self._dirty = d;
                dirtyEl.style.display = d ? "" : "none";
                try {
                    self.parent?.updateTitle?.((d ? "● " : "") + name);
                } catch {
                    // 忽略标题更新失败
                }
            };

            // 加载(或重新加载)对应类型的引擎
            const loadEngine = async () => {
                bodyEl.innerHTML = `<div class="syfe-office__loading">正在加载…</div>`;
                try {
                    let engine: OfficeEngine;
                    switch (kind) {
                        case "spreadsheet": {
                            const m = await import("../office/spreadsheet");
                            engine = await m.createSpreadsheetEngine(path, setDirty);
                            break;
                        }
                        case "document": {
                            const m = await import("../office/document");
                            engine = await m.createDocumentEngine(path, setDirty);
                            break;
                        }
                        case "presentation": {
                            const m = await import("../office/presentation");
                            engine = await m.createPresentationEngine(path, setDirty);
                            break;
                        }
                        default: {
                            const m = await import("../office/legacy");
                            engine = await m.createLegacyEngine(path, setDirty);
                            break;
                        }
                    }
                    if (self._engine) {
                        try {
                            self._engine.dispose();
                        } catch {
                            // 忽略
                        }
                    }
                    self._engine = engine;
                    bodyEl.innerHTML = "";
                    bodyEl.appendChild(engine.root);

                    // 引擎自定义按钮(如演示文稿的缩放)
                    extraEl.innerHTML = "";
                    (engine.toolbarActions || []).forEach(a => {
                        const b = document.createElement("button");
                        b.className = "b3-button b3-button--text";
                        b.textContent = a.label;
                        b.addEventListener("click", () => a.onClick());
                        extraEl.appendChild(b);
                    });
                    // 不可就地编辑时隐藏保存按钮
                    if (saveBtn) saveBtn.style.display = engine.editable ? "" : "none";

                    // 等布局稳定后再让引擎按容器尺寸自适应
                    requestAnimationFrame(() => {
                        try {
                            engine.resize?.();
                        } catch {
                            // 忽略
                        }
                    });
                } catch (e) {
                    bodyEl.innerHTML = `<div class="syfe-office__error">加载失败: ${escapeHTML(String(e))}</div>`;
                }
            };

            const save = async () => {
                const engine = self._engine;
                if (!engine || !engine.editable || self._saving) return;
                self._saving = true;
                try {
                    await engine.save();
                    setDirty(false);
                    showMessage("已保存", 2000, "info");
                } catch (e) {
                    showMessage(`保存失败: ${e}`, 5000, "error");
                } finally {
                    self._saving = false;
                }
            };

            const reload = () => {
                if (self._dirty) {
                    confirm(
                        "未保存的修改",
                        "重载会丢弃当前修改,确定重载吗?",
                        () => {
                            setDirty(false);
                            loadEngine();
                        },
                        () => {},
                    );
                    return;
                }
                loadEngine();
            };

            barEl.addEventListener("click", (e: MouseEvent) => {
                const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
                if (!btn) return;
                const act = btn.dataset.act;
                if (act === "save") save();
                else if (act === "reload") reload();
                else if (act === "external") {
                    openWithExternalApp(path).catch((err: any) => {
                        showMessage(`打开失败: ${err}`, 5000, "error");
                    });
                }
            });

            // Ctrl/Cmd + S 保存
            this._onKey = (e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
                    e.preventDefault();
                    e.stopPropagation();
                    save();
                }
            };
            this.element.addEventListener("keydown", this._onKey);
            this._reload = reload;

            loadEngine();
        },
        resize(this: OfficeTabInstance) {
            try {
                this._engine?.resize?.();
            } catch {
                // 忽略
            }
        },
        beforeDestroy(this: OfficeTabInstance): boolean | void {
            if (!this._dirty || this._closing) return;
            const self = this;
            const doClose = () => {
                self._closing = true;
                try {
                    self.parent?.close?.();
                } catch {
                    // 已关闭
                }
            };
            confirm(
                "未保存的修改",
                `「${basename(this._path || "")}」有未保存的修改,是否保存?`,
                () => {
                    const engine = self._engine;
                    if (!engine) {
                        doClose();
                        return;
                    }
                    engine.save().then(doClose).catch(() => showMessage("保存失败", 3000, "error"));
                },
                doClose,
            );
            return false; // 阻止本次关闭,等待用户选择
        },
        destroy(this: OfficeTabInstance) {
            if (this._onKey) {
                this.element.removeEventListener("keydown", this._onKey);
                this._onKey = undefined;
            }
            try {
                this._engine?.dispose();
            } catch {
                // 忽略
            }
            this._engine = null;
        },
    };
}
