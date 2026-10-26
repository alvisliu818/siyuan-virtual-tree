// 挂载到虚拟文档树:菜单项 + 面板内"添加挂载"所需的公共逻辑。
// 选项 = 顶层 + 现有所有挂载节点(带面包屑),供文件树右键、思源文档/块右键、虚拟文档树面板右键共用,
// 实现"支持嵌套挂载":同一个条目可以挂到顶层,也可以挂到任意已挂载节点下面。
//
// 注意:本文件**不要 import ./file-tree**(它 import 了本文件,会成环);
// 需要「挂载思源文档…」选择器的地方(mount-tree-dock)直接引 file-tree 的 pickMountTargetDialog。
import {Menu, Dialog, showMessage} from "siyuan";
import {addMountItem, listMountTargets, hasMounted, getRoots, MountItem, MountKind} from "../mount-tree";
import {readDir, querySQL} from "../api/file";
import {basename, dirname} from "../utils/path";
import {showOpenDialog} from "../utils/open-dialog";
import {getNativeRequire} from "../utils/native-require";
import {getBlock, blockTitle} from "../utils/blocks";

export interface MountPayload {
    kind: MountKind;
    name: string;
    path?: string;      // kind=file
    targetId?: string;  // kind=doc / notebook / block
    isDir?: boolean;    // kind=file:是否文件夹
}

// 执行挂载并提示结果
export async function mountPayload(plugin: any, payload: MountPayload, parentUid: string | null): Promise<boolean> {
    try {
        const item = await addMountItem(plugin, payload, parentUid);
        if (!item) {
            showMessage("挂载失败:目标节点已不存在", 3000, "error");
            return false;
        }
        showMessage(`${parentUid ? "已嵌套挂载" : "已挂载到虚拟文档树"}:${payload.name}`, 2500, "info");
        return true;
    } catch (e) {
        showMessage(`挂载失败: ${e}`, 3000, "error");
        return false;
    }
}

// 可选挂载位置的菜单项(已挂过的打勾)
function targetItems(plugin: any, payload: MountPayload) {
    return listMountTargets().map(t => ({
        label: t.label + (hasMounted(t.uid, payload.kind, payload.path, payload.targetId) ? " ✓" : ""),
        click: () => {
            void mountPayload(plugin, payload, t.uid);
        },
    }));
}

// 作为一项追加到调用方的 Menu 上(文件树 / 思源右键菜单复用其 Menu 实例)
export function addMountMenuItem(menu: Menu, plugin: any, payload: MountPayload): void {
    menu.addItem({
        icon: "iconList",
        label: "挂载到虚拟文档树",
        submenu: targetItems(plugin, payload),
    });
}

// 在虚拟文档/块行下嵌套挂载的前置步骤:该行只是思源数据的展示行,**不是挂载项**
// (没有 uid,挂载子项挂不住),必须先确保树上存在它对应的文档/块挂载项——
// 树上已有同目标挂载(任意位置)直接复用;否则自动把该目标挂到它展示所在的挂载节点
// (ownerUid)下,思路同「固定为手动挂载项」:树上会多一条挂载行,与原虚拟行并存
// (本插件挂载行与引用/自动行设计上不去重)。
// 返回挂载项与是否新建;树上没有且 ownerUid 为空时返回 null(调用方退回顶层挂载)。
export async function ensureTargetMountItem(
    plugin: any,
    kind: "doc" | "block",
    targetId: string,
    name: string,
    ownerUid: string | null,
): Promise<{item: MountItem; created: boolean} | null> {
    // 深度优先找同目标挂载项(直接返回值,不用外层变量——闭包赋值会被 TS 窄化坑)
    const walk = (list: MountItem[]): MountItem | null => {
        for (const it of list) {
            if (it.kind === kind && it.targetId === targetId) return it;
            const hit = walk(it.children || []);
            if (hit) return hit;
        }
        return null;
    };
    const found = walk(getRoots());
    if (found) return {item: found, created: false};
    if (!ownerUid) return null;
    const item = await addMountItem(plugin, {kind, name, targetId}, ownerUid);
    return item ? {item, created: true} : null;
}

// 独立弹出挂载位置选择菜单
export function showMountTargetMenu(x: number, y: number, plugin: any, payload: MountPayload): void {
    const menu = new Menu();
    for (const it of targetItems(plugin, payload)) {
        menu.addItem(it);
    }
    menu.open({x, y});
}

