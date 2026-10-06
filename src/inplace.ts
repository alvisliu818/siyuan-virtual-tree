/**
 * 就地渲染：在「非编辑态」接管思源代码块自身的高亮（更细的着色覆盖原生）。
 *
 * ## 编辑态（光标在块内）绝不改写 DOM
 * 思源对支持的语言是边输入边高亮的：input.ts 每次 input 都
 *   `removeAttribute("data-render")` + `highlightRender`，用 <wbr> 标记光标、
 *   重写 innerHTML、再 focusByOffset 复位光标（见 highlightRender.ts 46-58、112-113）。
 * mysql 已注册为 hljs 的 sql 别名（见 native-highlight.ts），所以输入时由内核原生着色，
 * 光标由内核 focusByOffset 处理。插件若在此刻改写 innerHTML，会与内核的光标恢复打架
 * → 光标乱跳（曾经踩过的坑：末尾输入一字直接跳到开头）。故编辑态一律返回 false。
 * 失焦 / 打开文档时（非编辑态）再接管，用我们的着色覆盖原生。
 *
 * ## 之前把思源卡死的真正原因
 * 不是「写了内容」，而是「监听了自己写的节点」：
 * 给每个 .hljs 挂 MutationObserver → 我们写入 → observer 触发 → 又写入 → 闭环。
 * → 改为唯一容器级 observer + 内容指纹幂等，自己写入引发的那次回调命中指纹闸直接终止。
 *
 * ## 防回环设计
 * 1. 唯一一个容器级 observer，脏块入集合 + 60ms 去抖统一处理
 * 2. 内容指纹幂等：指纹未变且包裹节点还在 → 直接返回，不写 DOM
 * 3. 编辑中（光标在块内）一律不写 DOM（交给内核原生高亮 + focusByOffset 保光标）
 * 4. 熔断：单块 2 秒内超过 12 次实际写入就停掉它的就地渲染并还原
 *
 * ## 数据安全闸
 * 每次写入后立刻比对 textContent，一旦与预期不符就把纯文本写回并放弃该块，
 * 宁可不上色也绝不污染用户笔记。
 */
import { CODE_BLOCK_SELECTOR, getBlockLang, getCodeEditable, getCodeText, getHljsHost } from "./dom";
import { resolveRule } from "./registry";
import { getSettings } from "./settings";

/** 我们插入的包裹节点标识：既是「是否已接管」的探针，也是清理入口 */
const WRAP_CLASS = "cr-hl";

interface Applied {
    sig: string;
    /** 实际写入次数时间戳，用于熔断 */
    writes: number[];
    /** 熔断后不再尝试 */
    disabled: boolean;
}

const applied = new WeakMap<HTMLElement, Applied>();

function stateOf(codeEl: HTMLElement): Applied {
    let st = applied.get(codeEl);
    if (!st) {
        st = { sig: "", writes: [], disabled: false };
        applied.set(codeEl, st);
    }
    return st;
}

function signature(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ":" + h;
}

/** 是否已由我们接管（思源重高亮会抹掉包裹节点，据此感知被覆盖） */
function isTakenOver(codeEl: HTMLElement): boolean {
    const first = codeEl.firstElementChild;
    return !!first && first.classList.contains(WRAP_CLASS);
}

/** 光标/选区是否在代码块内——编辑期间绝不改 DOM */
function isEditing(codeEl: HTMLElement): boolean {
    const active = document.activeElement;
    if (active === codeEl || (active && codeEl.contains(active))) return true;
    try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const node = sel.anchorNode;
            if (node && (node === codeEl || codeEl.contains(node))) return true;
        }
    } catch {
        /* 取不到选区就当作未编辑 */
    }
    return false;
}

/** 熔断窗口 */
const WRITE_WINDOW_MS = 2000;
const WRITE_MAX = 12;

function tripped(st: Applied): boolean {
    const now = Date.now();
    st.writes = st.writes.filter((t) => now - t < WRITE_WINDOW_MS);
    st.writes.push(now);
    return st.writes.length > WRITE_MAX;
}

/**
 * 应用就地渲染（仅在非编辑态）。返回 true 表示「当前已处于接管状态」。
 * 编辑态（光标在块内）直接返回 false，把着色交给内核原生高亮。
 */
export function applyInplace(block: HTMLElement): boolean {
    if (getSettings().renderTarget === "panel") return false;

    const codeEl = getCodeEditable(block);
    if (!codeEl) return false;

    const st = stateOf(codeEl);
    if (st.disabled) return false;

    // 闸 3：编辑中一律不写 DOM（光标交给内核 focusByOffset）
    if (isEditing(codeEl)) return false;

    const lang = getBlockLang(block);
    const resolved = resolveRule(lang);
    if (!resolved) {
        restoreInplace(block);
        return false;
    }

    const mode =
        resolved.renderer.modes.find((m) => m.id === (resolved.rule.modeId || resolved.mode.id)) ||
        resolved.mode;
    if (!mode.inplace) {
        restoreInplace(block);
        return false;
    }

    const raw = getCodeText(block);
    if (!raw.trim()) return false;

    // 与思源保持一致：末尾补换行，否则最后一行光标定位异常
    // （见内核 highlightRender.ts 对 issues/4609 的处理）
    const code = raw.endsWith("\n") ? raw : raw + "\n";

    const sig = signature(lang + "\u0000" + code);
    // 闸 2：指纹未变且包裹节点仍在 → 无需写 DOM。我们自己写入触发的回调在此终止。
    if (st.sig === sig && isTakenOver(codeEl)) return true;

    let inner: string | null | undefined;
    try {
        inner = mode.inplace(code, { lang });
    } catch {
        inner = null;
    }
    if (!inner) return false;

    // 闸 4：熔断
    if (tripped(st)) {
        st.disabled = true;
        restoreInplace(block);
        return false;
    }

    codeEl.innerHTML = `<span class="${WRAP_CLASS}">${inner}</span>`;

    // 数据安全闸：textContent 必须逐字等于预期，否则立刻回退为纯文本
    if (codeEl.textContent !== code) {
        codeEl.textContent = code;
        st.disabled = true;
        st.sig = "";
        return false;
    }

    st.sig = sig;
    return true;
}

