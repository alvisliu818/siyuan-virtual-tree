// 标签 UI:菜单(多标签切换/嵌套缩进)、文件树徽章、快速新建/管理标签对话框
import {Menu, Dialog, showMessage} from "siyuan";
import type {Plugin} from "siyuan";
import {TagDef} from "../types";
import {
    getAllTags,
    getTagsForPath,
    addTagToPath,
    removeTagFromPath,
    clearTagsForPath,
    addTag,
    updateTag,
    removeTag,
    sortTagsTree,
    tagDepth,
    tagFullName,
} from "./tag-store";

// 预设颜色(新建/编辑标签时可选)
export const TAG_COLORS = [
    "#e74c3c", "#e67e22", "#f39c12", "#f1c40f",
    "#2ecc71", "#27ae60", "#1abc9c", "#3498db",
    "#2980b9", "#9b59b6", "#8e44ad", "#e91e63",
    "#607d8b", "#95a5a6", "#34495e",
];

// 预设图标(思源内置 svg id + 常用字符)
export const TAG_ICONS = [
    "iconStar", "iconList", "iconRefresh", "iconCheck", "iconFolder",
    "iconFile", "iconHeart", "iconFlag", "iconLight", "iconClose",
    "iconEdit", "iconSearch", "iconDownload", "iconUpload", "iconLink",
];

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 渲染标签图标:思源 svg id → svg;否则当字符/emoji;都没有则显示彩色圆点
export function tagIconHTML(tag: TagDef): string {
    const color = tag.color || "var(--b3-theme-on-surface)";
    if (tag.icon && /^icon[A-Z]/.test(tag.icon)) {
        return `<svg style="width:12px;height:12px;fill:${escapeHTML(color)};"><use xlink:href="#${escapeHTML(tag.icon)}"></use></svg>`;
    }
    if (tag.icon) {
        return `<span style="color:${escapeHTML(color)};font-size:11px;line-height:1;">${escapeHTML(tag.icon)}</span>`;
    }
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHTML(color)};"></span>`;
}

// 文件树行上的标签徽章(多个标签依次排列)
export function tagBadgesHTML(path: string): string {
    const tags = getTagsForPath(path);
    if (tags.length === 0) return "";
    return `<span class="syfe-tag-badges">${tags.map(t => {
        const color = t.color || "var(--b3-theme-on-surface)";
        const label = escapeHTML(t.name);
        const icon = tagIconHTML(t);
        return `<span class="syfe-tag-badge" style="--syfe-tag-color:${escapeHTML(color)}" title="${escapeHTML(tagFullName(t.id))}">${icon}<span class="syfe-tag-badge__text">${label}</span></span>`;
    }).join("")}</span>`;
}

// 标签选择菜单:列出全部标签(嵌套用缩进),已打标的显示勾选,点击切换
export async function openTagMenu(
    plugin: Plugin,
    path: string,
    ev: MouseEvent,
    onChanged?: () => void,
): Promise<void> {
    const menu = new Menu();
    const assigned = new Set(getTagsForPath(path).map(t => t.id));
    const tags = sortTagsTree();
    if (tags.length === 0) {
        menu.addItem({label: "暂无标签,可点「新建标签」创建", type: "readonly"});
    }
    for (const t of tags) {
        const indent = "　".repeat(tagDepth(t.id)); // 嵌套缩进
        const isOn = assigned.has(t.id);
        menu.addItem({
            iconHTML: tagIconHTML(t),
            label: indent + t.name + (isOn ? " ✓" : ""),
            checked: isOn,
            click: async () => {
                if (isOn) await removeTagFromPath(plugin, path, t.id);
                else await addTagToPath(plugin, path, t.id);
                onChanged?.();
            },
        });
    }
    menu.addSeparator();
    menu.addItem({
        icon: "iconAdd",
        label: "新建标签…",
        click: () => {
            openTagEditDialog(plugin, null, async () => {
                // 新建后重新打开菜单,便于直接打标
                await openTagMenu(plugin, path, ev, onChanged);
                onChanged?.();
            });
        },
    });
    if (assigned.size > 0) {
        menu.addItem({
            icon: "iconTrashcan",
            label: "清除此条目的全部标签",
            click: async () => {
                await clearTagsForPath(plugin, path);
                showMessage("已清除标签", 2000, "info");
                onChanged?.();
            },
        });
    }
    menu.open({x: ev.clientX, y: ev.clientY});
}

