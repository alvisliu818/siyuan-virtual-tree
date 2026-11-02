// 全局单例 Monaco 代码块基础设施
// 诉求「代码块使用 Monaco 编辑和 Monaco 渲染,全局单一 Monaco 实例」:
//   - 编辑态:全局唯一的 Monaco editor 实例,点击代码块卡片时挂载进该卡片,离开归还
//     隐藏 stash —— 与代码文件同一主题服务/分词器(grammar-loader 已把围栏语言的
//     TextMate tokenizer 注册进 monaco),主题切换自动一致
//   - 渲染态/阅读态:monaco.editor.colorize() 用**当前全局主题**产出高亮 HTML
// 主题切换统一走 setGlobalCodeTheme(全局 setTheme 的唯一业务入口):记账主题名、
// 失效 colorize 缓存、通知订阅者 —— monaco 0.50 无公开的 onDidChangeTheme 事件。
//
// ⚠ 两条实测铁律:
//   1. 全部状态挂 window 注册表 —— webpack 分块会把本模块求值两份,模块级变量
//      各自为政会出现两个编辑器实例、主题记账错乱;挂 window 后天然全局唯一。
//   2. 挂载/重绑绝不能在 widget.toDOM 里做 —— CM6 重建/测量会克隆、销毁 widget
//      DOM;编辑器只能由 ViewPlugin 在**真实视图 DOM**上挂载(cm6-render 的
//      editMounter),toDOM 永远只渲染壳。
//   3. monaco 0.50 运行时 getDomNode() 返回 undefined(类型却声明存在),自抓
//      .monaco-editor 根节点搬运 DOM。
import * as monaco from "monaco-editor";

interface BlockState {
    editor: monaco.editor.IStandaloneCodeEditor | null;
    domNode: HTMLElement | null;
    stash: HTMLElement | null;
    themeName: string;
    /** 当前挂载中的活跃块;cm6 保存前 flush 用 */
    activeBlock: BlockEditorHandle | null;
    /** 当前挂载容器(重绑判定用) */
    mountedContainer: HTMLElement | null;
    /** 当前编辑块 key(与 cm6-render 共享的编辑态) */
    editingKey: string | null;
    /** 挂载时的 monaco language id(重绑复用) */
    mountedLanguage: string;
    /** 刚退出编辑的块的最终内容(复制按钮等在退出后仍取得到最终编辑值) */
    lastActiveValue: string | null;
    listeners: Array<() => void>;
    outsideListener: ((e: MouseEvent) => void) | null;
    contentListener: monaco.IDisposable | null;
    keyListener: monaco.IDisposable | null;
    relayoutListener: monaco.IDisposable | null;
    blockModel: monaco.editor.ITextModel | null;
    colorizeCache: Map<string, Promise<string>>;
}

export interface BlockEditorHandle {
    key: string;
    getValue(): string;
    flush(): void;
}

const G = window as any;
const S: BlockState = G.__syfeMonacoBlock || (G.__syfeMonacoBlock = {
    editor: null,
    domNode: null,
    stash: null,
    themeName: "",
    activeBlock: null,
    mountedContainer: null,
    editingKey: null,
    mountedLanguage: "plaintext",
    lastActiveValue: null,
    listeners: [],
    outsideListener: null,
    contentListener: null,
    keyListener: null,
    relayoutListener: null,
    blockModel: null,
    colorizeCache: new Map<string, Promise<string>>(),
});

// 懒建全局单例(隐藏 stash 容器;编辑态把它 mount 进代码块,离开后归还 stash)。
// 首次创建同时把当前主题的主题 CSS 注册进文档(colorize 产物的 mtk* 类才有着色)。
function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
    if (S.editor) return S.editor;
    S.stash = document.createElement("div");
    S.stash.style.cssText = "position:fixed;left:-99999px;top:0;width:600px;height:200px;overflow:hidden;";
    document.body.appendChild(S.stash);
    // 注意不能传 theme:构造时的 theme 参数会全局覆盖 setTheme,导致扩展主题失效
    // (与 monaco.ts createEditor 同款坑)。省略即跟随全局当前主题。
    // 字号/字体/换行与卡片正文一致,行高 21 ≈ 13px × 1.6
    S.editor = monaco.editor.create(S.stash, {
        value: "",
        automaticLayout: true,
        lineNumbers: "on",
        folding: false,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        minimap: {enabled: false},
        scrollbar: {vertical: "hidden", horizontal: "hidden", alwaysConsumeMouseWheel: false},
        fontSize: 13,
        lineHeight: 21,
        fontFamily: "var(--b3-font-family-code, monospace)",
    });
    S.domNode = (S.stash.querySelector(":scope > .monaco-editor") as HTMLElement | null);
    if (!S.domNode) {
        console.error("[monaco-block] create: .monaco-editor 根节点未找到");
    }
    return S.editor;
}

