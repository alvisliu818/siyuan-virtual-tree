// IMAP 邮箱挂载对话框(QQ 邮箱 / 网易 163 / 126;桌面端专用):
// 供应商选择 + 邮箱地址 + IMAP 授权码 → 测试连接(列邮箱夹)→ 挂载整个邮箱根。
// 邮箱为只读源:文件夹 → 邮件(.md 只读,附件在 .files/)。
import {Dialog, showMessage} from "siyuan";
import {
    IMAP_PROVIDERS,
    imapProviderOf,
    imapListFolders,
    getImapMailConfig,
    isImapConfigured,
    saveImapMailConfig,
} from "../api/imap-mail";
import {imapProviderRoot} from "../utils/imap-path";
import {isNodeModulesAvailable} from "../utils/native-require";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openImapMailDialog(opts: {
    title?: string;
    onPicked?: (vPath: string, label: string) => void;
} = {}): void {
    if (!isNodeModulesAvailable()) {
        showMessage("邮箱挂载仅桌面端可用(移动端 webview 没有 TCP/Node 能力)", 5000, "info");
        return;
    }
    const title = opts.title || "挂载邮箱(IMAP)";
    const cfg = getImapMailConfig();
    let pollDone = false;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-bdpan">
                <div class="syfe-bdpan__sec">
                    <div class="syfe-bdpan__title">账号(IMAP)</div>
                    <div class="syfe-bdpan__hint">QQ 邮箱:设置 → 账户 → 开启 IMAP/SMTP 服务 → 拿授权码;网易 163/126:设置 → POP3/IMAP/SMTP → 开启服务 → 拿客户端授权密码。授权码不是登录密码。仅桌面端可用。</div>
                    <label class="syfe-bdpan__field"><span>供应商</span><select id="syfe-im-provider" class="b3-select fn__flex-1">
                        ${IMAP_PROVIDERS.map(p => `<option value="${p.key}">${p.label}(${p.host})</option>`).join("")}
                    </select></label>
                    <label class="syfe-bdpan__field"><span>邮箱地址</span><input id="syfe-im-user" type="text" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.user)}" placeholder="完整邮箱地址,如 12345@qq.com" /></label>
                    <label class="syfe-bdpan__field"><span>授权码</span><input id="syfe-im-pass" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.pass)}" placeholder="IMAP 授权码(非登录密码)" /></label>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button b3-button--text" id="syfe-im-save">保存并验证</button>
                        <span class="syfe-bdpan__status" id="syfe-im-status">${isImapConfigured() ? "已配置" : "未配置"}</span>
                    </div>
                </div>
                <div class="syfe-bdpan__sec" id="syfe-im-mount-sec" style="display:none;">
                    <div class="syfe-bdpan__title">确认挂载</div>
                    <div class="syfe-bdpan__hint" id="syfe-im-folders">加载文件夹中…</div>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button" id="syfe-im-mount">挂载邮箱</button>
                    </div>
                </div>
            </div>`,
        width: "560px",
    });
    const statusEl = dialog.element.querySelector("#syfe-im-status") as HTMLElement;
    const mountSecEl = dialog.element.querySelector("#syfe-im-mount-sec") as HTMLElement;
    const foldersEl = dialog.element.querySelector("#syfe-im-folders") as HTMLElement;

    const inputVal = (id: string): string => ((dialog.element.querySelector("#" + id) as HTMLInputElement)?.value || "").trim();

    const showFolders = () => {
        if (!opts.onPicked) return;
        mountSecEl.style.display = "";
        foldersEl.textContent = "加载文件夹中…";
        void (async () => {
            try {
                const root = imapProviderRoot(getImapMailConfig().provider);
                const folders = await imapListFolders(root);
                foldersEl.textContent = `将挂载 ${folders.length} 个邮箱夹: ${folders.map(f => f.name).join("、")}`;
            } catch (e) {
                foldersEl.textContent = `文件夹加载失败: ${(e as any)?.message || e}`;
            }
        })();
    };

    const saveAndVerify = () => {
        void (async () => {
            const provider = (dialog.element.querySelector("#syfe-im-provider") as HTMLSelectElement).value;
            const user = inputVal("syfe-im-user");
            const pass = inputVal("syfe-im-pass");
            if (!user || !pass) {
                statusEl.textContent = "请填写邮箱地址与授权码";
                showMessage("请填写邮箱地址与授权码", 3000, "error");
                return;
            }
            try {
                statusEl.textContent = "连接中…";
                await saveImapMailConfig({provider, user, pass});
                const root = imapProviderRoot(provider);
                const folders = await imapListFolders(root);
                const info = imapProviderOf(provider);
                statusEl.textContent = `已连接: ${info.label}`;
                showMessage(`${info.label} 连接成功`, 2000, "info");
                if (opts.onPicked) showFolders();
                void folders;
            } catch (e) {
                statusEl.textContent = "连接失败";
                showMessage(`${(e as any)?.message || e}`, 8000, "error");
            }
        })();
    };

    const pick = () => {
        const provider = (dialog.element.querySelector("#syfe-im-provider") as HTMLSelectElement).value;
        dialog.destroy();
        opts.onPicked?.(imapProviderRoot(provider), imapProviderOf(provider).label);
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const id = ((ev.target as HTMLElement).closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-im-save") saveAndVerify();
        if (id === "syfe-im-mount") pick();
    });

    // 已配置且是挂载流程:直接展示确认区
    if (isImapConfigured() && opts.onPicked) {
        (dialog.element.querySelector("#syfe-im-provider") as HTMLSelectElement).value = cfg.provider;
        showFolders();
    } else {
        (dialog.element.querySelector("#syfe-im-provider") as HTMLSelectElement).value = cfg.provider || "qq";
    }
}
