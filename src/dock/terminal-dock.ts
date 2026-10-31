// 侧边栏「终端」面板:多终端版。
//
// 结构:标签条(可切换/可关闭/可新建) + 面板容器(每个终端一个 pane)。
// 每个 pane 复用终端 Tab 的整套实现 —— 把 tab config 的 init/destroy/resize
// call 到一个伪实例上(只需提供 element 与 data.cwd),那 500+ 行经过实机验证的
// 会话管理(后端选择、输入规范化、resize 同步、状态标签、重启)就一行都不用重写。
//
// 与终端 Tab 的关系:pane 与 Tab 互相独立,各持各的 shell 会话。
// pane 与 pane 之间也互相独立:切走时只是 display:none,会话保持存活。
import {showMessage, Menu} from "siyuan";
import {TERMINAL_DOCK_TYPE} from "../constants";
import {createTerminalTabConfig, IPluginForTerminalTab} from "../tabs/terminal-tab";
import {basename} from "../utils/path";
import {listTerminalShellOptions} from "../utils/builtin-terminal";

/** 同时开多少个终端封顶:每个终端是一个常驻 shell 进程,不设限会拖垮机器 */
const MAX_TERMINALS = 8;

interface TerminalPane {
    id: number;
    title: string;
    el: HTMLElement;
    /** 终端 Tab 配置的 init/destroy/resize 绑定的伪实例(结构与 TerminalTabInstance 对齐) */
    inst: any;
}

