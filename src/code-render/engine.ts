/**
 * 引擎：扫描文档里的代码块，注入渲染按钮，并把渲染面板作为「代码块的兄弟节点」挂载。
 *
 * 关键约束：面板绝不能插进代码块内部。思源用 Lute 把块 DOM 转成 Markdown 保存，
 * 块内多出来的节点会被写进文档正文，污染用户的笔记。作为兄弟节点插入则不会被保存，
 * 且文档重渲染时自然消失，再由 loaded-protyle-* 事件重新挂载。
 */
import { ensureRenderButton, findCodeBlocks, getBlockLang, getCodeText, PANEL_FLAG, removeRenderButton } from "./dom";
import { applyInplace, restoreInplace, stopWatching, watchContainer } from "./inplace";
import { ensureMysqlAlias, refreshMysqlNative } from "./native-highlight";
import { t } from "./i18n";
import { resolveRule } from "./registry";
import { getSettings, isDarkTheme } from "./settings";
import type { RenderContext } from "./types";
import { txt } from "./types";
import { h } from "./ui";

interface BlockState {
    lang: string;
    modeId: string;
    rendererId: string;
    open: boolean;
    panel: HTMLElement | null;
    controller: AbortController | null;
    refreshTimer: number | null;
}

const states = new WeakMap<HTMLElement, BlockState>();

function getState(block: HTMLElement): BlockState {
    let st = states.get(block);
    if (!st) {
        st = { lang: "", modeId: "", rendererId: "", open: false, panel: null, controller: null, refreshTimer: null };
        states.set(block, st);
    }
    return st;
}

function abortPending(st: BlockState): void {
    st.controller?.abort();
    st.controller = null;
}

/* ------------------------------- 面板构建 ------------------------------- */

function buildPanel(block: HTMLElement, st: BlockState): HTMLElement {
    const resolved = resolveRule(st.lang);
    const panel = h("div", "cr-panel");
    panel.setAttribute(PANEL_FLAG, "1");
    panel.contentEditable = "false";
    panel.dataset.crLang = st.lang;

    const head = h("div", "cr-panel-head");

    const title = h("span", "cr-title");
    title.textContent = resolved ? txt(resolved.renderer.name) : st.lang;
    head.appendChild(title);

    if (resolved) {
        const tabs = h("div", "cr-tabs");
        for (const mode of resolved.renderer.modes) {
            const tab = h("button", "cr-tab" + (mode.id === st.modeId ? " cr-tab--active" : ""), txt(mode.name));
            tab.type = "button";
            tab.onclick = () => {
                st.modeId = mode.id;
                renderPanel(block);
            };
            tabs.appendChild(tab);
        }
        head.appendChild(tabs);
    }

    const actions = h("div", "cr-actions");
    const refreshBtn = h("button", "cr-icon-btn", "⟳");
    refreshBtn.type = "button";
    refreshBtn.title = t("refresh");
    refreshBtn.onclick = () => renderPanel(block);
    actions.appendChild(refreshBtn);

    const closeBtn = h("button", "cr-icon-btn", "✕");
    closeBtn.type = "button";
    closeBtn.title = t("close");
    closeBtn.onclick = () => closePanel(block);
    actions.appendChild(closeBtn);
    head.appendChild(actions);

    panel.appendChild(head);
    const body = h("div", "cr-panel-body");
    panel.appendChild(body);
    return panel;
}

async function renderPanel(block: HTMLElement): Promise<void> {
    const st = getState(block);
    if (!st.open || !st.panel) return;
    const body = st.panel.querySelector(":scope > .cr-panel-body") as HTMLElement | null;
    if (!body) return;

    // 切换模式前中止上一次未完成的异步渲染（如正在跑的查询）
    abortPending(st);
    const controller = new AbortController();
    st.controller = controller;

    const resolved = resolveRule(st.lang);
    if (!resolved) {
        body.replaceChildren(h("div", "cr-empty", t("noRenderer", { lang: st.lang })));
        return;
    }

    const mode = resolved.renderer.modes.find((m) => m.id === st.modeId) || resolved.mode;
    st.modeId = mode.id;

    // 同步高亮当前 tab
    st.panel.querySelectorAll(".cr-tab").forEach((el) => {
        const btn = el as HTMLElement;
        btn.classList.toggle("cr-tab--active", btn.textContent === txt(mode.name));
    });

    const ctx: RenderContext = {
        lang: st.lang,
        code: getCodeText(block),
        blockId: block.getAttribute("data-node-id") || "",
        blockElement: block,
        panel: st.panel,
        settings: getSettings(),
        setMode: (modeId: string) => {
            st.modeId = modeId;
            void renderPanel(block);
        },
        refresh: () => void renderPanel(block),
        signal: controller.signal,
    };

    try {
        const output = await mode.render(ctx);
        if (controller.signal.aborted) return;
        body.replaceChildren();
        if (typeof output === "string") {
            const div = h("div", "cr-html");
            div.innerHTML = output;
            body.appendChild(div);
        } else if (output instanceof Node) {
            body.appendChild(output);
        } else if (output && typeof output === "object") {
            const rec = output as { html?: string; node?: Node; onMount?: (root: HTMLElement) => void };
            if (rec.html) {
                const div = h("div", "cr-html");
                div.innerHTML = rec.html;
                body.appendChild(div);
            }
            if (rec.node) body.appendChild(rec.node);
            rec.onMount?.(body);
        }
    } catch (err) {
        if (controller.signal.aborted) return;
        body.replaceChildren(h("div", "cr-msg cr-msg--error", `${t("errTitle")}: ${(err as Error)?.message || err}`));
    }
}

