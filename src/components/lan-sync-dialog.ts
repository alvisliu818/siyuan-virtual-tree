// 局域网同步任务管理对话框(桌面端)。
// 任务 = 本端目录 + 对端地址/共享根 + 方向 + 白/黑名单正则。
// 两个操作:预览差异(只算不动手)、立即同步(按三方比对模型执行,见 api/lan-sync.ts)。
import {Dialog, showMessage} from "siyuan";
import {
    LanSyncTask,
    LanSyncReport,
    parseLanSyncTasks,
    saveLanSyncTasks,
    lanPing,
    previewLanSyncTask,
    runLanSyncTask,
    formatLanSyncReport,
} from "../api/lan-sync";
import {isNativeFsAvailable} from "../api/native-fs";

function esc(s: string): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function newTaskId(): string {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function openLanSyncDialog(plugin: any): void {
    if (!isNativeFsAvailable()) {
        showMessage("局域网同步需要思源桌面端(Node 集成不可用)", 4000, "error");
        return;
    }
    let tasks: LanSyncTask[] = parseLanSyncTasks(plugin.config?.lanSyncTasks);
    let currentId: string = tasks[0]?.id || "";
    let syncing = false;

    const dialog = new Dialog({
        title: "局域网同步",
        width: "720px",
        height: "560px",
        content: `
            <div class="b3-dialog__content syfe-lansync">
                <div class="syfe-lansync__layout">
                    <div class="syfe-lansync__side">
                        <div class="syfe-lansync__tasks" id="syfe-ls-tasks"></div>
                        <div class="syfe-lansync__side-actions">
                            <button class="b3-button b3-button--text" id="syfe-ls-new">新建任务</button>
                            <button class="b3-button b3-button--text" id="syfe-ls-del">删除任务</button>
                        </div>
                    </div>
                    <div class="syfe-lansync__main">
                        <div class="syfe-gitrepo__sec">
                            <div class="syfe-gitrepo__field"><span>名称</span><input class="b3-text-field" id="syfe-ls-name" /></div>
                            <div class="syfe-gitrepo__field"><span>本端目录</span><input class="b3-text-field" id="syfe-ls-root" placeholder="/data/笔记 或 E:\\Notes" /></div>
                            <div class="syfe-gitrepo__field"><span>对端地址</span><input class="b3-text-field" id="syfe-ls-url" placeholder="http://192.168.1.20:39099" /></div>
                            <div class="syfe-gitrepo__field"><span>对端令牌</span><input class="b3-text-field" id="syfe-ls-token" placeholder="空 = 用本机令牌" /></div>
                            <div class="syfe-gitrepo__field">
                                <span>方向</span>
                                <select class="b3-select" id="syfe-ls-dir">
                                    <option value="both">双向</option>
                                    <option value="push">仅推送</option>
                                    <option value="pull">仅拉取</option>
                                </select>
                                <select class="b3-select" id="syfe-ls-remote-root" title="对端共享根(测试连接后选择)"></select>
                            </div>
                        </div>
                        <div class="syfe-gitrepo__sec">
                            <div class="syfe-gitrepo__hint">
                                白/黑名单为正则表达式,每行一条,匹配任务范围内的相对路径(目录分隔符用 /)。
                                白名单空 = 全部包含;黑名单命中即排除。示例:<code>\\.md$</code>、<code>assets/</code>、<code>temp/.*\\.log</code>
                            </div>
                            <div class="syfe-gitrepo__field"><span>白名单</span><textarea class="b3-text-field" id="syfe-ls-include" rows="3" style="flex:1"></textarea></div>
                            <div class="syfe-gitrepo__field"><span>黑名单</span><textarea class="b3-text-field" id="syfe-ls-exclude" rows="3" style="flex:1"></textarea></div>
                        </div>
                        <div class="syfe-gitrepo__actions">
                            <button class="b3-button b3-button--text" id="syfe-ls-save">保存任务</button>
                            <button class="b3-button b3-button--text" id="syfe-ls-ping">测试连接</button>
                            <button class="b3-button b3-button--text" id="syfe-ls-preview">预览差异</button>
                            <button class="b3-button b3-button--outline" id="syfe-ls-run">立即同步</button>
                        </div>
                        <div class="syfe-gitrepo__status" id="syfe-ls-status"></div>
                        <pre class="syfe-lansync__report" id="syfe-ls-report"></pre>
                    </div>
                </div>
            </div>`,
    });

    const q = (sel: string) => dialog.element.querySelector(sel) as HTMLElement;
    const inputOf = (sel: string) => q(sel) as HTMLInputElement;
    const taOf = (sel: string) => q(sel) as HTMLTextAreaElement;
    const tasksEl = q("#syfe-ls-tasks") as HTMLElement;
    const remoteRootSel = q("#syfe-ls-remote-root") as HTMLSelectElement;
    const statusEl = q("#syfe-ls-status") as HTMLElement;
    const reportEl = q("#syfe-ls-report") as HTMLElement;

    const cur = (): LanSyncTask | undefined => tasks.find(t => t.id === currentId);

    const renderTasks = (): void => {
        if (tasks.length === 0) {
            tasksEl.innerHTML = `<div class="syfe-lansync__empty">还没有任务</div>`;
            return;
        }
        tasksEl.innerHTML = tasks.map(t => `
            <div class="syfe-lansync__task${t.id === currentId ? " syfe-lansync__task--on" : ""}" data-id="${esc(t.id)}">
                <span class="syfe-lansync__task-name">${esc(t.name || t.id)}</span>
                <span class="syfe-lansync__task-sub">${esc(t.localRoot)}</span>
            </div>`).join("");
    };

    const fillEditor = (): void => {
        const t = cur();
        inputOf("#syfe-ls-name").value = t?.name || "";
        inputOf("#syfe-ls-root").value = t?.localRoot || "";
        inputOf("#syfe-ls-url").value = t?.remoteUrl || "";
        inputOf("#syfe-ls-token").value = t?.remoteToken || "";
        (q("#syfe-ls-dir") as HTMLSelectElement).value = t?.direction || "both";
        taOf("#syfe-ls-include").value = t?.includeRules || "";
        taOf("#syfe-ls-exclude").value = t?.excludeRules || "";
        remoteRootSel.innerHTML = t?.remoteRootId
            ? `<option value="${esc(t.remoteRootId)}">${esc(t.remoteRootId)}</option>` : "";
    };

    const setReport = (report: LanSyncReport | null, text?: string): void => {
        reportEl.textContent = text ?? (report ? formatLanSyncReport(report) : "");
    };

    const collectEditor = (): LanSyncTask => {
        const existing = cur();
        return {
            id: existing?.id || newTaskId(),
            name: inputOf("#syfe-ls-name").value.trim() || "同步任务",
            localRoot: inputOf("#syfe-ls-root").value.trim(),
            remoteUrl: inputOf("#syfe-ls-url").value.trim(),
            remoteRootId: remoteRootSel.value || existing?.remoteRootId || "",
            remoteToken: inputOf("#syfe-ls-token").value.trim(),
            direction: ((q("#syfe-ls-dir") as HTMLSelectElement).value || "both") as LanSyncTask["direction"],
            includeRules: taOf("#syfe-ls-include").value,
            excludeRules: taOf("#syfe-ls-exclude").value,
            lastSyncTs: existing?.lastSyncTs,
        };
    };

    const saveCurrent = async (silent = false): Promise<void> => {
        const t = collectEditor();
        // 正则校验:无效正则保存时直接拦下,避免运行时静默忽略
        for (const [label, text] of [["白名单", t.includeRules], ["黑名单", t.excludeRules]] as Array<[string, string]>) {
            for (const line of text.split(/\r?\n/)) {
                const s = line.trim();
                if (!s) continue;
                try {
                    new RegExp(s);
                } catch {
                    showMessage(`${label}正则无效: ${s}`, 4000, "error");
                    return;
                }
            }
        }
        if (!t.localRoot) {
            showMessage("请填写本端目录", 3000, "error");
            return;
        }
        const idx = tasks.findIndex(x => x.id === t.id);
        if (idx >= 0) tasks[idx] = t; else tasks.push(t);
        currentId = t.id;
        await saveLanSyncTasks(plugin, tasks);
        renderTasks();
        if (!silent) showMessage("任务已保存", 2000, "info");
    };

    const withTask = (fn: (t: LanSyncTask) => Promise<void>): (() => void) => {
        return () => {
            if (syncing) return;
            void (async () => {
                syncing = true;
                try {
                    // 先把编辑器当前内容落盘,再取最新的任务对象(编辑未保存也生效)
                    await saveCurrent(true);
                    const t = cur();
                    if (!t) return;
                    await fn(t);
                } catch (e) {
                    statusEl.textContent = "";
                    setReport(null, `失败: ${(e as Error)?.message || e}`);
                } finally {
                    syncing = false;
                }
            })();
        };
    };

    // 任务列表点击切换
    tasksEl.addEventListener("click", (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
        if (!el) return;
        currentId = el.dataset.id || "";
        renderTasks();
        fillEditor();
        setReport(null, "");
        statusEl.textContent = "";
    });

    q("#syfe-ls-new").addEventListener("click", () => {
        const t: LanSyncTask = {
            id: newTaskId(),
            name: "同步任务",
            localRoot: "",
            remoteUrl: "",
            remoteRootId: "",
            remoteToken: "",
            direction: "both",
            includeRules: "",
            excludeRules: "",
        };
        tasks.push(t);
        currentId = t.id;
        renderTasks();
        fillEditor();
    });

    q("#syfe-ls-del").addEventListener("click", () => {
        if (!cur()) return;
        tasks = tasks.filter(t => t.id !== currentId);
        currentId = tasks[0]?.id || "";
        void saveLanSyncTasks(plugin, tasks);
        renderTasks();
        fillEditor();
        setReport(null, "");
    });

    q("#syfe-ls-save").addEventListener("click", () => void saveCurrent());

    q("#syfe-ls-ping").addEventListener("click", withTask(async (t) => {
        statusEl.textContent = "连接中...";
        const ping = await lanPing(t);
        remoteRootSel.innerHTML = ping.roots.map(r => `<option value="${esc(r.id)}">${esc(r.name || r.id)}(${esc(r.id)})</option>`).join("")
            || `<option value="">(对端还没有任务)</option>`;
        if (ping.roots.length > 0) {
            // 已配置的 rootId 还在对端就选中它,否则选第一个
            remoteRootSel.value = ping.roots.some(r => r.id === t.remoteRootId) ? t.remoteRootId : ping.roots[0].id;
            await saveCurrent();
        }
        statusEl.textContent = `连接成功,对端共享根 ${ping.roots.length} 个`;
    }));

    q("#syfe-ls-preview").addEventListener("click", withTask(async (t) => {
        statusEl.textContent = "比对中...";
        const report = await previewLanSyncTask(plugin, t, msg => (statusEl.textContent = msg));
        statusEl.textContent = "差异预览(未做任何修改)";
        setReport(report);
    }));

    q("#syfe-ls-run").addEventListener("click", withTask(async (t) => {
        statusEl.textContent = "同步中...";
        const report = await runLanSyncTask(plugin, t, false, msg => (statusEl.textContent = msg));
        t.lastSyncTs = Date.now();
        await saveLanSyncTasks(plugin, tasks);
        statusEl.textContent = `同步完成 ${new Date().toLocaleTimeString()}`;
        setReport(report);
    }));

    renderTasks();
    fillEditor();
}