// 新建/编辑标签对话框(名称、颜色、图标、父标签)
export function openTagEditDialog(
    plugin: Plugin,
    tag: TagDef | null,
    onDone?: () => void,
): void {
    const isNew = !tag;
    const tags = getAllTags();
    const parentOptions = tags
        .filter(t => t.id !== tag?.id)
        .map(t => {
            const sel = tag?.parentId === t.id ? " selected" : "";
            return `<option value="${escapeHTML(t.id)}"${sel}>${escapeHTML(tagFullName(t.id))}</option>`;
        }).join("");
    const colorOptions = TAG_COLORS.map(c => {
        const sel = (tag?.color || TAG_COLORS[0]) === c ? " checked" : "";
        return `<label class="syfe-tag-color" style="background:${c}" title="${c}"><input type="radio" name="syfe-tag-color" value="${c}"${sel} /></label>`;
    }).join("");
    const iconOptions = TAG_ICONS.map(i => {
        const sel = tag?.icon === i ? " checked" : "";
        return `<label class="syfe-tag-icon-opt" title="${i}"><input type="radio" name="syfe-tag-icon" value="${i}"${sel} /><svg><use xlink:href="#${i}"></use></svg></label>`;
    }).join("");

    const dialog = new Dialog({
        title: isNew ? "新建标签" : "编辑标签",
        content: `<div class="b3-dialog__content syfe-tag-dialog">
            <div class="syfe-tag-field">
                <div class="syfe-tag-field__label">名称</div>
                <input class="b3-text-field fn__block" id="syfe-tag-name" value="${escapeHTML(tag?.name || "")}" placeholder="如:重要" />
            </div>
            <div class="syfe-tag-field">
                <div class="syfe-tag-field__label">父标签(可选,用于嵌套)</div>
                <select class="b3-select fn__block" id="syfe-tag-parent">
                    <option value="">(无,作为一级标签)</option>
                    ${parentOptions}
                </select>
            </div>
            <div class="syfe-tag-field">
                <div class="syfe-tag-field__label">颜色</div>
                <div class="syfe-tag-colors">${colorOptions}</div>
            </div>
            <div class="syfe-tag-field">
                <div class="syfe-tag-field__label">图标</div>
                <div class="syfe-tag-icons">${iconOptions}</div>
            </div>
        </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel" id="syfe-tag-cancel">取消</button>
            ${isNew ? "" : `<button class="b3-button b3-button--outline" id="syfe-tag-delete">删除</button>`}
            <button class="b3-button b3-button--text" id="syfe-tag-ok">${isNew ? "创建" : "保存"}</button>
        </div>`,
        width: "420px",
    });

    const nameEl = dialog.element.querySelector("#syfe-tag-name") as HTMLInputElement;
    const parentEl = dialog.element.querySelector("#syfe-tag-parent") as HTMLSelectElement;
    const colorEl = () => dialog.element.querySelector('input[name="syfe-tag-color"]:checked') as HTMLInputElement | null;
    const iconEl = () => dialog.element.querySelector('input[name="syfe-tag-icon"]:checked') as HTMLInputElement | null;
    nameEl.focus();

    const close = () => dialog.destroy();
    const submit = async () => {
        const name = nameEl.value.trim();
        if (!name) {
            showMessage("请填写标签名称", 2000, "error");
            return;
        }
        const patch = {
            name,
            parentId: parentEl.value || undefined,
            color: colorEl()?.value || TAG_COLORS[0],
            icon: iconEl()?.value || "",
        };
        if (isNew) await addTag(plugin, patch);
        else await updateTag(plugin, tag!.id, patch);
        close();
        onDone?.();
    };
    dialog.element.querySelector("#syfe-tag-ok")!.addEventListener("click", () => void submit());
    dialog.element.querySelector("#syfe-tag-cancel")!.addEventListener("click", close);
    const delBtn = dialog.element.querySelector("#syfe-tag-delete");
    if (delBtn) {
        delBtn.addEventListener("click", async () => {
            await removeTag(plugin, tag!.id);
            close();
            onDone?.();
        });
    }
    nameEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void submit();
        }
    });
}

// 标签管理对话框(设置入口):列出所有标签,可编辑/删除/新建
export function openTagManagerDialog(plugin: Plugin, onChanged?: () => void): void {
    const render = () => {
        const tags = sortTagsTree();
        const rows = tags.length === 0
            ? `<div class="syfe-tag-empty">暂无标签</div>`
            : tags.map(t => `
                <div class="syfe-tag-row" data-id="${escapeHTML(t.id)}" style="padding-left:${tagDepth(t.id) * 16}px">
                    <span class="syfe-tag-row__icon">${tagIconHTML(t)}</span>
                    <span class="syfe-tag-row__name">${escapeHTML(t.name)}</span>
                    <span class="syfe-tag-row__path">${escapeHTML(tagFullName(t.id))}</span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--text syfe-tag-edit" data-id="${escapeHTML(t.id)}">编辑</button>
                    <button class="b3-button b3-button--text syfe-tag-del" data-id="${escapeHTML(t.id)}">删除</button>
                </div>`).join("");
        return rows;
    };

    const dialog = new Dialog({
        title: "标签管理",
        content: `<div class="b3-dialog__content syfe-tag-manager">
            <div class="syfe-tag-manager__list" id="syfe-tag-list">${render()}</div>
        </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel" id="syfe-tagmgr-close">关闭</button>
            <button class="b3-button b3-button--text" id="syfe-tagmgr-new">新建标签</button>
        </div>`,
        width: "520px",
        height: "60%",
    });

    const listEl = dialog.element.querySelector("#syfe-tag-list") as HTMLElement;
    const refresh = () => {
        listEl.innerHTML = render();
    };
    listEl.addEventListener("click", async (ev) => {
        const el = ev.target as HTMLElement;
        if (el.classList.contains("syfe-tag-edit")) {
            const id = el.dataset.id!;
            const tag = getAllTags().find(t => t.id === id);
            if (tag) openTagEditDialog(plugin, tag, () => {
                refresh();
                onChanged?.();
            });
        } else if (el.classList.contains("syfe-tag-del")) {
            const id = el.dataset.id!;
            await removeTag(plugin, id);
            refresh();
            onChanged?.();
        }
    });
    dialog.element.querySelector("#syfe-tagmgr-close")!.addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector("#syfe-tagmgr-new")!.addEventListener("click", () => {
        openTagEditDialog(plugin, null, () => {
            refresh();
            onChanged?.();
        });
    });
}
