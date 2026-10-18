// 条目(文件 / 思源文档)的右键菜单,「最近使用」面板与新标签页共用。
// 统一提供:打开 / 分栏打开 / 复制各类链接 / 在文件夹树中定位 / 固定到新标签页 / 收藏。
import {Menu, showMessage, openTab} from "siyuan";
import {openFileTab} from "../tabs/editor-tab";
import {toFileLink, toMarkdownFileLink} from "../utils/system-path";
import {copyText, revealInFileTree} from "./file-tree";
import {removeRecent} from "../recent-files";
import {isPinned, isFavorite, itemFromPath, itemFromDoc, toggleInGroup} from "../start-page";
import {isNotebookId} from "../utils/siyuan-icon";
import {dispatchMountTreeEvent} from "../utils/mount-locate";
import {isVirtualPath, virtualId, virtualListDir, isBoxDocEnabled, VIRTUAL_PREFIX} from "../utils/virtual-tree";

// 菜单目标:兼容 recent-files 的 RecentEntry 与 start-page 的 StartPageItem
export interface EntryTarget {
    kind: "file" | "doc";
    path?: string;
    id?: string;
    title?: string;
    hpath?: string;
}

// 菜单所需的插件接口
export interface IPluginForEntryMenu {
    app: any;
    name: string;
    openFileSplit(path: string, position: "right" | "bottom"): void;
}

function copyWithToast(text: string | null, okMsg: string, failMsg: string): void {
    if (!text) {
        showMessage(failMsg, 3000, "error");
        return;
    }
    copyText(text).then(
        ok => ok ? showMessage(okMsg, 2500, "info") : showMessage("复制失败", 2000, "error"),
    );
}

