// 「分栏打开」(opts.position)与页签去重的协作语义。
//
// 为什么需要:思源 openFile 对 custom 页签的复用分支(allModels.custom / getUnInitTab)
// 会**无视 position** 直接 switchTab(editor/util.ts,issue #5366 的既定行为:
// "在右侧/下侧打开已有页签将进行页签切换");各 opener 自己的 getOpenedTab 去重
// 同样是直接聚焦已有页签。于是「接管打开用分栏」在文件已打开时表现为"点了没分栏"。
//
// 约定(仅对带 position 的打开请求生效;无 position 维持原去重语义):
//   - 已有页签在**活动分屏之外** → 聚焦那份(文档与文件已同屏,不再堆页签);
//   - 已有页签全在**活动分屏**(聚焦会盖住正在读的文档)或页签未开 → 新开分栏:
//     openTab 传 openNewTab: true 绕过思源的复用分支,position 才能走到 wnd.split。
//
// 「活动分屏」判定与思源同款(见 app/src/search/util.ts):Wnd 根元素挂
// layout__wnd--active,custom model → .parent(Tab) → .parent(Wnd) → .element。

export interface SplitOpenOptions {
    position?: "right" | "bottom";
}

// 本次打开是否要求分栏(right/bottom)
export function wantsSplitOpen(opts?: SplitOpenOptions): boolean {
    return opts?.position === "right" || opts?.position === "bottom";
}

// 从同文件的多个已开页签里,挑一个位于活动分屏之外的(优先返回);
// 全都在活动分屏、或元素的 wnd 判定不了时返回 null(调用方决定新开分栏)。
// 判定不了时若还有候选,返回第一个判不了的 —— 保守聚焦,避免反复堆分栏页签。
// 注意:Wnd.model.element 是外层包裹 div,layout__wnd--active 挂在它内层的
// data-type="wnd" 子节点上(layout/util.ts 按 data-type 加类),所以要下钻一层。
export function pickTabOutsideActiveWnd(tabs: unknown[]): unknown | null {
    let unjudgeable: unknown | null = null;
    for (const c of (tabs || [])) {
        const wrapEl = (c as any)?.parent?.parent?.element as HTMLElement | undefined;
        const wndEl = wrapEl
            ? ((wrapEl.querySelector(":scope > [data-type='wnd']") as HTMLElement | null) || wrapEl)
            : undefined;
        if (!wndEl || !wndEl.classList) {
            if (!unjudgeable) unjudgeable = c;
            continue;
        }
        if (!wndEl.classList.contains("layout__wnd--active")) return c;
    }
    return unjudgeable;
}

// 同文件是否已有页签落在 wndId 之外的分屏(接管分栏的自愈检查用):
// 任一在外 → true(已分栏或已在他屏,收工);全部都在 wndId 内 → false(需要补一次打开)。
// 背景:思源 Wnd.split 在退化态(活动分屏模型 children.length===1 且首个页签无 head,
// 整窗重载后页签未实例化时会出现,Wnd.ts 开头的早退守卫)会返回 this 不拆分,
// 新页签落回当前分屏 —— 此时页签模型已建好,补一次 openNewTab+position 必然分栏。
export function hasTabOutsideWnd(
    plugin: {getOpenedTab(): { [key: string]: any[] }},
    path: string,
    wndId: string,
): boolean {
    for (const arr of Object.values(plugin.getOpenedTab?.() || {})) {
        for (const c of (arr || [])) {
            if (c?.data?.path !== path) continue;
            const id = (c as any)?.parent?.parent?.id;
            if (id && id !== wndId) return true;
        }
    }
    return false;
}

// 同文件是否已有页签模型注册(自愈前置条件:模型没注册就补开,可能重复开页签)
export function hasTabIn(
    plugin: {getOpenedTab(): { [key: string]: any[] }},
    path: string,
): boolean {
    for (const arr of Object.values(plugin.getOpenedTab?.() || {})) {
        for (const c of (arr || [])) {
            if (c?.data?.path === path) return true;
        }
    }
    return false;
}

// 收集同文件落在指定分屏内的页签模型(自愈成功后关闭首次调用的残留页签用)
export function tabsInWnd(
    plugin: {getOpenedTab(): { [key: string]: any[] }},
    path: string,
    wndId: string,
): unknown[] {
    const out: unknown[] = [];
    for (const arr of Object.values(plugin.getOpenedTab?.() || {})) {
        for (const c of (arr || [])) {
            if (c?.data?.path !== path) continue;
            if ((c as any)?.parent?.parent?.id === wndId) out.push(c);
        }
    }
    return out;
}

// 与思源 openFile 同款的「当前分屏」解析:优先 layout__wnd--active;
// 整窗重载后可能还没有任何 active 标记,此时回退取 centerLayout 下第一个 Wnd。
export function currentWndId(): string {
    const el = document.querySelector(".layout__wnd--active");
    if (el) return el.getAttribute("data-id") || "";
    const walk = (node: any, depth: number): string => {
        if (!node || depth > 6) return "";
        const el2 = node.element as HTMLElement | undefined;
        const inner = el2 ? (el2.querySelector(":scope > [data-type='wnd']") as HTMLElement | null) : null;
        if (inner) return inner.getAttribute("data-id") || "";
        for (const c of (node.children || [])) {
            const r = walk(c, depth + 1);
            if (r) return r;
        }
        return "";
    };
    return walk((window as any).siyuan?.layout?.centerLayout, 0);
}