// ===== 全局主题 =====

// 统一的全局主题切换入口(替代散落的 monaco.editor.setTheme 直调):
// 记账主题名(colorize 缓存键)+ 清缓存 + 通知订阅者(cm6 卡片重建/阅读态重取色)。
export function setGlobalCodeTheme(name: string): void {
    if (S.themeName === name) return;   // 同名重复应用(如明暗切换到同一主题)不折腾
    monaco.editor.setTheme(name);
    S.themeName = name;
    S.colorizeCache.clear();
    for (const cb of [...S.listeners]) {
        try {
            cb();
        } catch {
            // 单个监听器异常不影响其他监听器
        }
    }
}

// 全局当前主题名(colorize 缓存键用)。理论上传入 Tracker 的第一个切换发生在
// setupMonaco→applyTheme,早于任何代码块渲染;兜底按思源明暗标记猜主题名。
export function getMonacoThemeName(): string {
    if (!S.themeName) {
        ensureEditor();
        S.themeName = document.body.classList.contains("dark") ? "siyuan-dark" : "siyuan-light";
    }
    return S.themeName;
}

// 主题变更订阅(setGlobalCodeTheme 触发;覆盖扩展主题/思源配色/明暗切换全部路径)
export function onMonacoThemeChanged(cb: () => void): {dispose(): void} {
    S.listeners.push(cb);
    return {
        dispose: () => {
            const i = S.listeners.indexOf(cb);
            if (i >= 0) S.listeners.splice(i, 1);
        },
    };
}

// ===== colorize 缓存 =====
const COLORIZE_CACHE_LIMIT = 256;

