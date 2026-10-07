import {Menu, Dialog, confirm, showMessage, IMenu} from "siyuan";
import {readDir, renameFile, removeFile, mkdir, writeFile, lsNotebooks, listDocsByPath, importStdMd, readBinaryFile, uploadAsset, insertBlockAtDocTop} from "../api/file";
import {isImportMdSourceAssetEnabled} from "../utils/config";
import {joinPath, basename, dirname, pathDepth, extname, isSiyuanPath} from "../utils/path";
import {toFileLink, toMarkdownFileLink, getWorkspacePath, toSystemPath} from "../utils/system-path";
import {openWithExternalApp, revealInSystemExplorer, openTreeFileWithExternalApp, launchOpenWith} from "../utils/external-app";
import {BINARY_EXTENSIONS, isImageFile, isOfficeFile, isMarkdownFile, isMediaFile, getMediaKind} from "../constants";
import {isVirtualPath, getMountsUnder, getMountList, normDirKey} from "../utils/virtual-tree";
import {isBaiduPath} from "../utils/baidu-path";
import {baiduCloudPath} from "../api/baidu-pan";
import {nativeCopyToTemp, nativeWriteTempFile, isNativeFsAvailable} from "../api/native-fs";
// 新标签页的固定/收藏:菜单里按当前状态显示「固定 / 取消固定」
import {isPinned, isFavorite, itemFromPath} from "../start-page";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {addMountMenuItem} from "./mount-menu";
import {tagBadgesHTML} from "../tags/tag-ui";
import {expandWithDescendants, pathMatchesFilter, pathHasAnyTag} from "../tags/tag-store";
import {getOpenWithItems, openWithMatches} from "../open-with/open-with-store";
import {DirEntry} from "../types";

// 文件树操作接口(由插件入口提供)
export interface IFileTreeActions {
    // 插件实例(虚拟文档树挂载菜单需要,拿到才能持久化)
    plugin?: any;
    openFile(path: string): void;
    openImage(path: string): void;
    openOffice(path: string): void;
    // 音视频播放器(媒体文件时才需要)
    openMedia?(path: string): void;
    openMarkdown?(path: string, mode?: "live" | "source" | "reading"): void;
    openSearch(rootPath?: string): void;
    openTerminal(cwd: string): void;
    // 在指定方向以分栏方式打开文件(支持同时查看多个文件)
    openFileSplit?(path: string, position: "right" | "bottom"): void;
    // 打开标签菜单(由 Dock 提供,便于拿到 plugin 与刷新回调)
    manageTags?(path: string, ev: MouseEvent, onChanged?: () => void): void;
    // 新标签页:切换固定/收藏(由 Dock 提供,内部调 src/start-page.ts)
    togglePin?(path: string): void;
    toggleFavorite?(path: string): void;
    // 取消挂载:移除某真实目录下的百度网盘挂载记录
    unmountDoc?(parentDir: string, vPath: string): void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 复制文本到剪贴板,带 execCommand 降级(navigator.clipboard 在部分上下文会因焦点问题失败)
// 导出供「最近使用」面板等复用
export function copyText(text: string): Promise<boolean> {
    return new Promise(resolve => {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(
                () => resolve(true),
                () => resolve(fallbackCopy(text)),
            );
            return;
        }
        resolve(fallbackCopy(text));
    });
}

