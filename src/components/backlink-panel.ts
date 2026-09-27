// 反向链接面板:嵌入各文件 Tab,展示引用当前文件的所有位置,点击跳转。
// 默认收起;首次展开时懒扫描。跳转:
// - 思源文档块 → siyuan://blocks/<id> 协议(思源打开文档并定位块)
// - Markdown 文件 → Markdown Tab 源码模式打开并定位到引用行
import {BacklinkItem, findBacklinks} from "../utils/backlink";
import {openMarkdownTab} from "../tabs/markdown-tab";
import {setPendingReveal} from "../editor/model-manager";

// 面板所需的插件接口(结构化类型,避免循环依赖加剧)
export interface IPluginForBacklink {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

export interface BacklinkPanel {
    el: HTMLElement;
    setTarget(path: string): void; // 切换被引用文件(图片 Tab 同目录切换时)
    refresh(): void;
    dispose(): void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 跳转到引用来源
export function navigateBacklink(plugin: IPluginForBacklink, item: BacklinkItem): void {
    if (item.kind === "siyuan-doc") {
        // 思源协议链接:打开文档并定位到块
        const a = document.createElement("a");
        a.href = `siyuan://blocks/${item.blockId}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
    }
    // Markdown 文件:源码模式打开并定位引用行
    if (item.lineNo) {
        setPendingReveal(item.sourcePath, item.lineNo);
    }
    openMarkdownTab(plugin as any, item.sourcePath, "source");
}

// 创建反向链接面板;targetPath 为被引用文件路径
export function createBacklinkPanel(plugin: IPluginForBacklink, targetPath: string): BacklinkPanel {
    let target = targetPath;
    let collapsed = true;
    let loading = false;
    let token = 0;

    const el = document.createElement("div");
    el.className = "syfe-backlink syfe-backlink--collapsed";
    el.innerHTML = `
        <div class="syfe-backlink__header" title="展开/收起反向链接">
            <svg class="syfe-backlink__icon"><use xlink:href="#iconLink"></use></svg>
            <span class="syfe-backlink__title">引用</span>
            <span class="syfe-backlink__count"></span>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--small" data-act="refresh" title="重新扫描引用">刷新</button>
        </div>
        <div class="syfe-backlink__body"></div>`;

    const header = el.querySelector(".syfe-backlink__header") as HTMLElement;
    const countEl = el.querySelector(".syfe-backlink__count") as HTMLElement;
    const body = el.querySelector(".syfe-backlink__body") as HTMLElement;

    const render = (items: BacklinkItem[]) => {
        countEl.textContent = items.length > 0 ? String(items.length) : "";
        if (items.length === 0) {
            body.innerHTML = `<div class="syfe-backlink__hint">没有找到引用</div>`;
            return;
        }
        body.innerHTML = items.map(item => {
            const icon = item.kind === "siyuan-doc" ? "iconFile" : "iconMarkdown";
            const loc = item.kind === "siyuan-doc"
                ? escapeHTML(item.docPath || "")
                : `${escapeHTML(item.sourcePath)}${item.lineNo ? ` : ${item.lineNo}` : ""}`;
            return `
                <div class="syfe-backlink__item" data-idx="${items.indexOf(item)}" title="${escapeHTML(loc)}">
                    <div class="syfe-backlink__itemhead">
                        <svg><use xlink:href="#${icon}"></use></svg>
                        <span class="syfe-backlink__itemtitle">${escapeHTML(item.title)}</span>
                        <span class="syfe-backlink__itemloc">${escapeHTML(loc)}</span>
                    </div>
                    ${item.snippet ? `<div class="syfe-backlink__snippet">${escapeHTML(item.snippet)}</div>` : ""}
                </div>`;
        }).join("");
        // 点击跳转
        body.querySelectorAll<HTMLElement>(".syfe-backlink__item").forEach(node => {
            node.addEventListener("click", () => {
                const item = items[Number(node.dataset.idx)];
                if (item) navigateBacklink(plugin, item);
            });
        });
    };

    const load = async () => {
        if (loading) return;
        loading = true;
        const t = ++token;
        body.innerHTML = `<div class="syfe-backlink__hint">扫描引用中…</div>`;
        try {
            const items = await findBacklinks(targetPath);
            if (t !== token) return;
            render(items);
        } catch (e) {
            if (t !== token) return;
            body.innerHTML = `<div class="syfe-backlink__hint">扫描失败: ${escapeHTML(String(e))}</div>`;
        } finally {
            loading = false;
        }
    };

    header.addEventListener("click", (e) => {
        // 刷新按钮不触发折叠
        if ((e.target as HTMLElement).closest("[data-act='refresh']")) return;
        collapsed = !collapsed;
        el.classList.toggle("syfe-backlink--collapsed", collapsed);
        if (!collapsed && !body.childElementCount) void load();
    });
    el.querySelector("[data-act='refresh']")!.addEventListener("click", () => {
        collapsed = false;
        el.classList.remove("syfe-backlink--collapsed");
        void load();
    });

    // 外部请求刷新(如斜杆命令插入了指向本文件的链接):目标匹配则重扫
    const onRefreshRequest = (e: Event) => {
        const p = (e as CustomEvent)?.detail?.path;
        if (!p || p !== target) return;
        body.innerHTML = "";
        countEl.textContent = "";
        collapsed = false;
        el.classList.remove("syfe-backlink--collapsed");
        void load();
    };
    window.addEventListener("syfe:backlink-refresh", onRefreshRequest);

    return {
        el,
        setTarget(path: string) {
            if (path === target) return;
            target = path;
            body.innerHTML = "";
            countEl.textContent = "";
            if (!collapsed) void load();
        },
        refresh() {
            collapsed = false;
            el.classList.remove("syfe-backlink--collapsed");
            void load();
        },
        dispose() {
            token++; // 使未完成的渲染失效
            window.removeEventListener("syfe:backlink-refresh", onRefreshRequest);
        },
    };
}
