import {Menu, Dialog, confirm, showMessage} from "siyuan";
import {readDir, renameFile, removeFile, mkdir, writeFile} from "../api/file";
import {joinPath, basename, dirname} from "../utils/path";
import {getFileIcon, iconHTML} from "../utils/icons";
import {DirEntry} from "../types";

// 文件树操作接口(由插件入口提供)
export interface IFileTreeActions {
    openFile(path: string): void;
    openSearch(rootPath?: string): void;
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
function createEntryHTML(entry: DirEntry, parentPath: string): string {
    const fullPath = joinPath(parentPath, entry.name);
    if (entry.isDir) {
        return `<li class="syfe-tree__item syfe-tree__item--dir" data-path="${escapeHTML(fullPath)}" data-is-dir="true" data-loaded="false" data-expanded="false">
            <div class="syfe-tree__row">
                <span class="syfe-tree__toggle"><svg><use xlink:href="#iconRight"></use></svg></span>
                <span class="syfe-tree__icon">${iconHTML("iconFolder")}</span>
                <span class="syfe-tree__label">${escapeHTML(entry.name)}</span>
            </div>
            <ul class="syfe-tree__children" style="display:none;"></ul>
        </li>`;
    }
    return `<li class="syfe-tree__item syfe-tree__item--file" data-path="${escapeHTML(fullPath)}" data-is-dir="false">
        <div class="syfe-tree__row">
            <span class="syfe-tree__toggle"></span>
            <span class="syfe-tree__icon">${iconHTML(getFileIcon(entry.name))}</span>
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
        container.innerHTML = sorted.map(e => createEntryHTML(e, dirPath)).join("");
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

// 展开/折叠文件夹
export async function toggleFolder(li: HTMLElement): Promise<void> {
    const children = li.querySelector(":scope > .syfe-tree__children") as HTMLElement;
    if (!children) return;
    const expanded = li.dataset.expanded === "true";
    if (expanded) {
        children.style.display = "none";
        li.dataset.expanded = "false";
        return;
    }
    children.style.display = "";
    li.dataset.expanded = "true";
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
    });
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
    menu.open({x: e.clientX, y: e.clientY});
}
