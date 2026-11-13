// Outlook 邮箱挂载对话框:账号授权(设备码)→ 确认挂载整个邮箱。
// 邮箱是只读源,无目录选择 —— 授权完成后直接挂载根(outlook:///),树内出现
// 邮件文件夹(Inbox、Sent Items…),邮件为 .md 只读文件,附件在其 .files/ 目录。
import {Dialog, showMessage} from "siyuan";
import {
    MailDeviceAuth,
    mailListFolders,
    mailPollDeviceAuth,
    mailStartDeviceAuth,
    getOutlookMailConfig,
    isOutlookMailConfigured,
    saveOutlookMailConfig,
} from "../api/outlook-mail";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openOutlookMailDialog(opts: {
    title?: string;
    onPicked?: (vPath: string, label: string) => void;
} = {}): void {
    const title = opts.title || "Outlook 邮箱";
    const cfg = getOutlookMailConfig();
    let pollTimer: any = null;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-bdpan">
                <div class="syfe-bdpan__sec">
                    <div class="syfe-bdpan__title">账号与授权</div>
                    <div class="syfe-bdpan__hint">同一 Azure 应用即可(若已配置 OneDrive,填同一个 Client ID),但需在应用的 API 权限里额外添加 Microsoft Graph 委托权限 Mail.ReadWrite。<br />邮箱挂载为只读:树内出现邮件文件夹与邮件(.md 只读,附件在 .files/ 目录),不支持在插件里改邮件。</div>
                    <label class="syfe-bdpan__field"><span>Client ID</span><input id="syfe-om-clientid" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.clientId)}" placeholder="应用程序(客户端) ID(必需)" /></label>
                    <label class="syfe-bdpan__field"><span>账户类型</span><select id="syfe-om-authority" class="b3-select fn__flex-1">
                        <option value="common">个人 + 工作/学校账户(common)</option>
                        <option value="consumers">仅个人账户(consumers)</option>
                        <option value="organizations">仅工作/学校账户(organizations)</option>
                    </select></label>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button b3-button--text" id="syfe-om-auth">获取授权</button>
                        <span class="syfe-bdpan__status" id="syfe-om-status">${isOutlookMailConfigured() ? "已授权" : "尚未授权"}</span>
                    </div>
                    <div class="syfe-bdpan__authflow" id="syfe-om-authflow" style="display:none;"></div>
                </div>
                <div class="syfe-bdpan__sec" id="syfe-om-mount-sec" style="display:none;">
                    <div class="syfe-bdpan__title">确认挂载</div>
                    <div class="syfe-bdpan__hint" id="syfe-om-folders">加载文件夹中…</div>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button" id="syfe-om-mount">挂载邮箱</button>
                    </div>
                </div>
            </div>`,
        width: "560px",
    });
    const statusEl = dialog.element.querySelector("#syfe-om-status") as HTMLElement;
    const authflowEl = dialog.element.querySelector("#syfe-om-authflow") as HTMLElement;
    const mountSecEl = dialog.element.querySelector("#syfe-om-mount-sec") as HTMLElement;
    const foldersEl = dialog.element.querySelector("#syfe-om-folders") as HTMLElement;

    const inputVal = (id: string): string => ((dialog.element.querySelector("#" + id) as HTMLInputElement)?.value || "").trim();

    const pick = () => {
        if (pollTimer) clearTimeout(pollTimer);
        dialog.destroy();
        opts.onPicked?.("outlook:///", "[Outlook 邮箱]");
    };

    // 授权完成(或已有授权)→ 显示文件夹确认区
    const showMountSection = () => {
        if (!opts.onPicked) return;
        mountSecEl.style.display = "";
        void (async () => {
            try {
                const folders = await mailListFolders();
                foldersEl.innerHTML = `将挂载 ${folders.length} 个邮件文件夹: ${folders.map(f => f.name + "(" + f.total + ")").join("、")}`;
            } catch (e) {
                foldersEl.textContent = `文件夹加载失败: ${(e as any)?.message || e}`;
            }
        })();
    };

    const startAuth = () => {
        const clientId = inputVal("syfe-om-clientid");
        if (!clientId) {
            showMessage("请先填写应用程序(客户端) ID", 3000, "error");
            return;
        }
        const authority = (dialog.element.querySelector("#syfe-om-authority") as HTMLSelectElement).value || "common";
        void saveOutlookMailConfig({clientId, authority});
        statusEl.textContent = "发起授权中…";
        void (async () => {
            let auth: MailDeviceAuth;
            try {
                auth = await mailStartDeviceAuth(clientId, authority);
            } catch (e) {
                statusEl.textContent = "发起失败";
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
                return;
            }
            authflowEl.style.display = "";
            authflowEl.innerHTML = `
                <div class="syfe-bdpan__hint">请在打开的微软页面输入验证码并确认:</div>
                <div class="syfe-bdpan__usercode">${escapeHTML(auth.userCode)}</div>
                <div class="syfe-bdpan__actions">
                    <button class="b3-button b3-button--outline" id="syfe-om-open-auth">打开授权页面</button>
                    <span class="syfe-bdpan__status" id="syfe-om-poll-status">等待确认…</span>
                </div>`;
            authflowEl.querySelector("#syfe-om-open-auth")!.addEventListener("click", () => {
                window.open(auth.verificationUrl, "_blank");
            });
            window.open(auth.verificationUrl, "_blank");
            let interval = auth.interval * 1000;
            const poll = async () => {
                if (!document.body.contains(dialog.element)) return;
                try {
                    const result = await mailPollDeviceAuth(auth);
                    if (result === "done") {
                        statusEl.textContent = "已授权(令牌自动刷新)";
                        authflowEl.style.display = "none";
                        showMessage("Outlook 邮箱授权成功", 2500, "info");
                        showMountSection();
                        return;
                    }
                    if (result === "slow") interval += 5000;
                    const ps = dialog.element.querySelector("#syfe-om-poll-status") as HTMLElement | null;
                    if (ps) ps.textContent = result === "slow" ? "请求过快,自动放慢…" : "等待你在微软页面确认…";
                } catch (e) {
                    statusEl.textContent = "授权失败";
                    const ps = dialog.element.querySelector("#syfe-om-poll-status") as HTMLElement | null;
                    if (ps) ps.textContent = String((e as any)?.message || e);
                    showMessage(`${(e as any)?.message || e}`, 6000, "error");
                    return;
                }
                pollTimer = setTimeout(() => void poll(), interval);
            };
            pollTimer = setTimeout(() => void poll(), interval);
        })();
    };

    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const id = ((ev.target as HTMLElement).closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-om-auth") startAuth();
        if (id === "syfe-om-mount") pick();
    });

    // 已有授权且是挂载流程:直接展示确认区
    if (isOutlookMailConfigured() && opts.onPicked) {
        showMountSection();
        mountSecEl.scrollIntoView?.();
    }
}
