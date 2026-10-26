import {openTab, confirm, showMessage, Menu} from "siyuan";
import {TAB_TYPE, MOUNT_TREE_DOCK_TYPE, isMarkdownFile} from "../constants";
import {basename, extname, dirname, joinPath} from "../utils/path";
import {guardUnsavedClose} from "../utils/close-guard";
import {applyFileTabHeadIcon, applyFileTabHeadIconWhenReady} from "../utils/tab-icon";
import {renderPathSegments, showPathSwitchMenu, enableCrumbScroll} from "../components/path-crumbs";
import {EditorConfig, DirEntry} from "../types";
import {createEditor, getLanguageByPath} from "../editor/monaco";
import {readDir} from "../api/file";
import {BINARY_EXTENSIONS, isImageFile, isOfficeFile, isMediaFile, isNotebookFile} from "../constants";
import {openMediaTab} from "./media-tab";
import {openImageTab} from "./image-tab";
import {openOfficeTab} from "./office-tab";
import {openMarkdownTab} from "./markdown-tab";
import {openNotebookTab} from "./notebook-tab";
import {wantsSplitOpen, pickTabOutsideActiveWnd} from "./split-open";
import {
    getModel,
    saveModel,
    markDirty,
    isDirty,
    isChangedExternally,
    reloadModel,
    consumePendingReveal,
} from "../editor/model-manager";
import {getGlobalDefaultChoice, kernelPythonOf} from "../utils/kernel/registry";
import {getResolved} from "../settings/user-settings";
import {createBacklinkPanel} from "../components/backlink-panel";
import {addRecent} from "../recent-files";
import {registerPythonEditor, unregisterPythonEditor} from "../utils/python-lsp-bridge";
import {resolvePythonInterpreter} from "../utils/python-kernel";
import {runCommandInTerminal} from "./terminal-tab";
import {toSystemPath} from "../utils/system-path";
// 带位置的文件链接(纯文本/代码文件的行号链接,详见 utils/file-ref.ts)
import {buildFileRefMd, consumePendingRef} from "../utils/file-ref";
import {copyText} from "../components/file-tree";
import {isDirectory} from "../utils/path-kind";
import {revealInFileTree, showFileTreeMenu, findTreeRootEl, buildFileTreeActions} from "../components/file-tree";
import {dispatchMountTreeEvent} from "../utils/mount-locate";
import {showVersionHistory} from "../version-control/version-ui";

// 打开文件夹:在文件树里展开定位。
//
// 「文件」面板默认不注册(见 index.ts 的 addFileTreeDock),用户从新标签页点
// 一个文件夹时如果不管这个,点了等于没点 —— revealInFileTree 找不到树根,
// 只会弹一句"面板已关闭"的提示。所以先补注册面板再定位。
//
// 补注册只能调一次(思源插件没有 removeDock),所以要等 DOM 里出现
// .syfe-tree__root 才继续,否则定位会在面板还没建出来时空转。
function openFolderInTree(path: string): void {
    // 首选:虚拟文档树(默认注册的 dock)——展开面板、定位并顺手展开该文件夹。
    // 用户点固定文件夹的预期是在虚拟文档树里看到它,而不是被逼去开「文件」面板;
    // 目录不在挂载范围内时 dock 侧会给出挂载提示,不再出现「面板已关闭」的旧提示。
    // dock 图标的 data-type 是「插件名+type」的全键 → 用后缀匹配
    if (document.querySelector(`.dock__item[data-type$="${MOUNT_TREE_DOCK_TYPE}"]`)) {
        // 面板是懒创建的:从未打开过时事件没人接,先确保面板初始化再派发
        dispatchMountTreeEvent("syfe:mount-tree-locate-folder", {path});
        return;
    }
    // 兜底:dock 图标不在(理论上不可能,插件加载即挂)才走「文件」面板旧流程。
    const locate = () => {
        // expandTarget:用户点文件夹是为了看里面的东西,定位后顺手展开
        void revealInFileTree(path, {expandTarget: true});
    };
    if (document.querySelector(".syfe-tree__root")) {
        locate();
        return;
    }
    const ensure = (window as any).__syfeAddFileTreeDock;
    if (typeof ensure !== "function") {
        locate();
        return;
    }
    ensure();
    const deadline = Date.now() + 3000;
    const timer = setInterval(() => {
        if (document.querySelector(".syfe-tree__root") || Date.now() > deadline) {
            clearInterval(timer);
            locate();
        }
    }, 120);
}

