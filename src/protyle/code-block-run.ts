// 文档内 Python 代码块的运行 UI
//
// 注入位置的选择很关键:
//   按钮   → 塞进 .protyle-action(代码块自带的那一行:语言 + 复制 + 更多)
//   输出面板 → 挂在代码块**外面紧跟其后**(nextElementSibling)
//
// 关于面板为什么必须在代码块外部(踩过的坑,别改回去):
//   一开始面板是挂在代码块内部末尾的,注释里写"lute 只认思源自己的块结构,
//   认不出的 DOM 一律丢弃"——**这是错的**,已实机验证会被写进 .sy:
//     在代码块里跑一次程序(面板有内容时),随便编辑文档触发一次 update,
//     导出的 markdown 里就出现了 <div class="syfe-cb-run">…</div>,
//     还被当成代码正文的一部分。
//   原因:代码块的正文提取是按「.hljs 之后的所有兄弟节点」取的,
//   .protyle-action / .protyle-attr 能活下来只是因为思源按 class 显式排除了它们,
//   自定义 class 不在白名单里就会被当成代码。
//   实测对照组:同样 position:absolute 的探针 div 挂在代码块**外面**时,
//   触发同样的 update,导出的 markdown 里干干净净(canary 搜不到)。
//
// 面板挂外部的副作用:思源重渲染代码块(update 事务会换掉块元素)后面板会掉,
// 这由 decorate() 在事件 + MutationObserver 里补回来;面板按 data-node-id
// 记住自己属于哪个块,所以「掉了补回」是对得上的。
import {showMessage} from "siyuan";
import type {Plugin} from "siyuan";
import {
    getCodeBlockOutput, setCodeBlockOutput, appendCodeBlockOutput,
    setCodeBlockCollapsed, clearCodeBlockOutput,
    CODE_BLOCK_RUN_LOADED_EVENT,
} from "./code-block-run-store";
import {runPythonCode, runKernelCode, resetDocKernel, extractCode, extractLang, type RunHandle} from "./code-block-run-exec";

const PANEL_CLASS = "syfe-cb-run";
const BTN_CLASS = "syfe-cb-run__btn";

// blockId → 正在跑的进程(用于「停止」)
const running = new Map<string, RunHandle>();

// ===== 内核模式(Task D / Phase 3b) =====
// 默认:代码块走注册表的持久内核(按文档绑定,变量跨块保留)。
// 不喜欢状态污染的场合:点面板上的「干净运行」切回独立的子进程(有真 stdin,
// 支持 input());切走后按钮变成「内核运行」可随时切回来。按文档记忆,仅内存。
const cleanModeDocs = new Set<string>();

function docKeyOf(block: HTMLElement): string {
    return "cb:" + docDirOf(block);
}

function isKernelMode(block: HTMLElement): boolean {
    return !cleanModeDocs.has(docKeyOf(block));
}

function toggleRunMode(block: HTMLElement): void {
    const key = docKeyOf(block);
    if (cleanModeDocs.has(key)) cleanModeDocs.delete(key);
    else cleanModeDocs.add(key);
}

/** 从 .protyle-wysiwyg 里找出所有 Python 代码块 */
function eachPythonBlock(root: ParentNode, fn: (block: HTMLElement) => void): void {
    const blocks = root.querySelectorAll<HTMLElement>('[data-type="NodeCodeBlock"]');
    blocks.forEach((b) => {
        const lang = extractLang(b);
        // 没写语言的不给按钮:八成是纯文本/输出片段,不是要跑的程序
        if (lang !== "python" && lang !== "py") return;
        fn(b);
    });
}

/** 代码块所在文档的目录(工作目录):.sy 文件同级 */
function docDirOf(block: HTMLElement): string {
    // 顺着 DOM 找已知的思源根容器上挂的 notebook 信息;
    // 拿不到就退回工作空间根 —— 至少相对路径的资源能找到
    const view = block.closest(".protyle") as HTMLElement | null;
    const dir = view?.dataset?.syfeDocDir;
    if (dir) return dir;
    return `${window.siyuan.config?.system?.workspaceDir || ""}/data`;
}