// 判断路径是文件还是文件夹。
// 注意:不能直接 readDir(目标)——思源内核对**文件**也返回空数组,与"空文件夹"无法区分;
// 必须读父目录再按名字回查 DirEntry.isDir(与标签面板同一套做法)。
export async function detectIsDir(path: string): Promise<boolean> {
    try {
        const list = await readDir(dirname(path));
        const ent = (Array.isArray(list) ? list : []).find(e => e.name === basename(path));
        return ent ? !!ent.isDir : false;
    } catch {
        return false;
    }
}

// 上次资源管理器浏览位置(localStorage 持久化,重启思源后仍记住)
const LAST_BROWSE_DIR_KEY = "syfe-mount-last-dir";

// 系统绝对路径(仅盘符形态;"/data/..." 是工作空间内路径,不能作为原生对话框的起始目录)
const isNativeAbsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

function rememberLastBrowseDir(p: string, isDirPick: boolean): void {
    try {
        // 选中的是文件夹 → 记住它本身;是文件 → 记住所在目录
        const d = isDirPick ? p : dirname(p);
        if (d) localStorage.setItem(LAST_BROWSE_DIR_KEY, d);
    } catch {
        // localStorage 不可用:静默跳过
    }
}

function lastBrowseDir(): string {
    try {
        return localStorage.getItem(LAST_BROWSE_DIR_KEY) || "";
    } catch {
        return "";
    }
}

