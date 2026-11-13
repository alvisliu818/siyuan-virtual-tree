// OneDrive 对话框:账号配置(设备码授权)+ 挂载目标选择,与百度网盘对话框同构。
// - 账号区:填写 Azure 应用(client)ID + 租户段,点「获取授权」走设备码流
//   (任意设备打开 microsoft.com/devicelogin 输码;令牌自动刷新)
// - 挂载区(onPicked 提供时显示):浏览 OneDrive 目录树后挂载任意文件夹
// 挂载结果回调 onPicked(vPath, label),vPath 为 onedrive:// 虚拟路径。
import {Dialog, showMessage} from "siyuan";
import {
    OdDeviceAuth,
    odListDir,
    odPollDeviceAuth,
    odQuota,
    odStartDeviceAuth,
    getOneDriveConfig,
    isOneDriveConfigured,
    saveOneDriveConfig,
} from "../api/onedrive";
import {oneDriveRootLabel, OD_PREFIX} from "../utils/onedrive-path";
import {formatFileSize} from "../constants";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openOneDriveDialog(opts: {
    title?: string;
    onPicked?: (vPath: string, label: string) => void;
} = {}): void {
    const title = opts.title || "OneDrive";
    const cfg = getOneDriveConfig();
    let browseVPath: string | null = null;
    let pollTimer: any = null;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-bdpan">
                <div class="syfe-bdpan__sec">
                    <div class="syfe-bdpan__title">账号与授权</div>
                    <div class="syfe-bdpan__hint">1. 在 Azure 门户(entrata.microsoft.com → 应用注册)新建注册:类型选「个人」,受支持的账户类型按需选(个人 OneDrive 选「任何组织目录中的个人账户」);<br />2. 重定向 URI 留空,「高级选项 → 允许公共客户端流」设为「是」;API 权限添加 Microsoft Graph 委托权限 Files.ReadWrite.All、User.Read、offline_access;<br />3. 把概览页的「应用程序(客户端) ID」填到下面,点「获取授权」即可。</div>
                    <label class="syfe-bdpan__field"><span>Client ID</span><input id="syfe-od-clientid" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.clientId)}" placeholder="应用程序(客户端) ID(必需)" /></label>
                    <label class="syfe-bdpan__field"><span>账户类型</span><select id="syfe-od-authority" class="b3-select fn__flex-1">
                        <option value="common">个人 + 工作/学校账户(common)</option>
                        <option value="consumers">仅个人账户(consumers)</option>
                        <option value="organizations">仅工作/学校账户(organizations)</option>
                    </select></label>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button b3-button--text" id="syfe-od-save">保存并验证</button>
                        <button class="b3-button b3-button--outline" id="syfe-od-auth">获取授权</button>
                        <span class="syfe-bdpan__status" id="syfe-od-status">${isOneDriveConfigured() ? (cfg.account ? "已授权:" + cfg.account : "已授权") : "尚未授权"}</span>
                    </div>
                    <div class="syfe-bdpan__authflow" id="syfe-od-authflow" style="display:none;"></div>
                </div>
                <div class="syfe-bdpan__sec" id="syfe-od-mount-sec" style="display:none;">
                    <div class="syfe-bdpan__title">选择挂载目标</div>
                    <div class="syfe-mount__crumb" id="syfe-od-crumb"></div>
                    <div class="syfe-mount__list" id="syfe-od-list"></div>
                </div>
            </div>`,
        width: "560px",
    });
    const listEl = dialog.element.querySelector("#syfe-od-list") as HTMLElement;
    const crumbEl = dialog.element.querySelector("#syfe-od-crumb") as HTMLElement;
    const statusEl = dialog.element.querySelector("#syfe-od-status") as HTMLElement;
    const mountSecEl = dialog.element.querySelector("#syfe-od-mount-sec") as HTMLElement;
    const authflowEl = dialog.element.querySelector("#syfe-od-authflow") as HTMLElement;

    const inputVal = (id: string): string => ((dialog.element.querySelector("#" + id) as HTMLInputElement)?.value || "").trim();

    // 保存并验证:写 client_id/authority → (已授权则)查配额
    const saveAndVerify = () => {
        void (async () => {
            const clientId = inputVal("syfe-od-clientid");
            if (!clientId) {
                statusEl.textContent = "请填写 Client ID";
                showMessage("请填写应用程序(客户端) ID", 3000, "error");
                return;
            }
            const authority = (dialog.element.querySelector("#syfe-od-authority") as HTMLSelectElement).value || "common";
            try {
                statusEl.textContent = "验证中…";
                await saveOneDriveConfig({clientId, authority});
                if (!isOneDriveConfigured()) {
                    statusEl.textContent = "尚未授权";
                    showMessage("请先点「获取授权」完成设备码授权", 4000, "error");
                    return;
                }
                const q = await odQuota();
                statusEl.textContent = `已连接:总 ${formatFileSize(q.quota)},已用 ${formatFileSize(q.used)}`;
                showMessage("OneDrive 连接成功", 2000, "info");
            } catch (e) {
                statusEl.textContent = "连接失败";
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
            }
        })();
    };

    // 设备码授权:发起 → 展示验证码 → 轮询(对话框关闭即停止)
    const startAuth = () => {
        const clientId = inputVal("syfe-od-clientid");
        if (!clientId) {
            showMessage("请先填写应用程序(客户端) ID", 3000, "error");
            return;
        }
        const authority = (dialog.element.querySelector("#syfe-od-authority") as HTMLSelectElement).value || "common";
        // 先落 client_id,轮询/后续请求要用
        void saveOneDriveConfig({clientId, authority});
        statusEl.textContent = "发起授权中…";
        void (async () => {
            let auth: OdDeviceAuth;
            try {
                auth = await odStartDeviceAuth(clientId, authority);
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
                    <button class="b3-button b3-button--outline" id="syfe-od-open-auth">打开授权页面</button>
                    <span class="syfe-bdpan__status" id="syfe-od-poll-status">等待确认…</span>
                </div>`;
            authflowEl.querySelector("#syfe-od-open-auth")!.addEventListener("click", () => {
                window.open(auth.verificationUrl, "_blank");
            });
            window.open(auth.verificationUrl, "_blank");
            let interval = auth.interval * 1000;
            let failures = 0;
            const poll = async () => {
                if (!document.body.contains(dialog.element)) return; // 对话框已关闭
                try {
                    const result = await odPollDeviceAuth(auth);
                    if (result === "done") {
                        statusEl.textContent = "已授权(令牌自动刷新)";
                        authflowEl.style.display = "none";
                        showMessage("OneDrive 授权成功", 2500, "info");
                        void renderMount();
                        return;
                    }
                    if (result === "slow") interval += 5000;
                    const ps = dialog.element.querySelector("#syfe-od-poll-status") as HTMLElement | null;
                    if (ps) ps.textContent = result === "slow" ? "请求过快,自动放慢…" : "等待你在微软页面确认…";
                } catch (e) {
                    statusEl.textContent = "授权失败";
                    const ps = dialog.element.querySelector("#syfe-od-poll-status") as HTMLElement | null;
                    if (ps) ps.textContent = String((e as any)?.message || e);
                    showMessage(`${(e as any)?.message || e}`, 6000, "error");
                    return;
                }
                pollTimer = setTimeout(() => void poll(), interval);
            };
            pollTimer = setTimeout(() => void poll(), interval);
        })();
    };

    const pick = (vPath: string, label: string) => {
        if (pollTimer) clearTimeout(pollTimer);
        dialog.destroy();
        opts.onPicked?.(vPath, label);
    };

    // 渲染挂载区:根快捷项 / 目录浏览层
    const renderMount = async () => {
        try {
            if (!isOneDriveConfigured()) {
                crumbEl.innerHTML = `<span>选择挂载目标</span>`;
                listEl.innerHTML = `<div class="syfe-mount__hint">请先在上方完成账号配置并授权</div>`;
                return;
            }
            if (browseVPath === null) {
                crumbEl.innerHTML = `<span>选择挂载目标</span>`;
                listEl.innerHTML = `
                    <div class="syfe-mount__row" data-vpath="${OD_PREFIX}/">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>
                        <span class="syfe-mount__name" title="浏览并挂载 OneDrive 目录">整个 OneDrive(根目录)</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                        <button class="b3-button b3-button--small" data-act="pick">挂载</button>
                    </div>`;
                return;
            }
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回上一级">‹ 返回</span>
                <span class="syfe-mount__mountcur" title="${escapeHTML(oneDriveRootLabel(browseVPath))}">${escapeHTML(oneDriveRootLabel(browseVPath))}</span>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--small" data-act="pick-cur">挂载当前目录</button>`;
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            const entries = await odListDir(browseVPath);
            const dirs = entries.filter(e => e.isDir);
            if (dirs.length === 0) {
                listEl.innerHTML = `<div class="syfe-mount__hint">没有子文件夹</div>`;
                return;
            }
            listEl.innerHTML = dirs.map(e => `
                <div class="syfe-mount__row" data-vpath="${escapeHTML(e.path || "")}" data-name="${escapeHTML(e.name)}">
                    <svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>
                    <span class="syfe-mount__name" title="${escapeHTML(e.name)}">${escapeHTML(e.name)}</span>
                    <span class="fn__flex-1"></span>
                    <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                    <button class="b3-button b3-button--small" data-act="pick">挂载</button>
                </div>`).join("");
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-mount__hint">加载失败: ${escapeHTML(String((e as any)?.message || e))}</div>`;
        }
    };

    // 事件绑定
    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const id = (target.closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-od-auth") {
            startAuth();
            return;
        }
        if (id === "syfe-od-save") {
            saveAndVerify();
            return;
        }
        if (!mountSecEl.contains(target)) return;
        const btn = target.closest("[data-act]") as HTMLElement | null;
        const row = target.closest(".syfe-mount__row") as HTMLElement | null;
        if (btn) {
            const act = btn.dataset.act;
            if (act === "back") {
                browseVPath = null;
                void renderMount();
                return;
            }
            if (act === "pick" && row?.dataset.vpath) {
                const vPath = row.dataset.vpath;
                const label = row.querySelector(".syfe-mount__name")?.textContent?.trim() || "OneDrive";
                pick(vPath, label);
                return;
            }
            if (act === "pick-cur" && browseVPath) {
                pick(browseVPath, oneDriveRootLabel(browseVPath).replace(/^\[[^\]]+\]\s*/, "") || "OneDrive");
                return;
            }
            if (act === "enter" && row?.dataset.vpath) {
                browseVPath = row.dataset.vpath;
                void renderMount();
                return;
            }
            return;
        }
        // 行点击 = 进入
        if (row?.dataset.vpath) {
            browseVPath = row.dataset.vpath;
            void renderMount();
        }
    });

    if (opts.onPicked) {
        mountSecEl.style.display = "";
        void renderMount();
    }
}