function blockIdOf(block: HTMLElement): string {
    return block.getAttribute("data-node-id") || "";
}

// ===== 运行按钮 =====

function ensureRunButton(block: HTMLElement): void {
    if (block.querySelector(`.${BTN_CLASS}`)) return;
    const action = block.querySelector(".protyle-action");
    if (!action) return;

    const btn = document.createElement("span");
    btn.className = `block__icon ariaLabel ${BTN_CLASS}`;
    btn.setAttribute("aria-label", "运行此 Python 代码块");
    btn.setAttribute("data-position", "4north");
    btn.innerHTML = `<svg><use xlink:href="#iconPlay"></use></svg>`;

    const id = blockIdOf(block);
    const syncLabel = () => {
        const isRunning = running.has(id);
        btn.setAttribute("aria-label", isRunning ? "停止运行" : "运行此 Python 代码块");
        btn.classList.toggle("syfe-cb-run__btn--stop", isRunning);
    };
    (btn as any)._syncLabel = syncLabel;
    syncLabel();

    btn.addEventListener("click", (e: MouseEvent) => {
        // 代码块区域里的点击可能会触发思源的光标定位,别让它抢
        e.preventDefault();
        e.stopPropagation();
        const handle = running.get(id);
        if (handle) {
            handle.interrupt();
            return;
        }
        void startRun(block, !isKernelMode(block));
    });

    // 放在「更多」按钮前面,和原生工具按钮排在一起
    const menu = action.querySelector(".protyle-action__menu");
    if (menu) action.insertBefore(btn, menu);
    else action.appendChild(btn);
}

// ===== 输出面板 =====

/**
 * 找某个代码块对应的输出面板,并保证它就贴在那个块后面。
 *
 * 查找按 data-block-id 而不是位置:思源的 update 事务会整块替换块元素,
 * 新块插到面板前面还是后面都不确定(实测遇到过面板被挤到块前面的情况),
 * 按位置找会漏掉面板,于是重复建一个。按 id 找则一定能认领回自己的面板,
 * 再用 after() 归位。
 */
function panelOf(block: HTMLElement, blockId: string): HTMLElement | null {
    // 限定在同一个文档容器里找,免得把别的文档的面板认过来
    const scope = block.closest(".protyle") || document;
    const panel = scope.querySelector<HTMLElement>(`.${PANEL_CLASS}[data-block-id="${blockId}"]`);
    if (!panel) return null;
    // 自愈:思源的 DOM 补丁偶尔会把面板弄进代码块内部(实测会把面板 HTML
    // 序列化进 .sy 正文,污染文档)。只要发现面板在块内,立刻挪回外面。
    if (block.contains(panel)) {
        block.after(panel);
        return panel;
    }
    if (block.nextElementSibling !== panel) block.after(panel);
    return panel;
}

/** 面板当前的状态是否还和存档一致 —— 不一致才需要重绘 */
function panelNeedsRebuild(
    block: HTMLElement,
    panel: HTMLElement,
    record: ReturnType<typeof getCodeBlockOutput>,
    isRunning: boolean,
): boolean {
    // 面板还没建过结构(首次创建、或被清空隐藏了)
    if (!record && !isRunning) {
        return panel.childElementCount > 0 || panel.style.display !== "none";
    }
    if (panel.style.display === "none") return true;         // 空壳 → 得显示出来
    if (panel.childElementCount === 0) return true;          // 结构没建
    if (panel.dataset.syfeRunning !== String(isRunning)) return true;
    const collapsed = record?.collapsed === true;
    // 折叠按钮的文案直接反映折叠态,变了就得重绘(折叠本身也要重绘 body 显示)
    const foldBtn = panel.querySelector('.syfe-cb-run__btn2[data-act="fold"]');
    const wantLabel = collapsed ? "▾ 展开" : "▴ 折叠";
    if ((foldBtn?.textContent || "").trim() !== wantLabel) return true;
    const runBtn = panel.querySelector('.syfe-cb-run__btn2[data-act="run"]');
    const wantRun = isRunning ? "■ 停止" : "▶ 运行";
    if ((runBtn?.textContent || "").trim() !== wantRun) return true;
    // stdin 输入框的有无跟着运行态走(内核模式没有 stdin)
    const hasStdin = !!panel.querySelector(".syfe-cb-run__stdin");
    if (hasStdin !== (isRunning && !collapsed && !isKernelMode(block))) return true;
    // 模式切换按钮的文案变了(模式翻转)也得重绘
    const modeBtn = (panel.querySelector('.syfe-cb-run__btn2[data-act="mode"]')?.textContent || "").trim();
    const wantMode = isKernelMode(block) ? "▸ 干净运行" : "▸ 内核运行";
    if (modeBtn !== wantMode) return true;
    // 重置内核按钮的有无跟着模式走
    if (!!panel.querySelector('.syfe-cb-run__btn2[data-act="reset-kernel"]') !== isKernelMode(block)) return true;
    return false;
}

