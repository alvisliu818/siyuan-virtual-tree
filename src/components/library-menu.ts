// 插件库右键动作:外部文件/文件夹 → 库内链接;库内链接条目 → 取消同步。
// 两个动作都只动链接与注册表,外部真实数据始终不被搬移、改写或删除。
import {confirm, showMessage} from "siyuan";
import {libraryEntryNameOf} from "../utils/library-path";
import {getLibraryUnlinkMode} from "../utils/config";
import {addLibraryEntry, getLibraryEntryByPath} from "../api/library";
import {unlinkLibraryEntry} from "../api/library-sync";

const LINK_KIND_LABEL: Record<string, string> = {
    junction: "目录链接",
    symlink: "文件符号链接",
    hardlink: "硬链接",
};

// 添加到插件库:非破坏性且可用「取消同步」还原,不再二次确认
export function addToLibrary(path: string, refresh: () => void): void {
    void (async () => {
        try {
            const entry = await addLibraryEntry(path);
            showMessage(
                `已添加到插件库:「${entry.name}」(${LINK_KIND_LABEL[entry.linkKind] || entry.linkKind})。`
                + "绑定 Git 仓库后移动端才能访问。",
                6000, "info",
            );
            refresh();
        } catch (e) {
            showMessage(`添加到插件库失败: ${(e as Error)?.message || e}`, 6000, "error");
        }
    })();
}

// 远端处理方式在设置 → 插件库里选;库内与外部是同一份数据,本地侧只有"摘链接"一种语义
const REMOTE_MODE_TEXT: Record<string, string> = {
    push: "会先把本地改动推送到已绑定的 Git 远端,再解除绑定。",
    keep: "已绑定的 Git 远端保持原样。",
    deleteRemote: "会在已绑定的 Git 远端提交一次删除(仍可从 Git 历史找回)。",
};

export function unlinkLibrary(path: string, refresh: () => void): void {
    const name = libraryEntryNameOf(path);
    const entry = getLibraryEntryByPath(path);
    const target = entry?.target || "";
    const mode = getLibraryUnlinkMode();
    const remoteNote = entry?.git ? REMOTE_MODE_TEXT[mode] : "";
    confirm(
        "取消同步",
        `确定取消「${name}」的同步吗?只会移除插件库里的链接${target ? `(指向 ${target})` : ""},`
        + "外部文件与文件夹保持原样,不会被删除或移动。"
        + (remoteNote ? "\n" + remoteNote + "(可在设置 → 插件库里更改)" : ""),
        () => {
            void (async () => {
                try {
                    const r = await unlinkLibraryEntry(name, mode, msg => showMessage(msg, 2000, "info"));
                    const extra = r.pushed ? `,已推送 ${r.pushed} 个文件` : r.removedRemote ? `,已在远端删除 ${r.removedRemote} 个文件` : "";
                    showMessage(`已取消同步,外部文件保持原样${extra}`, 4000, "info");
                    refresh();
                } catch (e) {
                    showMessage(`取消同步失败: ${(e as Error)?.message || e}`, 6000, "error");
                }
            })();
        },
        () => {},
    );
}