function fallbackCopy(text: string): boolean {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

// 转义 CSS 属性选择器中的特殊字符
function escapeSelector(s: string): string {
    return s.replace(/["\\]/g, "\\$&");
}

// === 标签筛选 ===
// 当前生效的标签筛选(展开后代后的 id 集合)与"允许显示"的路径集合
let tagFilterIds: Set<string> | null = null;
let tagFilterAllowed: Set<string> | null = null;

export function getTagFilter(): Set<string> | null {
    return tagFilterIds;
}

// 从根目录递归收集:命中标签的条目 + 其所有祖先目录(保证树形可展开到命中项)
export async function computeTagFilterAllowed(
    rootPath: string,
    selectedIds: string[],
    anyTagged = false,
): Promise<Set<string>> {
    // anyTagged:不指定标签,只要被打过任意标签就算命中
    const ids = anyTagged ? new Set<string>() : expandWithDescendants(selectedIds);
    const hit = (p: string) => anyTagged ? pathHasAnyTag(p) : pathMatchesFilter(p, ids);
    const allowed = new Set<string>();
    const markAncestors = (p: string) => {
        let cur = dirname(p);
        let guard = 0;
        while (cur && guard++ < 200) {
            if (allowed.has(cur)) break;
            allowed.add(cur);
            cur = dirname(cur);
        }
    };
    const MAX_DEPTH = 12; // 防止过深递归
    const walk = async (dir: string, depth: number) => {
        if (depth > MAX_DEPTH) return;
        let raw: DirEntry[];
        try {
            raw = await readDir(dir);
        } catch {
            return;
        }
        if (!Array.isArray(raw)) return;
        for (const entry of raw) {
            const full = joinPath(dir, entry.name);
            if (hit(full)) {
                allowed.add(full);
                markAncestors(full);
            }
            // 挂载的虚拟条目(bdpan://)不递归:云盘子树不参与标签筛选,也避免逐目录请求网盘
            if (entry.path && isBaiduPath(entry.path)) continue;
            if (entry.isDir) await walk(full, depth + 1);
        }
    };
    allowed.add(rootPath);
    await walk(rootPath, 0);
    // 挂载的思源文档条目:挂载父目录可见则条目可见(其子文档树不受标签筛选影响)
    if (getMountList().length > 0) {
        const allowedNorm = new Set(Array.from(allowed).map(normDirKey));
        for (const m of getMountList()) {
            if (allowedNorm.has(normDirKey(m.parent))) allowed.add(m.vPath);
        }
    }
    return allowed;
}

// 设置/清除标签筛选;传入 null 表示不筛选
// anyTagged=true 时忽略 selectedIds,只筛"打过任意标签"的条目
export function setTagFilter(
    selectedIds: string[] | null,
    allowed: Set<string> | null,
    anyTagged = false,
): void {
    if (!anyTagged && (!selectedIds || selectedIds.length === 0)) {
        tagFilterIds = null;
        tagFilterAllowed = null;
        return;
    }
    tagFilterIds = anyTagged ? new Set<string>() : expandWithDescendants(selectedIds!);
    tagFilterAllowed = allowed;
}

// 排序:文件夹优先,再按名称
function sortEntries(entries: DirEntry[]): DirEntry[] {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return entries.slice().sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

// 生成单个条目 HTML
// isEmpty: 目录已知为空(无子条目),此时不显示折叠箭头
function createEntryHTML(entry: DirEntry, parentPath: string, isEmpty = false): string {
    // 虚拟条目(思源文档)自带完整路径;普通条目由父路径拼接
    const fullPath = entry.path || joinPath(parentPath, entry.name);
    if (entry.isDir) {
        const icon = folderIconHTML(entry.name, false);
        // 空目录不显示折叠图标(与文件行的空 toggle 保持一致,保证对齐)
        const toggle = isEmpty
            ? `<span class="syfe-tree__toggle"></span>`
            : `<span class="syfe-tree__toggle"><svg><use xlink:href="#iconRight"></use></svg></span>`;
        return `<li class="syfe-tree__item syfe-tree__item--dir" data-path="${escapeHTML(fullPath)}" data-is-dir="true" data-loaded="false" data-expanded="false">
            <div class="syfe-tree__row">
                ${toggle}
                <span class="syfe-tree__icon">${icon}</span>
                <span class="syfe-tree__label">${escapeHTML(entry.name)}</span>
                ${tagBadgesHTML(fullPath)}
            </div>
            <ul class="syfe-tree__children" style="display:none;"></ul>
        </li>`;
    }
    return `<li class="syfe-tree__item syfe-tree__item--file" data-path="${escapeHTML(fullPath)}" data-is-dir="false">
        <div class="syfe-tree__row">
            <span class="syfe-tree__toggle"></span>
            <span class="syfe-tree__icon">${fileIconHTML(entry.name)}</span>
            <span class="syfe-tree__label">${escapeHTML(entry.name)}</span>
            ${tagBadgesHTML(fullPath)}
        </div>
    </li>`;
}

// 渲染目录内容到容器
export async function renderTree(container: HTMLElement, dirPath: string): Promise<void> {
    try {
        const raw = await readDir(dirPath);
        let all: DirEntry[] = Array.isArray(raw) ? raw : [];
        // 合并挂载到该目录下的百度网盘虚拟条目(与真实文件并存)
        // 注:思源文档树的挂载能力已迁到「虚拟文档树」面板,这里只剩 bdpan://
        const mounts = getMountsUnder(dirPath);
        if (mounts.length > 0) {
            all = all.concat(mounts.map(m => ({name: m.name, isDir: true, size: 0, updated: "", path: m.vPath})));
        }
        // 标签筛选:仅显示命中标签的条目,以及通向它们的祖先目录
        if (tagFilterAllowed) {
            all = all.filter(e => tagFilterAllowed!.has(e.path || joinPath(dirPath, e.name)));
        }
        const entries: DirEntry[] = all;
        const sorted = sortEntries(entries);
        if (sorted.length === 0) {
            container.innerHTML = `<li class="syfe-tree__empty">${tagFilterAllowed ? "没有符合标签的条目" : "空目录"}</li>`;
            return;
        }
        // 检测子目录是否为空,空目录不渲染折叠箭头
        const emptyDirs = new Set<string>();
        await Promise.all(sorted.map(async (e) => {
            if (!e.isDir) return;
            if (e.path) return; // 挂载的思源文档:始终可展开,不参与空目录预检
            try {
                const sub = await readDir(joinPath(dirPath, e.name));
                if ((!Array.isArray(sub) || sub.length === 0) && getMountsUnder(joinPath(dirPath, e.name)).length === 0) {
                    emptyDirs.add(e.name);
                }
            } catch {
                // 读取失败视为非空(保留折叠箭头),避免误判
            }
        }));
        container.innerHTML = sorted.map(e => createEntryHTML(e, dirPath, emptyDirs.has(e.name))).join("");
    } catch (e) {
        console.error("[siyuan-file-editor] renderTree error:", e);
        container.innerHTML = `<li class="syfe-tree__empty">读取失败: ${escapeHTML(String(e))}</li>`;
    }
}

// 重新加载文件夹 <li> 的子内容
async function refreshFolderLi(li: HTMLElement): Promise<void> {
    const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement;
    if (!children) return;
    const dirPath = li.dataset.path!;
    await renderTree(children, dirPath);
    li.dataset.loaded = "true";
    li.dataset.expanded = "true";
    children.style.display = "";
}

// 内容变更后,就地修正某目录自身在父树中的折叠箭头
// (目录由空变非空 / 由非空变空时,其父节点渲染的 <li> 上的箭头需要同步,且不能折叠父节点)
// 挂载条目计入非空:目录只有挂载的思源文档时同样保留折叠箭头
export async function syncDirToggleInParent(rootEl: HTMLElement | null, dirPath: string, rootPath: string): Promise<void> {
    if (!rootEl) return; // 无关联文件树(如搜索面板右键操作),跳过
    const parentPath = dirname(dirPath);
    if (parentPath === rootPath) return; // 根目录无父节点
    const parentLi = findFolderLi(rootEl, parentPath, rootPath);
    if (!parentLi || parentLi.dataset.loaded !== "true") return; // 父未展开则无需处理
    const childLi = parentLi.querySelector(`:scope > .syfe-tree__children > li[data-path="${escapeSelector(dirPath)}"]`) as HTMLElement | null;
    if (!childLi) return;
    const toggleEl = childLi.querySelector(":scope > .syfe-tree__row > .syfe-tree__toggle") as HTMLElement;
    if (!toggleEl) return;
    try {
        const sub = await readDir(dirPath);
        const isEmpty = (!Array.isArray(sub) || sub.length === 0) && getMountsUnder(dirPath).length === 0;
        const hasChevron = !!toggleEl.querySelector("svg");
        if (isEmpty && hasChevron) {
            toggleEl.innerHTML = "";
        } else if (!isEmpty && !hasChevron) {
            toggleEl.innerHTML = `<svg><use xlink:href="#iconRight"></use></svg>`;
        }
    } catch {
        // 读取失败则保持现状
    }
}

// 更新文件夹图标(展开/折叠状态切换时调用)
function updateFolderIcon(li: HTMLElement): void {
    // 虚拟文档节点不是文件夹:保持文档/笔记本图标,不随展开状态切换
    if (isVirtualPath(li.dataset.path || "")) return;
    const iconEl = li.querySelector(":scope > .syfe-tree__row > .syfe-tree__icon") as HTMLElement;
    if (!iconEl) return;
    const folderName = basename(li.dataset.path || "");
    const expanded = li.dataset.expanded === "true";
    iconEl.innerHTML = folderIconHTML(folderName, expanded);
}

// 展开/折叠文件夹
export async function toggleFolder(li: HTMLElement): Promise<void> {
    const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement;
    if (!children) return;
    const expanded = li.dataset.expanded === "true";
    if (expanded) {
        children.style.display = "none";
        li.dataset.expanded = "false";
        updateFolderIcon(li);
        return;
    }
    children.style.display = "";
    li.dataset.expanded = "true";
    updateFolderIcon(li);
    if (li.dataset.loaded === "false") {
        await renderTree(children, li.dataset.path!);
        li.dataset.loaded = "true";
    }
}

// 折叠所有文件夹
export function collapseAll(rootEl: HTMLElement): void {
    rootEl.querySelectorAll<HTMLElement>("li.syfe-tree__item--dir").forEach(li => {
        const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement;
        if (children) children.style.display = "none";
        li.dataset.expanded = "false";
        updateFolderIcon(li);
    });
}

// 刷新所有已展开文件夹的图标(保留展开状态)
// 用于扩展加载后更新文件树图标,不改变树的展开/折叠状态
export async function refreshAllExpanded(rootEl: HTMLElement): Promise<void> {
    // 1. 重新渲染根目录(保留当前展开的文件夹路径)
    const rootPath = rootEl.dataset.path;
    if (!rootPath) return;
    // 记录所有已展开的文件夹路径
    const expandedPaths = new Set<string>();
    rootEl.querySelectorAll<HTMLElement>("li.syfe-tree__item--dir[data-expanded='true']").forEach(li => {
        const p = li.dataset.path;
        if (p) expandedPaths.add(p);
    });
    // 2. 重新渲染根目录
    await renderTree(rootEl, rootPath);
    // 3. 重新展开之前展开的文件夹(递归,因为子文件夹需要父文件夹先展开才能找到)
    const toExpand = Array.from(expandedPaths).sort((a, b) => pathDepth(a) - pathDepth(b));
    for (const p of toExpand) {
        if (p === rootPath) continue;
        const li = rootEl.querySelector(`li[data-path="${escapeSelector(p)}"]`) as HTMLElement | null;
        if (li) {
            const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement;
            if (children) {
                await renderTree(children, p);
                li.dataset.loaded = "true";
                li.dataset.expanded = "true";
                children.style.display = "";
                updateFolderIcon(li);
            }
        }
    }
}

// 按路径查找对应的 <li>,根路径返回 null
function findFolderLi(rootEl: HTMLElement, path: string, rootPath: string): HTMLElement | null {
    if (path === rootPath) return null;
    return rootEl.querySelector(`li[data-path="${escapeSelector(path)}"]`) as HTMLElement | null;
}

// 刷新指定路径的文件夹(若为根则刷新根容器)
// rootEl 为 null 时跳过刷新(搜索面板右键操作时可能没有可用的文件树)
export async function refreshPath(rootEl: HTMLElement | null, path: string, rootPath: string): Promise<void> {
    if (!rootEl) return;
    if (path === rootPath) {
        await renderTree(rootEl, rootPath);
        return;
    }
    const li = findFolderLi(rootEl, path, rootPath);
    if (li) {
        await refreshFolderLi(li);
    } else {
        // 父文件夹未展开,无法直接刷新;刷新根作为兜底
        await renderTree(rootEl, rootPath);
    }
}

// 在文件树中定位路径:逐级展开父目录,滚动到目标节点并高亮
// 用于搜索结果点击文件夹/文件后在文件树中定位、思源正文 file:// 链接右键定位。
// 匹配策略:按每级名字的 basename(归一化、忽略大小写/分隔符)在容器直接子 li 中找,
// 而非按完整 data-path 字符串精确匹配——避免根前缀表示差异(系统↔虚拟路径、正反斜杠)
// 导致"链算对了但 DOM data-path 对不上"。每级始终 fresh 重渲其子项,对抗 stale/半渲染。
// 失败时 console.warn 列出实际存在的子项,便于一眼看出是名字差异还是 readDir 空/失败。
export async function revealPath(rootEl: HTMLElement, targetPath: string, rootPath: string): Promise<boolean> {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const basenameNorm = (p: string) => {
        const n = norm(p);
        const idx = n.lastIndexOf("/");
        return idx >= 0 ? n.slice(idx + 1) : n;
    };
    const target = norm(targetPath);
    const root = norm(rootPath);
    if (target !== root && !target.startsWith(root + "/")) {
        console.warn("[syfe] reveal: target not under root", {target, root});
        return false;
    }
    // 期望的逐级名字(从 URL/路径切出)
    const parts = target === root ? [] : target.slice(root.length + 1).split("/");
    if (parts.length === 0) return true; // 目标就是根

    let container: HTMLElement = rootEl; // 当前要从中找子 li 的 <ul>
    for (let i = 0; i < parts.length; i++) {
        const want = parts[i];
        // 始终 fresh 渲染当前容器(根:renderTree(rootEl,rootPath);非根:上一轮已展开并渲染)
        if (i === 0) {
            await renderTree(rootEl, rootPath);
        }
        const directChildren = Array.from(container.children).filter(
            (e): e is HTMLElement => e instanceof HTMLElement && !!e.dataset.path,
        );
        // 按 basename 归一化匹配(对抗完整 data-path 字符串的表示差异)
        let li = directChildren.find(e => basenameNorm(e.dataset.path!) === norm(want));
        if (!li) {
            const present = directChildren.map(e => e.dataset.path);
            const parentLi = container.closest("li[data-path]") as HTMLElement | null;
            console.warn(
                `[syfe] reveal: chain node not found i=${i} want=${JSON.stringify(want)} ` +
                `dir=${JSON.stringify(i === 0 ? rootPath : (parentLi?.dataset.path || ""))} ` +
                `present=${JSON.stringify(present)}`,
            );
            return false;
        }
        // 末节点:滚动到可见并高亮闪烁
        if (i === parts.length - 1) {
            const row = li.querySelector(":scope > .syfe-tree__row") as HTMLElement | null;
            if (row) {
                row.scrollIntoView({block: "center", behavior: "smooth"});
                row.classList.add("syfe-tree__row--reveal");
                setTimeout(() => row.classList.remove("syfe-tree__row--reveal"), 1600);
            }
            break;
        }
        // 中间目录:渲染并展开其子项
        const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement | null;
        if (!children) {
            console.warn("[syfe] reveal: no children container", {i, path: li.dataset.path});
            return false;
        }
        await renderTree(children, li.dataset.path!);
        li.dataset.loaded = "true";
        children.style.display = "";
        li.dataset.expanded = "true";
        updateFolderIcon(li);
        container = children;
    }
    return true;
}

// 查找包含指定路径的文件树根元素(多个文件树 Dock 时取第一个匹配)
// 用于搜索右键菜单、file:// 链接定位等需要拿到 rootEl 的场景
export function findTreeRootEl(path: string): HTMLElement | null {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(".syfe-tree__root"));
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = norm(path);
    return roots.find(r => {
        const rp = r.dataset.path;
        return !!rp && (target === norm(rp) || target.startsWith(norm(rp) + "/"));
    }) || null;
}

// 系统绝对路径 → 思源虚拟路径(/data/...);仅当位于工作空间 data 目录内时非空
// 边界匹配用归一化(忽略大小写/分隔符),截取保留原始大小写
function systemToDataPath(sysPath: string, ws: string): string | null {
    const fwd = sysPath.replace(/\\/g, "/");
    const wsFwd = ws.replace(/\\/g, "/").replace(/\/+$/, "");
    const lower = fwd.toLowerCase();
    const base = (wsFwd + "/data").toLowerCase();
    if (lower !== base && !lower.startsWith(base + "/")) return null;
    return "/data" + fwd.slice(wsFwd.length + "/data".length);
}

// 生成路径的双空间候选:原路径 + 工作空间↔/data 互转的形式
// (file:// 链接解出的是系统绝对路径,而文件树根可能是 /data 虚拟路径,反之亦然)
export function revealCandidates(path: string): string[] {
    const candidates: string[] = [path];
    const ws = getWorkspacePath();
    if (ws) {
        if (isSiyuanPath(path)) {
            // /data 虚拟路径 → 系统绝对路径
            const sys = toSystemPath(path, ws);
            if (sys && sys !== path) candidates.push(sys);
        } else {
            // 系统绝对路径 → /data 虚拟路径(若在工作空间内)
            const vp = systemToDataPath(path, ws);
            if (vp && vp !== path) candidates.push(vp);
        }
    }
    return candidates;
}

// 在文件树中定位并高亮某路径(跨多个文件树 Dock 取第一个包含它的根)
// 供搜索结果、思源正文 file:// 链接右键「在文件夹树中定位」共用。
// 仅在当前树根下逐级展开父目录并高亮目标,不切换根目录。
export async function revealInFileTree(path: string): Promise<boolean> {
    for (const cand of revealCandidates(path)) {
        const rootEl = findTreeRootEl(cand);
        if (rootEl?.dataset.path) {
            const ok = await revealPath(rootEl, cand, rootEl.dataset.path);
            if (ok) return true;
            showMessage("文件树中未找到该路径", 3000, "info");
            return false;
        }
    }
    // 「文件」面板默认不注册(DOCK_TYPE 不存在)→ 给可操作的提示
    if (!document.querySelector(".syfe-tree__root")) {
        showMessage("「文件」面板已关闭,可在设置里打开「侧边栏:显示「文件」面板」后重试,或在「虚拟文档树」中挂载该目录查看", 5000, "info");
        return false;
    }
    showMessage("文件树根目录不包含该路径,请将根目录切换到包含该文件的目录后再试", 3000, "info");
    return false;
}
// 简易输入对话框
export function promptDialog(title: string, defaultVal: string = ""): Promise<string | null> {
    return new Promise(resolve => {
        const dialog = new Dialog({
            title,
            content: `<div class="b3-dialog__content">
                <input class="b3-text-field fn__block" id="syfe-prompt-input" value="${escapeHTML(defaultVal)}" />
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-prompt-cancel">取消</button>
                <button class="b3-button b3-button--text" id="syfe-prompt-ok">确定</button>
            </div>`,
        });
        const inputEl = dialog.element.querySelector("#syfe-prompt-input") as HTMLInputElement;
        inputEl.focus();
        inputEl.select();
        const ok = () => {
            const val = inputEl.value.trim();
            dialog.destroy();
            resolve(val || null);
        };
        const cancel = () => {
            dialog.destroy();
            resolve(null);
        };
        dialog.element.querySelector("#syfe-prompt-ok")!.addEventListener("click", ok);
        dialog.element.querySelector("#syfe-prompt-cancel")!.addEventListener("click", cancel);
        inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                ok();
            }
            if (e.key === "Escape") {
                e.preventDefault();
                cancel();
            }
        });
    });
}

