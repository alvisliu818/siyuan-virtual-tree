// 思源文档/笔记本的「原生」右键菜单:对齐思源文档树(initFileMenu / initNavigationMenu)的
// 操作子集,全部通过内核 API 实现,操作结果与在思源文档树里操作完全一致。
// 虚拟文档树(挂载的思源文档/笔记本/子文档)与标签面板(sydoc:// 条目)共用。
import {Menu, confirm, showMessage, Dialog} from "siyuan";
import {
    createDocWithMd,
    renameDocByID,
    removeDocByID,
    duplicateDoc,
    duplicateDocTree,
    renameNotebook,
    exportMdContent,
    getRefText,
    getHPathByID,
    postJSON,
    lsNotebooks,
    listDocsByPath,
    moveDocsByID,
} from "../api/file";
import {getDocInfo, clearDocInfoCache} from "../utils/virtual-tree";
import {openSiyuanDoc, openSiyuanNotebook} from "./entry-menu";
import {promptDialog, copyText} from "./file-tree";
import {showOpenDialog} from "../utils/open-dialog";
import {isPinned, isFavorite, itemFromDoc, toggleInGroup} from "../start-page";

// 菜单所需的插件接口
export interface IDocMenuPlugin {
    app: any;
    name: string;
}

export interface DocMenuItem {
    icon?: string;
    label: string;
    click: () => void;
}

// 取思源界面文案(与原生菜单用词完全一致),取不到回退中文
function lang(key: string, fallback: string): string {
    const l = (window as any).siyuan?.languages || {};
    return typeof l[key] === "string" && l[key] ? l[key] : fallback;
}

async function copyWithToast(text: string | null, okMsg: string): Promise<void> {
    if (!text) return;
    const ok = await copyText(text);
    showMessage(ok ? okMsg : "复制失败", 2000, ok ? "info" : "error");
}

