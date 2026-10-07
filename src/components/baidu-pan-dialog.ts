// 百度网盘对话框:账号配置 + 挂载目标选择,两区合而为一。
// - 账号区:接入方式二选一
//     official —— 官方 API:填写开放平台 AppKey/SecretKey(pan.baidu.com/union 创建应用),设备码授权;
//     cookie   —— 网页 Cookie(BDUSS/STOKEN,全盘 + 同步空间,非官方接口)。
// - 挂载区(onPicked 提供时显示):快捷挂载「同步空间」(仅 cookie 模式),或逐层浏览网盘目录后挂载任意文件夹。
// 挂载结果回调 onPicked(vPath, label),vPath 为 bdpan:// 虚拟路径。
import {Dialog, showMessage} from "siyuan";
import {
    BdAuthTransientError,
    BdDeviceAuth,
    DEFAULT_BD_SYNC_DIR,
    bdListDir,
    bdPollDeviceAuth,
    bdQuota,
    bdStartDeviceAuth,
    getBaiduPanConfig,
    isBaiduConfigured,
    saveBaiduPanConfig,
} from "../api/baidu-pan";
import {BDPAN_SYNC_ROOT, baiduRootLabel} from "../utils/baidu-path";
import {formatFileSize} from "../constants";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openBaiduPanDialog(opts: {
    title?: string;
    onPicked?: (vPath: string, label: string) => void;
} = {}): void {
    const title = opts.title || "百度网盘";
    const cfg = getBaiduPanConfig();
    // 对话框内独立的浏览状态与接入方式(确认保存后才写入配置)
    let browseVPath: string | null = null;
    let curMode: "official" | "cookie" = cfg.mode;
    let pollTimer: any = null;

    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content syfe-bdpan">
                <div class="syfe-bdpan__sec">
                    <div class="syfe-bdpan__title">接入方式</div>
                    <select id="syfe-bd-mode" class="b3-select fn__flex-1">
                        <option value="official">官方 API(推荐:合规稳定,需在开放平台创建应用)</option>
                        <option value="cookie">网页 Cookie(全盘 + 同步空间,非官方接口)</option>
                    </select>
                    <div id="syfe-bd-official-sec"></div>
                    <div id="syfe-bd-cookie-sec"></div>
                    <div class="syfe-bdpan__actions">
                        <button class="b3-button b3-button--text" id="syfe-bd-save">保存并验证</button>
                        <span class="syfe-bdpan__status" id="syfe-bd-status"></span>
                    </div>
                </div>
                <div class="syfe-bdpan__sec" id="syfe-bd-mount-sec" style="display:none;">
                    <div class="syfe-bdpan__title">选择挂载目标</div>
                    <div class="syfe-mount__crumb" id="syfe-bd-crumb"></div>
                    <div class="syfe-mount__list" id="syfe-bd-list"></div>
                </div>
            </div>`,
        width: "560px",
    });
    const listEl = dialog.element.querySelector("#syfe-bd-list") as HTMLElement;
    const crumbEl = dialog.element.querySelector("#syfe-bd-crumb") as HTMLElement;
    const statusEl = dialog.element.querySelector("#syfe-bd-status") as HTMLElement;
    const mountSecEl = dialog.element.querySelector("#syfe-bd-mount-sec") as HTMLElement;
    const officialSecEl = dialog.element.querySelector("#syfe-bd-official-sec") as HTMLElement;
    const cookieSecEl = dialog.element.querySelector("#syfe-bd-cookie-sec") as HTMLElement;
    const modeEl = dialog.element.querySelector("#syfe-bd-mode") as HTMLSelectElement;
    modeEl.value = curMode;
    if (opts.onPicked) mountSecEl.style.display = "";

    const inputVal = (id: string): string => ((dialog.element.querySelector("#" + id) as HTMLInputElement)?.value || "").trim();

    // 渲染两种接入方式的字段区
    const renderAuthSections = () => {
        if (curMode === "official") {
            officialSecEl.style.display = "";
            cookieSecEl.style.display = "none";
            officialSecEl.innerHTML = `
                <div class="syfe-bdpan__hint">1. 访问 pan.baidu.com/union 注册开发者并创建应用,拿到 AppKey / SecretKey;<br />2. 填入后点「获取授权」,在百度页面输入验证码确认即可(令牌 30 天有效,自动续期)。<br />注意:未过审应用仅能访问网盘「我的应用数据 /apps/应用名/」目录,且官方 API 无同步空间。</div>
                <label class="syfe-bdpan__field"><span>AppKey</span><input id="syfe-bd-appkey" type="text" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.appKey)}" placeholder="开放平台应用的 AppKey(必需)" /></label>
                <label class="syfe-bdpan__field"><span>SecretKey</span><input id="syfe-bd-secret" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.secretKey)}" placeholder="开放平台应用的 SecretKey(必需)" /></label>
                <div class="syfe-bdpan__actions">
                    <button class="b3-button b3-button--outline" id="syfe-bd-auth">获取授权</button>
                    <span class="syfe-bdpan__status" id="syfe-bd-auth-status">${cfg.accessToken ? "已授权(令牌自动续期)" : "尚未授权"}</span>
                </div>
                <div class="syfe-bdpan__authflow" id="syfe-bd-authflow" style="display:none;"></div>`;
        } else {
            officialSecEl.style.display = "none";
            cookieSecEl.style.display = "";
            cookieSecEl.innerHTML = `
                <div class="syfe-bdpan__hint">登录 pan.baidu.com 后,浏览器 F12 → 应用/存储 → Cookies → 复制 BDUSS 与 STOKEN。凭据仅保存在本地插件数据;接口为非官方接口,请勿高频操作以免触发风控。</div>
                <label class="syfe-bdpan__field"><span>BDUSS</span><input id="syfe-bd-bduss" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.bduss)}" placeholder="网页 Cookie 中的 BDUSS 值(必需)" /></label>
                <label class="syfe-bdpan__field"><span>STOKEN</span><input id="syfe-bd-stoken" type="password" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.stoken)}" placeholder="网页 Cookie 中的 STOKEN 值(建议)" /></label>
                <label class="syfe-bdpan__field"><span>同步空间</span><input id="syfe-bd-syncdir" type="text" class="b3-text-field fn__flex-1" value="${escapeHTML(cfg.syncDir || DEFAULT_BD_SYNC_DIR)}" placeholder="/apps/sync(同步空间对应的云端目录)" /></label>`;
        }
    };

    // 设备码授权:发起 → 展示验证码 → 轮询(对话框关闭即停止)
    const startAuth = () => {
        const appKey = inputVal("syfe-bd-appkey");
        const secretKey = inputVal("syfe-bd-secret");
        if (!appKey || !secretKey) {
            showMessage("请先填写 AppKey 与 SecretKey", 3000, "error");
            return;
        }
        const statusElAuth = dialog.element.querySelector("#syfe-bd-auth-status") as HTMLElement;
        const flowEl = dialog.element.querySelector("#syfe-bd-authflow") as HTMLElement;
        statusElAuth.textContent = "发起授权中…";
        void (async () => {
            let auth: BdDeviceAuth;
            try {
                auth = await bdStartDeviceAuth(appKey, secretKey);
            } catch (e) {
                statusElAuth.textContent = "发起失败";
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
                return;
            }
            flowEl.style.display = "";
            flowEl.innerHTML = `
                <div class="syfe-bdpan__hint">请在打开的百度页面输入验证码并确认:</div>
                <div class="syfe-bdpan__usercode">${escapeHTML(auth.userCode)}</div>
                <div class="syfe-bdpan__actions">
                    <button class="b3-button b3-button--outline" id="syfe-bd-open-auth">打开授权页面</button>
                    <span class="syfe-bdpan__status" id="syfe-bd-poll-status">等待确认…</span>
                </div>`;
            flowEl.querySelector("#syfe-bd-open-auth")!.addEventListener("click", () => {
                window.open(auth.verificationUrl, "_blank");
            });
            window.open(auth.verificationUrl, "_blank");
            // 轮询(对话框关闭即停止):临时异常自动重试,仅致命错误才终止
            let interval = auth.interval * 1000;
            let failures = 0;
            const poll = async () => {
                if (!document.body.contains(dialog.element)) return; // 对话框已关闭
                try {
                    const result = await bdPollDeviceAuth(auth);
                    failures = 0;
                    if (result === "done") {
                        statusElAuth.textContent = "已授权(令牌自动续期)";
                        (dialog.element.querySelector("#syfe-bd-poll-status") as HTMLElement | null)?.remove();
                        (dialog.element.querySelector("#syfe-bd-authflow") as HTMLElement | null)?.remove();
                        showMessage("百度网盘授权成功", 2500, "info");
                        void renderMount();
                        return;
                    }
                    if (result === "slow") interval += 5000;
                    const ps = dialog.element.querySelector("#syfe-bd-poll-status") as HTMLElement | null;
                    if (ps) ps.textContent = result === "slow" ? "请求过快,自动放慢…" : "等待你在百度页面确认…";
                } catch (e) {
                    // 临时异常:连续多次仍失败才终止;致命错误(过期/密钥无效/拒绝)立即终止
                    if (e instanceof BdAuthTransientError && ++failures < 6) {
                        const ps = dialog.element.querySelector("#syfe-bd-poll-status") as HTMLElement | null;
                        if (ps) ps.textContent = `${(e as Error).message}`;
                    } else {
                        statusElAuth.textContent = "授权失败";
                        const ps = dialog.element.querySelector("#syfe-bd-poll-status") as HTMLElement | null;
                        if (ps) ps.textContent = String((e as any)?.message || e);
                        showMessage(`${(e as any)?.message || e}`, 6000, "error");
                        return;
                    }
                }
                pollTimer = setTimeout(() => void poll(), interval);
            };
            pollTimer = setTimeout(() => void poll(), interval);
        })();
    };

    // 保存并验证:按当前接入方式写配置 → 查配额
    const saveAndVerify = () => {
        const status = () => statusEl;
        void (async () => {
            try {
                status().textContent = "验证中…";
                if (curMode === "official") {
                    await saveBaiduPanConfig({
                        mode: "official",
                        appKey: inputVal("syfe-bd-appkey"),
                        secretKey: inputVal("syfe-bd-secret"),
                    });
                    if (!isBaiduConfigured()) {
                        status().textContent = "尚未授权";
                        showMessage("请先点「获取授权」完成设备码授权", 4000, "error");
                        return;
                    }
                } else {
                    const bduss = inputVal("syfe-bd-bduss");
                    if (!bduss) {
                        status().textContent = "请填写 BDUSS";
                        showMessage("请填写 BDUSS", 3000, "error");
                        return;
                    }
                    await saveBaiduPanConfig({
                        mode: "cookie",
                        bduss,
                        stoken: inputVal("syfe-bd-stoken"),
                        syncDir: inputVal("syfe-bd-syncdir"),
                    });
                }
                const q = await bdQuota();
                status().textContent = `已连接:总 ${formatFileSize(q.quota)},已用 ${formatFileSize(q.used)}`;
                showMessage("百度网盘连接成功", 2000, "info");
            } catch (e) {
                status().textContent = "连接失败";
                showMessage(`${(e as any)?.message || e}`, 6000, "error");
            }
        })();
    };

    const pick = (vPath: string, label: string) => {
        if (pollTimer) clearTimeout(pollTimer);
        dialog.destroy();
        opts.onPicked?.(vPath, label);
    };

    // 渲染挂载区:快捷层 / 目录浏览层
    const renderMount = async () => {
        try {
            if (!isBaiduConfigured()) {
                crumbEl.innerHTML = `<span>选择挂载目标</span>`;
                listEl.innerHTML = `<div class="syfe-mount__hint">请先在上方完成账号配置并验证通过</div>`;
                return;
            }
            if (browseVPath === null) {
                // 快捷层:同步空间(cookie 模式)+ 浏览整个网盘
                crumbEl.innerHTML = `<span>选择挂载目标</span>`;
                listEl.innerHTML = `
                    ${curMode === "cookie" ? `
                    <div class="syfe-mount__row" data-vpath="${BDPAN_SYNC_ROOT}">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconCloud"></use></svg>
                        <span class="syfe-mount__name" title="挂载百度网盘同步空间">同步空间</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">浏览</button>
                        <button class="b3-button b3-button--small" data-act="pick">挂载</button>
                    </div>` : `
                    <div class="syfe-mount__hint" style="text-align:left;padding:4px 6px;">同步空间仅「网页 Cookie」模式支持(官方 API 无同步空间接口);未过审应用只能访问 /apps/<应用名>/ 目录。</div>`}
                    <div class="syfe-mount__row" data-vpath="bdpan:///">
                        <svg class="syfe-mount__icon"><use xlink:href="#iconFolder"></use></svg>
                        <span class="syfe-mount__name" title="浏览并挂载网盘目录">全部文件</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline" data-act="enter">进入</button>
                    </div>`;
                return;
            }
            // 目录浏览层:列出子目录,可挂载/进入;顶部返回快捷层
            crumbEl.innerHTML = `
                <span class="syfe-mount__back" data-act="back" title="返回上一级">‹ 返回</span>
                <span class="syfe-mount__mountcur" title="${escapeHTML(baiduRootLabel(browseVPath))}">${escapeHTML(baiduRootLabel(browseVPath))}</span>
                <span class="fn__flex-1"></span>
                <button class="b3-button b3-button--small" data-act="pick-cur">挂载当前目录</button>`;
            listEl.innerHTML = `<div class="syfe-mount__hint">加载中…</div>`;
            const entries = await bdListDir(browseVPath);
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
    modeEl.addEventListener("change", () => {
        curMode = modeEl.value === "cookie" ? "cookie" : "official";
        renderAuthSections();
    });
    dialog.element.addEventListener("click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        const id = (target.closest("[id]") as HTMLElement | null)?.id;
        if (id === "syfe-bd-auth") {
            startAuth();
            return;
        }
        if (id === "syfe-bd-save") {
            saveAndVerify();
            return;
        }
        // 挂载区点击(限定在挂载面板内)
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
                const label = row.querySelector(".syfe-mount__name")?.textContent?.trim() || "同步空间";
                pick(vPath, vPath === BDPAN_SYNC_ROOT ? "同步空间" : label);
                return;
            }
            if (act === "pick-cur" && browseVPath) {
                pick(browseVPath, browseVPath === BDPAN_SYNC_ROOT ? "同步空间" : (baiduRootLabel(browseVPath).replace(/^\[[^\]]+\]\s*/, "") || "网盘目录"));
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

    renderAuthSections();
    if (opts.onPicked) void renderMount();
}