// Python 文件的头部「▶ 运行」:把文件丢进终端里跑。
//
// 为什么走终端而不是持久内核:运行一个**文件**的语义是 `python file.py` ——
// `__name__ == "__main__"`、argv、stdin(input() 交互)、退出码都要成立,
// 内核的 exec 模型给不了;终端里跑则与 VS Code 的「Run Python File」完全一致,
// 输出进可滚动的终端 Tab,cwd 自动取文件所在目录(相对路径的资源能找到)。
function addPythonRunButton(
    self: any,
    plugin: IPluginForTab,
    path: string,
    pathEl: HTMLElement,
): void {
    // 全局默认内核若指向 conda/Jupyter 环境,kernel.json argv[0] 就是该环境的 python,
    // ▶ 运行直接用它;否则退回自动探测
    const override = kernelPythonOf(getGlobalDefaultChoice());
    const py = override ? {cmd: override, args: [] as string[]} : resolvePythonInterpreter();
    if (!py) return; // 环境里没有 Python:不显示按钮
    const btn = document.createElement("span");
    btn.className = "syfe-editor__run";
    btn.textContent = "▶ 运行";
    btn.title = `在终端中运行此文件(${py.cmd})`;
    btn.addEventListener("click", () => {
        void (async () => {
            // 有未保存改动先落盘,避免跑到磁盘上的旧内容
            if (isDirty(path)) await self.save();
            const sysPath = toSystemPath(path);
            // 路径含空格才加引号;PowerShell 下带引号的路径会被当字符串字面量,
            // 需要补 & 前缀(cmd/bash 不需要,但 Windows 默认 shell 是 PowerShell)
            const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
            const exe = q(py.cmd);
            const line = (exe.startsWith('"') ? "& " : "") + exe + " \"" + sysPath.replace(/"/g, '') + "\"";
            const ok = await runCommandInTerminal(plugin as any, dirname(path), line);
            if (!ok) showMessage("终端不可用,无法运行", 4000, "error");
        })();
    });
    pathEl.appendChild(btn);
}

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

// 打开文件时的额外选项:position 用于"在分栏打开"(SiYuan openTab 的 right/bottom 拆分)
export interface OpenTabOptions {
    position?: "right" | "bottom";
}

// 打开文件编辑 Tab(同文件去重,聚焦已有 Tab)
// opts.position 指定时,在指定方向以分栏方式打开(支持同时查看多个文件)
//
// 文件夹走 revealInFileTree(在文件树里展开定位),不开编辑器 Tab ——
// 少了这个分支时,新标签页里固定的文件夹一点击就会开出编辑器 Tab,
// 内容是内核返回的 {"code":409,"msg":"path is a directory"}。
export function openFileTab(plugin: IPluginForTab, rawPath: string, opts?: OpenTabOptions): void {
    // 统一正斜杠:入口(资源管理器/挂载配置/接管)可能带反斜杠。不归一会同一文件
    // 两种 key 并存 —— Monaco URI 相同(Map key 不同)→ createModel 抛
    // "Cannot add model because it already exists",且页签复用检查也失效(实测)
    const path = (rawPath || "").replace(/\\/g, "/");
    if (isDirectory(path)) {
        void addRecent(plugin as any, path);
        openFolderInTree(path);
        return;
    }
    // 记录最近打开(放到最前,去重),供斜杆命令文件选择器快速插入
    void addRecent(plugin as any, path);
    // 图片文件交由独立的图片查看 Tab 处理
    if (isImageFile(path)) {
        openImageTab(plugin as any, path, opts);
        return;
    }
    // 音视频文件交由独立的播放器 Tab 处理
    if (isMediaFile(path)) {
        openMediaTab(plugin as any, path, opts);
        return;
    }
    // Jupyter Notebook(.ipynb)交由独立的 Notebook Tab 处理(单元格查看/编辑)
    if (isNotebookFile(path)) {
        openNotebookTab(plugin as any, path, opts);
        return;
    }
    // Office 文档(docx/xlsx/pptx、csv、旧版 doc/xls/ppt)交由独立的 Office Tab 处理
    if (isOfficeFile(path)) {
        openOfficeTab(plugin as any, path, opts);
        return;
    }
    // Markdown 文件交由独立的 Markdown Tab 处理(所见即所得/源码双模式)
    if (isMarkdownFile(path)) {
        openMarkdownTab(plugin as any, path, undefined, opts);
        return;
    }
    const opened = plugin.getOpenedTab()[TAB_TYPE] || [];
    const matches = opened.filter((c: any) => c?.data?.path === path);
    if (matches.length) {
        // 分栏请求时优先聚焦「活动分屏之外」的已有页签(文档与文件已同屏,不堆页签);
        // 全在活动分屏(聚焦会盖住文档)且要求分栏 → 落到 openTab 新开分栏
        const elsewhere = wantsSplitOpen(opts) ? pickTabOutsideActiveWnd(matches) : null;
        if (!wantsSplitOpen(opts) || elsewhere) {
            const tab = ((elsewhere || matches[0]) as any).parent;
            if (tab?.headElement) {
                (tab.headElement as HTMLElement).click();
            }
            // 文件在思源之外被改过(别的编辑器/git 切换分支/脚本生成)时,
            // 只切标签会一直显示旧内容 —— 这里同步一次。有未保存修改时**不动**,
            // 避免把用户正在编辑的内容冲掉,只提示他先保存。
            void syncExternalChange(path);
            return;
        }
    }
    // 新开分栏:openNewTab 绕过思源 openFile 的复用分支(allModels.custom /
    // getUnInitTab 都无视 position),position 才能走到 wnd.split,见 tabs/split-open.ts
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + TAB_TYPE,
            icon: "iconFile",
            title: basename(path),
            data: {path},
        },
        position: opts?.position,
        openNewTab: wantsSplitOpen(opts) || undefined,
    } as any).then((t: any) => applyFileTabHeadIcon(t, path, "iconFile"));
}