function escapeFallback(code: string): string {
    return code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Monaco 渲染:用当前全局主题把代码高亮成 HTML(mtk* 类,主题 CSS 已在文档中)。
// 语言未知/失败时回退转义纯文本 —— 与代码文件渲染同一取色来源。
export function colorizeCached(lang: string, code: string): Promise<string> {
    const key = `${getMonacoThemeName()}\u0000${lang || "plaintext"}\u0000${code}`;
    let p = S.colorizeCache.get(key);
    if (!p) {
        ensureEditor();
        p = monaco.editor
            .colorize(code, lang || "plaintext", {tabSize: 4})
            .then(
                (html) => {
                    if (S.colorizeCache.size > COLORIZE_CACHE_LIMIT) S.colorizeCache.clear();
                    // Monaco 每行(含最后一行)都补一个 <br/>:剥掉末尾那个,
                    // 卡片/阅读态盒子才不多出一行空行(my-logseq 同款处理)
                    return html.replace(/<br\/>\s*$/, "");
                },
                () => escapeFallback(code),
            );
        S.colorizeCache.set(key, p);
    }
    return p;
}

// ===== 编辑态:单例编辑器挂载/卸载/重绑 =====

export function getMountedBlockKey(): string | null {
    return S.activeBlock?.key ?? null;
}

// 当前挂载容器(同块重建后容器会变,重绑判定用)
export function getMountedContainer(): HTMLElement | null {
    return S.mountedContainer;
}

// 挂载时的 monaco language id(同块重绑复用,不重建 model)
export function getMountedLanguage(): string {
    return S.mountedLanguage;
}

export function getActiveBlockValue(): string | null {
    if (S.activeBlock) return S.activeBlock.getValue();
    return S.lastActiveValue;
}

function setActiveBlock(h: BlockEditorHandle | null): void {
    S.activeBlock = h;
}

// 保存前同步:把活跃块 Monaco 的当前内容同步回 cm6 文档(cm6-render 提供的回调)
export function flushActiveBlock(): void {
    S.activeBlock?.flush();
}

// 编辑块 key 的读写(cm6-render 的点击挂载/退出与销毁兜底共用)
export function getEditingKey(): string | null {
    return S.editingKey;
}

export function setEditingKey(key: string | null): void {
    S.editingKey = key;
}

export interface MountBlockOptions {
    /** 编辑器宿主容器(卡片正文内;必须是真实视图 DOM,不能是测量克隆) */
    container: HTMLElement;
    /** 块标识(cm6 文档内的块起始位置字符串) */
    key: string;
    /** monaco language id(调用方经 grammar-loader 解析,未知用 plaintext) */
    language: string;
    /** 初始内容(最近一次同步的块内容) */
    value: string;
    /** Monaco 内容变更 → 回写 cm6 文档 */
    onContentChange(value: string): void;
    /** Esc → 退出编辑态(点击外部由本模块捕获监听处理) */
    onExit(): void;
}

// 绑定内容/Esc 监听 + 记账(挂载与同块重绑共用)
function bindBlockListeners(o: MountBlockOptions, ed: monaco.editor.IStandaloneCodeEditor): void {
    S.contentListener?.dispose();
    S.keyListener?.dispose();
    S.contentListener = ed.onDidChangeModelContent(() => o.onContentChange(ed.getValue()));
    S.keyListener = ed.onKeyDown((e) => {
        if (e.keyCode === monaco.KeyCode.Escape) o.onExit();
    });
    setActiveBlock({
        key: o.key,
        getValue: () => ed.getValue(),
        flush: () => o.onContentChange(ed.getValue()),
    });
}

// 清监听(不动 model/DOM)
function unbindBlockListeners(): void {
    S.contentListener?.dispose();
    S.contentListener = null;
    S.keyListener?.dispose();
    S.keyListener = null;
    setActiveBlock(null);
}

// 高度自适应内容(行数 × 行高),宽随容器;内容变化时也要重算
function relayoutTo(container: HTMLElement, ed: monaco.editor.IStandaloneCodeEditor): void {
    const lines = ed.getModel()?.getLineCount() ?? 1;
    ed.layout({width: container.clientWidth || 600, height: Math.min(lines * 21 + 6, 800)});
}

// 把单例编辑器挂进卡片正文:换 model、搬 DOM、监听内容/Esc/点击外部
export function mountBlockEditor(o: MountBlockOptions): void {
    const ed = ensureEditor();
    unmountBlockEditor();   // 双保险:全局同时只挂一块
    if (S.blockModel && !S.blockModel.isDisposed()) S.blockModel.dispose();
    S.blockModel = monaco.editor.createModel(o.value, o.language);
    // 统一 LF:monaco 在 Windows 上默认 CRLF,会把插入内容转成 \r\n 污染 markdown
    S.blockModel.setEOL(monaco.editor.EndOfLineSequence.LF);
    ed.setModel(S.blockModel);
    S.mountedContainer = o.container;
    S.mountedLanguage = o.language;
    S.domNode && o.container.appendChild(S.domNode);
    bindBlockListeners(o, ed);
    // 点击卡片外 → 退出编辑态。不能只靠 blur:点击目标(如正文行)可能不抢焦点,
    // monaco 根本没失焦过;捕获阶段拦,卡片内/编辑器内点击不算外部
    S.outsideListener = (e: MouseEvent) => {
        const t = e.target as Node | null;
        const inCard = !!o.container.contains(t) || !!(S.domNode && S.domNode.contains(t));
        if (!inCard) {
            S.lastActiveValue = ed.getValue();
            o.onExit();
        }
    };
    document.addEventListener("mousedown", S.outsideListener, true);
    const relayout = () => relayoutTo(o.container, ed);
    relayout();
    setTimeout(relayout, 60);
    S.relayoutListener = ed.onDidChangeModelContent(relayout);
    // 聚焦要等 mousedown 默认动作结束,否则立即被浏览器夺走
    ed.focus();
    setTimeout(() => ed.focus(), 0);
}

// 同一块的 CM6 重建后:把编辑器 DOM 搬进新容器、重绑监听(model/value/焦点保持)。
// 由 cm6-render 的 editMounter 在真实视图 DOM 上调用;测量克隆中的宿主会被过滤。
export function remountBlockEditor(o: MountBlockOptions): void {
    if (!S.editor || !S.domNode) return;
    if (S.activeBlock?.key !== o.key) return;   // 只处理同块重绑,新挂载走 mountBlockEditor
    if (S.mountedContainer === o.container) return;   // 已在目标容器里
    const ed = S.editor;
    S.mountedContainer = o.container;
    S.domNode && o.container.appendChild(S.domNode);
    bindBlockListeners(o, ed);
    relayoutTo(o.container, ed);
}

// 卸载:归还 DOM 到 stash、dispose 临时 model 与监听
export function unmountBlockEditor(): void {
    if (S.outsideListener) {
        document.removeEventListener("mousedown", S.outsideListener, true);
        S.outsideListener = null;
    }
    S.contentListener?.dispose();
    S.contentListener = null;
    S.keyListener?.dispose();
    S.keyListener = null;
    S.relayoutListener?.dispose();
    S.relayoutListener = null;
    if (S.blockModel && !S.blockModel.isDisposed()) {
        S.lastActiveValue = S.blockModel.getValue();
    }
    setActiveBlock(null);
    S.mountedContainer = null;
    if (S.blockModel && !S.blockModel.isDisposed()) S.blockModel.dispose();
    S.blockModel = null;
    if (S.editor && S.stash && S.domNode) {
        S.stash.appendChild(S.domNode);
    }
}