function renderPanel(block: HTMLElement): HTMLElement | null {
    const id = blockIdOf(block);
    if (!id) return null;
    // 面板挂在代码块**外面**紧跟其后 —— 挂进代码块内部会被当成代码正文写进 .sy,
    // 详见文件头注释。
    let panel = panelOf(block, id);
    if (!panel) {
        panel = document.createElement("div");
        panel.className = PANEL_CLASS;
        block.after(panel);
    }
    // 归属标记:思源重渲染会换掉块元素,补面板时靠它确认没串到别的块上
    panel.dataset.blockId = id;

    const record = getCodeBlockOutput(id);
    const isRunning = running.has(id);

    // 已经有面板、状态没变、位置也对 → 什么都不用做。
    // decorate 会被 MutationObserver 频繁触发,每次都重绘的话
    // 正在折叠的面板/正在输入的 stdin 会不停地被重建。
    if (!panelNeedsRebuild(block, panel, record, isRunning)) return panel;

    // 任何一种重建都要同步这个标记:refreshPanel 靠它判断运行态有没有翻转
    panel.dataset.syfeRunning = String(isRunning);

    // 没有任何输出且没在跑 → 不显示面板(空壳留着省得下次重建)
    if (!record && !isRunning) {
        panel.innerHTML = "";
        panel.style.display = "none";
        return panel;
    }
    panel.style.display = "";

    const collapsed = record?.collapsed === true;
    const head = document.createElement("div");
    // 出错时给标题条加个 class,颜色由 CSS 的 __head--err 决定
    head.className = record && record.exitCode !== 0
        ? "syfe-cb-run__head syfe-cb-run__head--err" : "syfe-cb-run__head";
    // 有输出且在内核模式下,标题标注模式;按钮组里放模式切换 + 内核重置(仅内核模式)
    const kernelMode = isKernelMode(block);
    const title = isRunning
        ? `运行中…${kernelMode ? "(内核)" : "(独立进程)"}`
        : (record && record.exitCode !== 0 ? "已结束(出错)" : (kernelMode ? "输出(内核)" : "输出"));
    head.innerHTML = `<span class="syfe-cb-run__title">${title}</span>`
        + `<span class="fn__flex-1"></span>`
        + `<span class="syfe-cb-run__btn2" data-act="run">${isRunning ? "■ 停止" : "▶ 运行"}</span>`
        + `<span class="syfe-cb-run__btn2" data-act="mode" title="切换运行模式(内核模式变量跨块保留;干净模式有独立 stdin,支持 input())">${kernelMode ? "▸ 干净运行" : "▸ 内核运行"}</span>`
        + (kernelMode ? `<span class="syfe-cb-run__btn2" data-act="reset-kernel" title="销毁内核实例:变量与导入清空,下次执行自动重启">↺ 重置内核</span>` : "")
        + `<span class="syfe-cb-run__btn2" data-act="fold">${collapsed ? "▾ 展开" : "▴ 折叠"}</span>`
        + `<span class="syfe-cb-run__btn2" data-act="clear">✕ 清除</span>`;

    const body = document.createElement("div");
    body.className = "syfe-cb-run__body";
    if (!collapsed) {
        const text = record ? record.output : "";
        body.textContent = text;   // textContent:输出里有尖括号/HTML 片段也不会被解析
        body.scrollTop = body.scrollHeight;
    } else {
        body.style.display = "none";
    }

    panel.innerHTML = "";
    panel.appendChild(head);
    panel.appendChild(body);

    // 折叠状态下额外放一个输入框?不 —— 折叠就是收起,输入框跟着 body 一起藏
    if (!collapsed && isRunning && !isKernelMode(block)) {
        const input = document.createElement("div");
        input.className = "syfe-cb-run__stdin";
        input.innerHTML = `<input type="text" placeholder="程序在等输入,在这里输入后回车">`;
        panel.appendChild(input);
        const field = input.querySelector("input") as HTMLInputElement;
        field.addEventListener("keydown", (e: KeyboardEvent) => {
            // 所有按键都拦下来。面板虽然挂在代码块外面,但仍然在
            // .protyle-wysiwyg 这个 contenteditable 里,回车冒泡上去
            // 会被思源当成"在文档正文里换行",凭空插进一段内容。
            e.stopPropagation();
            if (e.key !== "Enter") return;
            e.preventDefault();
            const value = field.value;
            field.value = "";
            if (!value) return;
            running.get(id)?.sendInput(value);
            // 回显必须走 appendCodeBlockOutput 写进存档,不能只改 body.textContent:
            // 程序后续的输出会触发 refreshPanel,那里用 record.output 整体覆盖
            // body —— 只改 DOM 的话这行回显下一瞬间就被抹掉了(实测丢过)。
            appendCodeBlockOutput(id, `${value}\n`);
            refreshPanel(block);
        });
        // 程序一开跑就在等输入了,直接把焦点给它,省得用户再点一下
        setTimeout(() => {
            if (running.has(id)) field.focus();
        }, 0);
        // 失焦时自动收起输入框:程序已经不等输入了(跑完/卡在别处),
        // 一直杵着一个输入框会让人以为还能继续输
        field.addEventListener("blur", () => {
            setTimeout(() => {
                const h = running.get(id);
                if (!h) refreshPanel(block);
            }, 120);
        });
    }

    head.addEventListener("click", (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const act = target.closest(".syfe-cb-run__btn2")?.getAttribute("data-act");
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        if (act === "run") {
            const h = running.get(id);
            if (h) h.interrupt();
            else void startRun(block, !isKernelMode(block));
        } else if (act === "mode") {
            toggleRunMode(block);
            renderPanel(block);
        } else if (act === "reset-kernel") {
            void resetDocKernel(docKeyOf(block)).then(() => showMessage("内核已重置,变量已清空", 2500, "info"));
        } else if (act === "fold") {
            const cur = getCodeBlockOutput(id);
            setCodeBlockCollapsed(id, !(cur?.collapsed === true));
            renderPanel(block);
        } else if (act === "clear") {
            const h = running.get(id);
            if (h) h.interrupt();
            clearCodeBlockOutput(id);
            renderPanel(block);
        }
    });

    return panel;
}