interface TerminalDockInstance {
    element: HTMLElement;
    data: {cwd?: string};
    _panes: TerminalPane[];
    _activeId: number;
    _seq: number;
    _tablist?: HTMLElement;
    _panesEl?: HTMLElement;
    _clickHandler?: (e: MouseEvent) => void;
    _plugin?: IPluginForTerminalTab;
    _tab?: any;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 重新渲染标签条(标题 + 关闭钮 + 高亮当前) */
function renderTabs(self: TerminalDockInstance): void {
    if (!self._tablist) return;
    const list = self._tablist.querySelector(".syfe-terminal-dock__tablist-items") as HTMLElement;
    if (!list) return;
    list.innerHTML = self._panes.map((p) => `
        <span class="syfe-terminal-dock__tab${p.id === self._activeId ? " syfe-terminal-dock__tab--active" : ""}" data-pane-id="${p.id}" title="${escapeHTML(p.title)}">
            <span class="syfe-terminal-dock__tab-title">${escapeHTML(p.title)}</span>
            <span class="syfe-terminal-dock__tab-close" data-pane-close="${p.id}" aria-label="关闭">
                <svg><use xlink:href="#iconClose"></use></svg>
            </span>
        </span>`).join("");
}

function switchPane(self: TerminalDockInstance, id: number): void {
    const pane = self._panes.find((p) => p.id === id);
    if (!pane) return;
    self._activeId = id;
    for (const p of self._panes) {
        p.el.classList.toggle("syfe-terminal-dock__pane--active", p.id === id);
    }
    renderTabs(self);
    // 从 display:none 变回可见后 xterm 需要重新 fit,否则画布尺寸是旧的
    fitWhenReady(pane.inst, [0, 200, 600, 1500]);
}

function closePane(self: TerminalDockInstance, id: number): void {
    const idx = self._panes.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const pane = self._panes[idx];
    try {
        pane.inst.destroy.call(pane.inst);
    } catch {
        // 会话可能已经退出
    }
    pane.el.remove();
    self._panes.splice(idx, 1);
    if (self._activeId === id) {
        const next = self._panes[Math.max(0, idx - 1)];
        if (next) switchPane(self, next.id);
        else self._activeId = -1;
    }
    renderTabs(self);
    renderEmpty(self);
}

/** 全部终端关闭后面板不能显得像坏了:给一行明确的空态提示 */
function renderEmpty(self: TerminalDockInstance): void {
    if (!self._panesEl) return;
    const hint = self._panesEl.querySelector(".syfe-terminal-dock__empty");
    if (self._panes.length === 0) {
        if (!hint) {
            const el = document.createElement("div");
            el.className = "syfe-terminal-dock__empty";
            el.textContent = "终端已全部关闭,点击右上角 + 新建";
            self._panesEl.appendChild(el);
        }
    } else if (hint) {
        hint.remove();
    }
}

/**
 * 渐进式 fit:dock 面板开启动画/布局稳定需要时间,单次 fit 会算出 1 行高的尺寸。
 * 在多个时间点重试,收敛后若缓冲区没有任何输出(提示符在 0 尺寸期被丢),
 * 补一个回车让 shell 打印新提示符 —— 否则用户看到的就是黑屏只剩光标。
 */
function fitWhenReady(inst: any, extraDelays: number[]): void {
    for (const delay of extraDelays) {
        setTimeout(() => {
            try {
                inst.resize.call(inst);
            } catch {
                // ignore
            }
            if (delay !== extraDelays[extraDelays.length - 1]) return;
            // 最后一次:检查缓冲区,空的就补提示符
            try {
                const term = inst._term;
                if (!term) return;
                let hasText = false;
                const buf = term.buffer?.active;
                if (buf) {
                    for (let i = 0; i < Math.min(buf.length, 40); i++) {
                        if ((buf.getLine(i)?.translateToString(true) || "").trim()) {
                            hasText = true;
                            break;
                        }
                    }
                }
                if (inst._builtinSession) {
                    const s = inst._builtinSession;
                    if (s.backend === "pty") {
                        // PTY 不补 \r(实测:bash --login 慢启动时,这里补的 \r 会在
                        // profile 完成后被当作空命令执行,出现双提示符)。
                        // 改为总是做一次行数抖动触发 SIGWINCH 让 shell 重绘当前行:
                        //   - 不污染输入流(复现实测:启动+resize 仍是单提示符)
                        //   - 0 尺寸期丢输出/只画出半个提示符的首个 pane 靠它救回
                        //     (缓冲哪怕非空也可能缺提示符,所以不做 hasText 短路)
                        //   - shell 还在慢启动时抖动无副作用,提示符稍后自然出现
                        try {
                            const cols = inst._term?.cols || 80;
                            const rows = inst._term?.rows || 24;
                            s.resize(cols, Math.max(2, rows - 1));
                            setTimeout(() => {
                                try {
                                    s.resize(cols, rows);
                                } catch {
                                    // ignore
                                }
                            }, 120);
                        } catch {
                            // ignore
                        }
                    } else if (!hasText) {
                        // 管道模式无 tty 回显,shell 不主动画提示符,必须逼一下
                        s.write("\r\n");
                    }
                }
            } catch {
                // ignore
            }
        }, delay);
    }
}

/** 全局设置里 shell 别名 → 显示名(菜单「默认」项标注当前全局选择用) */
const GLOBAL_SHELL_LABELS: Record<string, string> = {
    auto: "自动检测",
    pwsh: "PowerShell 7",
    powershell: "Windows PowerShell",
    cmd: "命令提示符",
    bash: "Git Bash",
};

/**
 * 加号菜单:选择用哪个 shell 新建终端。
 * 只列出本机实际可用的 shell(listTerminalShellOptions 已做安装探测);
 * 「默认」项跟随全局设置。未安装的 shell 直接不显示。
 */
function openNewShellMenu(self: TerminalDockInstance, e: MouseEvent): void {
    const cwd = self.data?.cwd || "/data";
    const menu = new Menu("syfe-terminal-new");
    const globalId = self._plugin?.config?.terminalShell || "auto";
    menu.addItem({
        icon: "iconTerminal",
        label: `默认(当前:${GLOBAL_SHELL_LABELS[globalId] || globalId})`,
        click: () => createPane(self, cwd),
    });
    menu.addSeparator();
    let added = 0;
    for (const opt of listTerminalShellOptions()) {
        if (opt.id === "auto" || !opt.available) continue;
        menu.addItem({
            icon: "iconTerminal",
            label: opt.label,
            click: () => createPane(self, cwd, opt.id),
        });
        added++;
    }
    // click 处理器里同步弹菜单,事件继续冒泡到 document 会被思源 globalClickHideMenu
    // 立即关闭(实测:菜单开了就被关)——必须掐断冒泡
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    menu.open({x: Math.min(rect.left, window.innerWidth - 200), y: rect.bottom + 4});
}

function createPane(self: TerminalDockInstance, cwd: string, shellOverride?: string): void {
    if (!self._panesEl) return;
    if (self._panes.length >= MAX_TERMINALS) {
        showMessage(`最多同时开 ${MAX_TERMINALS} 个终端`, 3000, "error");
        return;
    }
    const id = ++self._seq;
    // 标题去重:同目录的第 2/3 个终端加序号;不同 shell 的终端以「 · shell」后缀区分
    const shellSuffix = shellOverride ? ` · ${shellOverride}` : "";
    const base = (basename(cwd) || cwd) + shellSuffix;
    let title = base;
    let n = 2;
    while (self._panes.some((p) => p.title === title)) title = `${base} (${n++})`;

    const paneEl = document.createElement("div");
    // ⚠️ 必须先激活(display:block)再 init:xterm 在隐藏容器里 open() 时尺寸为 0,
    // shell 启动瞬间写下的提示符/横幅会丢,之后 fit 也补不回来 → 黑屏只剩光标
    paneEl.className = "syfe-terminal-dock__pane syfe-terminal-dock__pane--active";
    self._panesEl.appendChild(paneEl);
    const prevActive = self._panes.find((p) => p.id === self._activeId);
    if (prevActive) prevActive.el.classList.remove("syfe-terminal-dock__pane--active");
    self._activeId = id;

    // 伪实例:终端 Tab 的 init/destroy/resize 只依赖 element 与 data.cwd/shell
    const inst: any = {element: paneEl, data: {cwd, shell: shellOverride || ""}};
    try {
        self._tab.init.call(inst);
    } catch (e) {
        console.warn("[siyuan-file-editor] 终端面板初始化失败:", e);
        paneEl.remove();
        if (prevActive) {
            prevActive.el.classList.add("syfe-terminal-dock__pane--active");
            self._activeId = prevActive.id;
        } else {
            self._activeId = -1;
        }
        showMessage("终端初始化失败", 3000, "error");
        return;
    }
    const pane: TerminalPane = {id, title, el: paneEl, inst};
    self._panes.push(pane);
    renderTabs(self);
    renderEmpty(self);
    // 布局稳定后再补 fit;窗口给足 6s(实测底部面板打开动画+布局稳定可能超过 2s),
    // 收敛后若提示符丢失则补一个回车
    fitWhenReady(inst, [60, 300, 800, 1500, 2500, 4000, 6000]);
}

export function createTerminalDockConfig(plugin: IPluginForTerminalTab) {
    const tab = createTerminalTabConfig(plugin) as any;
    return {
        type: TERMINAL_DOCK_TYPE,
        config: {
            // 底部面板(VSCode 式终端位);height 是面板初始高度
            position: "BottomLeft" as const,
            size: {width: 0, height: 300},
            icon: "iconTerminal",
            title: "终端",
            hotkey: "",
            // 显式 index:见 recent-dock.ts 同位置注释(避免多 dock 同 index 导致图标乱跳)
            index: 0,
        },
        data: {cwd: plugin.config?.fileTreeRoot || "/data"},
        init(this: TerminalDockInstance) {
            this._panes = [];
            this._activeId = -1;
            this._seq = 0;
            this._plugin = plugin;
            this._tab = tab;
            this.element.classList.add("syfe-terminal-dock");
            this.element.innerHTML = `
                <div class="syfe-terminal-dock__tabs">
                    <div class="syfe-terminal-dock__tablist-items"></div>
                    <span class="fn__flex-1"></span>
                    <span class="block__icon ariaLabel syfe-terminal-dock__new" data-action="new" aria-label="新建终端(选择 Shell)" data-position="north">
                        <svg><use xlink:href="#iconAdd"></use></svg>
                    </span>
                </div>
                <div class="syfe-terminal-dock__panes"></div>`;
            this._tablist = this.element.querySelector(".syfe-terminal-dock__tabs") as HTMLElement;
            this._panesEl = this.element.querySelector(".syfe-terminal-dock__panes") as HTMLElement;

            // 事件委托:切标签 / 关标签 / 新建,一个监听覆盖所有 pane
            this._clickHandler = (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                const newBtn = target.closest("[data-action='new']");
                if (newBtn) {
                    openNewShellMenu(this, e);
                    return;
                }
                const closeBtn = target.closest("[data-pane-close]");
                if (closeBtn) {
                    e.stopPropagation();
                    closePane(this, Number(closeBtn.getAttribute("data-pane-close")));
                    return;
                }
                const tabEl = target.closest("[data-pane-id]");
                if (tabEl) {
                    switchPane(this, Number(tabEl.getAttribute("data-pane-id")));
                }
            };
            this.element.addEventListener("click", this._clickHandler);

            // 首个终端
            createPane(this, this.data?.cwd || "/data");
        },
        resize(this: TerminalDockInstance) {
            const active = this._panes.find((p) => p.id === this._activeId);
            if (active) {
                try {
                    active.inst.resize.call(active.inst);
                } catch {
                    // ignore
                }
            }
        },
        destroy(this: TerminalDockInstance) {
            if (this._clickHandler) {
                this.element.removeEventListener("click", this._clickHandler);
                this._clickHandler = undefined;
            }
            for (const p of this._panes.slice()) {
                try {
                    p.inst.destroy.call(p.inst);
                } catch {
                    // 会话可能已经退出
                }
            }
            this._panes = [];
            // ⚠️ 关键:面板被 × 关闭后,思源重新打开时**不会重新 init**,而是按 dock 按钮
            // 上的 data-id 找已有 tab(见思源源码 layout/dock/index.ts toggleModel 的
            // 「tab 切换」分支:有 data-id 就只移除 fn__none,找不到匹配的 tab 就什么都不做)。
            // 本模型销毁时必须清掉这个标记,否则下次点图标 → 白屏。
            // 这正是思源自己在 layout/dock/index.ts 的 add() 里移除 tab 后
            // `sourceElement.removeAttribute("data-id")` 的原因。
            try {
                const type2 = (this._plugin?.name || "") + TERMINAL_DOCK_TYPE;
                document.querySelector(`.dock__item[data-type="${type2}"]`)?.removeAttribute("data-id");
            } catch {
                // ignore
            }
        },
    };
}
