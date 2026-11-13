// 双链面板:嵌入各文件 Tab,展示「入链」(谁引用了当前文件)与「出链」(当前文件
// 指向哪些文件),点击跳转。默认收起;首次展开时懒扫描。跳转:
// - 思源文档块 → siyuan://blocks/<id> 协议(思源打开文档并定位块)
// - 文件 → openFileTab 按扩展名分发页签(入链定位到引用所在行,出链带上目标位置)
import {showMessage} from "siyuan";
import {BacklinkItem, backlinkPosBadgeHTML, findBacklinksCached, findOutlinksCached} from "../utils/backlink";
import {openFileTab} from "../tabs/editor-tab";
import {setPendingReveal} from "../editor/model-manager";
import {setPendingRef, FileRef} from "../utils/file-ref";
import {basename} from "../utils/path";

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
    isExpanded(): boolean;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 跳转到引用来源(入链条目):定位到来源文件里引用所在的那一行
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
    // 文件:按扩展名分发页签(Markdown/代码/图片等),并定位到引用所在行
    if (item.sourcePath) {
        if (item.lineNo) {
            setPendingReveal(item.sourcePath, item.lineNo);
        }
        openFileTab(plugin as any, item.sourcePath);
    }
}

// 跳转到出链目标:思源块走 siyuan:// 协议定位;文件打开并带上链接指向的位置(行/锚点/时间点)
export function navigateOutlink(plugin: IPluginForBacklink, item: BacklinkItem): void {
    if (item.kind === "siyuan-doc" && item.blockId) {
        // 出链 = 思源外部块引用(siyuan://blocks/<id>):协议跳转,由思源打开并定位
        navigateBacklink(plugin, item);
        return;
    }
    if (!item.sourcePath) {
        showMessage(`「${item.unresolvedName || item.title}」无法解析,请修正链接`, 3000, "error");
        return;
    }
    const ref: FileRef = {path: item.sourcePath};
    if (item.targetLine) ref.line = item.targetLine;
    if (item.targetAnchor) ref.anchor = item.targetAnchor;
    if (item.targetTime !== undefined) ref.t = item.targetTime;
    setPendingRef(item.sourcePath, ref);
    openFileTab(plugin as any, item.sourcePath);
}

