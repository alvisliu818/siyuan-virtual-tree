// 思源原生文档里的「[[: 双链补全」:
//   [[          → 完全留给思源原生文档/块引用 hint(不干预、不拦键、不抑制)
//   [[: + 筛选词 → 弹出本插件的补全浮层(全部挂载根、任意文件类型),选中后在正文
//                  落地 [名称](file:///绝对路径) 的 markdown 链接。
//   浮层上按 Esc → 让行给思源原生 [[(撤抑制、不拦键,本次 [[: 不再弹我们的浮层)。
//
// 为什么不占用思源自带的 [[ hint:思源把 [[/(("/【【 等列为 BLOCK_HINT_KEYS,
// 选中候选时 app/src/protyle/hint/index.ts 的 select() 会把 value **无条件转成
// block-ref**(取 data-id 走 setInlineMark),任何普通链接 HTML 都会被改造成无效
// 块引用。所以用独立触发符 [[: + 自建轻量浮层 + 自己走 protyle.insert,
// 与 slash-commands.ts 的「插入文件链接」同一条落地路径。
//
// 落地格式(与项目既有 file 链接体系完全一致,反链扫描 MD_LINK_RE 可直接识别):
//   [[:readme        → [readme.md](file:///E:/notes/readme.md)
//   [[:readme:42     → [readme.md:42](file:///E:/notes/readme.md?line=42)
//   [[:readme#标题   → [readme.md#标题](file:///E:/notes/readme.md#标题slug)
//   [[:块内容        → [块标题](siyuan://blocks/<块ID>)(思源块候选)
// 注意:思源 v3.1.21 起 file:// 链接不能 percent-编码,所以 url 全部由
// toMarkdownFileLink / buildFileRefUrl 生成(原始路径,只转正斜杠)。
import {showMessage} from "siyuan";
import {getLinkIndex} from "../utils/wikilink";
import {searchBlocksForRef} from "../utils/backlink";
import {toMarkdownFileLink} from "../utils/system-path";
import {buildFileRefUrl, slugifyHeading} from "../utils/file-ref";
import {basename} from "../utils/path";
import {emitBacklinkRefresh} from "./slash-commands";
import {onDispose} from "../utils/disposal";

const POPUP_CLASS = "syfe-wikihint";
// 加在思源原生 .protyle-hint 上:仅「[[: 浮层活动期间」隐藏原生 [[ 菜单,
// 避免两个浮层叠在一起;纯 [[ 时从不加这个 class。用 class 而非 fn__none ——
// 思源每次 input 都会移除 fn__none,但不会动自定义 class。
const SUPPRESS_CLASS = "syfe-wikihint-suppressed";
const MAX_FILES = 64;
const MAX_BLOCKS = 8;

interface HintItem {
    kind: "file" | "block";
    label: string;   // 列表显示名
    detail: string;  // 所在目录 / 思源文档路径
    url: string;     // 链接节点的 data-href
    text: string;    // 链接显示文字
    path?: string;   // 文件绝对路径(插入后刷新反链用)
}

interface Trigger {
    range: Range;    // 覆盖 [[:query,选中时整段删除
    query: string;
    editor: any;     // Protyle 实例(有 insert())
    inner: any;      // IProtyle(toolbar.range / hint.element / wysiwyg.element)
    rect: DOMRect;   // 光标位置(浮层定位)
}

let popup: HTMLElement | null = null;
let items: HintItem[] = [];
let active = 0;
let trigger: Trigger | null = null;
let seq = 0;
let suppressed: HTMLElement[] = [];
let enabledFn: () => boolean = () => true;
let registered = false;
let selTimer = 0;
// 本次 [[: 让给思源原生块/文档引用 hint:浮层上按 Esc 置位,期间既不弹我们的
// 浮层也不抑制原生菜单;删掉触发符的 : / 输入 ] / 换行 / 光标离开后自动复位。
let yielded = false;

