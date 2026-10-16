// 顶部路径面包屑:渲染 + 点击切换菜单(编辑器 Tab / Markdown Tab 共用)
//
// 放独立模块的原因:editor-tab 和 markdown-tab 互相之间已经有一条导入边
// (editor-tab 用 openMarkdownTab),再让 markdown-tab 反向导入 editor-tab
// 会形成循环依赖;把这两块无状态的工具挪出来,两边都只依赖本模块。

import {showMessage} from "siyuan";
import {readDir} from "../api/file";
import {DirEntry} from "../types";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {basename, dirname, joinPath, sepFor} from "../utils/path";

// 路径 → 面包屑分段(每段带 data-dir,点击弹树状切换菜单)
export function renderPathSegments(path: string): string {
    const segs = pathSegments(path);
    if (segs.length === 0) return escapeHTML(path);
    const sep = sepFor(path);
    const out: string[] = [];
    segs.forEach((s, i) => {
        if (i > 0) {
            // 前一段本身就以分隔符结尾时不能再插一个 ——
            // POSIX 根分段(basename 为空、回退成完整路径)的 label 就是 "/",
            // 无脑 join 会渲染出 "//data/templates/xxx.py" 这种多一个斜杠的路径。
            const prev = segs[i - 1].label;
            if (!prev.endsWith(sep)) {
                out.push(`<span class="syfe-editor__sep">${escapeHTML(sep)}</span>`);
            }
        }
        const parentDir = dirname(s.fullPath) || s.fullPath;
        // 分段保持纯文本:图标只在点击分段展开的树状切换菜单里展示(见 showPathSwitchMenu)
        out.push(`<span class="syfe-editor__seg" data-dir="${escapeHTML(parentDir)}" title="点击切换文件或文件夹">${escapeHTML(s.label)}</span>`);
    });
    return out.join("");
}

/**
 * 面包屑横向滚动:容器加 .syfe-crumbs-scroll(样式见 index.scss),
 * 悬停时鼠标滚轮的纵向滚动映射为横向滚动(内容放得下时不拦截,外层继续滚)。
 * 打开时自动滚到最右,保证"当前文件"那段可见。
 */
export function enableCrumbScroll(el: HTMLElement): void {
    el.classList.add("syfe-crumbs-scroll");
    el.addEventListener("wheel", (e: WheelEvent) => {
        if (!e.deltaY) return;
        const max = el.scrollWidth - el.clientWidth;
        if (max <= 0) return; // 没有可滚的余量:不拦截,让外层滚动
        const before = el.scrollLeft;
        el.scrollLeft = Math.max(0, Math.min(max, before + e.deltaY));
        if (el.scrollLeft !== before) e.preventDefault();
    }, {passive: false});
    // 初始定位到最右(当前文件段);字体加载可能改变宽度,延迟一帧再校一次
    requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
}

// ===== 树状切换菜单:独立自有元素 =====
//
// ⚠️ 为什么不用思源的 Menu 单例(#commonMenu):它是全局共用元素,「open 后原地
// 级联重绘」的树与它的生命周期(isOpen 状态、item 点击自动 remove、外部点击
// 关闭、空菜单 popup 守卫)处处互斥 —— 逐个补丁后仍然「点一次就点不动」。
// 最终方案:完全自有元素(自己创建/定位/关闭),行样式复用 syfe-mtree 同款,
// 观感与虚拟文档树一致,生命周期零冲突。

interface PathMenuCtx {
    openFile: (p: string) => void;
    dirPath: string;
    currentPath: string;
    listings: Map<string, DirEntry[]>;
    expanded: Set<string>;
    emptyDirs: Set<string>;
    loading: Set<string>;
    menuEl: HTMLElement;
}

let activeMenuEl: HTMLElement | null = null;

function normKey(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string): boolean {
    return normKey(a) === normKey(b);
}