// 创建双链面板;targetPath 为当前文件路径(入链的被引用者 / 出链的发起者)
export function createBacklinkPanel(plugin: IPluginForBacklink, targetPath: string, opts?: {expanded?: boolean; onInLinks?: (items: BacklinkItem[]) => void}): BacklinkPanel {
    let target = targetPath;
    // opts.expanded=true 用于侧边 dock(常驻展开);页签内嵌面板默认收起
    let collapsed = opts?.expanded !== true;
    let loading = false;
    let token = 0;
    let mode: "in" | "out" = "in";
    // 状态模型:
    //   dirty.X      = X 模式的数据需要重扫(外部刷新/保存事件)
    //   modeData.X   = X 模式已取到的条目(切 tab 秒切,避免重复等扫描)
    //   bodyShows    = body 当前实际显示的模式(扫描中=null)。body 只有一份,
    //                  渲染另一模式即失效 —— 这是「切回旧 tab 显示错数据」的根因防线
    const dirty = {in: false, out: false};
    const modeData: {in?: BacklinkItem[]; out?: BacklinkItem[]} = {};
    const counts = {in: "", out: ""};
    let bodyShows: "in" | "out" | null = null;

    const el = document.createElement("div");
    // 初始类名跟随 opts.expanded(dock 常驻展开):collapsed 类控制 body/tabs 显隐
    el.className = "syfe-backlink" + (collapsed ? " syfe-backlink--collapsed" : "");
    el.innerHTML = `
        <div class="syfe-backlink__header" title="展开/收起双链面板">
            <svg class="syfe-backlink__icon"><use xlink:href="#iconLink"></use></svg>
            <span class="syfe-backlink__title">双链</span>
            <span class="syfe-backlink__count"></span>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--small" data-act="refresh" title="重新扫描">刷新</button>
        </div>
        <div class="syfe-backlink__tabs">
            <span class="syfe-backlink__tab is-active" data-tab="in" title="引用了当前文件的位置">入链</span>
            <span class="syfe-backlink__tab" data-tab="out" title="当前文件链接指向的位置">出链</span>
        </div>
        <div class="syfe-backlink__body"></div>`;

    const header = el.querySelector(".syfe-backlink__header") as HTMLElement;
    const tabsEl = el.querySelector(".syfe-backlink__tabs") as HTMLElement;
    const countEl = el.querySelector(".syfe-backlink__count") as HTMLElement;
    const body = el.querySelector(".syfe-backlink__body") as HTMLElement;

    const updateCount = () => {
        countEl.textContent = counts[mode];
    };

    const itemHTML = (item: BacklinkItem, idx: number): string => {
        if (item.unresolvedName) {
            // 出链:无法解析的 wikilink 短名(灰显,不可跳转)
            return `
                <div class="syfe-backlink__item syfe-backlink__item--unresolved" data-idx="${idx}"
                     title="「${escapeHTML(item.unresolvedName)}」无法解析为文件(名字不存在或有歧义),请修正链接">
                    <div class="syfe-backlink__itemhead">
                        <svg><use xlink:href="#iconClose"></use></svg>
                        <span class="syfe-backlink__itemtitle">${escapeHTML(item.unresolvedName)}</span>
                        <span class="syfe-backlink__itemloc">未解析</span>
                    </div>
                    ${item.snippet ? `<div class="syfe-backlink__snippet">${escapeHTML(item.snippet)}</div>` : ""}
                </div>`;
        }
        const icon = item.kind === "siyuan-doc" ? "iconFile" : "iconMarkdown";
        const loc = item.kind === "siyuan-doc"
            ? escapeHTML(item.docPath || "")
            : `${escapeHTML(basename(item.sourcePath))}${item.lineNo ? ` : ${item.lineNo}` : ""}`;
        const fullLoc = item.kind === "siyuan-doc" ? loc : escapeHTML(item.sourcePath) + (item.lineNo ? ` : ${item.lineNo}` : "");
        return `
            <div class="syfe-backlink__item" data-idx="${idx}" title="${fullLoc}">
                <div class="syfe-backlink__itemhead">
                    <svg><use xlink:href="#${icon}"></use></svg>
                    <span class="syfe-backlink__itemtitle">${escapeHTML(item.title)}</span>
                    ${backlinkPosBadgeHTML(item)}
                    <span class="syfe-backlink__itemloc">${loc}</span>
                </div>
                ${item.snippet ? `<div class="syfe-backlink__snippet">${escapeHTML(item.snippet)}</div>` : ""}
            </div>`;
    };

    const render = (items: BacklinkItem[]) => {
        if (items.length === 0) {
            body.innerHTML = `<div class="syfe-backlink__hint">${mode === "in" ? "没有找到引用" : "没有出链(文件里没有链接指向其他文件)"}</div>`;
            return;
        }
        body.innerHTML = items.map((item, idx) => itemHTML(item, idx)).join("");
        // 点击跳转
        body.querySelectorAll<HTMLElement>(".syfe-backlink__item").forEach(node => {
            if (node.classList.contains("syfe-backlink__item--unresolved")) return;
            node.addEventListener("click", () => {
                const item = items[Number(node.dataset.idx)];
                if (!item) return;
                if (mode === "out") navigateOutlink(plugin, item);
                else navigateBacklink(plugin, item);
            });
        });
    };

    // 用缓存数据渲染某模式(body 只有一份:渲染即改写 bodyShows)
    const showMode = (m: "in" | "out") => {
        const data = modeData[m];
        if (!data) return false;
        mode = m;
        tabsEl.querySelectorAll(".syfe-backlink__tab").forEach(t =>
            t.classList.toggle("is-active", (t as HTMLElement).dataset.tab === m));
        updateCount();
        render(data);
        bodyShows = m;
        return true;
    };

    // 清空某模式的数据(数据/视图一起失效)
    const invalidateAll = () => {
        dirty.in = true;
        dirty.out = true;
        modeData.in = undefined;
        modeData.out = undefined;
        counts.in = "";
        counts.out = "";
        bodyShows = null;
        body.innerHTML = "";
        updateCount();
    };

    // load(force):常规展开走缓存(与行号槽标记共用);刷新按钮/外部事件强制重扫。
    // 扫描是长耗时操作,期间用户可能切 tab —— 用 loadMode 快照,完成后数据入
    // modeData;只有「当前 mode 仍是发起时的模式」才直接渲染,否则由 tab 切换
    // 逻辑按 modeData/dirty 决定展示(避免旧模式的响应渲染进新模式的面板)。
    const load = async (force = false) => {
        if (loading) return;
        if (!target) {
            body.innerHTML = `<div class="syfe-backlink__hint">打开文件页签后自动跟随显示其双链</div>`;
            return;
        }
        loading = true;
        const t = ++token;
        const loadMode = mode;
        body.innerHTML = `<div class="syfe-backlink__hint">扫描引用中…</div>`;
        bodyShows = null;
        let items: BacklinkItem[] | null = null;
        let failed: string | null = null;
        try {
            items = loadMode === "in"
                ? await findBacklinksCached(target, {force})
                : await findOutlinksCached(target, {force});
        } catch (e) {
            failed = String(e);
        }
        loading = false;
        if (t !== token) return; // 面板已销毁/换目标
        if (failed !== null) {
            if (mode === loadMode) {
                body.innerHTML = `<div class="syfe-backlink__hint">扫描失败: ${escapeHTML(failed)}</div>`;
            }
            return;
        }
        dirty[loadMode] = false;
        modeData[loadMode] = items!;
        if (loadMode === "in") opts?.onInLinks?.(items!);
        counts[loadMode] = items!.length > 0 ? String(items!.length) : "";
        if (mode !== loadMode) {
            // 扫描期间切走了:数据已入 modeData,当前模式若有干净数据立即展示,否则补载
            if (!showMode(mode) && !loading) void load(dirty[mode]);
            return;
        }
        updateCount();
        render(items!);
        bodyShows = loadMode;
    };

    header.addEventListener("click", (e) => {
        // 刷新按钮不触发折叠
        if ((e.target as HTMLElement).closest("[data-act='refresh']")) return;
        collapsed = !collapsed;
        el.classList.toggle("syfe-backlink--collapsed", collapsed);
        if (collapsed || bodyShows === mode) return;
        // 展开时 body 显示的不是当前模式:有干净数据秒切,否则(重)扫
        if (modeData[mode] && !dirty[mode]) {
            showMode(mode);
        } else if (!loading) {
            void load(dirty[mode]);
        } else {
            dirty[mode] = true;
        }
    });
    el.querySelector("[data-act='refresh']")!.addEventListener("click", () => {
        collapsed = false;
        el.classList.remove("syfe-backlink--collapsed");
        void load(true);
    });

    // tab 切换:入链 / 出链
    tabsEl.addEventListener("click", (e) => {
        const tab = (e.target as HTMLElement).closest(".syfe-backlink__tab") as HTMLElement | null;
        if (!tab) return;
        const next = tab.dataset.tab as "in" | "out";
        if (!next || next === mode) return;
        mode = next;
        tabsEl.querySelectorAll(".syfe-backlink__tab").forEach(t => t.classList.toggle("is-active", t === tab));
        updateCount();
        if (collapsed) {
            collapsed = false;
            el.classList.remove("syfe-backlink--collapsed");
        }
        if (bodyShows !== next) {
            // body 显示的不是目标模式:有干净数据就秒切,否则(重)扫
            if (modeData[next] && !dirty[next]) {
                updateCount();
                render(modeData[next]!);
                bodyShows = next;
            } else if (loading) {
                dirty[next] = true; // 在途扫描完成后按当前模式补载
            } else {
                void load(dirty[next]);
            }
        }
    });

    // 外部请求刷新(如斜杆命令插入了指向本文件的链接 / 文件保存):目标匹配则全量失效;
    // 收起状态不强制展开、不扫描(没点开就不扫描),展开后才重扫
    const onRefreshRequest = (e: Event) => {
        const p = (e as CustomEvent)?.detail?.path;
        if (!p || p !== target) return;
        invalidateAll();
        if (!collapsed) void load(true);
    };
    window.addEventListener("syfe:backlink-refresh", onRefreshRequest);

    // opts.expanded(dock 常驻)创建即首扫;页签内嵌收起面板保持懒加载
    if (!collapsed && target) void load();

    return {
        el,
        setTarget(path: string) {
            if (path === target) return;
            target = path;
            dirty.in = false;
            dirty.out = false;
            modeData.in = undefined;
            modeData.out = undefined;
            bodyShows = null;
            counts.in = "";
            counts.out = "";
            body.innerHTML = "";
            updateCount();
            if (!collapsed) void load();
        },
        refresh() {
            invalidateAll();
            void load(true);
        },
        dispose() {
            window.removeEventListener("syfe:backlink-refresh", onRefreshRequest);
        },
        isExpanded() {
            return !collapsed;
        },
    };
}
