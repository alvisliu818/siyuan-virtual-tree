import {Menu, Dialog, confirm, showMessage} from "siyuan";
import {readDir, renameFile, removeFile, mkdir, writeFile} from "../api/file";
import {joinPath, basename, dirname} from "../utils/path";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {DirEntry} from "../types";

// 文件树操作接口(由插件入口提供)
export interface IFileTreeActions {
    openFile(path: string): void;
    openSearch(rootPath?: string): void;
    openTerminal(cwd: string): void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 转义 CSS 属性选择器中的特殊字符
function escapeSelector(s: string): string {
    return s.replace(/["\\]/g, "\\$&");
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
    const fullPath = joinPath(parentPath, entry.name);
    if (entry.isDir) {
        // 空目录不显示折叠图标(与文件行的空 toggle 保持一致,保证对齐)
        const toggle = isEmpty
            ? `<span class="syfe-tree__toggle"></span>`
            : `<span class="syfe-tree__toggle"><svg><use xlink:href="#iconRight"></use></svg></span>`;
        return `<li class="syfe-tree__item syfe-tree__item--dir" data-path="${escapeHTML(fullPath)}" data-is-dir="true" data-loaded="false" data-expanded="false">
            <div class="syfe-tree__row">
                ${toggle}
                <span class="syfe-tree__icon">${folderIconHTML(entry.name, false)}</span>
                <span class="syfe-tree__label">${escapeHTML(entry.name)}</span>
            </div>
            <ul class="syfe-tree__children" style="display:none;"></ul>
        </li>`;
    }
    return `<li class="syfe-tree__item syfe-tree__item--file" data-path="${escapeHTML(fullPath)}" data-is-dir="false">
        <div class="syfe-tree__row">
            <span class="syfe-tree__toggle"></span>
            <span class="syfe-tree__icon">${fileIconHTML(entry.name)}</span>
            <span class="syfe-tree__label">${escapeHTML(entry.name)}</span>
        </div>
    </li>`;
}

// 渲染目录内容到容器
export async function renderTree(container: HTMLElement, dirPath: string): Promise<void> {
    try {
        const raw = await readDir(dirPath);
        const entries: DirEntry[] = Array.isArray(raw) ? raw : [];
        const sorted = sortEntries(entries);
        if (sorted.length === 0) {
            container.innerHTML = `<li class="syfe-tree__empty">空目录</li>`;
            return;
        }
        // 检测子目录是否为空,空目录不渲染折叠箭头
        const emptyDirs = new Set<string>();
        await Promise.all(sorted.map(async (e) => {
            if (!e.isDir) return;
            try {
                const sub = await readDir(joinPath(dirPath, e.name));
                if (!Array.isArray(sub) || sub.length === 0) emptyDirs.add(e.name);
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
async function syncDirToggleInParent(rootEl: HTMLElement, dirPath: string, rootPath: string): Promise<void> {
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
        const isEmpty = !Array.isArray(sub) || sub.length === 0;
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
    const toExpand = Array.from(expandedPaths).sort((a, b) => a.split("/").length - b.split("/").length);
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
export async function refreshPath(rootEl: HTMLElement, path: string, rootPath: string): Promise<void> {
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
export async function createNewFile(parentDir: string, rootEl: HTMLElement, rootPath: string): Promise<void> {
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
export async function createNewFolder(parentDir: string, rootEl: HTMLElement, rootPath: string): Promise<void> {
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
export async function renameEntry(path: string, rootEl: HTMLElement, rootPath: string): Promise<void> {
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
export function deleteEntry(path: string, isDir: boolean, rootEl: HTMLElement, rootPath: string): void {
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

// 右键菜单
export function showFileTreeMenu(
    e: MouseEvent,
    path: string,
    isDir: boolean,
    rootEl: HTMLElement,
    rootPath: string,
    actions: IFileTreeActions,
): void {
    const menu = new Menu();
    if (isDir) {
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
        menu.addItem({
            icon: "iconTerminal",
            label: "在集成终端中打开",
            click: () => actions.openTerminal(path),
        });
        menu.addSeparator();
    }
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
            navigator.clipboard.writeText(path).then(
                () => showMessage("路径已复制", 2000, "info"),
                () => showMessage("复制失败", 2000, "error"),
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
    menu.open({x: e.clientX, y: e.clientY});
}