// 新建文件
export async function createNewFile(parentDir: string, rootEl: HTMLElement | null, rootPath: string): Promise<void> {
    const name = await promptDialog("新建文件", "untitled.md");
    if (!name) return;
    const fullPath = joinPath(parentDir, name);
    try {
        await writeFile(fullPath, "");
        showMessage("文件已创建", 2000, "info");
        await refreshPath(rootEl, parentDir, rootPath);
        await syncDirToggleInParent(rootEl, parentDir, rootPath);
    } catch (e) {
        showMessage(`创建失败: ${e}`, 5000, "error");
    }
}

// 新建文件夹
export async function createNewFolder(parentDir: string, rootEl: HTMLElement | null, rootPath: string): Promise<void> {
    const name = await promptDialog("新建文件夹", "new-folder");
    if (!name) return;
    const fullPath = joinPath(parentDir, name);
    try {
        await mkdir(fullPath);
        showMessage("文件夹已创建", 2000, "info");
        await refreshPath(rootEl, parentDir, rootPath);
        await syncDirToggleInParent(rootEl, parentDir, rootPath);
    } catch (e) {
        showMessage(`创建失败: ${e}`, 5000, "error");
    }
}

// 重命名
export async function renameEntry(path: string, rootEl: HTMLElement | null, rootPath: string): Promise<void> {
    const oldName = basename(path);
    const newName = await promptDialog("重命名", oldName);
    if (!newName || newName === oldName) return;
    const newPath = joinPath(dirname(path), newName);
    try {
        await renameFile(path, newPath);
        showMessage("重命名成功", 2000, "info");
        await refreshPath(rootEl, dirname(path), rootPath);
        await refreshPath(rootEl, dirname(newPath), rootPath);
        await syncDirToggleInParent(rootEl, dirname(path), rootPath);
        await syncDirToggleInParent(rootEl, dirname(newPath), rootPath);
    } catch (e) {
        showMessage(`重命名失败: ${e}`, 5000, "error");
    }
}