// 点击某分段:弹出树状切换菜单。
//   - 文件夹行:左侧折叠箭头(里面有内容才显示;空目录是同宽占位,与文件行对齐),
//     点击行在原面板内级联展开/收起,面板不跳转;
//   - 文件行:点击用调用方给的 openFile 打开;当前文件行高亮(--current)。
// 行结构与样式复用虚拟文档树(syfe-mtree__row/toggle/icon/text/name)。
export async function showPathSwitchMenu(
    openFile: (p: string) => void,
    dirPath: string,
    anchor: HTMLElement,
    currentPath: string,
): Promise<void> {
    let raw: any;
    try {
        raw = await readDir(dirPath);
    } catch (e) {
        showMessage(`读取目录失败: ${e}`, 3000, "error");
        return;
    }
    const entries = (Array.isArray(raw) ? raw : []) as DirEntry[];
    if (entries.length === 0) {
        showMessage("该目录为空", 2000, "info");
        return;
    }

    closePathMenu(); // 每次全新打开:旧菜单元素先移除,避免状态/监听残留

    const ctx: PathMenuCtx = {
        openFile,
        dirPath,
        currentPath,
        listings: new Map([[normKey(dirPath), entries]]),
        expanded: new Set<string>(),
        emptyDirs: new Set<string>(),
        loading: new Set<string>(),
        menuEl: null as unknown as HTMLElement,
    };

    const menuEl = document.createElement("div");
    menuEl.className = "b3-menu syfe-pathmenu";
    ctx.menuEl = menuEl;
    document.body.appendChild(menuEl);
    // 层级:与原生 Menu.popup 一致用递增 zIndex。不设的话 .b3-menu 无 z-index,
    // 编辑器内容(Monaco/protyle 的层叠上下文)会盖住面板(实测:行文字盖住菜单)。
    const sy = window as any;
    sy.siyuan = sy.siyuan || {};
    sy.siyuan.zIndex = (sy.siyuan.zIndex || 90) + 1;
    menuEl.style.zIndex = String(sy.siyuan.zIndex);
    menuEl.style.visibility = "hidden"; // 内容渲染后再量测定位,避免空盒尺寸错误

    // 关闭:外部 mousedown / Escape
    const onOutside = (e: MouseEvent) => {
        if (!menuEl.contains(e.target as Node)) closePathMenu();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") closePathMenu();
    };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
    standaloneCleanup = () => {
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKey);
    };
    activeMenuEl = menuEl;

    // 事件委托:元素自有,随元素销毁,无累积
    menuEl.addEventListener("click", (e: Event) => {
        const row = (e.target as HTMLElement).closest(".syfe-mtree__row") as HTMLElement | null;
        if (!row || !menuEl.contains(row)) return;
        const p = row.dataset.path || "";
        if (row.dataset.dir !== "1") {
            closePathMenu();
            ctx.openFile(p);
            return;
        }
        const key = normKey(p);
        if (ctx.expanded.has(key)) {
            ctx.expanded.delete(key);
        } else {
            ctx.expanded.add(key);
            void loadDir(ctx, p);
        }
        renderPathMenu(ctx);
    });

    renderPathMenu(ctx);

    // 渲染后量测定位:永远在面包屑**下方**展开;面板不能太高 ——
    // 高度 = min(视口剩余高度, 40% 视口),超出部分面板内滚动,不遮挡面包屑。
    // ⚠️ .syfe-pathmenu 有 zoom(与 scss 的 .syfe-pathmenu zoom 保持一致) ——
    // style 的 top/left/maxHeight 会被 zoom 同步缩放(实测:top 70px 渲染在
    // 59.5px 处,面板盖住面包屑下缘)。先按视觉坐标算好目标值,再除以 Z 写入。
    const ar = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth; // zoom 后的视觉宽度
    const Z = 0.923;
    let leftV = ar.left;
    if (leftV + mw > window.innerWidth - 8) leftV = Math.max(8, window.innerWidth - mw - 8);
    const topV = ar.bottom + 4;
    const maxHV = Math.max(160, Math.min(window.innerHeight - topV - 8, Math.round(window.innerHeight * 0.4)));
    menuEl.style.left = Math.round(leftV / Z) + "px";
    menuEl.style.top = Math.round(topV / Z) + "px";
    menuEl.style.maxHeight = Math.round(maxHV / Z) + "px";
    menuEl.style.overflowY = "auto";
    // 宽度固定(视觉 420px):长路径/深层级联不撑宽面板,超出走横向滚动
    menuEl.style.width = Math.round(420 / Z) + "px";
    menuEl.style.overflowX = "auto";
    menuEl.style.visibility = "";

    // 自动展开到当前文件:点击的面包屑分段若是当前文件的祖先目录,面板默认只显示
    // 顶层,当前文件藏在里面看不见 —— 沿路径逐级展开,把当前行(渲染时自带
    // --current 高亮)滚到面板竖直方向的中部。视觉像素差 ÷ zoom 换算回 scrollTop,
    // 与上方定位代码同一套换算(面板有 zoom:0.923)。
    void (async () => {
        const findRow = (p: string) =>
            Array.from(menuEl.querySelectorAll<HTMLElement>(".syfe-mtree__row"))
                .find(r => r.dataset.path && normKey(r.dataset.path) === normKey(p));
        const centerRow = (row: HTMLElement) => {
            const pr = menuEl.getBoundingClientRect();
            const rr = row.getBoundingClientRect();
            const delta = rr.top + rr.height / 2 - (pr.top + pr.height / 2);
            if (Math.abs(delta) < 8) return;
            menuEl.scrollTop += delta / Z;
        };
        const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
        for (let guard = 0; guard < 14; guard++) {
            if (!menuEl.isConnected) return; // 用户已点外部关闭
            const row = findRow(ctx.currentPath);
            if (row) { centerRow(row); return; }
            // 当前文件行还没渲染:沿祖先链向上找「最深的一个已渲染目录行」,展开它
            let dir = dirname(ctx.currentPath);
            let target: string | null = null;
            for (let i = 0; i < 14; i++) {
                if (!dir || samePath(dir, dirPath)) break;
                const r = findRow(dir);
                if (r && r.dataset.dir === "1") { target = dir; break; }
                dir = dirname(dir);
            }
            if (!target) return; // 当前文件不在该面板目录子树内
            const key = normKey(target);
            if (!ctx.expanded.has(key)) {
                ctx.expanded.add(key);
                void loadDir(ctx, target);
                renderPathMenu(ctx);
                await wait(160);
            } else {
                // 已展开但文件行还没出现(加载中/超 200 项截断):稍等再试
                await wait(160);
            }
        }
    })();
}