/** 还原成思源原生高亮 */
export function restoreInplace(block: HTMLElement): void {
    const codeEl = getCodeEditable(block);
    if (!codeEl) return;
    const st = applied.get(codeEl);
    if (st) {
        st.sig = "";
        st.writes = [];
    }
    if (!isTakenOver(codeEl)) return;
    if (isEditing(codeEl)) return;

    // 先降级为纯文本（保证内容不丢），再请思源重新高亮
    codeEl.textContent = codeEl.textContent || "";
    const host = getHljsHost(block);
    host?.removeAttribute("data-render");
    try {
        (window as unknown as { Protyle?: { highlightRender?: (el: Element) => void } }).Protyle?.highlightRender?.(
            block,
        );
    } catch {
        /* 拿不到内核渲染函数就保持纯文本，下次文档重载时思源会自行恢复 */
    }
}

/* --------------------------- 容器级监听（闸 1） --------------------------- */

const dirty = new Set<HTMLElement>();
let observer: MutationObserver | null = null;
let flushTimer = 0;
const watched = new WeakSet<HTMLElement>();
let globalBound = false;
/** IME 组词中（中文输入必须不改写 DOM，否则打断组词） */
let composing = false;

function markDirty(el: Element | null): void {
    if (!el) return;
    const block = el.closest?.(CODE_BLOCK_SELECTOR) as HTMLElement | null;
    if (block) dirty.add(block);
}

function collectFrom(node: Node): void {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.matches?.(CODE_BLOCK_SELECTOR)) dirty.add(el as HTMLElement);
    el.querySelectorAll?.(CODE_BLOCK_SELECTOR).forEach((b) => dirty.add(b as HTMLElement));
}

function schedule(): void {
    if (flushTimer) return;
    flushTimer = window.setTimeout(() => {
        flushTimer = 0;
        const blocks = Array.from(dirty);
        dirty.clear();
        for (const block of blocks) {
            if (!block.isConnected) continue;
            applyInplace(block);
        }
    }, 60);
}

function ensureObserver(): MutationObserver {
    if (observer) return observer;
    observer = new MutationObserver((records) => {
        if (composing) return; // 组词中不处理，等 compositionend 再 markDirty
        for (const r of records) {
            if (r.type === "childList") {
                r.addedNodes.forEach(collectFrom);
                markDirty(r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement);
            } else {
                markDirty(r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement);
            }
        }
        if (dirty.size) schedule();
    });
    return observer;
}

/** 监听一个编辑器容器（protyle.wysiwyg.element），重复调用安全 */
export function watchContainer(root: HTMLElement | null | undefined): void {
    if (!root || watched.has(root)) return;
    watched.add(root);
    ensureObserver().observe(root, { childList: true, subtree: true, characterData: true });
    bindGlobal();
}

/** 失焦后补一次接管 + IME 组词状态跟踪 */
function bindGlobal(): void {
    if (globalBound) return;
    globalBound = true;
    document.addEventListener(
        "focusout",
        (ev) => {
            // 失焦后光标离开代码块，此时可安全接管（之前编辑态被跳过的块）
            const el = ev.target as Element | null;
            const block = el?.closest?.(CODE_BLOCK_SELECTOR) as HTMLElement | null;
            if (block) {
                dirty.add(block);
                schedule();
            }
        },
        true,
    );
    document.addEventListener("compositionstart", () => { composing = true; }, true);
    document.addEventListener(
        "compositionend",
        (ev) => {
            composing = false;
            // 组词结束后补一次接管（组词期间的变更都被跳过了）
            markDirty(ev.target as Element | null);
            if (dirty.size) schedule();
        },
        true,
    );
}

/** 主动扫一遍容器内的代码块（loaded-protyle-* 时调用） */
export function sweepInplace(root: ParentNode | null | undefined): void {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll(CODE_BLOCK_SELECTOR).forEach((b) => dirty.add(b as HTMLElement));
    if (dirty.size) schedule();
}

/** 关掉就地渲染 / 卸载插件：还原所有被接管的代码块 */
export function restoreAll(): void {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((wrap) => {
        const block = wrap.closest(CODE_BLOCK_SELECTOR) as HTMLElement | null;
        if (block) restoreInplace(block);
    });
}

export function stopWatching(): void {
    observer?.disconnect();
    observer = null;
    if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = 0;
    }
    dirty.clear();
}
