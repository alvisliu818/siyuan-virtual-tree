// 移动端文件打开入口。
//
// 移动端没有页签系统:思源的 openTab 是空实现、addTab 是 noop、getOpenedTab 恒空
// (app/src/plugin/API.ts 的 `/// #if MOBILE` 分支)。桌面那套「开页签 + Monaco」
// 在移动端点了等于没点,所以这里用全屏 Dialog 承接同一批入口。
//
// 读写一律走 api/file.ts:内核路径 → /api/file/*,远程路径(github:// 等)→
// 官方 REST API,两条都不需要 Node,移动端可用。
import {Dialog, showMessage, confirm} from "siyuan";
import {basename, extname, normalizePath, joinPath} from "../utils/path";
import {isDirectory} from "../utils/path-kind";
import {readDir, readTextFile, readBinaryFile, writeFile} from "../api/file";
import {BINARY_EXTENSIONS, isImageFile, isMediaFile, isOfficeFile, isNotebookFile} from "../constants";
import {createMobileEditor, MobileEditorHandle} from "../editor/mobile-editor";
import {addRecent} from "../recent-files";
import {buildFileRefMd} from "../utils/file-ref";
import {DirEntry} from "../types";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 剪贴板写入:优先异步 API,WebView 焦点/权限受限时用 execCommand 兜底 */
async function copyTextMobile(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 继续走降级
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

// 同一路径只开一个 Dialog,重复点击聚焦已有的(与桌面页签去重语义一致)
const openDialogs = new Map<string, Dialog>();

const FULLSCREEN = {
    width: "100vw",
    height: "100%",
};

const BODY_STYLE = "display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;";

/**
 * Android / 鸿蒙:思源在软键盘收起后会把 WebView 设为不可聚焦,而它自己的
 * canInput() 只认 protyle-wysiwyg 里的编辑区,认不出插件的 CM6。
 * 于是 CM6 拿得到 DOM 焦点却唤不起系统输入法 —— 表现为"点编辑区也进不了编辑"。
 * 点编辑区时主动放行,点其它区域退出聚焦后由思源自己收回焦点。
 */
function enableNativeEditorFocus(): void {
    try {
        const w = window as any;
        w.JSAndroid?.setWebViewFocusable?.(true);
        w.JSHarmony?.setWebViewFocusable?.(true);
    } catch {
        // 桥不存在或机型不支持:忽略,浏览器/桌面本来就允许聚焦
    }
}

// siyuan@1.2.9 的 d.ts 落后于运行时:beforeClose 在思源 3.8.x 的 Dialog 里已支持
// (app/src/dialog/index.ts 的 closeGuard,返回 false 即拦下关闭),但没写进 typings。
type MobileDialogOptions = ConstructorParameters<typeof Dialog>[0] & {
    beforeClose?: () => boolean;
};

/**
 * 移动端打开文件/文件夹。
 * isDir 由调用方(文件树 / dock)传入 —— 它们手上就有这个标记;
 * 缺省时退回 path-kind 的同步判定(移动端没有原生 fs,只能靠已渲染节点)。
 */
export function openFileOnMobile(plugin: any, rawPath: string, isDir?: boolean): void {
    const path = normalizePath((rawPath || "").replace(/\\/g, "/"));
    if (!path) return;
    void addRecent(plugin, path);
    const dir = isDir === true || (isDir === undefined && isDirectory(path));
    if (dir) {
        openBrowseDialog(plugin, path);
        return;
    }
    if (isImageFile(path)) {
        openImageDialog(path);
        return;
    }
    if (isMediaFile(path) || isOfficeFile(path) || isNotebookFile(path)) {
        showMessage("移动端暂不支持该格式,请用思源桌面端打开", 4000, "info");
        return;
    }
    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) {
        showMessage("二进制文件无法在移动端编辑", 4000, "info");
        return;
    }
    openEditorDialog(plugin, path);
}