function escapeHTML(s: string): string {
    return String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ===== 找到光标所在的 Protyle 实例 =====
// 复刻 app/src/layout/getAll.ts 的遍历,但不依赖思源内部模块(插件包里没有)。
// window.siyuan.layout.layout 是布局根,children 里 Tab 挂 model.editor
// (Protyle 实例,含 .protyle 内部对象与 insert());Layout 继续递归。
function collectEditors(): any[] {
    const out: any[] = [];
    const w = window as any;
    const walk = (node: any): void => {
        if (!node) return;
        const editor = node.model?.editor;
        if (editor?.protyle?.wysiwyg?.element && editor.insert) out.push(editor);
        const children = node.children;
        if (Array.isArray(children)) {
            for (const c of children) walk(c);
        }
    };
    walk(w?.siyuan?.layout?.layout);
    // 弹窗/块面板里也有编辑器(搜索结果、浮窗文档),一并纳入
    for (const dlg of w?.siyuan?.dialogs || []) {
        const editors = dlg?.editors;
        if (!editors) continue;
        for (const key of Object.keys(editors)) {
            const ed = editors[key];
            if (ed?.protyle?.wysiwyg?.element && ed.insert) out.push(ed);
        }
    }
    for (const panel of w?.siyuan?.blockPanels || []) {
        for (const ed of panel?.editors || []) {
            if (ed?.protyle?.wysiwyg?.element && ed.insert) out.push(ed);
        }
    }
    return out;
}

function findEditor(node: Node): any | null {
    for (const editor of collectEditors()) {
        const el = editor?.protyle?.wysiwyg?.element as HTMLElement | undefined;
        if (el && el.contains(node)) return editor;
    }
    return null;
}

// ===== 读取触发状态 =====
function caretRect(range: Range): DOMRect {
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[0];
    const r = range.getBoundingClientRect();
    if (r.width || r.height) return r;
    const parent = (range.startContainer.nodeType === 3
        ? range.startContainer.parentElement : range.startContainer as Element) as HTMLElement | null;
    return parent?.getBoundingClientRect() || new DOMRect(0, 0, 0, 0);
}

function readTrigger(): Trigger | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== 3) return null;
    const parent = node.parentElement;
    const wysiwyg = parent?.closest(".protyle-wysiwyg") as HTMLElement | null;
    // 只读、代码块、行内码里不弹(避免把代码文本当查询)
    if (!wysiwyg || wysiwyg.getAttribute("contenteditable") !== "true") return null;
    if (parent?.closest('[data-type="NodeCodeBlock"], pre, code, [data-type="code"]')) return null;
    const before = (node.textContent || "").slice(0, range.startOffset);
    // 触发符必须是 [[: —— 纯 [[ 完全留给思源原生文档/块引用 hint
    const m = /\[\[:([^\[\]\n]{0,80})$/.exec(before);
    if (!m) return null;
    const editor = findEditor(node);
    if (!editor?.protyle) return null;
    const triggerRange = document.createRange();
    triggerRange.setStart(node, m.index);
    triggerRange.setEnd(node, range.startOffset);
    return {
        range: triggerRange,
        query: m[1],
        editor,
        inner: editor.protyle,
        rect: caretRect(range),
    };
}

// ===== 候选生成 =====
// 查询支持三种形态:
//   文件名            → 普通 file 链接
//   文件名:42         → 带 ?line=42 的 file 链接(链接到行)
//   文件名#标题       → 带 #slug 的 file 链接(链接到标题/块首)
// 另外把思源块搜索结果混入候选(链接到块,siyuan://blocks/<id>)。
async function buildItems(query: string): Promise<HintItem[]> {
    let base = query.trim();
    let line: number | undefined;
    let anchorRaw = "";
    let anchor: string | undefined;
    const lineMatch = /^(.*?):(\d{1,6})$/.exec(base);
    if (lineMatch) {
        base = lineMatch[1];
        const n = Number(lineMatch[2]);
        line = n > 0 ? Math.floor(n) : undefined;
    } else {
        const anchorMatch = /^(.*?)#([^#]{1,60})$/.exec(base);
        if (anchorMatch) {
            base = anchorMatch[1];
            anchorRaw = anchorMatch[2];
            anchor = slugifyHeading(anchorRaw) || undefined;
        }
    }
    const q = base.toLowerCase();
    const out: HintItem[] = [];
    const seen = new Set<string>();
    let fileCount = 0;
    const index = await getLinkIndex();
    const collect = (map: Map<string, string[]>) => {
        for (const [key, paths] of map) {
            if (q && !key.includes(q)) continue;
            for (const p of paths) {
                if (fileCount >= MAX_FILES) return;
                if (seen.has(p)) continue;
                seen.add(p);
                const link = toMarkdownFileLink(p);
                if (!link?.url) continue;
                const name = basename(p);
                // 带位置时改走 buildFileRefUrl(同一套 ?line= / #slug 规则)
                const url = (line || anchor)
                    ? buildFileRefUrl({path: p, line, anchor})
                    : link.url;
                if (!url) continue;
                const text = line ? `${name}:${line}` : anchorRaw ? `${name}#${anchorRaw}` : name;
                out.push({
                    kind: "file",
                    label: name,
                    detail: p.slice(0, p.lastIndexOf("/")) || p,
                    url,
                    text,
                    path: p,
                });
                fileCount++;
            }
            if (fileCount >= MAX_FILES) return;
        }
    };
    collect(index.byName);
    if (fileCount < MAX_FILES) collect(index.byStem);

    // 思源块候选:与插件 md 页签的 (( 补全同数据源(空查询不搜,同思源行为)
    if (base) {
        const briefs = await searchBlocksForRef(base, MAX_BLOCKS);
        for (const b of briefs) {
            const clean = String(b.title || b.id)
                .replace(/[\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || b.id;
            out.push({
                kind: "block",
                label: clean,
                detail: b.hpath || "思源块",
                url: `siyuan://blocks/${b.id}`,
                text: clean,
            });
        }
    }
    return out;
}

// ===== 浮层 =====
function positionPopup(rect: DOMRect): void {
    if (!popup) return;
    const width = 420;
    const maxHeight = 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (window.innerHeight - top < Math.min(maxHeight, 160) && rect.top > maxHeight) {
        top = Math.max(8, rect.top - maxHeight - 6);
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
}

function updateActive(): void {
    if (!popup) return;
    const nodes = popup.querySelectorAll<HTMLElement>("[data-index]");
    nodes.forEach((el, i) => el.classList.toggle("syfe-wikihint__item--focus", i === active));
    nodes[active]?.scrollIntoView({block: "nearest"});
}

function renderPopup(rect: DOMRect): void {
    if (!popup) {
        popup = document.createElement("div");
        popup.className = `${POPUP_CLASS} b3-list b3-list--background`;
        popup.addEventListener("mousedown", (e) => {
            const el = (e.target as HTMLElement | null)?.closest("[data-index]") as HTMLElement | null;
            if (!el) return;
            e.preventDefault(); // 别让编辑器丢光标
            e.stopPropagation();
            choose(Number(el.dataset.index));
        });
        document.body.appendChild(popup);
    }
    const body = items.map((it, i) => {
        const icon = it.kind === "block" ? "iconRef" : "iconFile";
        const tag = it.kind === "block" ? "思源块" : "文件";
        // data-href 便于调试/检查最终会落地的 url(不改变交互)
        return `<div class="b3-list-item syfe-wikihint__item" data-index="${i}" data-href="${escapeHTML(it.url)}">
            <svg class="b3-list-item__graphic"><use xlink:href="#${icon}"></use></svg>
            <span class="b3-list-item__text">${escapeHTML(it.label)}</span>
            <span class="b3-list-item__meta">${escapeHTML(tag)}</span>
            <span class="syfe-wikihint__detail">${escapeHTML(it.detail)}</span>
        </div>`;
    }).join("");
    popup.innerHTML = (body || `<div class="syfe-wikihint__empty">无匹配文件/块</div>`) +
        `<div class="syfe-wikihint__tip">名:行号 定位到行 · 名#标题 定位到标题 · 文字可搜思源块 · Esc 让给思源原生 [[</div>`;
    positionPopup(rect);
    updateActive();
}

function suppressNativeHint(inner: any): void {
    const el = inner?.hint?.element as HTMLElement | null;
    if (el && !el.classList.contains(SUPPRESS_CLASS)) {
        el.classList.add(SUPPRESS_CLASS);
        suppressed.push(el);
    }
}

function hide(): void {
    seq++;
    trigger = null;
    items = [];
    active = 0;
    if (popup) {
        popup.remove();
        popup = null;
    }
    for (const el of suppressed) el.classList.remove(SUPPRESS_CLASS);
    suppressed = [];
}

async function sync(): Promise<void> {
    // Esc 让行中:原生 [[ hint 完全接管,不弹浮层也不加抑制。
    // 删掉 : 变回纯 [[、输入 ] / 换行、光标离开该区间或设置关闭即复位。
    if (yielded) {
        if (!enabledFn() || !readTrigger()) yielded = false;
        return;
    }
    const t = enabledFn() ? readTrigger() : null;
    if (!t) {
        hide();
        return;
    }
    const mySeq = ++seq;
    const list = await buildItems(t.query);
    if (mySeq !== seq) return; // 期间又有输入,丢弃旧结果
    if (list.length === 0) {
        // 无候选也要保留浮层(显示「无匹配」)并压住原生 [[ 菜单,
        // 否则 [[: 期间两个浮层会叠在一起、且旧候选列表不会刷新
        trigger = t;
        items = [];
        renderPopup(t.rect);
        suppressNativeHint(t.inner);
        return;
    }
    trigger = t;
    items = list;
    if (active >= items.length) active = 0;
    renderPopup(t.rect);
    suppressNativeHint(t.inner);
}

// ===== 选中并插入 =====
function insertLink(t: Trigger, it: HintItem): void {
    const r = t.range;
    if (!r.startContainer.isConnected) {
        showMessage("光标已变化,请重新输入 [[: 选择", 3000, "info");
        return;
    }
    // 先删掉 [[:query(与 slash-commands.removeSlashText 同一套 Range 操作),
    // 再把光标折叠到删除位置并同步 protyle.toolbar.range —— insert(html,false,true)
    // 内部用的正是 protyle.toolbar.range,不同步会插到旧位置。
    r.deleteContents();
    const caret = document.createRange();
    caret.setStart(r.startContainer, r.startOffset);
    caret.collapse(true);
    const sel = window.getSelection();
    if (sel) {
        sel.removeAllRanges();
        sel.addRange(caret);
    }
    if (t.inner?.toolbar) t.inner.toolbar.range = caret.cloneRange();
    const html = `<span data-type="a" data-href="${escapeHTML(it.url)}">${escapeHTML(it.text)}</span>`;
    try {
        t.editor.insert(html, false, true);
    } catch (e) {
        showMessage(`插入链接失败: ${e}`, 4000, "error");
        return;
    }
    // 文件类链接:立刻刷新已打开的反链面板(与 /file 斜杆命令同款)
    if (it.kind === "file" && it.path) emitBacklinkRefresh(it.path);
}

function choose(index: number): void {
    const it = items[index];
    const t = trigger;
    if (!it || !t) return;
    // 先删触发符并插入链接,再撤掉原生菜单抑制:若反过来,移除抑制的瞬间
    // [[:query 还在 DOM 里,思源原生块引用菜单会闪一下
    insertLink(t, it);
    hide();
}

// ===== 全局事件 =====
function onInput(e: Event): void {
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.(".protyle-wysiwyg")) return;
    // 思源自己的 input handler 在 target 阶段跑(可能重排 DOM),延后一拍再读光标
    window.setTimeout(() => { void sync(); }, 0);
}

function onKeydown(e: KeyboardEvent): void {
    if (!popup || !trigger || e.isComposing) return;
    const keys = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Enter", "Tab", "Escape"];
    if (!keys.includes(e.key)) return;
    // 仅浮层活动期间拦键:纯 [[ 时 popup 为 null,思源原生 hint 完全不受影响。
    // 思源在 .protyle-wysiwyg 上绑 keydown,document capture 更早;
    // 拦截导航键避免原生 [[ hint 同时响应(它会把回车变成块引用)。
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
        // 让给思源原生 [[ 文档/块引用:hide() 会撤掉原生 hint 的抑制 class;
        // 我们的键盘拦截已 stopImmediatePropagation,思源不会收到这次 Esc 关菜单。
        // 用户把触发符里的 : 删掉即回到纯 [[ 的原生搜索(此时 yielded 复位)。
        yielded = true;
        hide();
        return;
    }
    if (items.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "PageDown") active = (active + 1) % items.length;
    else if (e.key === "ArrowUp" || e.key === "PageUp") active = (active - 1 + items.length) % items.length;
    else {
        choose(active);
        return;
    }
    updateActive();
}

function onDocMouseDown(e: MouseEvent): void {
    if (!popup) return;
    if ((e.target as HTMLElement | null)?.closest(`.${POPUP_CLASS}`)) return;
    hide();
}

function onSelectionChange(): void {
    if (!popup) return;
    window.clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
        const t = enabledFn() ? readTrigger() : null;
        if (!t) hide();
        else trigger = t; // 只更新插入用的 range,不重建候选(避免每次移动光标都查 SQL)
    }, 80);
}

function onScroll(): void {
    if (popup) hide();
}

/**
 * 注册补全(全局监听只装一次;跨 window.eval 换届由 disposal 注册表清理,
 * 避免热重载后监听器按份数累积 —— 与 utils/disposal.ts 的约定一致)。
 * isEnabled 每次输入时调用,设置保存后立即生效,无需重新注册。
 */
export function registerDocWikilinkHint(isEnabled: () => boolean): () => void {
    enabledFn = isEnabled;
    if (!registered) {
        registered = true;
        document.addEventListener("input", onInput, true);
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("mousedown", onDocMouseDown, true);
        document.addEventListener("selectionchange", onSelectionChange);
        document.addEventListener("scroll", onScroll, true);
        onDispose(() => {
            document.removeEventListener("input", onInput, true);
            document.removeEventListener("keydown", onKeydown, true);
            document.removeEventListener("mousedown", onDocMouseDown, true);
            document.removeEventListener("selectionchange", onSelectionChange);
            document.removeEventListener("scroll", onScroll, true);
            window.clearTimeout(selTimer);
            hide();
            yielded = false;
            registered = false;
        });
    }
    return () => {
        enabledFn = () => false;
        hide();
    };
}
