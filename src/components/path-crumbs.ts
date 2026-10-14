// 顶部路径面包屑:渲染 + 点击切换菜单(编辑器 Tab / Markdown Tab 共用)
//
// 放独立模块的原因:editor-tab 和 markdown-tab 互相之间已经有一条导入边
// (editor-tab 用 openMarkdownTab),再让 markdown-tab 反向导入 editor-tab
// 会形成循环依赖;把这两块无状态的工具挪出来,两边都只依赖本模块。

import {Menu, showMessage} from "siyuan";
import {readDir} from "../api/file";
import {DirEntry} from "../types";
import {basename, dirname, joinPath, sepFor} from "../utils/path";

// 路径 → 面包屑分段(每段带 data-dir,点击弹同级选择菜单)
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

// 点击某分段:列出该目录下的条目(文件夹优先),可切换到同级/下级文件或文件夹
// 点文件夹 → 进入该文件夹继续选;点文件 → 用调用方给的 openFile 打开
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
    const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name);
    const dirs = entries.filter(e => e.isDir).sort(byName);
    const files = entries.filter(e => !e.isDir).sort(byName);

    const menu = new Menu();
    const rect = anchor.getBoundingClientRect();
    const enter = (p: string) => {
        void showPathSwitchMenu(openFile, p, anchor, currentPath);
    };
    // 条目过多时截断,避免菜单过长卡顿
    const MAX = 200;
    let shown = 0;
    for (const d of dirs) {
        if (shown++ >= MAX) break;
        const p = joinPath(dirPath, d.name);
        menu.addItem({icon: "iconFolder", label: d.name, click: () => enter(p)});
    }
    for (const f of files) {
        if (shown++ >= MAX) break;
        const p = joinPath(dirPath, f.name);
        const mark = p === currentPath ? " · 当前" : "";
        menu.addItem({icon: "iconFile", label: f.name + mark, click: () => openFile(p)});
    }
    if (entries.length > MAX) {
        menu.addSeparator();
        menu.addItem({label: `仅显示前 ${MAX} 项(共 ${entries.length} 项)`, click: () => {}});
    }
    menu.open({x: rect.left, y: rect.bottom});
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