/** 文件夹:逐层浏览 Dialog(移动端 dock 之外的独立入口,面包屑可回退) */
function openBrowseDialog(plugin: any, path: string): void {
    const existing = openDialogs.get(path);
    if (existing) {
        existing.element.querySelector<HTMLElement>(".b3-dialog__container")?.scrollIntoView();
        return;
    }
    let cur = path;
    const dialog = new Dialog({
        title: basename(cur) || cur,
        ...FULLSCREEN,
        content: `<div class="b3-dialog__content syfe-mopen" style="${BODY_STYLE}padding:8px 12px;">
            <div class="syfe-mopen__crumb" style="flex:none;font-size:12px;opacity:.7;word-break:break-all;padding-bottom:6px;"></div>
            <div class="syfe-mopen__list" style="flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;"></div>
        </div>`,
        destroyCallback: () => openDialogs.delete(path),
    });
    openDialogs.set(path, dialog);
    const crumbEl = dialog.element.querySelector(".syfe-mopen__crumb") as HTMLElement;
    const listEl = dialog.element.querySelector(".syfe-mopen__list") as HTMLElement;

    const render = async () => {
        crumbEl.textContent = cur;
        listEl.innerHTML = `<div style="padding:16px;opacity:.6;">加载中…</div>`;
        let entries: DirEntry[] = [];
        try {
            entries = await readDir(cur);
        } catch (e) {
            listEl.innerHTML = `<div style="padding:16px;color:var(--b3-card-error-color);">${escapeHTML(String((e as any)?.message || e))}</div>`;
            return;
        }
        const sorted = [...entries].sort((a, b) =>
            (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
        const rows: string[] = [];
        // 上级目录:库根/挂载根本身没有可回退的父层,到 /data 就停
        if (cur !== "/data" && cur !== "/") {
            rows.push(`<div class="syfe-mopen__row" data-up="1" style="display:flex;align-items:center;gap:8px;padding:12px 8px;border-bottom:1px solid var(--b3-border-color);cursor:pointer;">
                <span style="opacity:.6;">↑</span><span>上级目录</span></div>`);
        }
        for (const e of sorted) {
            rows.push(`<div class="syfe-mopen__row" data-name="${escapeHTML(e.name)}" data-isdir="${e.isDir ? "1" : "0"}"
                style="display:flex;align-items:center;gap:8px;padding:12px 8px;border-bottom:1px solid var(--b3-border-color);cursor:pointer;">
                <span style="opacity:.6;">${e.isDir ? "▸" : "·"}</span>
                <span style="flex:1;min-width:0;word-break:break-all;">${escapeHTML(e.name)}</span>
            </div>`);
        }
        listEl.innerHTML = rows.join("") || `<div style="padding:16px;opacity:.6;">空目录</div>`;
    };

    listEl.addEventListener("click", ev => {
        const row = (ev.target as HTMLElement).closest(".syfe-mopen__row") as HTMLElement | null;
        if (!row) return;
        if (row.dataset.up === "1") {
            const parent = cur.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/data";
            cur = parent;
            void render();
            return;
        }
        const name = row.dataset.name || "";
        const child = joinPath(cur, name);
        if (row.dataset.isdir === "1") {
            cur = child;
            void render();
        } else {
            openFileOnMobile(plugin, child, false);
        }
    });

    void render();
}

/** 图片:下载到内存转 blob URL(远程图片同样适用) */
function openImageDialog(path: string): void {
    const existing = openDialogs.get(path);
    if (existing) return;
    let blobUrl = "";
    const dialog = new Dialog({
        title: basename(path),
        ...FULLSCREEN,
        content: `<div class="b3-dialog__content syfe-mopen" style="${BODY_STYLE}padding:8px;align-items:center;justify-content:center;">
            <img class="syfe-mopen__img" style="max-width:100%;max-height:100%;object-fit:contain;" alt="${escapeHTML(basename(path))}" />
        </div>`,
        destroyCallback: () => {
            openDialogs.delete(path);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        },
    });
    openDialogs.set(path, dialog);
    const img = dialog.element.querySelector(".syfe-mopen__img") as HTMLImageElement;
    void readBinaryFile(path).then(buf => {
        blobUrl = URL.createObjectURL(new Blob([new Uint8Array(buf)]));
        img.src = blobUrl;
    }).catch(e => {
        showMessage(`图片加载失败: ${String((e as any)?.message || e)}`, 5000, "error");
    });
}

/** 代码 / Markdown:CM6 全屏编辑器,顶部工具栏带保存与脏标记 */
function openEditorDialog(plugin: any, path: string): void {
    const existing = openDialogs.get(path);
    if (existing) return;

    let handle: MobileEditorHandle | null = null;
    let dirty = false;
    let saving = false;
    let loaded = false;

    const dialog = new Dialog({
        title: basename(path),
        ...FULLSCREEN,
        // 文件名只在 Dialog 标题出现一次;内栏留给脏态与操作工具,不重复占一行
        content: `<div class="b3-dialog__content syfe-mopen syfe-mopen--editor" style="${BODY_STYLE}">
            <div class="syfe-mopen__bar">
                <span class="syfe-mopen__dirty"></span>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="undo" aria-label="撤销" title="撤销">↶</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="redo" aria-label="重做" title="重做">↷</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="indent-less" aria-label="减少缩进(Shift+Tab)" title="减少缩进(Shift+Tab)">⇤</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool syfe-mopen__shift" data-tool="shift" aria-label="Shift 修饰键" title="Shift(点亮后点 Tab 为反缩进)">Shift</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="tab" aria-label="Tab 缩进" title="Tab 缩进">Tab</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="font-down" aria-label="减小字号" title="减小字号">A−</button>
                <span class="syfe-mopen__fontval"></span>
                <button class="b3-button b3-button--outline syfe-mopen__tool" data-tool="font-up" aria-label="增大字号" title="增大字号">A+</button>
                <button class="b3-button b3-button--outline syfe-mopen__tool syfe-mopen__wrap" data-tool="wrap" aria-label="自动折行" title="自动折行">折行</button>
                <span class="fn__flex-1 fn__space"></span>
                <button class="b3-button syfe-mopen__save">保存</button>
            </div>
            <div class="syfe-mopen__editor" style="flex:1;min-height:0;overflow:hidden;"></div>
            <div class="syfe-mopen__path" title="点击展开/收起完整路径">${escapeHTML(path)}</div>
        </div>`,
        // 有未保存改动时拦下关闭(覆盖按钮 / Esc / 移动端返回手势)
        beforeClose: () => {
            if (!dirty) return true;
            confirm("未保存的修改", "当前文件有未保存的修改,关闭后将丢失。仍要关闭吗?", () => {
                dirty = false;
                dialog.destroy();
            });
            return false;
        },
        destroyCallback: () => {
            openDialogs.delete(path);
            handle?.destroy();
            handle = null;
        },
    } as MobileDialogOptions);
    openDialogs.set(path, dialog);
    // 只放行"可聚焦",不主动聚焦 —— 是否进入编辑由用户点哪里决定
    enableNativeEditorFocus();

    const editorEl = dialog.element.querySelector(".syfe-mopen__editor") as HTMLElement;

    // 点编辑区进入编辑,点 Dialog 其它区域(路径条/标题/空白)退出编辑并失焦。
    // 捕获阶段监听:思源与 CM6 都会在目标节点上抢 touch/pointer。
    const onAreaPointer = (ev: Event) => {
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        // 行号槽算"其它区域":点它复制链接并退出编辑,不误弹键盘
        const inEditor = editorEl.contains(target) && !target.closest(".cm-gutters");
        if (inEditor) {
            enableNativeEditorFocus();
            handle?.focus();
        } else {
            handle?.blur();
        }
    };
    dialog.element.addEventListener("touchstart", onAreaPointer, {capture: true, passive: true});
    dialog.element.addEventListener("pointerdown", onAreaPointer, {capture: true});
    const dirtyEl = dialog.element.querySelector(".syfe-mopen__dirty") as HTMLElement;
    const saveBtn = dialog.element.querySelector(".syfe-mopen__save") as HTMLButtonElement;
    const barEl = dialog.element.querySelector(".syfe-mopen__bar") as HTMLElement;
    const fontValEl = dialog.element.querySelector(".syfe-mopen__fontval") as HTMLElement;
    const wrapBtn = dialog.element.querySelector(".syfe-mopen__wrap") as HTMLButtonElement;
    const pathEl = dialog.element.querySelector(".syfe-mopen__path") as HTMLElement;

    const syncToolState = () => {
        if (!handle) return;
        fontValEl.textContent = String(handle.getFontSize());
        wrapBtn.classList.toggle("syfe-mopen__tool--on", handle.isWrap());
    };

    // 工具栏:撤销/重做/字号/换行。handle 异步就绪前先禁用,避免空点
    const toolBtns = Array.from(barEl.querySelectorAll("[data-tool]")) as HTMLButtonElement[];
    toolBtns.forEach(b => { b.disabled = true; });
    // Shift 是粘滞修饰键:点亮一次,下一次点 Tab 走反缩进,用完自动复位
    let shiftOn = false;
    const shiftBtn = barEl.querySelector('[data-tool="shift"]') as HTMLButtonElement;
    barEl.addEventListener("click", ev => {
        const btn = (ev.target as HTMLElement).closest("[data-tool]") as HTMLButtonElement | null;
        if (!btn || !handle) return;
        const tool = btn.dataset.tool;
        if (tool === "undo") handle.undo();
        else if (tool === "redo") handle.redo();
        else if (tool === "indent-less") handle.indentLess();
        else if (tool === "shift") {
            shiftOn = !shiftOn;
            shiftBtn.classList.toggle("syfe-mopen__tool--on", shiftOn);
        } else if (tool === "tab") {
            if (shiftOn) handle.indentLess();
            else handle.indentMore();
            shiftOn = false;
            shiftBtn.classList.remove("syfe-mopen__tool--on");
        }
        else if (tool === "font-down") handle.setFontSize(handle.getFontSize() - 1);
        else if (tool === "font-up") handle.setFontSize(handle.getFontSize() + 1);
        else if (tool === "wrap") handle.setWrap(!handle.isWrap());
        syncToolState();
    });
    pathEl.addEventListener("click", () => pathEl.classList.toggle("syfe-mopen__path--expanded"));

    const setDirty = (v: boolean) => {
        dirty = v;
        dirtyEl.textContent = v ? "● 未保存" : "";
    };

    const save = async () => {
        if (!handle || !loaded || saving) return;
        saving = true;
        saveBtn.disabled = true;
        try {
            await writeFile(path, handle.getValue());
            setDirty(false);
            showMessage("已保存", 1500, "info");
        } catch (e) {
            showMessage(`保存失败: ${String((e as any)?.message || e)}`, 6000, "error");
        } finally {
            saving = false;
            saveBtn.disabled = false;
        }
    };

    saveBtn.addEventListener("click", () => void save());
    editorEl.innerHTML = `<div style="padding:16px;opacity:.6;">加载中…</div>`;

    void readTextFile(path).then(text => {
        editorEl.innerHTML = "";
        handle = createMobileEditor(editorEl, {
            value: text,
            path,
            onSave: () => void save(),
            onInput: () => setDirty(true),
            // 与桌面端「右键行号复制行链接」同一格式,移动端改为点击行号
            onCopyLine: (line: number) => {
                // 虚拟路径(github:// / gitee:// 等)不能交给 toFileLink,
                // 它会被拼成 file:///gitee://... 的坏链接;直接用裸路径 + line 参数
                const label = `${basename(path)}:${line}`.replace(/[[\]\\]/g, "\\$1");
                const virtual = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
                const md = virtual
                    ? `[${label}](<${path}${path.includes("?") ? "&" : "?"}line=${line}>)`
                    : buildFileRefMd({path, line, label});
                if (!md) {
                    showMessage("无法生成行链接", 2500, "error");
                    return;
                }
                void copyTextMobile(md).then(ok =>
                    showMessage(ok ? `已复制第 ${line} 行链接` : "复制失败", 2000, ok ? "info" : "error"));
            },
        });
        loaded = true;
        setDirty(false);
        toolBtns.forEach(b => { b.disabled = false; });
        syncToolState();
    }).catch(e => {
        editorEl.innerHTML = `<div style="padding:16px;color:var(--b3-card-error-color);">${escapeHTML(String((e as any)?.message || e))}</div>`;
    });
}