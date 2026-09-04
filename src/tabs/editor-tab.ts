import {openTab, confirm, showMessage} from "siyuan";
import {TAB_TYPE} from "../constants";
import {basename} from "../utils/path";
import {EditorConfig} from "../types";
import {createEditor} from "../editor/monaco";
import {BINARY_EXTENSIONS, isImageFile, isOfficeFile} from "../constants";
import {openImageTab} from "./image-tab";
import {openOfficeTab} from "./office-tab";
import {
    getModel,
    saveModel,
    markDirty,
    isDirty,
    consumePendingReveal,
} from "../editor/model-manager";

// 编辑器 Tab 所需的插件接口(结构化类型,避免循环依赖)
export interface IPluginForTab {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
}

// 编辑器 Tab 实例上附加的字段
interface EditorTabInstance {
    element: HTMLElement;
    data: { path?: string };
    parent?: { updateTitle?: (t: string) => void; close?: () => void; headElement?: HTMLElement };
    _path?: string;
    _editor?: import("monaco-editor").editor.IStandaloneCodeEditor;
    _disposables?: Array<() => void>;
    _closing?: boolean;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 打开文件编辑 Tab(同文件去重,聚焦已有 Tab)
export function openFileTab(plugin: IPluginForTab, path: string): void {
    // 图片文件交由独立的图片查看 Tab 处理
    if (isImageFile(path)) {
        openImageTab(plugin as any, path);
        return;
    }
    // Office 文档(docx/xlsx/pptx、csv、旧版 doc/xls/ppt)交由独立的 Office Tab 处理
    if (isOfficeFile(path)) {
        openOfficeTab(plugin as any, path);
        return;
    }
    const opened = plugin.getOpenedTab()[TAB_TYPE] || [];
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
            id: plugin.name + TAB_TYPE,
            icon: "iconFile",
            title: basename(path),
            data: {path},
        },
    } as any);
}

// 创建 addTab 配置(捕获 plugin 闭包)
export function createEditorTabConfig(plugin: IPluginForTab) {
    return {
        type: TAB_TYPE,
        init(this: EditorTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定文件路径</div>`;
                return;
            }
            this._path = path;
            this._disposables = [];
            this.element.classList.add("syfe-editor-tab");

            const isBinary = BINARY_EXTENSIONS.has("." + (path.split(".").pop() || "").toLowerCase());
            if (isBinary) {
                this.element.innerHTML = `
                    <div class="syfe-editor syfe-editor--readonly">
                        <div class="syfe-editor__path">${escapeHTML(path)}</div>
                        <div class="syfe-editor__binary">该文件为二进制格式,不在编辑器中打开。</div>
                    </div>`;
                return;
            }

            this.element.innerHTML = `
                <div class="syfe-editor">
                    <div class="syfe-editor__path" data-path="${escapeHTML(path)}">
                        <span class="syfe-editor__dirty" style="display:none;">●</span>
                        <span class="syfe-editor__pathtext">${escapeHTML(path)}</span>
                    </div>
                    <div class="syfe-editor__container"></div>
                </div>`;
            const container = this.element.querySelector(".syfe-editor__container") as HTMLElement;
            const dirtyDot = this.element.querySelector(".syfe-editor__dirty") as HTMLElement;
            const self = this;

            const updateDirtyUI = (dirty: boolean) => {
                if (dirtyDot) dirtyDot.style.display = dirty ? "" : "none";
                const title = (dirty ? "● " : "") + basename(path);
                try {
                    self.parent?.updateTitle?.(title);
                } catch {
                    // 忽略标题更新失败
                }
            };

            (async () => {
                try {
                    const model = await getModel(path);
                    const editor = createEditor(container, model, path, plugin.config, async () => {
                        await self.save();
                    });
                    self._editor = editor;
                    // 初始脏状态(复用 model 时可能已脏)
                    updateDirtyUI(isDirty(path));
                    // 内容变更 → 标脏
                    const sub = model.onDidChangeContent(() => {
                        if (!isDirty(path)) {
                            markDirty(path, true);
                        }
                        updateDirtyUI(true);
                    });
                    self._disposables.push(() => sub.dispose());
                    // 搜索结果跳转
                    const revealLine = consumePendingReveal(path);
                    if (revealLine !== null) {
                        editor.revealLineInCenter(revealLine);
                        editor.setPosition({lineNumber: revealLine, column: 1});
                    }
                } catch (e) {
                    container.innerHTML = `<div class="syfe-editor__error">加载失败: ${escapeHTML(String(e))}</div>`;
                }
            })();

            // 保存方法挂到实例,供 Ctrl+S 与外部调用
            (self as any).save = async () => {
                try {
                    await saveModel(path);
                    updateDirtyUI(false);
                    showMessage("已保存", 2000, "info");
                } catch (e) {
                    showMessage(`保存失败: ${e}`, 5000, "error");
                }
            };
        },
        beforeDestroy(this: EditorTabInstance): boolean | void {
            const path = this._path;
            if (!path || this._closing || !isDirty(path)) {
                return;
            }
            const self = this;
            confirm(
                "未保存的修改",
                `「${basename(path)}」有未保存的修改,是否保存?`,
                () => {
                    // 保存后关闭
                    saveModel(path)
                        .then(() => {
                            self._closing = true;
                            try {
                                self.parent?.close?.();
                            } catch {
                                // 已关闭
                            }
                        })
                        .catch(() => showMessage("保存失败", 3000, "error"));
                },
                () => {
                    // 不保存,放弃修改并关闭
                    markDirty(path, false);
                    self._closing = true;
                    try {
                        self.parent?.close?.();
                    } catch {
                        // 已关闭
                    }
                },
            );
            return false; // 阻止本次关闭,等待用户选择
        },
        destroy(this: EditorTabInstance) {
            this._disposables?.forEach(d => {
                try {
                    d();
                } catch {
                    // 忽略
                }
            });
            this._disposables = [];
            try {
                this._editor?.dispose();
            } catch {
                // 忽略
            }
            this._editor = undefined;
            // 不 dispose model:同一文件多 Tab 共享,保留以供复用
        },
        resize(this: EditorTabInstance) {
            try {
                this._editor?.layout();
            } catch {
                // 忽略
            }
        },
    };
}