// 把所有已打开、且外部改过的编辑器一次同步(供面板「刷新」调用)。
// 只处理没未保存修改的 —— 有改动的不动,避免覆盖用户正在编辑的内容。
export async function syncOpenEditors(plugin: any): Promise<void> {
    try {
        const opened = plugin?.getOpenedTab?.()[TAB_TYPE] || [];
        for (const c of opened) {
            const p = c?.data?.path;
            if (typeof p === "string" && p && !isDirty(p) && isChangedExternally(p)) {
                await syncExternalChange(p);
            }
        }
    } catch {
        // 同步失败不影响刷新本身
    }
}

// 文件被思源之外的程序改过后,把磁盘上的新内容拉回已打开的模型。
// 触发点在"再次点开同一个文件":打开动作本来只是切标签(openFileTab 的复用分支),
// 不重新读盘,所以外部改动永远看不见 —— 用户看到的就是"还是旧的"。
export async function syncExternalChange(path: string): Promise<void> {
    try {
        if (!isChangedExternally(path)) return;
        if (isDirty(path)) {
            showMessage("文件在外部已被修改,但你有未保存的修改 —— 保存后再打开即会同步", 4000, "info");
            return;
        }
        await reloadModel(path);
        showMessage("文件在外部已修改,已重新加载最新内容", 3000, "info");
    } catch {
        // 刷新失败不打断用户(内容保持原样)
    }
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
            // 定位用:虚拟文档树面板的「定位」按钮靠该属性识别当前打开的文件
            this.element.dataset.syfePath = path;
            this._disposables = [];
            this.element.classList.add("syfe-editor-tab");

            const isBinary = BINARY_EXTENSIONS.has(extname(path));
            if (isBinary) {
                this.element.innerHTML = `
                    <div class="syfe-editor syfe-editor--readonly">
                        <div class="syfe-editor__path">${escapeHTML(path)}</div>
                        <div class="syfe-editor__backlink"></div>
                        <div class="syfe-editor__binary">该文件为二进制格式,不在编辑器中打开。</div>
                    </div>`;
                const blEl = this.element.querySelector(".syfe-editor__backlink") as HTMLElement;
                const bl = createBacklinkPanel(plugin as any, path);
                blEl.appendChild(bl.el);
                this._disposables!.push(() => bl.dispose());
                return;
            }

            this.element.innerHTML = `
                <div class="syfe-editor">
                    <div class="syfe-editor__path" data-path="${escapeHTML(path)}">
                        <span class="syfe-editor__dirty" style="display:none;">●</span>
                        <span class="syfe-editor__pathtext syfe-crumbs-scroll">${renderPathSegments(path)}</span>
                    </div>
                    <div class="syfe-editor__backlink"></div>
                    <div class="syfe-editor__container"></div>
                </div>`;
            const container = this.element.querySelector(".syfe-editor__container") as HTMLElement;
            const dirtyDot = this.element.querySelector(".syfe-editor__dirty") as HTMLElement;
            const pathEl = this.element.querySelector(".syfe-editor__path") as HTMLElement;
            enableCrumbScroll(this.element.querySelector(".syfe-editor__pathtext") as HTMLElement);
            const self = this;

            // 点击顶部分段:列出同级条目,可切换到其他文件或文件夹
            const pathClickHandler = (e: MouseEvent) => {
                const seg = (e.target as HTMLElement).closest(".syfe-editor__seg") as HTMLElement | null;
                if (!seg) return;
                const dir = seg.dataset.dir;
                if (!dir) return;
                void showPathSwitchMenu((p) => openFileTab(plugin, p), dir, seg, path);
            };
            pathEl.addEventListener("click", pathClickHandler);
            this._disposables!.push(() => pathEl.removeEventListener("click", pathClickHandler));
            // 页签头图标(重试版):新建与会话恢复的页签都覆盖
            applyFileTabHeadIconWhenReady(self, path, "iconFile");

            // 历史版本入口:查看/恢复此前保存的版本(版本控制在 saveModel 落盘前自动快照,
            // 文本文件通用)。恢复写进 model 而不直接落盘,Monaco 会立即反映,确认后手动保存
            const verBtn = document.createElement("span");
            verBtn.className = "syfe-editor__run";
            verBtn.textContent = "⏱ 历史版本";
            verBtn.title = "查看历史版本(每次保存自动保留修改前的内容)";
            verBtn.addEventListener("click", () => showVersionHistory(plugin as any, path));
            pathEl.appendChild(verBtn);

            // 顶栏最右侧「更多」:弹出与文件树右键一致的完整文件菜单
            // (对齐原生思源面包屑的「更多」;markdown Tab 也有同款按钮)
            const moreBtn = document.createElement("span");
            moreBtn.className = "syfe-editor__run syfe-editor__more";
            moreBtn.title = "更多操作(与文件树右键菜单一致)";
            moreBtn.innerHTML = `<svg style="width:14px;height:14px;"><use xlink:href="#iconMore"></use></svg>`;
            moreBtn.addEventListener("click", (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const rootEl = findTreeRootEl(path);
                showFileTreeMenu(e, path, false, rootEl, rootEl?.dataset.path || "", buildFileTreeActions(plugin as any));
            });
            pathEl.appendChild(moreBtn);

            // 反向链接面板(默认收起,展开时懒扫描)
            const backlinkEl = this.element.querySelector(".syfe-editor__backlink") as HTMLElement;
            const backlink = createBacklinkPanel(plugin as any, path);
            backlinkEl.appendChild(backlink.el);
            this._disposables!.push(() => backlink.dispose());

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
                        await (self as any).save();
                    });
                    self._editor = editor;
                    // Python 文件登记到 LSP 桥接层。
                    // 为什么要登记而不是靠 monaco model 的 URI 反查:monaco 给的
                    // model URI 是 `inmemory://model/1` 这种自造串,里面**没有**真实
                    // 磁盘路径,而 pyright 的 didOpen/补全都必须按真实路径走。
                    // 顺带这一步也把「打开 .py 就把内容推给 pyright」给做了。
                    if (getLanguageByPath(path) === "python") {
                        try {
                            registerPythonEditor(editor, path);
                        } catch (e) {
                            console.warn("[siyuan-file-editor] Python LSP 登记失败:", e);
                        }
                        addPythonRunButton(self, plugin, path, pathEl);
                    }
                    // 初始脏状态(复用 model 时可能已脏)
                    updateDirtyUI(isDirty(path));
                    // 内容变更 → 标脏
                    const sub = model.onDidChangeContent(() => {
                        if (!isDirty(path)) {
                            markDirty(path, true);
                        }
                        updateDirtyUI(true);
                    });
                    self._disposables!.push(() => sub.dispose());
                    // 搜索结果跳转;链接带来的行号(?line=N)同样走这条
                    let revealLine = consumePendingReveal(path);
                    if (revealLine === null) {
                        const ref = consumePendingRef(path);
                        if (ref?.line) revealLine = ref.line;
                    }
                    if (revealLine !== null) {
                        editor.revealLineInCenter(revealLine);
                        editor.setPosition({lineNumber: revealLine, column: 1});
                    }
                    // 右键菜单:复制「当前行」的链接(纯文本/代码文件也支持双链定位)
                    try {
                        self._disposables!.push(editor.addAction({
                            id: "syfe.copyLineLink",
                            label: "复制当前行链接",
                            contextMenuGroupId: "navigation",
                            contextMenuOrder: 9,
                            run: (ed: any) => {
                                const line = ed?.getPosition?.()?.lineNumber || 1;
                                const md = buildFileRefMd({path, line, label: `${basename(path)}:${line}`});
                                if (!md) {
                                    showMessage("无法生成链接(取不到文件的绝对路径)", 3000, "error");
                                    return;
                                }
                                void copyText(md).then(ok => showMessage(
                                    ok ? "行链接已复制,粘贴到思源文档点击可定位" : "复制失败",
                                    2500, ok ? "info" : "error",
                                ));
                            },
                        }).dispose);
                    } catch {
                        // 菜单注册失败不影响编辑
                    }
                } catch (e) {
                    container.innerHTML = `<div class="syfe-editor__error">加载失败: ${escapeHTML(String(e))}</div>`;
                }
            })();

            // 保存方法挂到实例,供 Ctrl+S 与外部调用
            (self as any).save = async () => {
                try {
                    // 「保存时格式化」:先跑格式化再落盘。
                    // 没有格式化器的语言(如纯文本)formatDocument 会静默失败,不影响保存
                    if (getResolved("editor.formatOnSave") === true) {
                        try {
                            await self._editor?.getAction("editor.action.formatDocument")?.run();
                        } catch {
                            // 格式化失败不阻断保存
                        }
                    }
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
            const discardThenClose = () => {
                // 不保存,放弃修改并关闭
                markDirty(path, false);
                self._closing = true;
                try {
                    self.parent?.close?.();
                } catch {
                    // 已关闭
                }
            };
            const saveThenClose = () => {
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
            };
            // 行为由设置项「关闭未保存标签页时」决定:ask 弹确认 / discard 直接放弃 / save 直接保存
            return guardUnsavedClose(basename(path), saveThenClose, discardThenClose);
        },
        destroy(this: EditorTabInstance) {
            // 先摘 LSP:必须在 editor.dispose() 之前,
            // 因为注销逻辑要读 editor.getModel() 来清 marker
            try {
                if (this._editor) unregisterPythonEditor(this._editor);
            } catch {
                // 忽略
            }
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
