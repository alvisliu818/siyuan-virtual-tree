// 思源文档/笔记本的「原生」右键菜单:对齐思源文档树(initFileMenu / initNavigationMenu)的
// 操作子集,全部通过内核 API 实现,操作结果与在思源文档树里操作完全一致。
// 虚拟文档树(挂载的思源文档/笔记本/子文档)与标签面板(sydoc:// 条目)共用。
import {Menu, confirm, showMessage} from "siyuan";
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
} from "../api/file";
import {getDocInfo, clearDocInfoCache} from "../utils/virtual-tree";
import {openSiyuanDoc} from "./entry-menu";
import {promptDialog, copyText} from "./file-tree";
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
        click: () => openSiyuanDoc(notebookId, plugin.app),
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