// 思源协议链接跳转并定位(兜底:不依赖 app 实例,但需系统已注册 siyuan:// 协议)
function openDocByProtocol(id: string): void {
    const a = document.createElement("a");
    a.href = `siyuan://blocks/${id}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// 打开思源文档:优先 openTab 在当前应用内直接打开正文(挂载文档/最近文档等场景
// 系统协议未注册或无法唤起时协议跳转会静默失败);失败再回退 siyuan:// 协议。
// 返回:openTab 成功 → true;openTab 失败转协议 / 未传 app 走协议 → false
// (协议跳转是 fire-and-forget,结果无法确认,调用方不能据此声称"已打开")。
export function openSiyuanDoc(id: string, app?: any): Promise<boolean> {
    if (app) {
        try {
            return openTab({app, doc: {id}}).then(
                () => true,
                () => {
                    openDocByProtocol(id);
                    return false;
                });
        } catch {
            // openTab 不可用时走协议跳转
        }
    }
    openDocByProtocol(id);
    return Promise.resolve(false);
}

// 打开思源笔记本:笔记本 id 与文档 id 同格式,但 openTab/siyuan:// 协议都打不开
// (两者只认文档/块 id,对笔记本 id 静默失败)。「启用顶层笔记本文档」时笔记本
// 自己就是那篇顶层文档(id 相同),直接按文档打开;否则打开笔记本下的第一篇文档,
// 且只在确认打开成功后才提示——协议回退的结果无法确认,不能谎称"已打开"。
export async function openSiyuanNotebook(id: string, app?: any): Promise<void> {
    if (isBoxDocEnabled()) {
        await openSiyuanDoc(id, app);
        locateSiyuanDocInMountTree(id);
        return;
    }
    let first: {name: string; docId: string} | null = null;
    try {
        const kids = await virtualListDir(VIRTUAL_PREFIX + "nb/" + id);
        const e = (kids || [])[0];
        if (e) first = {name: String(e.name || ""), docId: virtualId(e.path)};
    } catch {
        // 查询失败按空笔记本处理
    }
    if (!first || !first.docId) {
        showMessage("该笔记本下还没有文档", 2500, "info");
        return;
    }
    const ok = await openSiyuanDoc(first.docId, app);
    // 树里若挂载了该笔记本/文档,顺带闪烁定位到打开的这篇
    locateSiyuanDocInMountTree(first.docId);
    if (ok) {
        showMessage(`笔记本没有自己的正文,已打开其中的文档:${first.name}`, 3000, "info");
    }
}

// 自动识别文档/笔记本后走对应的打开逻辑(固定/收藏/最近里的条目可能是笔记本 id)
// 是文档的话,顺带在虚拟文档树里闪烁定位一下(树里没有它时静默跳过,不打扰)
export function openSiyuanDocAuto(id: string, app?: any): void {
    // 「启用顶层笔记本文档」时笔记本 id 就是它那篇顶层文档的 id,直接按文档打开即可
    // (固定/收藏里存的就是这篇文档);关闭时笔记本只是容器,才需要取它下面的第一篇。
    if (isBoxDocEnabled()) {
        openSiyuanDoc(id, app);
        locateSiyuanDocInMountTree(id);
        return;
    }
    void (async () => {
        if (await isNotebookId(id)) {
            await openSiyuanNotebook(id, app);
            return;
        }
        openSiyuanDoc(id, app);
        locateSiyuanDocInMountTree(id);
    })();
}

// 让虚拟文档树闪烁定位到某篇文档(挂载树面板监听;未挂载时静默无动作)
export function locateSiyuanDocInMountTree(docId: string): void {
    dispatchMountTreeEvent("syfe:mount-tree-locate-doc", {docId});
}

// 打开条目:文档 → 自动识别文档/笔记本后打开(笔记本 id 用 openSiyuanDoc 打不开);
// 文件 → openFileTab 统一路由
// 思源虚拟路径(sydoc://<id>,思源文档/块在标签面板、收藏等处以此作键)→ 走思源协议
export function openEntry(plugin: IPluginForEntryMenu, target: EntryTarget): void {
    if (target.kind === "doc" && target.id) {
        openSiyuanDocAuto(target.id, plugin.app);
    } else if (target.path) {
        if (isVirtualPath(target.path)) {
            const id = virtualId(target.path);
            if (id) {
                openSiyuanDoc(id, plugin.app);
                return;
            }
        }
        openFileTab(plugin as any, target.path);
    }
}

// 弹出右键菜单
// removable=true 时额外显示「从最近使用中移除」(仅最近使用列表需要)
// extra 供调用方追加菜单项(如标签面板的「标签…」「从此标签中移除」),避免各处重复实现整套菜单
export function showEntryMenu(opts: {
    x: number;
    y: number;
    target: EntryTarget;
    plugin: IPluginForEntryMenu;
    removable?: boolean;
    extra?: Array<{icon?: string; label: string; click: () => void}>;
}): void {
    const {target, plugin, removable, extra} = opts;
    const menu = new Menu();
    if (target.kind === "doc" && target.id) {
        menu.addItem({
            icon: "iconOpen",
            label: "打开文档",
            // 条目可能是笔记本 id,走自动识别(笔记本 → 打开其中第一篇文档)
            click: () => openSiyuanDocAuto(target.id!, plugin.app),
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconLink",
            label: "复制思源链接",
            click: () => copyWithToast(`siyuan://blocks/${target.id}`, "思源链接已复制", "复制失败"),
        });
    } else if (target.path) {
        menu.addItem({
            icon: "iconOpen",
            label: "打开",
            click: () => openFileTab(plugin as any, target.path!),
        });
        menu.addItem({
            label: "分栏打开",
            submenu: [
                {label: "在右侧分栏打开", click: () => plugin.openFileSplit(target.path!, "right")},
                {label: "在下方分栏打开", click: () => plugin.openFileSplit(target.path!, "bottom")},
            ],
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconCopy",
            label: "复制路径",
            click: () => copyWithToast(target.path!, "路径已复制", "复制失败"),
        });
        menu.addItem({
            icon: "iconLink",
            label: "复制链接 (file://)",
            click: () => copyWithToast(
                toFileLink(target.path!), "链接已复制,可粘贴到思源或浏览器使用", "无法获取工作空间路径,复制链接失败",
            ),
        });
        menu.addItem({
            icon: "iconLink",
            label: "复制 Markdown 链接",
            click: () => copyWithToast(
                toMarkdownFileLink(target.path!)?.md ?? null, "Markdown 链接已复制", "无法获取工作空间路径,复制链接失败",
            ),
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconFolder",
            label: "在文件夹树中定位",
            click: () => {
                void revealInFileTree(target.path!);
            },
        });
    }

    // 固定 / 收藏(两组数据独立,可同时存在)
    const item = target.kind === "doc"
        ? itemFromDoc(target.id!, target.title || target.id!, target.hpath)
        : itemFromPath(target.path!);
    menu.addSeparator();
    const pinned = isPinned(item);
    menu.addItem({
        icon: "iconPin",
        label: pinned ? "取消固定到新标签页" : "固定到新标签页",
        click: () => void toggleInGroup(plugin as any, "pinned", item),
    });
    const faved = isFavorite(item);
    menu.addItem({
        icon: "iconStar",
        label: faved ? "取消收藏" : "收藏",
        click: () => void toggleInGroup(plugin as any, "favorites", item),
    });

    if (removable) {
        menu.addSeparator();
        menu.addItem({
            icon: "iconTrashcan",
            label: "从最近使用中移除",
            click: () => void removeRecent(plugin as any, target as any),
        });
    }
    // 调用方追加项
    if (extra && extra.length > 0) {
        menu.addSeparator();
        for (const it of extra) {
            menu.addItem({icon: it.icon, label: it.label, click: it.click});
        }
    }
    menu.open({x: opts.x, y: opts.y});
}