// ===== 执行 =====

async function startRun(block: HTMLElement, clean = false): Promise<void> {
    const id = blockIdOf(block);
    if (!id) return;
    const code = extractCode(block);
    if (!code.trim()) {
        showMessage("代码块是空的", 2000, "info");
        return;
    }

    // 新的一次运行 = 覆盖旧输出。
    // 塞一条空记录占位:没有记录时 renderPanel 会认为"没运行过"而把面板藏起来。
    setCodeBlockOutput(id, {output: "", collapsed: false, finishedAt: 0, exitCode: 0});

    // 内核模式(默认):走文档绑定的持久内核,变量跨块保留;
    // 干净模式(逃生通道):独立子进程,有真 stdin,支持 input(),跑完即弃
    const useKernel = !clean;

    let handle: RunHandle;
    try {
        if (useKernel) {
            const khandle = runKernelCode({
                docId: docKeyOf(block),
                code,
                onOutput: (chunk) => {
                    appendCodeBlockOutput(id, chunk);
                    refreshPanel(block);
                },
                onExit: (exitCode) => {
                    running.delete(id);
                    const cur = getCodeBlockOutput(id);
                    if (cur && cur.output.length > 0) {
                        setCodeBlockOutput(id, {...cur, exitCode, finishedAt: Date.now()});
                    } else {
                        setCodeBlockOutput(id, {
                            output: `（无输出，退出码 ${exitCode}）\n`,
                            collapsed: false, finishedAt: Date.now(), exitCode,
                        });
                    }
                    refreshPanel(block);
                },
            });
            if (!khandle) throw new Error("内核不可用");
            handle = khandle;
        } else {
            handle = runPythonCode({
                code,
                cwd: docDirOf(block),
                onOutput: (chunk) => {
                    appendCodeBlockOutput(id, chunk);
                    refreshPanel(block);
                },
                onExit: (exitCode) => {
                    running.delete(id);
                    const cur = getCodeBlockOutput(id);
                    if (cur && cur.output.length > 0) {
                        setCodeBlockOutput(id, {...cur, exitCode, finishedAt: Date.now()});
                    } else {
                        // 空输出也留一条记录(而且必须有非空文本,见 store 的 sanitize):
                        // 否则面板会自己消失,用户以为没跑;重载后存档也会被丢掉。
                        setCodeBlockOutput(id, {
                            output: `（无输出，退出码 ${exitCode}）\n`,
                            collapsed: false, finishedAt: Date.now(), exitCode,
                        });
                    }
                    refreshPanel(block);
                },
            });
        }
    } catch (e: any) {
        setCodeBlockOutput(id, {
            output: String(e?.message || e) + "\n",
            collapsed: false, finishedAt: Date.now(), exitCode: -1,
        });
        refreshPanel(block);
        return;
    }

    // 顺序要紧:必须先登记 running 再渲染面板 —— renderPanel 靠 running.has(id)
    // 决定要不要挂 stdin 输入框。反过来(先渲染后登记)输入框就永远出不来。
    running.set(id, handle);
    // 按钮上的文字跟着切到「停止」
    const btn = block.querySelector<HTMLElement>(`.${BTN_CLASS}`) as any;
    btn?._syncLabel?.();
    // 整体重绘(不是 refreshPanel):要把 stdin 输入框建出来
    renderPanel(block);
}

