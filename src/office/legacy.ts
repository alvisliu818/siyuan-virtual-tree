import {showMessage} from "siyuan";
import {basename} from "../utils/path";
import {openTreeFileWithExternalApp} from "../utils/external-app";
import {toSystemPath} from "../utils/system-path";
import {OfficeEngine} from "./types";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 旧版 Office 二进制格式(doc/xls/ppt 及 WPS 对应格式)的兜底引擎
// 这些格式无法在浏览器中解析,只能交由系统关联的外部应用打开编辑。
export async function createLegacyEngine(
    path: string,
    _onDirtyChange: (dirty: boolean) => void,
): Promise<OfficeEngine> {
    const root = document.createElement("div");
    root.className = "syfe-office syfe-office--legacy";
    const name = basename(path);
    const sysPath = toSystemPath(path);

    root.innerHTML = `
        <div class="syfe-office__legacy-box">
            <div class="syfe-office__legacy-title">${escapeHTML(name)}</div>
            <div class="syfe-office__legacy-desc">
                这是旧版 Office 二进制格式,浏览器内无法解析与编辑。<br />
                请用系统关联的应用程序(WPS / Microsoft Office / LibreOffice)打开编辑,
                保存后回到本插件「重载」即可看到最新内容。
            </div>
            <button class="b3-button b3-button--text syfe-office__legacy-btn" data-act="open">用外部应用打开</button>
            <div class="syfe-office__legacy-path" title="${escapeHTML(sysPath)}">${escapeHTML(sysPath)}</div>
        </div>`;

    const btn = root.querySelector("[data-act='open']") as HTMLButtonElement;
    const handler = async () => {
        btn.disabled = true;
        try {
            await openTreeFileWithExternalApp(path);
        } catch (e) {
            showMessage(`打开失败: ${e}`, 5000, "error");
        } finally {
            btn.disabled = false;
        }
    };
    btn.addEventListener("click", handler);

    return {
        root,
        editable: false,
        isDirty: () => false,
        onDirtyChange: () => {},
        // 无可就地保存的内容,保存为空操作
        async save() {},
        dispose() {
            btn.removeEventListener("click", handler);
        },
    };
}
