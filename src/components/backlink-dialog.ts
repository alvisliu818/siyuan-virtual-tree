// 双链弹窗:虚拟文档树行末「查看引用」图标的展示层。
// 由调用方传入标题与数据加载函数(load 入链;loadOut 出链,可选 —— 传入才显示
// 入链/出链切换),弹窗负责加载态、分组渲染与点击跳转:
// - 思源文档块 → siyuan://blocks/<id> 协议(思源打开文档并定位块)
// - 文件 → openFileTab 按扩展名分发页签(入链定位到引用行,出链带上目标位置)
// 数据来源见 utils/backlink.ts:文件引用 / 文件夹引用 / 思源原生反链(refs 表)。
import {Dialog} from "siyuan";
import {BacklinkItem, backlinkPosBadgeHTML} from "../utils/backlink";
import {IPluginForBacklink, navigateBacklink, navigateOutlink} from "./backlink-panel";

export interface BacklinkDialogOptions {
    title: string;
    /** 副标题:文件路径 / 文档 ID 等目标说明 */
    subtitle?: string;
    /** 入链数据加载(谁引用了目标) */
    load: () => Promise<BacklinkItem[]>;
    /** 出链数据加载(目标指向哪些文件);传入才显示入链/出链切换 */
    loadOut?: () => Promise<BacklinkItem[]>;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function showBacklinkDialog(plugin: IPluginForBacklink, opts: BacklinkDialogOptions): void {
    let token = 0; // 弹窗销毁后使在途渲染失效
    let mode: "in" | "out" = "in";

    const tabsHTML = opts.loadOut ? `
    <div class="syfe-bldlg__tabs">
        <span class="syfe-bldlg__tab is-active" data-tab="in" title="引用了目标的位置">入链</span>
        <span class="syfe-bldlg__tab" data-tab="out" title="目标链接指向的位置">出链</span>
    </div>` : "";

    const dlg = new Dialog({
        title: opts.title,
        content: `<div class="syfe-bldlg">
    <div class="syfe-bldlg__bar">
        <span class="syfe-bldlg__sub" title="${escapeHTML(opts.subtitle || "")}">${escapeHTML(opts.subtitle || "")}</span>
        <span class="fn__flex-1"></span>
        ${tabsHTML}
        <button class="b3-button b3-button--text" data-act="refresh" title="重新扫描">刷新</button>
    </div>
    <div class="syfe-bldlg__body"><div class="syfe-bldlg__hint">扫描引用中…</div></div>
</div>`,
        width: "680px",
        height: "56vh",
        destroyCallback: () => {
            token++;
        },
    });

    const body = dlg.element.querySelector(".syfe-bldlg__body") as HTMLElement;
    const hint = opts.subtitle ? "" : "display:none;";
    (dlg.element.querySelector(".syfe-bldlg__sub") as HTMLElement).style.cssText += hint;

    const render = (items: BacklinkItem[]) => {
        if (items.length === 0) {
            body.innerHTML = `<div class="syfe-bldlg__hint">${mode === "in" ? "没有找到引用" : "没有出链"}</div>`;
            return;
        }
        const renderItem = (item: BacklinkItem) => {
            if (item.unresolvedName) {
                return `
                    <div class="syfe-bldlg__item syfe-bldlg__item--unresolved"
                         title="「${escapeHTML(item.unresolvedName)}」无法解析为文件(名字不存在或有歧义),请修正链接">
                        <div class="syfe-bldlg__itemhead">
                            <svg><use xlink:href="#iconClose"></use></svg>
                            <span class="syfe-bldlg__itemtitle">${escapeHTML(item.unresolvedName)}</span>
                            <span class="syfe-bldlg__itemloc">未解析</span>
                        </div>
                        ${item.snippet ? `<div class="syfe-bldlg__snippet">${escapeHTML(item.snippet)}</div>` : ""}
                    </div>`;
            }
            const icon = item.kind === "siyuan-doc" ? "iconFile" : "iconMarkdown";
            const loc = item.kind === "siyuan-doc"
                ? (item.docPath || "")
                : `${item.sourcePath}${item.lineNo ? ` : ${item.lineNo}` : ""}`;
            return `
                <div class="syfe-bldlg__item" data-idx="${items.indexOf(item)}" title="${escapeHTML(loc)}">
                    <div class="syfe-bldlg__itemhead">
                        <svg><use xlink:href="#${icon}"></use></svg>
                        <span class="syfe-bldlg__itemtitle">${escapeHTML(item.title)}</span>
                        ${backlinkPosBadgeHTML(item)}
                        <span class="syfe-bldlg__itemloc">${escapeHTML(loc)}</span>
                    </div>
                    ${item.snippet ? `<div class="syfe-bldlg__snippet">${escapeHTML(item.snippet)}</div>` : ""}
                </div>`;
        };
        if (mode === "out") {
            // 出链:按目标文件平铺(目标位置徽章在条目上)
            body.innerHTML = items.map(renderItem).join("");
        } else {
            // 入链:分组,思源文档引用在前,文件引用在后
            const docItems = items.filter(it => it.kind === "siyuan-doc");
            const mdItems = items.filter(it => it.kind === "md-file");
            const section = (title: string, list: BacklinkItem[]) => list.length === 0 ? "" : `
                <div class="syfe-bldlg__group">${escapeHTML(title)}(${list.length})</div>
                ${list.map(renderItem).join("")}`;
            body.innerHTML = section("思源文档", docItems) + section("文件", mdItems);
        }
        // 点击跳转
        body.querySelectorAll<HTMLElement>(".syfe-bldlg__item").forEach(node => {
            if (node.classList.contains("syfe-bldlg__item--unresolved")) return;
            node.addEventListener("click", () => {
                const item = items[Number(node.dataset.idx)];
                if (!item) return;
                if (mode === "out") navigateOutlink(plugin, item);
                else navigateBacklink(plugin, item);
            });
        });
    };

    const load = async () => {
        const t = token;
        body.innerHTML = `<div class="syfe-bldlg__hint">扫描引用中…</div>`;
        try {
            const items = mode === "out"
                ? await (opts.loadOut ? opts.loadOut() : Promise.resolve([]))
                : await opts.load();
            if (t !== token) return;
            render(items);
        } catch (e) {
            if (t !== token) return;
            body.innerHTML = `<div class="syfe-bldlg__hint">扫描失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    // 入链/出链切换
    const tabsEl = dlg.element.querySelector(".syfe-bldlg__tabs") as HTMLElement | null;
    if (tabsEl) {
        tabsEl.addEventListener("click", (e) => {
            const tab = (e.target as HTMLElement).closest(".syfe-bldlg__tab") as HTMLElement | null;
            if (!tab) return;
            const next = tab.dataset.tab as "in" | "out";
            if (!next || next === mode) return;
            mode = next;
            tabsEl.querySelectorAll(".syfe-bldlg__tab").forEach(t => t.classList.toggle("is-active", t === tab));
            void load();
        });
    }

    dlg.element.querySelector("[data-act='refresh']")!.addEventListener("click", () => {
        void load();
    });
    void load();
}