// 删除
export function deleteEntry(path: string, isDir: boolean, rootEl: HTMLElement | null, rootPath: string): void {
    const name = basename(path);
    const typeStr = isDir ? "文件夹" : "文件";
    confirm(
        `删除${typeStr}`,
        `确定删除${typeStr}「${name}」${isDir ? "及其所有内容" : ""}吗?此操作不可恢复。`,
        async () => {
            try {
                await removeFile(path);
                showMessage("已删除", 2000, "info");
                await refreshPath(rootEl, dirname(path), rootPath);
                await syncDirToggleInParent(rootEl, dirname(path), rootPath);
            } catch (e) {
                showMessage(`删除失败: ${e}`, 5000, "error");
            }
        },
        () => {},
    );
}

// 外部操作统一错误提示
function runExternal(fn: () => Promise<void>): void {
    fn().catch(e => showMessage(`打开失败: ${e?.message || e}`, 3000, "error"));
}

// === 导入到思源 ===

// 选择导入目标(笔记本 / 文档)的对话框,选中后回调 onPicked({nbId, toPath, label})
// toPath:"/"=笔记本根;"/xxx.sy"=导入为该文档的子文档
function pickImportTargetDialog(title: string, onPicked: (target: {nbId: string; toPath: string; label: string}) => void): void {
    // state:null = 笔记本层;否则 {nbId, nbName, docPath, docName} = 文档层(docPath:"/" 表示浏览到笔记本根)
    let state: {nbId: string; nbName: string; docPath: string; docName: string} | null = null;
    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-mount">
                <div class="syfe-mount__crumb"></div>
                <div class="syfe-mount__list"></div>
            </div>`,
        width: "520px",
    });
    const listEl = dialog.element.querySelector(".syfe-mount__list") as HTMLElement;
    const crumbEl = dialog.element.querySelector(".syfe-mount__crumb") as HTMLElement;

    const pick = (t: {nbId: string; toPath: string; label: string}) => {
        dialog.destroy();
        onPicked(t);
    };

    const render = async () => {
        try {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            if (!state) {
                // 笔记本层:每行可「导入到该笔记本」,或「进入」浏览文档
                const notebooks = (await lsNotebooks()).filter((n: any) => n && !n.closed);
                crumbEl.innerHTML = `<span>选择导入位置(笔记本)</span>`;
                if (notebooks.length === 0) {
                    listEl.innerHTML = `<div class="syfe-mount__hint">没有打开的笔记本</div>`;
                    return;
                }
                listEl.innerHTML = notebooks.map((n: any) => `
                    <div class="syfe-mount__row" data-nb="${escapeHTML(String(n.id))}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconNotebook"></use></svg>
                        <span class="syfe-mount__name" title="${escapeHTML(String(n.name || n.id))}">${escapeHTML(String(n.name || n.id))}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">浏览</button>
                        <button class="b3-button b3-button--small" data-act="pick-nb">导入到此</button>
                    </div>`).join("");
                return;
            }
            // 文档层:顶部「导入到当前文档下」+ 子文档列表(可导入到子文档下 / 继续进入)
            const docs = state.docPath === "/"
                ? await listDocsByPath(state.nbId, "/")
                : await listDocsByPath(state.nbId, state.docPath);
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回上一级">‹ 返回</span>
                <span class="syfe-mount__mountcur">${escapeHTML(state.nbName)}${state.docName ? " / " + escapeHTML(state.docName) : ""}</span>
                <span class="fn__flex-1"></span>
                ${state.docPath !== "/" ? `<button class="b3-button b3-button--small" data-act="pick-cur">导入到此文档下</button>` : ""}`;
            if (!Array.isArray(docs) || docs.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">没有子文档</div>`;
                return;
            }
            listEl.innerHTML = docs.map((d: any) => `
                <div class="syfe-mount__row" data-sy="${escapeHTML(String(d.path || ""))}" data-name="${escapeHTML(String(d.name || ""))}">
                    <svg class="syfe-mount__icon"><use xlink:href="#iconFile"></use></svg>
                    <span class="syfe-mount__name" title="${escapeHTML(String(d.name || ""))}">${escapeHTML(String(d.name || ""))}</span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                    <button class="b3-button b3-button--small" data-act="pick-doc">导入到其下</button>
                </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
        if (btn) {
            const act = btn.dataset.act;
            const row = btn.closest(".syfe-mount__row") as HTMLElement | null;
            if (act === "pick-nb" && row) {
                const label = row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!;
                pick({nbId: row.dataset.nb!, toPath: "/", label});
                return;
            }
            if (act === "pick-cur" && state && state.docPath !== "/") {
                pick({nbId: state.nbId, toPath: state.docPath, label: state.docName});
                return;
            }
            if (act === "pick-doc" && row && row.dataset.sy) {
                pick({nbId: state!.nbId, toPath: row.dataset.sy, label: row.dataset.name || ""});
                return;
            }
            if (act === "back") {
                // 文档层 → 笔记本层
                state = null;
                void render();
                return;
            }
            if (act === "enter" && row) {
                if (!state) {
                    state = {nbId: row.dataset.nb!, nbName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!, docPath: "/", docName: ""};
                } else {
                    state = {...state, docPath: row.dataset.sy!, docName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || ""};
                }
                void render();
                return;
            }
            return;
        }
        // 行点击 = 进入
        const row = (ev.target as HTMLElement).closest(".syfe-mount__row") as HTMLElement | null;
        if (row) {
            if (!state) {
                state = {nbId: row.dataset.nb!, nbName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!, docPath: "/", docName: ""};
            } else if (row.dataset.sy) {
                state = {...state, docPath: row.dataset.sy!, docName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || ""};
            }
            void render();
        }
    });
    void render();
}

// 导入完成后:把源文件上传为资源,并在新建文档顶部插入一个引述块链接到它
// 步骤:① 记录导入前的文档列表 ② 上传源文件为资源 ③ 再列一次找出新文档 ④ 顶部插入引述块
async function attachSourceAsset(
    nbId: string,
    toPath: string,
    srcPath: string,
    name: string,
): Promise<void> {
    // toPath 形如 "/" 或 "/xxx.sy"(导入为某文档的子文档)
    const before = new Set((await listDocsByPath(nbId, toPath) || []).map(d => String(d.path || "")));
    const assetUrl = await uploadAsset(name, await readBinaryFile(srcPath));
    const after = await listDocsByPath(nbId, toPath) || [];
    const created = after.find(d => !before.has(String(d.path || "")));
    if (!created) return; // 没找到新文档(理论上不会发生),静默跳过
    const docId = String(created.path || "").split("/").pop()?.replace(/\.sy$/i, "") || "";
    if (!docId) return;
    // 引述块里放资源链接:> [源文件:xxx.md](assets/xxx.md)
    const label = `源文件:${name}`;
    await insertBlockAtDocTop(docId, `> [${label}](${assetUrl})`);
    showMessage(`已在文档顶部插入源文件资源引述块:${assetUrl}`, 3500, "info");
}

// 执行导入:准备 localPath(工作空间内文件先复制到临时目录)→ 调用思源导入接口
// isDir:导入目标是文件夹(markdown 文件夹导入,保留文件夹名层级;非 md 文件作为资源)
async function doImportToSiyuan(treePath: string, isDir: boolean): Promise<void> {
    const name = basename(treePath);
    pickImportTargetDialog(
        `导入「${name}」到思源`,
        async (target) => {
            let temp: {tempPath: string; cleanup: () => Promise<void>} | null = null;
            try {
                let localPath = treePath;
                if (isBaiduPath(treePath)) {
                    // 网盘文件先下载到系统临时目录(仅支持文件;文件夹需整树下载,代价过高)
                    if (isDir) {
                        showMessage("网盘文件夹暂不支持导入思源,请先同步到本地后再导入", 4000, "error");
                        return;
                    }
                    if (!isNativeFsAvailable()) {
                        showMessage("下载网盘文件需要思源桌面端(原生 fs)", 4000, "error");
                        return;
                    }
                    temp = await nativeWriteTempFile(name, await readBinaryFile(treePath));
                    localPath = temp.tempPath;
                } else if (isSiyuanPath(treePath)) {
                    // 内核拒绝导入工作空间子路径,先复制到系统临时目录(需桌面端原生 fs)
                    if (!getWorkspacePath()) {
                        showMessage("无法获取工作空间路径,导入失败", 4000, "error");
                        return;
                    }
                    try {
                        temp = await nativeCopyToTemp(toSystemPath(treePath));
                        localPath = temp.tempPath;
                    } catch (e) {
                        showMessage(`工作空间内文件需复制到临时目录后导入,当前环境不支持: ${(e as any)?.message || e}`, 6000, "error");
                        return;
                    }
                }
                await importStdMd(target.nbId, localPath, target.toPath, false);

                // 设置开启时:把源文件作为资源插入到新文档顶部的引述块
                // 仅单个 Markdown 文件;文件夹导入不适用(一个目录会变成 N 个文档,无法确定挂哪个)
                if (!isDir && isMarkdownFile(treePath) && isImportMdSourceAssetEnabled()) {
                    try {
                        await attachSourceAsset(target.nbId, target.toPath, treePath, name);
                    } catch (e) {
                        // 资源引述块插入失败**不影响导入结果**,只提示
                        showMessage(`已导入,但插入源文件资源引述块失败:${(e as any)?.message || e}`, 5000, "error");
                        return;
                    }
                }

                showMessage(`已导入到「${target.label}」${isDir ? ",文件夹将作为一个文档层级,非 Markdown 文件自动作为资源" : ""}`, 4000, "info");
            } catch (e) {
                showMessage(`导入失败: ${(e as any)?.message || e}`, 6000, "error");
            } finally {
                if (temp) void temp.cleanup();
            }
        },
    );
}

// 下载网盘文件到临时目录并用系统默认应用打开(桌面端)
function downloadBaiduAndOpen(path: string): void {
    runExternal(() => openTreeFileWithExternalApp(path));
}

// 从虚拟条目 <li> 向上查找其挂载父目录(最近的真实目录;顶层挂载则取树根)
// 条目本身就是树根、或父链上没有真实目录(虚拟根内部)时返回 null
function findMountParentDir(li: HTMLElement, rootEl: HTMLElement | null, vPath: string): string | null {
    if (rootEl && rootEl.dataset.path === vPath) return null;
    let el: HTMLElement | null = li.parentElement;
    while (el) {
        if (el.classList.contains("syfe-tree__root")) {
            const rp = el.dataset.path || "";
            return rp && !isVirtualPath(rp) ? rp : null;
        }
        if (el.tagName === "LI") {
            const p = (el as HTMLElement).dataset.path || "";
            if (p && !isVirtualPath(p)) return p;
        }
        el = el.parentElement;
    }
    return null;
}

// 选择要挂载的思源笔记本 / 文档(可逐层浏览子文档),选中后回调虚拟路径与显示名
// 供文件树 Dock 工具栏「挂载思源文档树」与文件树右键「挂载思源文档…」共用
// state:null = 笔记本层;否则 {nbId, nbName, docPath, docName} = 文档层
export function pickMountTargetDialog(title: string, onPicked: (vPath: string, label: string) => void): void {
    let state: {nbId: string; nbName: string; docPath: string; docName: string} | null = null;
    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-mount">
                <div class="syfe-mount__crumb"></div>
                <div class="syfe-mount__list"></div>
            </div>`,
        width: "520px",
    });
    const listEl = dialog.element.querySelector(".syfe-mount__list") as HTMLElement;
    const crumbEl = dialog.element.querySelector(".syfe-mount__crumb") as HTMLElement;

    const pick = (vPath: string, label: string) => {
        dialog.destroy();
        onPicked(vPath, label);
    };

    const docIdFromPath = (syPath: string) =>
        syPath.split("/").pop()?.replace(/\.sy$/i, "") || "";

    const render = async () => {
        try {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            if (!state) {
                // 笔记本层:每行可「挂载该笔记本」,或「进入」浏览文档
                const notebooks = (await lsNotebooks()).filter((n: any) => n && !n.closed);
                crumbEl.innerHTML = `<span>选择笔记本</span>`;
                if (notebooks.length === 0) {
                    listEl.innerHTML = `<div class="syfe-mount__hint">没有打开的笔记本</div>`;
                    return;
                }
                listEl.innerHTML = notebooks.map((n: any) => `
                    <div class="syfe-mount__row" data-nb="${escapeHTML(String(n.id))}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconNotebook"></use></svg>
                        <span class="syfe-mount__name" title="${escapeHTML(String(n.name || n.id))}">${escapeHTML(String(n.name || n.id))}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">浏览</button>
                        <button class="b3-button b3-button--small" data-act="mount-nb">挂载</button>
                    </div>`).join("");
                return;
            }
            // 文档层:顶部「挂载当前文档」+ 子文档列表(可挂载子文档 / 继续进入)
            const docs = await listDocsByPath(state.nbId, state.docPath);
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回笔记本层">‹ 返回</span>
                <span class="syfe-mount__mountcur" title="挂载当前位置">${escapeHTML(state.nbName)}${state.docName ? " / " + escapeHTML(state.docName) : ""}</span>
                <span class="fn__flex-1"></span>
                ${state.docPath !== "/" ? `<button class="b3-button b3-button--small" data-act="mount-cur">挂载此文档</button>` : ""}`;
            if (!Array.isArray(docs) || docs.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">没有子文档</div>`;
                return;
            }
            listEl.innerHTML = docs.map((d: any) => `
                <div class="syfe-mount__row" data-sy="${escapeHTML(String(d.path || ""))}" data-name="${escapeHTML(String(d.name || ""))}">
                    <svg class="syfe-mount__icon"><use xlink:href="#iconFile"></use></svg>
                    <span class="syfe-mount__name" title="${escapeHTML(String(d.name || ""))}">${escapeHTML(String(d.name || ""))}</span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                    <button class="b3-button b3-button--small" data-act="mount-doc">挂载</button>
                </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    // 对话框内点击委托
    const onClick = (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
        if (btn) {
            const act = btn.dataset.act;
            const row = btn.closest(".syfe-mount__row") as HTMLElement | null;
            if (act === "mount-nb" && row) {
                pick(`sydoc://nb/${row.dataset.nb}`, row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!);
                return;
            }
            if (act === "mount-cur" && state && state.docPath !== "/") {
                pick(`sydoc://${docIdFromPath(state.docPath)}`, state.docName || docIdFromPath(state.docPath));
                return;
            }
            if (act === "mount-doc" && row && row.dataset.sy) {
                pick(`sydoc://${docIdFromPath(row.dataset.sy)}`, row.dataset.name || docIdFromPath(row.dataset.sy));
                return;
            }
            if (act === "back") {
                // 文档层 → 笔记本层
                state = null;
                void render();
                return;
            }
            if (act === "enter" && row) {
                if (!state) {
                    state = {nbId: row.dataset.nb!, nbName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!, docPath: "/", docName: ""};
                } else {
                    state = {...state, docPath: row.dataset.sy!, docName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || ""};
                }
                void render();
                return;
            }
            return;
        }
        // 行点击 = 进入
        const row = (ev.target as HTMLElement).closest(".syfe-mount__row") as HTMLElement | null;
        if (row) {
            if (!state) {
                state = {nbId: row.dataset.nb!, nbName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || row.dataset.nb!, docPath: "/", docName: ""};
            } else if (row.dataset.sy) {
                state = {...state, docPath: row.dataset.sy!, docName: row.querySelector(".syfe-mount__name")?.textContent?.trim() || ""};
            }
            void render();
        }
    };
    dialog.element.addEventListener("click", onClick);
    void render();
}

