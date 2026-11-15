// OneDrive 云同步任务管理对话框(EasySync 模式:云中转,桌面/移动端同一套)。
// 任务 = 本端目录 + OneDrive 远端目录(onedrive:// 路径) + 方向 + 白/黑名单正则。
// 预览差异/立即同步走与局域网同步同一个三方引擎(api/lan-sync.ts runThreeWaySync)。
// 前置:先在「OneDrive」设置页完成账号授权(设备码登录)。
import {Dialog, showMessage} from "siyuan";
import {
    OdSyncTask,
    parseOdSyncTasks,
    saveOdSyncTasks,
    previewOdSyncTask,
    runOdSyncTask,
} from "../api/onedrive-sync";
import {isOneDriveConfigured} from "../api/onedrive";

function esc(s: string): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function newTaskId(): string {
    return "od" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function openOdSyncDialog(plugin: any): void {
    let tasks: OdSyncTask[] = parseOdSyncTasks(plugin.config?.odSyncTasks);
    let currentId: string = tasks[0]?.id || "";
    let syncing = false;

    const dialog = new Dialog({
        title: "OneDrive 云同步",
        width: "680px",
        height: "540px",
        content: `
            <div class="b3-dialog__content syfe-lansync">
                <div class="syfe-lansync__layout">
                    <div class="syfe-lansync__side">
                        <div class="syfe-lansync__tasks" id="syfe-od-tasks"></div>
                        <div class="syfe-lansync__side-actions">
                            <button class="b3-button b3-button--text" id="syfe-od-new">新建任务</button>
                            <button class="b3-button b3-button--text" id="syfe-od-del">删除任务</button>
                        </div>
                    </div>
                    <div class="syfe-lansync__main">
                        <div class="syfe-gitrepo__sec">
                            <div class="syfe-gitrepo__field"><span>名称</span><input class="b3-text-field" id="syfe-od-name" /></div>
                            <div class="syfe-gitrepo__field"><span>本端目录</span><input class="b3-text-field" id="syfe-od-root" placeholder="/data/笔记 或 E:\\Notes" /></div>
                            <div class="syfe-gitrepo__field"><span>远端目录</span><input class="b3-text-field" id="syfe-od-remote" placeholder="onedrive://docs/backup" /></div>
                            <div class="syfe-gitrepo__field">
                                <span>方向</span>
                                <select class="b3-select" id="syfe-od-dir">
                                    <option value="both">双向</option>
                                    <option value="push">仅推送</option>
                                    <option value="pull">仅拉取</option>
                                </select>
                            </div>
                        </div>
                        <div class="syfe-gitrepo__sec">
                            <div class="syfe-gitrepo__hint">
                                白/黑名单为正则表达式,每行一条,匹配任务范围内的相对路径(目录分隔符用 /)。
                                白名单空 = 全部包含;黑名单命中即排除。<br />
                                与局域网同步共用一套三方引擎:基线比对、冲突跳过、绝不自动删除本地文件;
                                远端删除后本地仍在的文件会持续提示,本地有新改动时会重建远端。<br />
                                <b>移动端</b>:本端目录须为工作空间内路径(以 /data/ 开头);云端经 Graph API 直连,
                                桌面/移动端行为一致。需先在「OneDrive」设置页完成账号授权。
                            </div>
                            <div class="syfe-gitrepo__field"><span>白名单</span><textarea class="b3-text-field" id="syfe-od-include" rows="3" style="flex:1"></textarea></div>
                            <div class="syfe-gitrepo__field"><span>黑名单</span><textarea class="b3-text-field" id="syfe-od-exclude" rows="3" style="flex:1"></textarea></div>
                        </div>
                        <div class="syfe-gitrepo__actions">
                            <button class="b3-button b3-button--text" id="syfe-od-save">保存任务</button>
                            <button class="b3-button b3-button--text" id="syfe-od-preview">预览差异</button>
                            <button class="b3-button b3-button--outline" id="syfe-od-run">立即同步</button>
                        </div>
                        <div class="syfe-gitrepo__status" id="syfe-od-status"></div>
                        <pre class="syfe-lansync__report" id="syfe-od-report"></pre>
                    </div>
                </div>
            </div>`,
    });

    const q = (sel: string) => dialog.element.querySelector(sel) as HTMLElement;
    const inputOf = (sel: string) => q(sel) as HTMLInputElement;
    const taOf = (sel: string) => q(sel) as HTMLTextAreaElement;
    const tasksEl = q("#syfe-od-tasks") as HTMLElement;
    const statusEl = q("#syfe-od-status") as HTMLElement;
    const reportEl = q("#syfe-od-report") as HTMLElement;

    const cur = (): OdSyncTask | undefined => tasks.find(t => t.id === currentId);

    const renderTasks = (): void => {
        if (tasks.length === 0) {
            tasksEl.innerHTML = `<div class="syfe-lansync__empty">还没有任务</div>`;
            return;
        }
        tasksEl.innerHTML = tasks.map(t => `
            <div class="syfe-lansync__task${t.id === currentId ? " syfe-lansync__task--on" : ""}" data-id="${esc(t.id)}">
                <span class="syfe-lansync__task-name">${esc(t.name || t.id)}</span>
                <span class="syfe-lansync__task-sub">${esc(t.remotePath || t.localRoot)}</span>
            </div>`).join("");
    };

    const fillEditor = (): void => {
        const t = cur();
        inputOf("#syfe-od-name").value = t?.name || "";
        inputOf("#syfe-od-root").value = t?.localRoot || "";
        inputOf("#syfe-od-remote").value = t?.remotePath || "";
        (q("#syfe-od-dir") as HTMLSelectElement).value = t?.direction || "both";
        taOf("#syfe-od-include").value = t?.includeRules || "";
        taOf("#syfe-od-exclude").value = t?.excludeRules || "";
    };

    const setReport = (text: string): void => {
        reportEl.textContent = text;
    };

    const collectEditor = (): OdSyncTask => {
        const existing = cur();
        return {
            id: existing?.id || newTaskId(),
            name: inputOf("#syfe-od-name").value.trim() || "同步任务",
            localRoot: inputOf("#syfe-od-root").value.trim(),
            remotePath: inputOf("#syfe-od-remote").value.trim(),
            direction: ((q("#syfe-od-dir") as HTMLSelectElement).value || "both") as OdSyncTask["direction"],
            includeRules: taOf("#syfe-od-include").value,
            excludeRules: taOf("#syfe-od-exclude").value,
            lastSyncTs: existing?.lastSyncTs,
        };
    };

    const saveCurrent = async (silent = false): Promise<void> => {
        const t = collectEditor();
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
        if (!t.localRoot || !t.remotePath) {
            showMessage("请填写本端目录与 OneDrive 远端目录", 3000, "error");
            return;
        }
        const idx = tasks.findIndex(x => x.id === t.id);
        if (idx >= 0) tasks[idx] = t; else tasks.push(t);
        currentId = t.id;
        await saveOdSyncTasks(plugin, tasks);
        renderTasks();
        if (!silent) showMessage("任务已保存", 2000, "info");
    };

    const withTask = (fn: (t: OdSyncTask) => Promise<void>): (() => void) => {
        return () => {
            if (syncing) return;
            if (!isOneDriveConfigured()) {
                showMessage("请先在设置 → OneDrive 完成账号授权", 4000, "error");
                return;
            }
            void (async () => {
                syncing = true;
                try {
                    await saveCurrent(true);
                    const t = cur();
                    if (!t) return;
                    await fn(t);
                } catch (e) {
                    statusEl.textContent = "";
                    setReport(`失败: ${(e as Error)?.message || e}`);
                } finally {
                    syncing = false;
                }
            })();
        };
    };

    tasksEl.addEventListener("click", (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
        if (!el) return;
        currentId = el.dataset.id || "";
        renderTasks();
        fillEditor();
        setReport("");
        statusEl.textContent = "";
    });

    q("#syfe-od-new").addEventListener("click", () => {
        const t: OdSyncTask = {
            id: newTaskId(),
            name: "同步任务",
            localRoot: "",
            remotePath: "",
            direction: "both",
            includeRules: "",
            excludeRules: "",
        };
        tasks.push(t);
        currentId = t.id;
        renderTasks();
        fillEditor();
    });

    q("#syfe-od-del").addEventListener("click", () => {
        if (!cur()) return;
        tasks = tasks.filter(t => t.id !== currentId);
        currentId = tasks[0]?.id || "";
        void saveOdSyncTasks(plugin, tasks);
        renderTasks();
        fillEditor();
        setReport("");
    });

    q("#syfe-od-save").addEventListener("click", () => void saveCurrent());

    q("#syfe-od-preview").addEventListener("click", withTask(async (t) => {
        statusEl.textContent = "比对中...";
        const report = await previewOdSyncTask(plugin, t, msg => (statusEl.textContent = msg));
        statusEl.textContent = "差异预览(未做任何修改)";
        setReport(formatReport(report));
    }));

    q("#syfe-od-run").addEventListener("click", withTask(async (t) => {
        statusEl.textContent = "同步中...";
        const report = await runOdSyncTask(plugin, t, false, msg => (statusEl.textContent = msg));
        t.lastSyncTs = Date.now();
        await saveOdSyncTasks(plugin, tasks);
        statusEl.textContent = `同步完成 ${new Date().toLocaleTimeString()}`;
        setReport(formatReport(report));
    }));

    // 报告文本(与局域网同步同款分类;从 report 对象本地拼装,避免引 lan-sync 的展示函数)
    function formatReport(report: {pushed: string[]; pulled: string[]; deletedRemote: string[]; remoteDeleted: string[]; conflicts: string[]; skipped: string[]}): string {
        const lines: string[] = [];
        const push = (label: string, list: string[]) => {
            if (list.length === 0) return;
            lines.push(`${label}(${list.length}):`);
            for (const it of list.slice(0, 50)) lines.push("  " + it);
            if (list.length > 50) lines.push(`  … 共 ${list.length} 条`);
        };
        push("推送云端", report.pushed);
        push("拉取本地", report.pulled);
        push("已提交云端删除", report.deletedRemote);
        push("云端已删除(本地保留)", report.remoteDeleted);
        push("冲突跳过", report.conflicts);
        push("其他跳过", report.skipped);
        if (lines.length === 0) lines.push("两侧已一致,无需同步");
        return lines.join("\n");
    }

    renderTasks();
    fillEditor();
}
