// 思源文档右键:列出当前文档引用的外部文件(排除图片)。
//
// 两个入口,同一个弹窗:
//   A. 正文右键(open-menu-content 官方插件事件,条目落「插件」子菜单):
//      1. exportMdContent(rootID) 一次性拿整篇 markdown(比逐块 SQL 稳,
//         折叠/未加载的块也覆盖);
//      2. 正则抽取 markdown 链接与 HTML 嵌入(video/audio/embed/iframe/object)
//         里的地址;
//      3. 只保留能解析成本地文件的:assets/ 资源、file:// 链接、裸本地绝对路径
//         (http/siyuan:// 等解析不了自然淘汰),按扩展名排除图片;
//      4. 分组展示(本地文件 / 工作空间资源),行点击 = 插件页签打开,
//         悬停按钮 = 在文件夹树定位 / 复制路径。
//   B. 文档页签头右键(见 registerDocExternalFilesMenu 内注释,DOM 层补挂)。
import {Dialog, showMessage} from "siyuan";
import type {Plugin} from "siyuan";
import {exportMdContent} from "../api/file";
import {openFileTab} from "../tabs/editor-tab";
import {copyText, revealInFileTree} from "../components/file-tree";
import {isImageFile} from "../constants";
import {basename, extname} from "../utils/path";
import {toAbsolutePath} from "../open-takeover/doc-open-takeover";

interface ExternalFileItem {
    /** 系统绝对路径(正斜杠形式,与 toAbsolutePath 输出一致) */
    path: string;
    /** assets/ 工作空间资源 | 本地文件(file:// / 裸绝对路径) */
    kind: "asset" | "local";
    /** 被引用次数(同一文件多处引用只显示一行) */
    count: number;
}

// markdown 链接: [text](url)、![alt](url)、[text](<含空格 url> "title")。
// 链接文字段允许转义序列(kramdown 会把 ] 转义成 \],如 [a\]b](assets/a]b.pdf));
// URL 段用惰性 [^)]*?(容纳未转义空格 —— 思源 assets 文件名常含空格),
// 尖括号包裹与标题后缀("title"/'title')在 add() 里统一剥离;
// 「!」前缀不参与捕获,图片与文件走同一正则,之后按扩展名分流
const MD_LINK_RE = /\[(?:[^\]\\]|\\.)*\]\(([^)]*?)\)/g;
// HTML 嵌入标签的 src/data 属性(思源导出的视频/音频是 <video src="assets/x.mp4">)
const HTML_SRC_RE = /<(?:video|audio|embed|iframe|object)\b[^>]*\b(?:src|data)="([^"]+)"/gi;

// isImageFile 覆盖之外的图片格式(思源列表没列,但视觉上就是图片)
const EXTRA_IMAGE_EXTS = new Set([".heic", ".heif", ".emf", ".wmf"]);

