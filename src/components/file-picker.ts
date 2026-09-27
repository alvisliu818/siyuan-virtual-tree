// 文件选择器:斜杆命令「插入文件链接」使用
// 打开时递归扫描根目录一次(带深度/数量上限),之后输入即本地过滤,避免每次请求接口
import {Dialog, showMessage} from "siyuan";
import {readDir} from "../api/file";
import {joinPath, basename, dirname, extname} from "../utils/path";
import {fileIconHTML, folderIconHTML} from "../utils/icons";
import {getRecents} from "../recent-files";

interface PickEntry {
    path: string;
    name: string;
    isDir: boolean;
}

const MAX_DEPTH = 8;
const MAX_ENTRIES = 20000;

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 递归收集条目(名称 + 路径)
async function collect(root: string): Promise<PickEntry[]> {
    const out: PickEntry[] = [];
    const walk = async (dir: string, depth: number) => {
        if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
        let raw: any;
        try {
            raw = await readDir(dir);
        } catch {
            return;
        }
        if (!Array.isArray(raw)) return;
        for (const e of raw) {
            if (out.length >= MAX_ENTRIES) return;
            const full = joinPath(dir, e.name);
            out.push({path: full, name: e.name, isDir: !!e.isDir});
            if (e.isDir) await walk(full, depth + 1);
        }
    };
    await walk(root, 0);
    return out;
}

// 高亮匹配片段
function highlight(text: string, keyword: string): string {
    if (!keyword) return escapeHTML(text);
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx < 0) return escapeHTML(text);
    return escapeHTML(text.slice(0, idx)) +
        `<mark>${escapeHTML(text.slice(idx, idx + keyword.length))}</mark>` +
        escapeHTML(text.slice(idx + keyword.length));
}

export interface FilePickerOptions {
    rootPath: string;
    title?: string;
    // 是否允许选中文件夹(插入文件夹链接)
    allowDir?: boolean;
    onPick(path: string, isDir: boolean): void;
}

// 打开文件选择器
export function openFilePicker(opts: FilePickerOptions): void {
    const {rootPath, allowDir = false, onPick} = opts;
    let entries: PickEntry[] = [];
    let loading = true;

    const dialog = new Dialog({
        title: opts.title || "插入文件链接",
        content: `<div class="syfe-picker">
            <div class="syfe-picker__bar">
                <input type="text" class="b3-text-field fn__block" id="syfe-picker-input"
                       placeholder="输入文件名搜索…" />
            </div>
            <div class="syfe-picker__meta" id="syfe-picker-meta">扫描中…</div>
            <div class="syfe-picker__list" id="syfe-picker-list"></div>
        </div>
        <div class="b3-dialog__action">
            <button class="b3-button b3-button--cancel" id="syfe-picker-cancel">取消</button>
        </div>`,
        width: "640px",
        height: "70%",
    });

    const input = dialog.element.querySelector("#syfe-picker-input") as HTMLInputElement;
    const listEl = dialog.element.querySelector("#syfe-picker-list") as HTMLElement;
    const metaEl = dialog.element.querySelector("#syfe-picker-meta") as HTMLElement;

    // 渲染单条文件/文件夹(供搜索结果与"最近打开"复用)
    const itemHTML = (e: PickEntry, kw: string): string => {
        const icon = e.isDir ? folderIconHTML(e.name, false) : fileIconHTML(e.name);
        return `<div class="syfe-picker__item" data-path="${escapeHTML(e.path)}" data-dir="${e.isDir ? "true" : "false"}" title="${escapeHTML(e.path)}">
            <span class="syfe-picker__icon">${icon}</span>
            <span class="syfe-picker__name">${highlight(e.name, kw)}</span>
            <span class="syfe-picker__path">${escapeHTML(dirname(e.path))}</span>
        </div>`;
    };

    const render = () => {
        const kw = input.value.trim().toLowerCase();
        let matched = kw
            ? entries.filter(e => e.name.toLowerCase().includes(kw))
            : entries;
        if (!allowDir) matched = matched.filter(e => !e.isDir);
        // 文件夹优先,再按名称;限制渲染条数避免卡顿
        matched.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
        const shown = matched.slice(0, 200);

        // 无搜索词且扫描完成:顶部展示"最近打开",便于快速插入(去重后不再在"全部文件"重复)
        if (!kw && !loading) {
            const recents = getRecents().slice(0, 10);
            if (recents.length > 0) {
                const recentSet = new Set(recents);
                const recentHTML = recents.map(p => {
                    const name = basename(p);
                    const icon = fileIconHTML(name);
                    return `<div class="syfe-picker__item syfe-picker__recent-item" data-path="${escapeHTML(p)}" data-dir="false" title="${escapeHTML(p)}">
                        <span class="syfe-picker__icon">${icon}</span>
                        <span class="syfe-picker__name">${escapeHTML(name)}</span>
                        <span class="syfe-picker__path">${escapeHTML(dirname(p))}</span>
                    </div>`;
                }).join("");
                const rest = shown.filter(e => !recentSet.has(e.path)).map(e => itemHTML(e, kw)).join("");
                metaEl.textContent = `最近打开 ${recents.length} 项` + (matched.length ? ` · 共 ${matched.length} 个文件` : "");
                listEl.innerHTML = `<div class="syfe-picker__recent-head">最近打开</div>${recentHTML}` +
                    (rest ? `<div class="syfe-picker__recent-head syfe-picker__recent-head--all">全部文件</div>${rest}` : "");
                return;
            }
        }

        metaEl.textContent = loading
            ? "扫描中…"
            : `${matched.length} 个结果${matched.length > shown.length ? `(显示前 ${shown.length} 个)` : ""}`;
        if (shown.length === 0) {
            listEl.innerHTML = `<div class="syfe-picker__empty">${loading ? "扫描中…" : "没有匹配的文件"}</div>`;
            return;
        }
        listEl.innerHTML = shown.map(e => itemHTML(e, kw)).join("");
    };

    const pick = (el: HTMLElement) => {
        const path = el.dataset.path!;
        const isDir = el.dataset.dir === "true";
        dialog.destroy();
        onPick(path, isDir);
    };

    listEl.addEventListener("click", (ev) => {
        const item = (ev.target as HTMLElement).closest(".syfe-picker__item") as HTMLElement | null;
        if (item) pick(item);
    });

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const first = listEl.querySelector(".syfe-picker__item") as HTMLElement | null;
            if (first) pick(first);
        } else if (e.key === "Escape") {
            e.preventDefault();
            dialog.destroy();
        }
    });

    dialog.element.querySelector("#syfe-picker-cancel")!.addEventListener("click", () => dialog.destroy());
    input.focus();

    // 异步扫描
    void (async () => {
        try {
            entries = await collect(rootPath);
        } catch (e) {
            showMessage(`扫描目录失败: ${e}`, 4000, "error");
        } finally {
            loading = false;
            render();
        }
    })();
    render();
}
