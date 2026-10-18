// 插件设置面板:VS Code 式「左分类树 + 右内容」自绘对话框。
//
// 为什么不用思源 Setting 类:它只支持把设置项一个一个排进滚动列表,做不了
// 树状导航。这里直接用 Dialog 自绘,思源的取消/保存按钮语义由本模块自己实现。
//
// 页面(DOM)生命周期:
// - 页面 build() 只在首次 open 前执行一次,DOM 缓存在 pageElCache;
// - Dialog 销毁时把整个面板 DOM 搬回缓存壳(display:none),下次 open 复用,
//   避免控件监听/异步填充(kernel 列表等)重复构建;
// - 搜索会把命中的行 DOM 移动到结果区(带来源标注),清空/切页时按记录放回原位。
import {Dialog} from "siyuan";

export interface DialogPage {
    id: string;
    label: string;
    /** 有 parent = 树的二级节点(缩进显示在父节点下) */
    parent?: string;
    /** 页面内容(轻装配:每次选中时调用,内部应返回缓存的 DOM) */
    build(): HTMLElement;
}

export interface SettingsPanelOptions {
    title?: string;
    width?: string;
    height?: string;
    /** 每次打开面板后回调(回填控件值为当前配置) */
    onOpen?: () => void;
    /** 点「保存」时回调;完成后面板关闭 */
    onSave?: () => void | Promise<void>;
}

export interface SettingsPanel {
    addPage(page: DialogPage): void;
    open(): void;
}

/** 标准设置行:左侧标题+说明,右侧控件 */
export function settingsRow(title: string, description: string | undefined, control: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "syfe-set__row";
    row.dataset.tags = `${title} ${description || ""}`.toLowerCase();

    const text = document.createElement("div");
    text.className = "syfe-set__rowtext";
    const t = document.createElement("div");
    t.className = "syfe-set__rowtitle";
    t.textContent = title;
    text.appendChild(t);
    if (description) {
        const d = document.createElement("div");
        d.className = "syfe-set__rowdesc";
        d.textContent = description;
        text.appendChild(d);
    }
    row.appendChild(text);

    if (control) {
        const ctrl = document.createElement("div");
        ctrl.className = "syfe-set__rowctrl";
        ctrl.appendChild(control);
        row.appendChild(ctrl);
    }
    return row;
}