// 输入路径挂载文件/文件夹(虚拟文档树面板右键「挂载文件/文件夹…」用)。
// 附带「浏览文件…/浏览文件夹…」按钮:直接打开系统资源管理器选择,
// 起始目录 = 输入框已有系统绝对路径时取其父目录,否则取上次浏览位置。
export function promptMountPathDialog(
    title: string,
    onPicked: (p: string, isDir: boolean, name: string) => void,
): void {
    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content">
                <div style="margin-bottom:6px;">文件或文件夹路径</div>
                <input class="b3-text-field fn__block" id="syfe-mtree-path" placeholder="E:\\notes 或 /data/子目录/笔记.md" />
                <div style="margin-top:8px;display:flex;gap:8px;">
                    <button class="b3-button b3-button--outline" id="syfe-mtree-browse-file">浏览文件…</button>
                    <button class="b3-button b3-button--outline" id="syfe-mtree-browse-dir">浏览文件夹…</button>
                </div>
                <div style="margin-top:6px;font-size:12px;opacity:.7;">支持工作空间内路径(/data/...)与系统绝对路径;资源管理器会定位到上次选择的位置</div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-mtree-cancel">取消</button>
                <button class="b3-button b3-button--text" id="syfe-mtree-ok">挂载</button>
            </div>`,
        width: "520px",
    });
    const inputEl = dialog.element.querySelector("#syfe-mtree-path") as HTMLInputElement;
    const close = () => dialog.destroy();

    // 打开系统资源管理器选择(桌面端);选中后回填输入框并记住位置
    const browse = async (isDir: boolean) => {
        if (!getNativeRequire()) {
            showMessage("打开资源管理器仅桌面端支持,请手动填写路径", 3000, "error");
            return;
        }
        const cur = inputEl.value.trim();
        const picked = await showOpenDialog({
            properties: [isDir ? "openDirectory" : "openFile"],
            title: isDir ? "选择要挂载的文件夹" : "选择要挂载的文件",
            defaultPath: isNativeAbsPath(cur) ? dirname(cur) : lastBrowseDir(),
        });
        if (!picked) return;
        rememberLastBrowseDir(picked, isDir);
        inputEl.value = picked;
        inputEl.focus();
    };

    const submit = async () => {
        const p = inputEl.value.trim();
        if (!p) {
            showMessage("请填写路径", 2000, "error");
            return;
        }
        const isDir = await detectIsDir(p);
        // 手动输入的系统绝对路径也计入"上次位置",浏览按钮跟着走
        if (isNativeAbsPath(p)) rememberLastBrowseDir(p, isDir);
        close();
        onPicked(p, isDir, basename(p));
    };
    inputEl.focus();
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void submit();
        }
    });
    dialog.element.querySelector("#syfe-mtree-browse-file")!.addEventListener("click", () => void browse(false));
    dialog.element.querySelector("#syfe-mtree-browse-dir")!.addEventListener("click", () => void browse(true));
    dialog.element.querySelector("#syfe-mtree-ok")!.addEventListener("click", () => void submit());
    dialog.element.querySelector("#syfe-mtree-cancel")!.addEventListener("click", close);
}

// ===== 挂载思源块:关键词搜块 / 直接粘贴块 ID,点击结果行完成挂载 =====
// 块 ID 形态:14 位时间戳-7 位随机(如 20240101150000-abcdefg)
const BLOCK_ID_RE = /^\d{14}-[0-9a-z]{7}$/i;

export function pickBlockDialog(title: string, onPicked: (blockId: string, label: string) => void): void {
    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-mount">
                <input class="b3-text-field fn__block" id="syfe-block-kw"
                    placeholder="输入关键词搜索思源块,或直接粘贴块 ID(如 20240101150000-abcdefg)" />
                <div class="syfe-mount__list" id="syfe-block-results" style="margin-top:8px;">
                    <div class="syfe-mount__hint">输入关键词自动搜索(回车立即搜);点击结果行完成挂载</div>
                </div>
            </div>`,
        width: "560px",
    });
    const kwEl = dialog.element.querySelector("#syfe-block-kw") as HTMLInputElement;
    const listEl = dialog.element.querySelector("#syfe-block-results") as HTMLElement;

    // SQL 字面量转义(单引号翻倍)+ LIKE 元字符转义(反斜杠,配合 ESCAPE 子句)
    const likeEsc = (s: string) =>
        String(s || "").replace(/'/g, "''").replace(/[\\%_]/g, (c) => "\\" + c);
    const escHTML = (s: string) =>
        String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    // 竞态防护:慢查询返回时若已有更新请求则丢弃(连续输入时防旧结果覆盖新结果)
    let seq = 0;
    const search = async () => {
        const kw = kwEl.value.trim();
        const my = ++seq;
        if (!kw) {
            listEl.innerHTML = `<div class="syfe-mount__hint">输入关键词自动搜索(回车立即搜);点击结果行完成挂载</div>`;
            return;
        }
        listEl.innerHTML = `<div class="syfe-mount__hint">搜索中…</div>`;
        let rows: {id: string; content: string; type: string; hpath: string}[] = [];
        try {
            if (BLOCK_ID_RE.test(kw)) {
                // 粘贴的是块 ID:精确命中一个
                const b = await getBlock(kw);
                if (b) rows = [{id: kw, content: b.content, type: b.type, hpath: ""}];
            } else {
                const res = await querySQL(
                    `SELECT id, content, type, hpath FROM blocks
                     WHERE content LIKE '%${likeEsc(kw)}%' ESCAPE '\\'
                       AND type != 'd' AND content != ''
                     LIMIT 50`);
                if (Array.isArray(res)) {
                    rows = res.filter((r: any) => r && r.id).map((r: any) => ({
                        id: String(r.id),
                        content: String(r.content == null ? "" : r.content),
                        type: String(r.type || "p"),
                        hpath: String(r.hpath || ""),
                    }));
                }
            }
        } catch {
            rows = [];
        }
        if (my !== seq) return;   // 已有更新的搜索,丢弃本轮结果
        if (rows.length === 0) {
            listEl.innerHTML = `<div class="syfe-mount__hint">没有匹配的块;换个关键词,或直接粘贴块 ID</div>`;
            return;
        }
        listEl.innerHTML = rows.map((r) => `
            <div class="syfe-mount__row" data-id="${escHTML(r.id)}" data-name="${escHTML(blockTitle(r.content, r.type))}"
                title="${escHTML(r.hpath || "")}${r.hpath ? "&#10;" : ""}块 ID: ${escHTML(r.id)}">
                <svg class="syfe-mount__icon"><use xlink:href="#iconList"></use></svg>
                <span class="syfe-mount__name"><span style="opacity:.55;margin-right:6px;font-size:11px;">${escHTML(r.type)}</span>${escHTML(blockTitle(r.content, r.type))}</span>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--small">挂载</button>
            </div>`).join("")
            + (rows.length >= 50 ? `<div class="syfe-mount__hint">仅显示前 50 条,可换更精确的关键词</div>` : "");
    };

    // 整行点击即挂载(按钮只是可见的落点提示)
    listEl.addEventListener("click", (e) => {
        const row = (e.target as HTMLElement).closest(".syfe-mount__row") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.id || "";
        if (!id) return;
        dialog.destroy();
        onPicked(id, row.dataset.name || id);
    });

    // 输入防抖自动搜索;回车立即搜
    let timer: number | undefined;
    kwEl.addEventListener("input", () => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => void search(), 400);
    });
    kwEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (timer) window.clearTimeout(timer);
            void search();
        }
    });
    kwEl.focus();
}