let standaloneCleanup: (() => void) | null = null;

function closePathMenu(): void {
    if (standaloneCleanup) { standaloneCleanup(); standaloneCleanup = null; }
    if (activeMenuEl) { activeMenuEl.remove(); activeMenuEl = null; }
}

function loadDir(ctx: PathMenuCtx, p: string): Promise<DirEntry[]> {
    const key = normKey(p);
    if (ctx.listings.has(key)) return Promise.resolve(ctx.listings.get(key)!);
    if (ctx.loading.has(key)) return Promise.resolve([]);
    ctx.loading.add(key);
    return readDir(p).then((sub) => {
        const list = (Array.isArray(sub) ? sub : []) as DirEntry[];
        ctx.listings.set(key, list);
        if (list.length === 0) {
            // 仅「成功读取且确认为空」才去掉折叠图标
            ctx.emptyDirs.add(key);
            renderPathMenu(ctx);
        } else {
            // 非空目录 listing 就绪后重绘一次:恢复可能被竞态吞掉的箭头
            renderPathMenu(ctx);
        }
        return list;
    }).catch((e) => {
        // 读取失败 ≠ 空目录:保留折叠图标(用户预期:默认都有,空目录才去掉);
        // 不缓存失败结果,下次展开会重试
        console.warn("[siyuan-file-editor] 路径菜单 readDir 失败:", p, e);
        return [];
    }).finally(() => {
        ctx.loading.delete(key);
    });
}

// 一行:折叠符占位(恒在,隐藏也占宽,保证有无折叠符的行对齐)+ 树图标 + 名称
function rowHTML(ctx: PathMenuCtx, p: string, name: string, isDir: boolean, depth: number): string {
    const key = normKey(p);
    const pad = 6 + depth * 14;
    const expandedNow = isDir && ctx.expanded.has(key);
    const knownEmpty = isDir && ctx.emptyDirs.has(key);
    // 与挂载树 toggleArrow 同款:有子项才画箭头(展开 iconDown/收起 iconRight),
    // 没有子项(空目录/文件)放同宽空占位,保证折叠符列对齐
    const arrow = isDir && !knownEmpty
        ? `<span class="syfe-mtree__toggle syfe-mtree__toggle--arrow" data-arrow="1" title="展开/收起"><svg><use xlink:href="#${expandedNow ? "iconDown" : "iconRight"}"></use></svg></span>`
        : `<span class="syfe-mtree__toggle"></span>`;
    const icon = isDir ? folderIconHTML(name, expandedNow) : fileIconHTML(name);
    const cur = samePath(p, ctx.currentPath) ? " syfe-mtree__row--current" : "";
    return `<li class="syfe-mtree__row${expandedNow ? " syfe-mtree__row--open" : ""}${cur}" data-path="${escapeHTML(p)}" data-dir="${isDir ? "1" : "0"}" style="padding-left:${pad}px" title="${escapeHTML(name)}">` +
        arrow +
        `<span class="syfe-mtree__icon">${icon}</span>` +
        `<span class="syfe-mtree__text"><span class="syfe-mtree__name">${escapeHTML(name)}</span></span>` +
        `</li>`;
}