// 下载文本文件(导出 Markdown 用)
function downloadText(fileName: string, content: string): void {
    const blob = new Blob([content], {type: "text/markdown;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 「移动」目标选择对话框:逐层浏览笔记本/文档,选笔记本 → 移到顶层,选文档 → 作为其子文档。
// 底层走 /api/filetree/moveDocsByID(思源原生文档树拖拽/页签移动同款接口),
// 样式复用挂载选择器的 .syfe-mount 系列(零新增 CSS)。
// 源文档自身及其子树不能作为目标(内核也会拒绝),这里先行过滤,避免浏览进去后无处可移。
async function moveDocTargetDialog(docId: string, name: string, after: () => void): Promise<void> {
    // 源文档的归属(box + .sy 存储路径),用于排除自身子树;查不到(索引延迟等)就不过滤,内核兜底
    const src = await getDocInfo(docId);
    const dialog = new Dialog({
        title: `${lang("move", "移动")}「${escapeHTML(name || docId)}」到…`,
        content: `
            <div class="b3-dialog__content syfe-mount">
                <div class="syfe-mount__crumb"></div>
                <div class="syfe-mount__list"></div>
            </div>`,
        width: "520px",
    });
    const listEl = dialog.element.querySelector(".syfe-mount__list") as HTMLElement;
    const crumbEl = dialog.element.querySelector(".syfe-mount__crumb") as HTMLElement;

    // 文档层状态;docId 为当前所在文档(顶层为 undefined,只挂「移动到顶层」)
    type DocLayer = {nbId: string; nbName: string; docPath: string; docName: string; docId?: string};
    let state: DocLayer | null = null;

    const docIdFromPath = (syPath: string) => syPath.split("/").pop()?.replace(/\.sy$/i, "") || "";

    // 目标是否是源文档自身/其子树(同笔记本且存储路径为源路径或其下,子文档存储路径嵌套在父 .sy/ 下)
    const isOwnSubtree = (nbId: string, syPath: string): boolean =>
        !!src && nbId === src.box && !!syPath &&
        (syPath === src.path || syPath.startsWith(src.path + "/"));

    const doMove = async (toId: string, label: string) => {
        try {
            await moveDocsByID([docId], toId);
            dialog.destroy();
            showMessage(`已移动到「${label}」`, 3000, "info");
            after();
        } catch (e: any) {
            showMessage(`移动失败: ${e?.message || e}`, 4000, "error");
        }
    };

    const enterRow = (row: HTMLElement) => {
        if (!state) {
            state = {
                nbId: row.dataset.nb!,
                nbName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!,
                docPath: "/", docName: "",
            };
        } else if (row.dataset.sy) {
            state = {
                ...state,
                docPath: row.dataset.sy,
                docName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || "",
                docId: docIdFromPath(row.dataset.sy),
            };
        }
        void render();
    };

    const render = async () => {
        try {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            if (!state) {
                // 笔记本层:每行可「移动到顶层」,或「进入」浏览子文档
                const notebooks = (await lsNotebooks()).filter((n: any) => n && !n.closed);
                crumbEl.innerHTML = `<span>选择目标笔记本,或进入浏览文档层级</span>`;
                if (notebooks.length === 0) {
                    listEl.innerHTML = `<div class="syfe-mount__hint">没有打开的笔记本</div>`;
                    return;
                }
                listEl.innerHTML = notebooks.map((n: any) => `
                    <div class="syfe-mount__row" data-nb="${escapeHTML(String(n.id))}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconNotebook"></use></svg>
                        <span class="syfe-mount__name" title="${escapeHTML(String(n.name || n.id))}">${escapeHTML(String(n.name || n.id))}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                        <button class="b3-button b3-button--small" data-act="here-nb">移动到顶层</button>
                    </div>`).join("");
                return;
            }
            // 文档层:顶部「移动到此处」(作为当前文档的子文档)+ 子文档列表
            const docs = await listDocsByPath(state.nbId, state.docPath);
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回笔记本层">‹ 返回</span>
                <span class="syfe-mount__mountcur">${escapeHTML(state.nbName)}${state.docName ? " / " + escapeHTML(state.docName) : ""}</span>
                <span class="fn__flex-1"></span>
                ${state.docId ? `<button class="b3-button b3-button--small" data-act="here-cur">移动到此处</button>` : ""}`;
            if (!Array.isArray(docs) || docs.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">没有子文档</div>`;
                return;
            }
            listEl.innerHTML = docs
                .filter((d: any) => !isOwnSubtree(state!.nbId, String(d.path || "")))
                .map((d: any) => `
                    <div class="syfe-mount__row" data-sy="${escapeHTML(String(d.path || ""))}" data-name="${escapeHTML(String(d.name || ""))}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconFile"></use></svg>
                        <span class="syfe-mount__name" title="${escapeHTML(String(d.name || ""))}">${escapeHTML(String(d.name || ""))}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                        <button class="b3-button b3-button--small" data-act="here-doc">移动到此处</button>
                    </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
        if (btn) {
            const act = btn.dataset.act;
            const row = btn.closest(".syfe-mount__row") as HTMLElement | null;
            if (act === "here-nb" && row) {
                void doMove(row.dataset.nb!, row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!);
                return;
            }
            if (act === "here-cur" && state?.docId) {
                void doMove(state.docId, state.docName || state.docId);
                return;
            }
            if (act === "here-doc" && row?.dataset.sy) {
                const id = docIdFromPath(row.dataset.sy);
                void doMove(id, row.dataset.name || id);
                return;
            }
            if (act === "back") {
                state = null;
                void render();
                return;
            }
            if (act === "enter" && row) {
                enterRow(row);
                return;
            }
            return;
        }
        // 行点击 = 进入
        const row = (ev.target as HTMLElement).closest(".syfe-mount__row") as HTMLElement | null;
        if (row) enterRow(row);
    });
    void render();
}

// 与思源文档树 copySubMenu 一致的复制子菜单(复制副本/复制文档树由调用方视情况追加)
function copySubMenuItems(docId: string, onAfter?: () => void): DocMenuItem[] {
    return [
        {
            label: lang("copyBlockRef", "复制块引用"),
            click: () => void (async () => {
                try {
                    const refText = await getRefText(docId);
                    await copyWithToast(`((${docId} '${refText}'))`, "块引用已复制");
                } catch (e: any) {
                    showMessage(`复制失败: ${e?.message || e}`, 3000, "error");
                }
            })(),
        },
        {
            label: lang("copyBlockEmbed", "复制块嵌入"),
            click: () => void copyWithToast(`{{select * from blocks where id='${docId}'}}`, "块嵌入已复制"),
        },
        {
            label: lang("copyProtocol", "复制思源链接"),
            click: () => void copyWithToast(`siyuan://blocks/${docId}`, "思源链接已复制"),
        },
        {
            label: lang("copyProtocolInMd", "复制 Markdown 链接"),
            click: () => void (async () => {
                try {
                    const refText = await getRefText(docId);
                    const md = `[${refText.replace("[", "\\[").replace("]", "\\]")}](siyuan://blocks/${docId})`;
                    await copyWithToast(md, "Markdown 链接已复制");
                } catch (e: any) {
                    showMessage(`复制失败: ${e?.message || e}`, 3000, "error");
                }
            })(),
        },
        {
            label: lang("copyHPath", "复制 HPath"),
            click: () => void (async () => {
                try {
                    await copyWithToast(await getHPathByID(docId), "文档路径已复制");
                } catch (e: any) {
                    showMessage(`复制失败: ${e?.message || e}`, 3000, "error");
                }
            })(),
        },
        {
            label: lang("copyID", "复制 ID"),
            click: () => void copyWithToast(docId, "文档 ID 已复制"),
        },
        {
            label: lang("duplicateCopy", "复制副本"),
            click: () => {
                void duplicateDoc(docId).then(() => {
                    showMessage("已复制副本", 2000, "info");
                    onAfter?.();
                }).catch((e: any) => showMessage(`复制副本失败: ${e?.message || e}`, 3000, "error"));
            },
        },
        {
            label: lang("duplicateDocTree", "复制文档树"),
            click: () => {
                void duplicateDocTree(docId).then(() => {
                    showMessage("已复制文档树", 2000, "info");
                    onAfter?.();
                }).catch((e: any) => showMessage(`复制文档树失败: ${e?.message || e}`, 3000, "error"));
            },
        },
    ];
}

// 新标签页固定/收藏(思源文档 target;与条目菜单共用同一份数据)。
// 供本模块内部与「块」节点的菜单(定位到块/复制块链接)复用。
export function addPinFavEntries(menu: Menu, plugin: IDocMenuPlugin, docId: string, name: string, onAfter?: () => void): void {
    const item = itemFromDoc(docId, name || docId);
    menu.addSeparator();
    menu.addItem({
        icon: "iconPin",
        label: isPinned(item) ? "取消固定到新标签页" : "固定到新标签页",
        click: () => {
            void toggleInGroup(plugin as any, "pinned", item).then(on => {
                showMessage(on ? "已固定到新标签页" : "已取消固定", 2000, "info");
                onAfter?.();
            });
        },
    });
    menu.addItem({
        icon: "iconStar",
        label: isFavorite(item) ? "取消收藏" : "收藏",
        click: () => {
            void toggleInGroup(plugin as any, "favorites", item).then(on => {
                showMessage(on ? "已收藏" : "已取消收藏", 2000, "info");
                onAfter?.();
            });
        },
    });
}

// 导入 Markdown 到某个文档下(对齐思源文档树的「导入 Markdown 文档/文件夹」)。
//
// 走 /api/import/importStdMd,参数与思源原生一致:
//   notebook = 文档所属笔记本;toPath = 文档的**存储路径**(/xxx.sy);localPath = 用户选的本地路径。
// 注意 toPath 必须是 .sy 存储路径而不是 hpath:内核 resolveMarkdownImportTarget 按
// blocktrees.path(存储路径)查目标文档,传 hpath 会报 "target document not found"。
// 选路径要弹系统对话框,思源没给插件开放 API,只能走 Electron IPC(见 utils/open-dialog)。
async function importInto(docId: string, isDir: boolean, after: () => void): Promise<void> {
    const localPath = await showOpenDialog({
        properties: [isDir ? "openDirectory" : "openFile"],
        filters: isDir ? [] : [{name: "Markdown", extensions: ["md", "markdown"]}],
    });
    if (!localPath) return; // 取消,或拿不到对话框(非桌面端)
    const info = await getDocInfo(docId);
    if (!info?.box || !info?.path) {
        showMessage("无法确定文档所属笔记本", 3000, "error");
        return;
    }
    try {
        await postJSON("/api/import/importStdMd", {
            notebook: info.box,
            localPath,
            toPath: info.path,
        });
        showMessage(isDir ? "文件夹已导入,非 Markdown 文件作为资源" : "文档已导入", 3000, "info");
        after();
    } catch (e: any) {
        showMessage(`导入失败: ${e?.message || e}`, 4000, "error");
    }
}

// 思源文档的右键菜单(挂载的思源文档、子文档、标签面板 sydoc:// 条目共用)。
// 结构对齐思源文档树:打开 / 新建子文档 / 复制(原生复制子菜单) / 重命名 / 删除 / 固定 / 收藏,
// extra 由调用方追加面板特有项(标签、取消挂载、挂载子菜单等)。
export function showDocMenu(opts: {
    x: number;
    y: number;
    plugin: IDocMenuPlugin;
    docId: string;
    name?: string;          // 显示名(重命名默认值;缺省查内核)
    extra?: DocMenuItem[];  // 追加在末尾(前面加分隔线)
    onAfter?: () => void;   // 新建/重命名/删除/副本/固定收藏后回调(面板重绘)
}): void {
    const {plugin, docId, onAfter} = opts;
    const after = () => {
        clearDocInfoCache();
        onAfter?.();
    };
    const menu = new Menu();
    menu.addItem({
        icon: "iconOpen",
        label: lang("openDocument", "打开文档"),
        click: () => openSiyuanDoc(docId, plugin.app),
    });
    menu.addSeparator();
    menu.addItem({
        icon: "iconAddDoc",
        label: lang("newSubDoc", "新建子文档"),
        click: () => {
            void (async () => {
                const untitled = lang("untitled", "未命名文档");
                const title = await promptDialog(lang("newSubDoc", "新建子文档"), untitled);
                if (!title) return;
                const info = await getDocInfo(docId);
                if (!info?.box) {
                    showMessage("无法确定文档所属笔记本", 3000, "error");
                    return;
                }
                // path 必须是**包含父文档的完整人类可读路径**(/父文档/新文档);
                // parentID 仅用于同名父文档时精确定位(内核 issue 8138)
                const parentHpath = info.hpath && info.hpath !== "/" ? info.hpath : "";
                await createDocWithMd(info.box, `${parentHpath}/${title}`, "", docId);
                showMessage("子文档已创建", 2000, "info");
                after();
            })().catch((e: any) => showMessage(`创建失败: ${e?.message || e}`, 3000, "error"));
        },
    });
    menu.addSeparator();
    menu.addItem({
        icon: "iconCopy",
        label: lang("copy", "复制"),
        submenu: copySubMenuItems(docId, after) as any,
    });
    menu.addItem({
        icon: "iconUpload",
        label: lang("export", "导出"),
        submenu: [
            {
                label: "Markdown .md",
                click: () => {
                    void (async () => {
                        const data = await exportMdContent(docId);
                        const name = (opts.name || data.hPath.split("/").pop() || docId).replace(/[\\/:*?"<>|]/g, "_");
                        downloadText(`${name}.md`, data.content);
                    })().catch((e: any) => showMessage(`导出失败: ${e?.message || e}`, 3000, "error"));
                },
            },
        ] as any,
    });
    // 导入 Markdown:思源文档树右键原生就有这两项(单个 md 文件 / 整个文件夹),
    // 插件的文档菜单之前漏了,虚拟文档树里挂载的文档就没法往里导入。
    // 语义与原生一致:导入到**该文档下**(toPath 用它的 hpath)。
    menu.addItem({
        icon: "iconDownload",
        label: lang("import", "导入"),
        submenu: [
            {
                label: "Markdown 文档",
                click: () => void importInto(docId, false, after),
            },
            {
                label: "Markdown 文件夹",
                click: () => void importInto(docId, true, after),
            },
        ] as any,
    });
    menu.addSeparator();
    menu.addItem({
        icon: "iconEdit",
        label: lang("rename", "重命名"),
        click: () => {
            void (async () => {
                let current = opts.name || "";
                if (!current) {
                    const info = await getDocInfo(docId);
                    current = info?.hpath?.split("/").pop() || docId;
                }
                const title = await promptDialog(lang("rename", "重命名"), current);
                if (!title) return;
                await renameDocByID(docId, title);
                showMessage("重命名成功", 2000, "info");
                after();
            })().catch((e: any) => showMessage(`重命名失败: ${e?.message || e}`, 3000, "error"));
        },
    });
    // 移动文档位置:选笔记本 → 顶层;选文档 → 作为其子文档(对齐原生文档树的「移动」)
    menu.addItem({
        icon: "iconMove",
        label: lang("move", "移动"),
        click: () => void moveDocTargetDialog(docId, opts.name || docId, after),
    });
    menu.addItem({
        icon: "iconTrashcan",
        label: lang("delete", "删除"),
        click: () => {
            const name = opts.name || docId;
            confirm(`⚠️ ${lang("delete", "删除")} ${name}`, lang("confirmDelete", "确定删除该文档吗?删除后无法恢复"), () => {
                void removeDocByID(docId).then(() => {
                    showMessage("文档已删除", 2000, "info");
                    after();
                }).catch((e: any) => showMessage(`删除失败: ${e?.message || e}`, 3000, "error"));
            }, () => {});
        },
    });
    addPinFavEntries(menu, plugin, docId, opts.name || docId, onAfter);
    if (opts.extra && opts.extra.length > 0) {
        menu.addSeparator();
        for (const it of opts.extra) menu.addItem(it);
    }
    menu.open({x: opts.x, y: opts.y});
}

// 思源笔记本的右键菜单(挂载的笔记本用):新建文档 / 重命名,对齐原生笔记本菜单的常用项。
export function showNotebookMenu(opts: {
    x: number;
    y: number;
    plugin: IDocMenuPlugin;
    notebookId: string;
    name?: string;
    extra?: DocMenuItem[];
    onAfter?: () => void;
}): void {
    const {plugin, notebookId, onAfter} = opts;
    const menu = new Menu();
    menu.addItem({
        icon: "iconOpen",
        label: lang("openNotebook", "在思源中打开笔记本"),
        // 笔记本 id 用 openSiyuanDoc(openTab/协议)打不开,走打开其中第一篇文档的逻辑
        click: () => openSiyuanNotebook(notebookId, plugin.app),
    });
    menu.addSeparator();
    menu.addItem({
        icon: "iconAddDoc",
        label: lang("newDoc", "新建文档"),
        click: () => {
            void (async () => {
                const untitled = lang("untitled", "未命名文档");
                const title = await promptDialog(lang("newDoc", "新建文档"), untitled);
                if (!title) return;
                await createDocWithMd(notebookId, "/" + title, "");
                showMessage("文档已创建", 2000, "info");
                onAfter?.();
            })().catch((e: any) => showMessage(`创建失败: ${e?.message || e}`, 3000, "error"));
        },
    });
    menu.addItem({
        icon: "iconEdit",
        label: lang("rename", "重命名"),
        click: () => {
            void (async () => {
                const current = opts.name || notebookId;
                const name = await promptDialog(lang("rename", "重命名"), current);
                if (!name || name === current) return;
                await renameNotebook(notebookId, name);
                showMessage("重命名成功", 2000, "info");
                onAfter?.();
            })().catch((e: any) => showMessage(`重命名失败: ${e?.message || e}`, 3000, "error"));
        },
    });
    addPinFavEntries(menu, plugin, notebookId, opts.name || notebookId, onAfter);
    if (opts.extra && opts.extra.length > 0) {
        menu.addSeparator();
        for (const it of opts.extra) menu.addItem(it);
    }
    menu.open({x: opts.x, y: opts.y});
}