function isImageRef(path: string): boolean {
    return isImageFile(path) || EXTRA_IMAGE_EXTS.has(extname(path));
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 从文档 markdown 源里抽取引用的外部文件(排除图片)。
 * 同一文件多处引用合并为一条(count 累计),按路径排序。
 */
export function extractExternalFiles(md: string): ExternalFileItem[] {
    const byPath = new Map<string, ExternalFileItem>();
    const add = (raw: string) => {
        let url = (raw || "").trim();
        if (!url) return;
        // 先剥链接标题后缀( [a](<url> "标题") / [a](url '标题') ),
        // 再剥 <...> 包裹(路径含空格的 kramdown 写法)
        const titled = /^(.*?)[ \t]+("[^"]*"|'[^']*')$/.exec(url);
        if (titled) url = titled[1].trim();
        const angled = /^<(.*)>$/.exec(url);
        if (angled) url = angled[1].trim();
        if (!url) return;
        // 与「接管文档内打开」同一套解析:assets/ → 工作空间路径,file:// → 绝对路径,
        // http/siyuan:// 等返回 null 自然淘汰 —— 列表里的每一项都和点击链接打开的是同一个文件
        const path = toAbsolutePath(url);
        if (!path || isImageRef(path)) return;
        const kind: ExternalFileItem["kind"] = /^assets\//i.test(url) ? "asset" : "local";
        const prev = byPath.get(path);
        if (prev) prev.count++;
        else byPath.set(path, {path, kind, count: 1});
    };
    for (const m of md.matchAll(MD_LINK_RE)) add(m[1]);
    for (const m of md.matchAll(HTML_SRC_RE)) add(m[1]);
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

function showDocExternalFilesDialog(plugin: Plugin, rootId: string): void {
    let token = 0; // 弹窗销毁后使在途渲染失效
    const dlg = new Dialog({
        title: "文档引用的外部文件",
        content: `<div class="syfe-efdlg">
    <div class="syfe-efdlg__bar">
        <span class="syfe-efdlg__sub"></span>
        <button class="b3-button b3-button--text" data-act="refresh" title="重新扫描文档">刷新</button>
    </div>
    <div class="syfe-efdlg__body"><div class="syfe-efdlg__hint">正在扫描文档引用…</div></div>
</div>`,
        width: "720px",
        height: "56vh",
        destroyCallback: () => {
            token++;
        },
    });

    const body = dlg.element.querySelector(".syfe-efdlg__body") as HTMLElement;
    const sub = dlg.element.querySelector(".syfe-efdlg__sub") as HTMLElement;

    const render = (items: ExternalFileItem[]) => {
        if (items.length === 0) {
            body.innerHTML = `<div class="syfe-efdlg__hint">文档没有引用外部文件(图片已排除)</div>`;
            return;
        }
        const row = (item: ExternalFileItem) => `
            <div class="syfe-efdlg__item" data-idx="${items.indexOf(item)}">
                <div class="syfe-efdlg__itemhead">
                    <svg><use xlink:href="#iconFile"></use></svg>
                    <span class="syfe-efdlg__name" title="${escapeHTML(item.path)}">${escapeHTML(basename(item.path))}</span>
                    ${item.count > 1 ? `<span class="syfe-efdlg__count">×${item.count}</span>` : ""}
                    <span class="syfe-efdlg__path" title="${escapeHTML(item.path)}">${escapeHTML(item.path)}</span>
                    <span class="syfe-efdlg__act" data-act="locate" title="在文件夹树中定位"><svg><use xlink:href="#iconFolder"></use></svg></span>
                    <span class="syfe-efdlg__act" data-act="copy" title="复制路径"><svg><use xlink:href="#iconCopy"></use></svg></span>
                </div>
            </div>`;
        const section = (title: string, list: ExternalFileItem[]) => list.length === 0 ? "" : `
            <div class="syfe-efdlg__group">${escapeHTML(title)}(${list.length})</div>
            ${list.map(row).join("")}`;
        body.innerHTML = section("本地文件", items.filter(i => i.kind === "local"))
            + section("工作空间资源(assets)", items.filter(i => i.kind === "asset"));
        // 行点击 = 用插件页签打开;悬停出来的图标按钮 = 定位 / 复制
        body.querySelectorAll<HTMLElement>(".syfe-efdlg__item").forEach(node => {
            node.addEventListener("click", (ev) => {
                const item = items[Number(node.dataset.idx)];
                if (!item) return;
                const act = (ev.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
                if (act === "locate") {
                    void revealInFileTree(item.path);
                    return;
                }
                if (act === "copy") {
                    void copyText(item.path).then(ok => {
                        if (ok) showMessage("路径已复制", 1500, "info");
                    });
                    return;
                }
                openFileTab(plugin as any, item.path);
            });
        });
    };

    const load = async () => {
        const t = token;
        body.innerHTML = `<div class="syfe-efdlg__hint">正在扫描文档引用…</div>`;
        try {
            const {hPath, content} = await exportMdContent(rootId);
            if (t !== token) return;
            sub.textContent = hPath || "";
            render(extractExternalFiles(content || ""));
        } catch (e) {
            if (t !== token) return;
            body.innerHTML = `<div class="syfe-efdlg__hint">扫描失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    dlg.element.querySelector("[data-act='refresh']")!.addEventListener("click", () => {
        void load();
    });
    void load();
}

// 页签头 → 文档 rootID。
// 页签头 li 与对应面板 div 都以 tab id 为 data-id(思源 Tab 构造器给两者写),
// 在所属分屏内按 id 找到面板;文档页签面板里有 .protyle-title[data-node-id]
// = 文档 rootID(Title 渲染时写入)。资产页签 / 插件自定义页签没有 → null。
function docRootIdOfTabHeader(header: HTMLElement): string | null {
    const tabId = header.getAttribute("data-id");
    if (!tabId) return null;
    const scope = header.closest('[data-type="wnd"]') || document;
    const panel = scope.querySelector(`[data-id="${tabId.replace(/["\\]/g, "\\$&")}"]`);
    if (!panel) return null;
    return panel.querySelector(".protyle-title[data-node-id]")?.getAttribute("data-node-id") || null;
}

/**
 * 注册两个右键入口,返回注销函数(window 监听必须随插件卸载摘除,
 * eventBus 监听由思源随插件实例回收,无需处理)。
 *   A. 正文右键:open-menu-content 官方插件事件,条目落「插件」子菜单;
 *   B. 文档页签头右键:思源对此**没有插件事件**(menus/index.ts 的 window
 *      冒泡委托直接 initTabMenu → 单例菜单同步 popup),只能在 DOM 层补挂:
 *      - 挂 window **捕获**监听。不能挂冒泡蹭时序:思源的委托注册于 Menus
 *        构造器,而 app/src/index.ts 里 loadPlugins 先于 new Menus → 双方
 *        注册顺序不定;捕获阶段恒先于同节点冒泡阶段,必先于思源处理器执行;
 *      - 此刻原生菜单尚未构建,setTimeout(0) 推迟到事件分发结束后再追加;
 *      - 追加前三重校验:单例菜单存在、处于打开态(无 fn__none,shift 右键
 *        等未弹菜单的场景由此兜住)、data-name==="tab"(initTabMenu 特有标记,
 *        思源其它菜单不会冒充)。
 *      菜单条目不会泄漏到后续菜单:单例菜单每次关闭都清空全部条目。
 */
export function registerDocExternalFilesMenu(plugin: Plugin): () => void {
    // A. 正文右键(官方插件菜单事件)
    plugin.eventBus.on("open-menu-content", (e: any) => {
        const menu = e?.detail?.menu;
        const rootId = e?.detail?.protyle?.block?.rootID;
        if (!menu || !rootId) return;
        menu.addItem({
            icon: "iconLink",
            label: "引用的外部文件",
            click: () => showDocExternalFilesDialog(plugin, rootId),
        });
    });

    // B. 页签头右键(见函数注释)
    const onTabHeaderContextMenu = (ev: MouseEvent) => {
        if (ev.shiftKey) return; // 思源对 shift 右键放行浏览器原生菜单,不弹菜单
        const target = ev.target as HTMLElement | null;
        const header = target?.closest?.('[data-type="tab-header"]') as HTMLElement | null;
        if (!header) return;
        const rootId = docRootIdOfTabHeader(header);
        if (!rootId) return; // 非文档页签(资产/插件页签)不提供
        // 原生页签菜单在本次事件的冒泡阶段才构建,捕获阶段先记下,
        // 宏任务里(分发已结束、菜单已同步弹出)再校验并追加
        setTimeout(() => {
            const menu = (window as any).siyuan?.menus?.menu;
            if (!menu?.addItem || !menu.element) return;
            if (menu.element.classList.contains("fn__none")) return; // 菜单未打开
            if (menu.element.getAttribute("data-name") !== "tab") return; // 非页签菜单
            menu.addItem({type: "separator"});
            menu.addItem({
                icon: "iconLink",
                label: "引用的外部文件",
                click: () => showDocExternalFilesDialog(plugin, rootId),
            });
        }, 0);
    };
    window.addEventListener("contextmenu", onTabHeaderContextMenu, true);
    return () => {
        try {
            window.removeEventListener("contextmenu", onTabHeaderContextMenu, true);
        } catch {
            // 窗口销毁场景忽略
        }
    };
}
