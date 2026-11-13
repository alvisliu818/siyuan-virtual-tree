// 移动/复制的目标目录选择器:从虚拟文档树的挂载根出发,逐层浏览真实目录。
// 复用 syfe-mount 对话框样式(与挂载目标选择器同款)。
import {Dialog, showMessage} from "siyuan";
import {readDir} from "../api/file";
import {joinPath} from "../utils/path";
import {getRoots} from "../mount-tree";
import {isBaiduPath} from "../utils/baidu-path";
import {isGitRepoPath} from "../utils/git-repo-path";
import {isLibraryPath} from "../utils/library-path";
import {isRemotePath} from "../utils/path";
import {normDirKey} from "../utils/virtual-tree";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface DestPickerOptions {
    title: string;
    srcPath: string;
    srcIsDir: boolean;
    onPick(destDir: string): void;
}

export function pickDestDirDialog(opts: DestPickerOptions): void {
    // null = 挂载根层;否则为当前浏览的真实目录
    let current: string | null = null;
    const dialog = new Dialog({
        title: opts.title,
        content: `
            <div class="b3-dialog__content syfe-mount">
                <div class="syfe-mount__crumb"></div>
                <div class="syfe-mount__list"></div>
            </div>`,
        width: "520px",
    });
    const listEl = dialog.element.querySelector(".syfe-mount__list") as HTMLElement;
    const crumbEl = dialog.element.querySelector(".syfe-mount__crumb") as HTMLElement;

    const pick = (destDir: string) => {
        const d = normDirKey(destDir);
        const s = normDirKey(opts.srcPath);
        if (d === s) {
            showMessage("目标位置与源相同", 3000, "error");
            return;
        }
        if (opts.srcIsDir && d.startsWith(s + "/")) {
            showMessage("不能把文件夹移动/复制到它自己的子目录里", 3000, "error");
            return;
        }
        if (isBaiduPath(destDir) || isGitRepoPath(destDir)) {
            showMessage("网盘/Git 仓库目录暂不支持作为移动/复制目标", 3000, "error");
            return;
        }
        dialog.destroy();
        opts.onPick(destDir);
    };

    const render = async () => {
        try {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            if (current === null) {
                const roots = getRoots().filter(r =>
                    r.kind === "file" && r.isDir && r.path &&
                    !isBaiduPath(r.path) && !isGitRepoPath(r.path) && !isLibraryPath(r.path));
                crumbEl.innerHTML = `<span>选择目标目录(挂载根)</span>`;
                if (roots.length === 0) {
                    listEl.innerHTML = `<div class="syfe-mount__hint">没有可用的目录根,先在虚拟文档树挂载文件夹</div>`;
                    return;
                }
                listEl.innerHTML = roots.map(r => `
                    <div class="syfe-mount__row" data-dir="${escapeHTML(r.path!)}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>
                        <span class="syfe-mount__name" title="${escapeHTML(r.path!)}">${escapeHTML(r.name)}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">浏览</button>
                        <button class="b3-button b3-button--small" data-act="pick">选择</button>
                    </div>`).join("");
                return;
            }
            const entries = (await readDir(current)).filter(e => e.isDir && !isRemotePath(e.path || ""));
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回上一级">‹ 返回</span>
                <span class="syfe-mount__mountcur" title="${escapeHTML(current)}">${escapeHTML(current)}</span>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--small" data-act="pick-cur">选择当前目录</button>`;
            if (entries.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">没有子目录(可选择当前目录)</div>`;
                return;
            }
            listEl.innerHTML = entries.map(e => `
                <div class="syfe-mount__row" data-dir="${escapeHTML(joinPath(current!, e.name))}">
                    <svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>
                    <span class="syfe-mount__name" title="${escapeHTML(e.name)}">${escapeHTML(e.name)}</span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                    <button class="b3-button b3-button--small" data-act="pick">选择</button>
                </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const btn = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
        const row = (ev.target as HTMLElement).closest(".syfe-mount__row") as HTMLElement | null;
        if (btn) {
            const act = btn.dataset.act;
            if (act === "pick-cur" && current !== null) {
                pick(current);
                return;
            }
            if (act === "pick" && row) {
                pick(row.dataset.dir!);
                return;
            }
            if (act === "enter" && row) {
                current = row.dataset.dir!;
                void render();
                return;
            }
            if (act === "back") {
                if (current === null) return;
                const trimmed = current.replace(/[\\/]+$/, "");
                const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
                const parent = idx > 0 ? trimmed.slice(0, idx) : null;
                const underRoot = (p: string) => getRoots().some(r => {
                    if (r.kind !== "file" || !r.path) return false;
                    const rk = normDirKey(r.path);
                    const pk = normDirKey(p);
                    return rk === "/" || pk === rk || pk.startsWith(rk + "/");
                });
                current = parent !== null && underRoot(parent) ? parent : null;
                void render();
                return;
            }
            return;
        }
        if (row) {
            current = row.dataset.dir!;
            void render();
        }
    });
    void render();
}