// 输出是流式来的,每段都重建整个面板会打断用户选中文本/正在输入的 stdin,
// 所以这里只在「结构性的东西」变了时才重绘:运行态切换、折叠、清除。
// 纯文本追加则直接改 textContent,不动结构。
function refreshPanel(block: HTMLElement): void {
    const id = blockIdOf(block);
    const panel = panelOf(block, id);
    if (!panel) {
        renderPanel(block);
        return;
    }
    const record = getCodeBlockOutput(id);
    const isRunning = running.has(id);

    // 运行态翻转(刚开始 / 刚结束)必须整体重绘:
    // stdin 输入框的增删、头部「运行/停止」按钮的文案都在结构里,
    // 只改文本补不回来也删不掉。
    if (panel.dataset.syfeRunning !== String(isRunning)) {
        renderPanel(block);
        return;
    }
    if (record?.collapsed) {
        renderPanel(block);
        return;
    }
    const body = panel.querySelector<HTMLElement>(".syfe-cb-run__body");
    if (!body) {
        renderPanel(block);
        return;
    }
    // 没有记录且没在跑 → 清空并隐藏
    if (!record && !isRunning) {
        panel.innerHTML = "";
        panel.style.display = "none";
        return;
    }
    const title = panel.querySelector(".syfe-cb-run__title");
    if (title) title.textContent = isRunning ? "运行中…" : (record && record.exitCode !== 0 ? "已结束(出错)" : "输出");
    body.textContent = record ? record.output : "";
    body.scrollTop = body.scrollHeight;
}