function h(tag: string, className?: string, text?: string): HTMLElement {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

interface MovedNode {
    el: HTMLElement;
    parent: Node;
    next: Node | null;
}

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
    const pages: DialogPage[] = [];

    const cacheHost = h("div", "syfe-set__cache");
    cacheHost.style.display = "none";
    document.body.appendChild(cacheHost);

    let navEl: HTMLElement | undefined;
    let pageShell: HTMLElement | undefined;
    let resultEl: HTMLElement | undefined;
    let mainEl: HTMLElement | undefined;
    let built = false;
    let currentId = "";
    let dialog: Dialog | undefined;
    const moved: MovedNode[] = [];

    const restoreMoved = (): void => {
        for (let i = moved.length - 1; i >= 0; i--) {
            const m = moved[i];
            m.parent.insertBefore(m.el, m.next);
        }
        moved.length = 0;
    };

    const select = (id: string, keepSearch = false): void => {
        const page = pages.find(p => p.id === id);
        if (!page || !pageShell || !navEl) return;
        currentId = id;
        if (!keepSearch) restoreMoved();
        if (resultEl) {
            resultEl.style.display = "none";
            resultEl.innerHTML = "";
        }
        pageShell.style.display = "";
        pageShell.innerHTML = "";
        pageShell.appendChild(page.build());
        pageShell.scrollTop = 0;
        // 树高亮
        navEl.querySelectorAll(".syfe-set__navitem").forEach(n => n.classList.remove("syfe-set__navitem--active"));
        const active = navEl.querySelector(`.syfe-set__navitem[data-page="${CSS.escape(id)}"]`);
        if (active) active.classList.add("syfe-set__navitem--active");
    };

    /** 搜索:把所有页里 data-tags 命中的块/行移到结果区(带来源页标注) */
    const runSearch = (raw: string): void => {
        const shell = pageShell;
        const results = resultEl;
        if (!shell || !results) return;
        restoreMoved();
        results.innerHTML = "";
        const q = raw.trim().toLowerCase();
        if (!q) {
            results.style.display = "none";
            shell.style.display = "";
            select(currentId);
            return;
        }
        shell.style.display = "none";
        let hits = 0;
        for (const page of pages) {
            const el = page.build();
            const parentLabel = page.parent ? (pages.find(p => p.id === page.parent)?.label || "") + " · " : "";
            const source = `${parentLabel}${page.label}`;
            el.querySelectorAll<HTMLElement>("[data-tags]").forEach(row => {
                const tags = row.dataset.tags || "";
                if (tags.indexOf(q) < 0) return;
                hits++;
                // 编辑器行精确到子分组(行挂在共享的组 DOM 里,closest 可取到组名)
                let src = source;
                if (row.classList.contains("syfe-es__row")) {
                    const g = row.closest(".syfe-es__group") as HTMLElement | null;
                    if (g?.dataset.group) src = `${source} · ${g.dataset.group}`;
                }
                const section = h("div", "syfe-set__hit");
                section.appendChild(h("div", "syfe-set__hitsrc", src));
                section.appendChild(row);
                results.appendChild(section);
                moved.push({el: row, parent: el, next: row.nextSibling});
            });
        }
        if (!hits) results.appendChild(h("div", "syfe-set__empty", "没有匹配的设置项"));
        results.style.display = "";
    };

    const buildTree = (): HTMLElement => {
        navEl = h("div", "syfe-set__nav");
        const tops = pages.filter(p => !p.parent);
        for (const page of tops) {
            navEl.appendChild(treeItem(page, false));
            for (const child of pages.filter(c => c.parent === page.id)) {
                navEl.appendChild(treeItem(child, true));
            }
        }
        return navEl;
    };

    const treeItem = (page: DialogPage, child: boolean): HTMLElement => {
        const item = h("div", `syfe-set__navitem${child ? " syfe-set__navitem--child" : ""}`, page.label);
        item.dataset.page = page.id;
        item.title = page.label;
        item.addEventListener("click", () => {
            if (searchInput) searchInput.value = "";
            select(page.id);
        });
        return item;
    };

    let searchInput: HTMLInputElement | undefined;

    const buildMain = (): HTMLElement => {
        mainEl = h("div", "syfe-set");

        // 顶部搜索栏(横跨全宽,VS Code 式):跨页面搜索设置项
        const topbar = h("div", "syfe-set__topbar");
        searchInput = document.createElement("input");
        searchInput.className = "b3-text-field syfe-set__search";
        searchInput.type = "text";
        searchInput.placeholder = "搜索设置(名称、说明或键名)…";
        searchInput.addEventListener("input", () => runSearch(searchInput?.value || ""));
        topbar.appendChild(searchInput);
        mainEl.appendChild(topbar);

        const mainRow = h("div", "syfe-set__mainrow");
        mainRow.appendChild(buildTree());

        const right = h("div", "syfe-set__right");
        pageShell = h("div", "syfe-set__pages");
        right.appendChild(pageShell);
        resultEl = h("div", "syfe-set__results");
        resultEl.style.display = "none";
        right.appendChild(resultEl);
        mainRow.appendChild(right);
        mainEl.appendChild(mainRow);

        // 底部按钮区
        const footer = h("div", "syfe-set__footer");
        const spacer = h("div", "fn__flex-1");
        footer.appendChild(spacer);
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "b3-button b3-button--cancel";
        cancelBtn.textContent = "取消";
        cancelBtn.addEventListener("click", () => dialog?.destroy());
        footer.appendChild(cancelBtn);
        const saveBtn = document.createElement("button");
        saveBtn.className = "b3-button b3-button--text";
        saveBtn.textContent = "保存";
        saveBtn.addEventListener("click", () => {
            Promise.resolve(options.onSave ? options.onSave() : undefined)
                .catch(err => console.error("[siyuan-virtual-tree] 保存设置失败:", err))
                .finally(() => dialog?.destroy());
        });
        footer.appendChild(saveBtn);
        mainEl.appendChild(footer);
        return mainEl;
    };

    const open = (): void => {
        if (!built) {
            built = true;
            // 首次:预装配全部页(控件/监听/异步填充只发生一次;页定义内部自缓存,
            // 预装配只触发构建、不挂树)
            pages.forEach(p => p.build());
        }
        const first = pages.find(p => !p.parent);
        if (first && !currentId) currentId = first.id;

        dialog = new Dialog({
            title: options.title || "设置",
            content: `<div class="syfe-set__mount"></div>`,
            width: options.width || "900px",
            height: options.height || "660px",
            destroyCallback: () => {
                dialog = undefined;
                if (mainEl) cacheHost.appendChild(mainEl);
            },
        });
        options.onOpen?.();
        const mount = dialog.element.querySelector(".syfe-set__mount");
        if (!mount) return;
        if (!mainEl) buildMain();
        if (mainEl && searchInput) searchInput.value = "";
        mount.appendChild(mainEl as Node);
        // 恢复搜索被移走的行后回到当前页
        select(currentId);
    };

    return {
        addPage(page) {
            if (built) throw new Error("addPage 必须在首次 open 之前调用");
            pages.push(page);
        },
        open,
    };
}