function openPanel(block: HTMLElement): void {
    const st = getState(block);
    if (st.panel?.isConnected) st.panel.remove();
    st.open = true;
    const panel = buildPanel(block, st);
    st.panel = panel;
    block.insertAdjacentElement("afterend", panel);
    void renderPanel(block);
}

function closePanel(block: HTMLElement): void {
    const st = getState(block);
    abortPending(st);
    st.open = false;
    st.panel?.remove();
    st.panel = null;
}

export function togglePanel(block: HTMLElement): void {
    if (!getSettings().enabled) return;
    const st = getState(block);
    if (st.open) closePanel(block);
    else openPanel(block);
}

/* -------------------------------- 扫描 -------------------------------- */

function bindInputRefresh(block: HTMLElement): void {
    if (block.dataset.crInputBound === "1") return;
    block.dataset.crInputBound = "1";
    let timer = 0;
    block.addEventListener("input", () => {
        const st = states.get(block);
        if (!st?.open) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void renderPanel(block), 700);
    });
}

export function scan(root: ParentNode): void {
    if (!getSettings().enabled) return;
    if (!root) return;
    const settings = getSettings();

    // 注册 mysql→sql 别名：让思源在「输入时」用原生 sql 着色（内核 focusByOffset 保光标），
    // 插件无需在输入时改写 DOM。hljs 未就绪时返回 false，下次 scan 再试。
    ensureMysqlAlias();

    // 就地渲染靠「容器级 observer」跟踪思源的重建，这里只需登记一次容器
    if (settings.renderTarget !== "panel") {
        watchContainer(root as HTMLElement);
    }

    for (const block of findCodeBlocks(root)) {
        const lang = getBlockLang(block);
        const st = getState(block);

        // 语言变了（用户切换了代码语言）→ 关掉旧面板
        if (st.lang && st.lang !== lang) {
            closePanel(block);
        }
        st.lang = lang;

        const resolved = resolveRule(lang);
        if (!resolved) {
            removeRenderButton(block);
            if (st.open) closePanel(block);
            if (settings.renderTarget !== "panel") restoreInplace(block);
            continue;
        }

        // 就地渲染：接管代码块自身的高亮
        if (settings.renderTarget !== "panel") {
            applyInplace(block);
        }

        // 只要就地渲染时，不挂按钮也不挂面板
        if (settings.renderTarget === "inplace") {
            removeRenderButton(block);
            if (st.open) closePanel(block);
            continue;
        }

        st.rendererId = resolved.renderer.id;
        if (!st.modeId) st.modeId = resolved.rule.modeId || resolved.mode.id;

        if (settings.showToolbarButton) {
            const btn = ensureRenderButton(block, t("render"));
            if (btn.dataset.crBound !== "1") {
                btn.dataset.crBound = "1";
                btn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    togglePanel(block);
                });
                // 避免拖拽/选中代码块时误触
                btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
            }
        } else {
            removeRenderButton(block);
        }

        bindInputRefresh(block);

        if (settings.autoRender && resolved.rule.autoOpen) {
            if (!st.open || !st.panel?.isConnected) openPanel(block);
        }
    }

    // 注册别名前被渲染成 plaintext 的 mysql 块，刷一次拿原生 sql 着色（每个容器只刷一次）
    refreshMysqlNative(root);

    // 清掉文档重渲染后残留的孤儿面板
    const host = root as HTMLElement;
    if (host.querySelectorAll) {
        host.querySelectorAll(`[${PANEL_FLAG}]`).forEach((el) => {
            const prev = el.previousElementSibling;
            if (!prev || prev.getAttribute("data-type") !== "NodeCodeBlock") el.remove();
        });
    }
}

/** 设置变更后重扫所有已打开面板 */
export function rerenderAll(): void {
    const panels = document.querySelectorAll(`[${PANEL_FLAG}]`);
    panels.forEach((p) => {
        const block = p.previousElementSibling as HTMLElement | null;
        if (!block) return;
        const st = states.get(block);
        if (!st) return;
        if (st.open) void renderPanel(block);
        else p.remove();
    });
}

export function closeAll(): void {
    stopWatching();
    document.querySelectorAll(`[${PANEL_FLAG}]`).forEach((p) => p.remove());
    document.querySelectorAll("[data-code-render-btn]").forEach((b) => b.remove());
    document.querySelectorAll("[data-cr-input-bound]").forEach((b) => {
        delete (b as HTMLElement).dataset.crInputBound;
    });
}