// 右键菜单(文件树与搜索结果共用)
// rootEl/rootPath 用于操作后就地刷新文件树,可为 null(此时仅跳过树刷新)
// li:被右键的 <li> 节点(文件树传入;用于挂载条目的「取消挂载」定位父目录)
export function showFileTreeMenu(
    e: MouseEvent,
    path: string,
    isDir: boolean,
    rootEl: HTMLElement | null,
    rootPath: string,
    actions: IFileTreeActions,
    li?: HTMLElement,
    extra?: IMenu[],
): void {
    const menu = new Menu();

    // 注:思源文档(sydoc://)的文件树菜单与挂载能力已整体迁到侧边栏「虚拟文档树」面板,
    // 文件树不再渲染/挂载思源文档,这里只剩百度网盘(bdpan://)。

    // 百度网盘节点(bdpan://):云盘专用菜单(打开/下载/改名/删除/取消挂载;无系统路径类操作)
    if (isBaiduPath(path)) {
        const cloud = baiduCloudPath(path);
        const openWith: IMenu[] = [];
        if (isDir) {
            openWith.push({
                icon: "iconFile",
                label: "新建文件",
                click: () => createNewFile(path, rootEl, rootPath),
            });
            openWith.push({
                icon: "iconFolder",
                label: "新建文件夹",
                click: () => createNewFolder(path, rootEl, rootPath),
            });
        } else {
            // 与真实文件一致的打开方式(内容经网盘接口下载),但无系统路径类项
            if (isMarkdownFile(path)) {
                openWith.push({
                    icon: "iconMarkdown",
                    label: "实时预览编辑",
                    click: () => actions.openMarkdown?.(path, "live"),
                });
                openWith.push({
                    icon: "iconCode",
                    label: "文本编辑器",
                    click: () => actions.openMarkdown?.(path, "source"),
                });
            } else if (!BINARY_EXTENSIONS.has(extname(path)) && !isOfficeFile(path) && !isMediaFile(path)) {
                openWith.push({
                    icon: "iconCode",
                    label: "文本编辑器",
                    click: () => actions.openFile(path),
                });
            }
            if (isMediaFile(path)) {
                openWith.push({
                    icon: getMediaKind(path) === "audio" ? "iconRecord" : "iconVideo",
                    label: "音视频播放器",
                    click: () => {
                        if (actions.openMedia) actions.openMedia(path);
                        else actions.openFile(path);
                    },
                });
            }
            if (isImageFile(path)) {
                openWith.push({
                    icon: "iconImage",
                    label: "图片查看器",
                    click: () => actions.openImage(path),
                });
            }
            if (isOfficeFile(path)) {
                openWith.push({
                    icon: "iconFile",
                    label: "Office 查看器",
                    click: () => actions.openOffice(path),
                });
            }
            // 下载到系统临时目录后交给系统默认应用(仅桌面端)
            if (isNativeFsAvailable()) {
                openWith.push({
                    icon: "iconDownload",
                    label: "下载副本并用系统应用打开",
                    click: () => downloadBaiduAndOpen(path),
                });
            }
        }
        if (openWith.length > 0) {
            menu.addItem({
                icon: "iconOpen",
                label: "打开方式",
                submenu: openWith,
            });
        }
        // Markdown 文件可直接导入思源(下载到临时目录后走标准导入)
        if (!isDir && isMarkdownFile(path)) {
            menu.addItem({
                icon: "iconDownload",
                label: "导入到思源…",
                click: () => void doImportToSiyuan(path, false),
            });
        }
        if (!isDir && actions.openFileSplit) {
            menu.addItem({
                label: "分栏打开",
                submenu: [
                    {label: "在右侧分栏打开", click: () => actions.openFileSplit!(path, "right")},
                    {label: "在下方分栏打开", click: () => actions.openFileSplit!(path, "bottom")},
                ],
            });
        }
        menu.addSeparator();
        menu.addItem({
            icon: "iconEdit",
            label: "重命名",
            click: () => renameEntry(path, rootEl, rootPath),
        });
        menu.addItem({
            icon: "iconTrashcan",
            label: "删除",
            click: () => deleteEntry(path, isDir, rootEl, rootPath),
        });
        // 挂载在真实目录下的网盘条目:可取消挂载(条目本身是树根/挂载根时不适用)
        const mountParentDir = li ? findMountParentDir(li, rootEl, path) : null;
        if (mountParentDir !== null && actions.unmountDoc) {
            menu.addSeparator();
            menu.addItem({
                icon: "iconClose",
                label: "取消挂载",
                click: () => actions.unmountDoc!(mountParentDir!, path),
            });
        }
        menu.addSeparator();
        menu.addItem({
            icon: "iconCopy",
            label: "复制路径",
            click: () => {
                copyText(path).then(
                    ok => ok
                        ? showMessage("路径已复制", 2000, "info")
                        : showMessage("复制失败", 2000, "error"),
                );
            },
        });
        menu.addItem({
            icon: "iconLink",
            label: "复制网盘路径",
            click: () => {
                copyText(cloud).then(
                    ok => ok
                        ? showMessage("网盘路径已复制", 2000, "info")
                        : showMessage("复制失败", 2000, "error"),
                );
            },
        });
        // 调用方追加项(如标签面板的「从此标签中移除」)
        if (extra && extra.length > 0) {
            menu.addSeparator();
            for (const it of extra) menu.addItem(it);
        }
        menu.open({x: e.clientX, y: e.clientY});
        return;
    }

    // "打开方式"子菜单:按扩展名动态生成可用项
    const openWith: IMenu[] = [];
    if (isDir) {
        openWith.push({
            icon: "iconFolder",
            label: "系统文件资源管理器",
            click: () => runExternal(() => revealInSystemExplorer(path, true)),
        });
        openWith.push({
            icon: "iconTerminal",
            label: "集成终端",
            click: () => actions.openTerminal(path),
        });
    } else {
        // 文本编辑器:非二进制、非 Office 文件(csv/svg 等可同时出现在多个打开方式中)
        // Markdown 文件的"文本编辑器"= Markdown Tab 源码模式,另加实时预览项
        if (isMarkdownFile(path)) {
            openWith.push({
                icon: "iconMarkdown",
                label: "实时预览编辑",
                click: () => actions.openMarkdown?.(path, "live"),
            });
            openWith.push({
                icon: "iconCode",
                label: "文本编辑器",
                click: () => actions.openMarkdown?.(path, "source"),
            });
        } else if (!BINARY_EXTENSIONS.has(extname(path)) && !isOfficeFile(path) && !isMediaFile(path)) {
            openWith.push({
                icon: "iconCode",
                label: "文本编辑器",
                click: () => actions.openFile(path),
            });
        }
        if (isMediaFile(path)) {
            openWith.push({
                icon: getMediaKind(path) === "audio" ? "iconRecord" : "iconVideo",
                label: "音视频播放器",
                click: () => {
                    if (actions.openMedia) actions.openMedia(path);
                    else actions.openFile(path);
                },
            });
        }
        if (isImageFile(path)) {
            openWith.push({
                icon: "iconImage",
                label: "图片查看器",
                click: () => actions.openImage(path),
            });
        }
        if (isOfficeFile(path)) {
            openWith.push({
                icon: "iconFile",
                label: "Office 查看器",
                click: () => actions.openOffice(path),
            });
        }
        openWith.push({
            icon: "iconOpen",
            label: "系统默认应用",
            click: () => runExternal(() => openWithExternalApp(path)),
        });
openWith.push({
          icon: "iconFolder",
    label: "在文件资源管理器中显示",
     click: () => runExternal(() => revealInSystemExplorer(path, false)),
   });
    }

    // ===== 自定义「打开方式」=====
    // 放在内置项之后、菜单.addItem 之前。菜单是同步构建的,所以这里读的是
    // open-with-store 的内存缓存(插件启动时已 load 完),不需要 await。
    //
    // 虚拟路径(sydoc:// 之类)没有系统路径,交给外部程序一定失败,
    // 所以整段跳过 —— 挂一堆点了就报错的项比不挂更糟。
    if (!isVirtualPath(path)) {
        const ext = extname(path).toLowerCase();
        for (const item of getOpenWithItems()) {
   if (!openWithMatches(item, isDir, ext)) continue;
     openWith.push({
       icon: item.icon || (isDir ? "iconFolder" : "iconOpen"),
                label: item.label,
       click: () => runExternal(() => launchOpenWith(item, path)),
 });
        }
        // 一个自定义项都没有时,「打开方式」里就只有内置项,不必再加分组线
    }

    menu.addItem({
        icon: "iconOpen",
        label: "打开方式",
   submenu: openWith,
    });

    // 导入到思源:Markdown 文件 / 文件夹(效果同思源文档树的「导入 Markdown 文件/文件夹」)
    if (isDir || isMarkdownFile(path)) {
        menu.addItem({
            icon: "iconDownload",
            label: isDir ? "导入到思源(Markdown 文件夹)…" : "导入到思源…",
            click: () => void doImportToSiyuan(path, isDir),
        });
    }

    // 分栏打开:在右侧/下方以分栏方式打开文件(支持同时查看多个文件)
    if (!isDir && actions.openFileSplit) {
        menu.addItem({
            label: "分栏打开",
            submenu: [
                {label: "在右侧分栏打开", click: () => actions.openFileSplit!(path, "right")},
                {label: "在下方分栏打开", click: () => actions.openFileSplit!(path, "bottom")},
            ],
        });
    }

    if (isDir) {
        menu.addSeparator();
        menu.addItem({
            icon: "iconFile",
            label: "新建文件",
            click: () => createNewFile(path, rootEl, rootPath),
        });
        menu.addItem({
            icon: "iconFolder",
            label: "新建文件夹",
            click: () => createNewFolder(path, rootEl, rootPath),
        });
        menu.addSeparator();
        menu.addItem({
            icon: "iconSearch",
            label: "在此目录搜索",
            click: () => actions.openSearch(path),
        });
    } else {
        menu.addSeparator();
    }
    menu.addItem({
        icon: "iconTags",
        label: "标签",
        click: () => {
            if (actions.manageTags) {
                actions.manageTags(path, e, () => refreshPath(rootEl, dirname(path), rootPath));
            }
        },
    });
    // 新标签页:固定到页顶常驻区 / 收藏(数据存 start-page.json,与固定区互不干扰)
    if (actions.togglePin || actions.toggleFavorite) {
        if (actions.togglePin) {
            const item = itemFromPath(path);
            menu.addItem({
                icon: "iconPin",
                label: isPinned(item) ? "取消固定到新标签页" : "固定到新标签页",
                click: () => actions.togglePin!(path),
            });
        }
        if (actions.toggleFavorite) {
            const item = itemFromPath(path);
            menu.addItem({
                icon: "iconStar",
                label: isFavorite(item) ? "取消收藏" : "收藏",
                click: () => actions.toggleFavorite!(path),
            });
        }
    }
    // 虚拟文档树:把文件/文件夹挂到自建树上(支持挂到顶层或嵌套到已有挂载点)
    if (actions.plugin) {
        addMountMenuItem(menu, actions.plugin, {
            kind: "file",
            name: basename(path),
            path,
            isDir,
        });
    }
    menu.addSeparator();
    menu.addItem({
        icon: "iconEdit",
        label: "重命名",
        click: () => renameEntry(path, rootEl, rootPath),
    });
    menu.addItem({
        icon: "iconTrashcan",
        label: "删除",
        click: () => deleteEntry(path, isDir, rootEl, rootPath),
    });
    menu.addSeparator();
    menu.addItem({
        icon: "iconCopy",
        label: "复制路径",
        click: () => {
            copyText(path).then(
                ok => ok
                    ? showMessage("路径已复制", 2000, "info")
                    : showMessage("复制失败", 2000, "error"),
            );
        },
    });
    // 复制 file:// 链接:思源虚拟路径还原为工作空间绝对路径,外部路径原样转换
    menu.addItem({
        icon: "iconLink",
        label: "复制链接 (file://)",
        click: () => {
            const url = toFileLink(path);
            if (!url) {
                showMessage("无法获取工作空间路径,复制链接失败", 3000, "error");
                return;
            }
            copyText(url).then(
                ok => ok
                    ? showMessage("链接已复制,可粘贴到思源或浏览器使用", 2500, "info")
                    : showMessage("复制失败", 2000, "error"),
            );
        },
    });
    // 复制 Markdown 格式链接:[文件名](file://...)
    // 用原始 file:// 链接(思源可点击打开,不用 percent-编码);路径含空格或 ) 时用 <...> 包裹
    menu.addItem({
        icon: "iconLink",
        label: "复制 Markdown 链接",
        click: () => {
            const result = toMarkdownFileLink(path);
            if (!result) {
                showMessage("无法获取工作空间路径,复制链接失败", 3000, "error");
                return;
            }
            copyText(result.md).then(
                ok => ok
                    ? showMessage("Markdown 链接已复制", 2500, "info")
                    : showMessage("复制失败", 2000, "error"),
            );
        },
    });
    // 文件:在父目录中打开终端(目录已在上方添加终端选项)
    if (!isDir) {
        menu.addItem({
            icon: "iconTerminal",
            label: "在集成终端中打开",
            click: () => actions.openTerminal(dirname(path)),
        });
    }
    // 调用方追加项(如标签面板的「从此标签中移除」)
    if (extra && extra.length > 0) {
        menu.addSeparator();
        for (const it of extra) menu.addItem(it);
    }
    menu.open({x: e.clientX, y: e.clientY});
}
