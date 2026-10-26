// 反向链接弹窗:虚拟文档树行末「查看引用」图标的展示层。
// 由调用方传入标题与数据加载函数(load),弹窗负责加载态、分组渲染与点击跳转:
// - 思源文档块 → siyuan://blocks/<id> 协议(思源打开文档并定位块)
// - Markdown 文件 → Markdown Tab 源码模式打开并定位到引用行
// 数据来源见 utils/backlink.ts:文件引用 / 文件夹引用 / 思源原生反链(refs 表)。
import {Dialog} from "siyuan";
import {BacklinkItem, backlinkPosBadgeHTML} from "../utils/backlink";
import {IPluginForBacklink, navigateBacklink} from "./backlink-panel";

export interface BacklinkDialogOptions {
    title: string;
    /** 副标题:文件路径 / 文档 ID 等目标说明 */
    subtitle?: string;
    load: () => Promise<BacklinkItem[]>;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function showBacklinkDialog(plugin: IPluginForBacklink, opts: BacklinkDialogOptions): void {
    let token = 0; // 弹窗销毁后使在途渲染失效

    const dlg = new Dialog({
        title: opts.title,
        content: `<div class="syfe-bldlg">
    <div class="syfe-bldlg__bar">
        <span class="syfe-bldlg__sub" title="${escapeHTML(opts.subtitle || "")}">${escapeHTML(opts.subtitle || "")}</span>
        <span class="fn__flex-1"></span>
        <button class="b3-button b3-button--text" data-act="refresh" title="重新扫描引用">刷新</button>
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
            body.innerHTML = `<div class="syfe-bldlg__hint">没有找到引用</div>`;
            return;
        }
        // 分组:思源文档引用在前,Markdown 文件引用在后
        const docItems = items.filter(it => it.kind === "siyuan-doc");
        const mdItems = items.filter(it => it.kind === "md-file");
        const renderItem = (item: BacklinkItem) => {
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
        const section = (title: string, list: BacklinkItem[]) => list.length === 0 ? "" : `
            <div class="syfe-bldlg__group">${escapeHTML(title)}(${list.length})</div>
            ${list.map(renderItem).join("")}`;
        body.innerHTML = section("思源文档", docItems) + section("Markdown 文件", mdItems);
        // 点击跳转
        body.querySelectorAll<HTMLElement>(".syfe-bldlg__item").forEach(node => {
            node.addEventListener("click", () => {
                const item = items[Number(node.dataset.idx)];
                if (item) navigateBacklink(plugin, item);
            });
        });
    };

    const load = async () => {
        const t = token;
        body.innerHTML = `<div class="syfe-bldlg__hint">扫描引用中…</div>`;
        try {
            const items = await opts.load();
            if (t !== token) return;
            render(items);
        } catch (e) {
            if (t !== token) return;
            body.innerHTML = `<div class="syfe-bldlg__hint">扫描失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    dlg.element.querySelector("[data-act='refresh']")!.addEventListener("click", () => {
        void load();
    });
    void load();
}