/** 给一批代码块补齐按钮与面板 */
function decorate(root: ParentNode): void {
    eachPythonBlock(root, (block) => {
        ensureRunButton(block);
        renderPanel(block);
    });
    // 顺序要紧:先补面板再清孤儿。反过来的话,刚被 update 重建、
    // 还没走到 decorate 的块对应的面板会被误判成孤儿删掉。
    pruneOrphanPanels();
}

/**
 * 清掉「已经不对应任何代码块」的孤儿面板。
 *
 * 为什么需要:面板挂在代码块外面,而思源的 update 事务会整块替换块元素 ——
 * 旧块没了、挂在它后面的面板就成了孤儿,留在正文里当垃圾。
 * 认领规则:面板的下一个兄弟元素必须是它自己的代码块。
 */
function pruneOrphanPanels(): void {
    document.querySelectorAll<HTMLElement>(`.${PANEL_CLASS}`).forEach((panel) => {
        const id = panel.dataset.blockId;
        if (!id) {
            panel.remove();
            return;
        }
        // 自己的代码块还在吗?不在了就是 update 事务留下的孤儿
        const owner = document.querySelector(
            `[data-type="NodeCodeBlock"][data-node-id="${id}"]`,
        );
        if (!owner) {
            panel.remove();
            return;
        }
        // 自愈:面板被思源的 DOM 补丁弄进块内时会污染文档(序列化进 .sy),
        // 一旦发现立刻挪回块外
        if (owner.contains(panel)) {
            owner.after(panel);
        }
    });
}

let observer: MutationObserver | null = null;

/**
 * 注册到插件。需要在 onload 里调用。
 */
export function registerCodeBlockRun(plugin: Plugin): void {
    const onRendered = () => {
        // 事件带的是 protyle 元素;只处理已经挂上 DOM 的
        document.querySelectorAll<HTMLElement>(".protyle-wysiwyg").forEach((w) => decorate(w));
    };

    plugin.eventBus.on("loaded-protyle-static", onRendered);
    plugin.eventBus.on("loaded-protyle-dynamic", onRendered);

    // 存档是异步加载的,而注册发生在更早的 onload 里 —— 注册时 decorate 看到的
    // 是空存档,面板全成了隐藏的空壳。等存档到位后必须整体再decorate 一次,
    // 否则重载窗口后已保存的输出不会显示(实测踩过)。
    window.addEventListener(CODE_BLOCK_RUN_LOADED_EVENT, onRendered);

    // 兜底:update 事务替换块 DOM 时不会触发上面两个事件(那是"局部更新"),
    // 只靠事件会漏。用 MutationObserver 盯着 protyle 容器,发现新的代码块再补。
    observer = new MutationObserver((records) => {
        let need = false;
        for (const r of records) {
            for (const n of Array.from(r.addedNodes)) {
                if (n.nodeType !== 1) continue;
                const el = n as HTMLElement;
                // 自己挂的面板也会进 addedNodes,不排除的话
                // decorate → 挂面板 → 触发 observer → decorate … 死循环
                if (el.classList.contains(PANEL_CLASS)) continue;
                if (el.matches?.('[data-type="NodeCodeBlock"]') || el.querySelector?.('[data-type="NodeCodeBlock"]')) {
                    need = true;
                    break;
                }
            }
            if (need) break;
        }
        if (!need) return;
        document.querySelectorAll<HTMLElement>(".protyle-wysiwyg").forEach((w) => decorate(w));
    });
    observer.observe(document.body, {childList: true, subtree: true});

    // 启动时把已经打开的文档补一遍
    onRendered();
    (onRendered as any)._detach = () => {
        window.removeEventListener(CODE_BLOCK_RUN_LOADED_EVENT, onRendered);
    };
    detachLoadedListener = (onRendered as any)._detach;
}

// dispose 时要解绑的存档加载监听(见 registerCodeBlockRun)
let detachLoadedListener: null | (() => void) = null;

/** 插件卸载时清理 */
export function disposeCodeBlockRun(): void {
    observer?.disconnect();
    observer = null;
    detachLoadedListener?.();
    detachLoadedListener = null;
    running.forEach((h) => h.interrupt());
    running.clear();
    document.querySelectorAll(`.${PANEL_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((el) => el.remove());
}