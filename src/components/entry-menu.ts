// 条目(文件 / 思源文档)的右键菜单,「最近使用」面板与新标签页共用。
// 统一提供:打开 / 分栏打开 / 复制各类链接 / 在文件夹树中定位 / 固定到新标签页 / 收藏。
import {Menu, showMessage, openTab} from "siyuan";
import {openFileTab} from "../tabs/editor-tab";
import {toFileLink, toMarkdownFileLink} from "../utils/system-path";
import {copyText, revealInFileTree} from "./file-tree";
import {removeRecent} from "../recent-files";
import {isPinned, isFavorite, itemFromPath, itemFromDoc, toggleInGroup} from "../start-page";
import {isVirtualPath, virtualId} from "../utils/virtual-tree";

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
// 系统协议未注册或无法唤起时协议跳转会静默失败);失败再回退 siyuan:// 协议
export function openSiyuanDoc(id: string, app?: any): void {
    if (app) {
        try {
            void openTab({app, doc: {id}}).catch(() => openDocByProtocol(id));
            return;
        } catch {
            // openTab 不可用时走协议跳转
        }
    }
    openDocByProtocol(id);
}

// 打开条目:文档 → 应用内打开(回退协议);文件 → openFileTab 统一路由
// 思源虚拟路径(sydoc://<id>,思源文档/块在标签面板、收藏等处以此作键)→ 走思源协议
export function openEntry(plugin: IPluginForEntryMenu, target: EntryTarget): void {
    if (target.kind === "doc" && target.id) openSiyuanDoc(target.id, plugin.app);
    else if (target.path) {
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
            click: () => openSiyuanDoc(target.id!),
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