// 递归生成 rows:展开的目录带子行(级联);深度越深缩进越大。
// depth 上限 12:目录树里若有连接点(junction)成环,递归靠深度上限兜底,
// 否则一个环就能把主线程打死(整界面卡死的实测根因之一)。
function buildRows(ctx: PathMenuCtx, dir: string, depth: number, out: string[], count: {n: number}): void {
    if (depth > 12) return;
    // 目录未加载完成:挂载树同款「加载中…」占位(展开动作已触发 loadDir,就绪后重绘)
    if (!ctx.listings.has(normKey(dir))) {
        out.push(`<li class="syfe-mtree__row" style="padding-left:${6 + depth * 14 + 14}px"><span class="syfe-mtree__text"><span class="syfe-mtree__name">加载中…</span></span></li>`);
        return;
    }
    const list = ctx.listings.get(normKey(dir))!;
    // 成功读取但确实是空目录
    if (list.length === 0) {
        out.push(`<li class="syfe-mtree__row" style="padding-left:${6 + depth * 14 + 14}px"><span class="syfe-mtree__text"><span class="syfe-mtree__name">(空)</span></span></li>`);
        return;
    }
    const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name);
    const dirs = list.filter(e => e.isDir).sort(byName);
    const files = list.filter(e => !e.isDir).sort(byName);
    let shown = 0;
    for (const d of dirs) {
        if (count.n >= MAX_PATH_MENU_ITEMS) break;
        shown++; count.n++;
        const p = joinPath(dir, d.name);
        out.push(rowHTML(ctx, p, d.name, true, depth));
        if (ctx.expanded.has(normKey(p))) buildRows(ctx, p, depth + 1, out, count);
    }
    for (const f of files) {
        if (count.n >= MAX_PATH_MENU_ITEMS) break;
        shown++; count.n++;
        const p = joinPath(dir, f.name);
        out.push(rowHTML(ctx, p, f.name, false, depth));
    }
    if ((dirs.length + files.length) > shown) {
        out.push(`<li class="syfe-mtree__row" style="padding-left:${6 + depth * 14}px">` +
            `<span class="syfe-mtree__text"><span class="syfe-mtree__name">仅显示前 ${shown} 项(共 ${dirs.length + files.length} 项)</span></span></li>`);
    }
}

const MAX_PATH_MENU_ITEMS = 200;

function renderPathMenu(ctx: PathMenuCtx): void {
    const menuEl = ctx.menuEl;
    if (!menuEl.isConnected) return;
    const out: string[] = [];
    buildRows(ctx, ctx.dirPath, 0, out, {n: 0});
    menuEl.innerHTML = `<ul class="syfe-mtree__list">${out.join("")}</ul>`;
    // 异步补绘:目录确认「确实为空」后把箭头换成占位(有内容不动);
    // 已知目录跳过,命中缓存不会重复触发
    menuEl.querySelectorAll<HTMLElement>(".syfe-mtree__row[data-dir=\"1\"]").forEach(row => {
        const p = row.dataset.path || "";
        const key = normKey(p);
        // loading 中的目录必须跳过:否则竞态下 loadDir 的兜底空数组会把
        // 还在真实读取的目录误标为空,折叠箭头永久消失(实测根因)
        if (ctx.emptyDirs.has(key) || ctx.listings.has(key) || ctx.loading.has(key)) return;
        void loadDir(ctx, p).then(list => {
            if (list.length === 0) {
                ctx.emptyDirs.add(key);
                renderPathMenu(ctx);
            }
        });
    });
}

// ===== 以下两个依赖从 editor-tab 原样搬来(pathSegments / escapeHTML) =====

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 把完整路径拆成可点击的分段(面包屑):[{label: "E:", fullPath: "E:\\"}, ...]
// 根目录(盘符 E:\ / POSIX /)也作为一段,basename 为空时回退用完整路径
function pathSegments(path: string): Array<{label: string; fullPath: string}> {
    const segs: Array<{label: string; fullPath: string}> = [];
    let cur = path;
    while (cur) {
        segs.unshift({label: basename(cur) || cur, fullPath: cur});
        const parent = dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
    }
    return segs;
}
