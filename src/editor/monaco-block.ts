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
//   3. monaco 0.50 运行时 getDomNode() 返回 undefined(类型却声明存在):
//      create 挂在随行 root 上,S.domNode = root 本体(.monaco-editor 是其子节点,
//      随行搬运);同时 automaticLayout 观察的就是 root —— 搬到哪量到哪。
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
    settleTimer: number | null;
    hostObserver: {ro: ResizeObserver; poll: number; startedAt: number; lastW: number} | null;
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
    settleTimer: null,
    hostObserver: null,
});

// 懒建全局单例(隐藏 stash 容器;编辑态把**随行 root** mount 进代码块,离开后归还 stash)。
// 首次创建同时把当前主题的主题 CSS 注册进文档(colorize 产物的 mtk* 类才有着色)。
// ⚠ 不用 automaticLayout(关掉):monaco 自带的 ElementSizeObserver 在搬运窗口
//   (CM6 重建 → root 瞬时 0 宽/脱离文档)会把 0/2^24 脏值烙进 lines-content 内联
//   宽且不再自愈(0→0 恒稳 RO 不触发;实测反复复根)。改自管 ResizeObserver 观察
//   host(见 startHostObserver),发现尺寸变化就双维齐传 layout() 钉回正确值。
// 卡片(阅读态 colorize)与块内编辑态统一用 **Monaco 字体**(用户 2026-11-09 决策:
// 卡片用 Monaco 字体,不再跟随思源 --b3-font-family-code/JetBrains Mono)。
// 字串在两处保持一致:这里(Monaco 选项)+ index.scss 的 .syfe-cm-codeblock-body。
// ⚠ 也不能把 var(...) 传给 Monaco 的 fontFamily 选项:实测 .view-line 的 computed
//   font-family 会在变量值之后拼上默认字体串,两态字形来源含糊;显式字面串最稳。
// 导出给 cm6-markdown 的卡片主题(阅读态 colorize)使用 —— 两态字体单一来源
export const BLOCK_FONT_FAMILY = "Consolas, 'Courier New', monospace";
export const BLOCK_FONT_SIZE = 13;
// BLOCK_LINE_HEIGHT = 21 在文件下方(relayoutTo 计算卡片高度处)已定义,此处复用

function ensureEditor(): monaco.editor.IStandaloneCodeEditor {
    if (S.editor) return S.editor;
    S.stash = document.createElement("div");
    S.stash.style.cssText = "position:fixed;left:-99999px;top:0;width:600px;height:200px;overflow:hidden;";
    document.body.appendChild(S.stash);
    const root = document.createElement("div");
    root.style.cssText = "width:100%;";
    S.stash.appendChild(root);
    // 注意不能传 theme:构造时的 theme 参数会全局覆盖 setTheme,导致扩展主题失效
    // (与 monaco.ts createEditor 同款坑)。省略即跟随全局当前主题。
// 字号/字体/行高与卡片正文一致(21px);其余与 my-logseq 块内形态同套:
        // 无行号、折叠槽清零、无 minimap、不折行(Logseq parity:长行横向滚)、
        // 关括号彩虹(此处编辑器级选项实际到不了 model,真开关在 mountBlockEditor
        // 的 model 级 updateOptions —— 这里保留是防御,两态颜色一致靠那个)、
        // 横向滚动条 10px = 阅读态常驻条带高度 —— 两态任何情况下等高。
    S.editor = monaco.editor.create(root, {
        value: "",
        automaticLayout: false,
        // 行号打开:与代码文件编辑器一致,阅读态卡片的行号列(逐行重建)也
        // 一直在 —— 两态都有行号,视觉不跳
        lineNumbers: "on",
        lineNumbersMinChars: 2,
        // 末空行行号:Enter 后模型以换行结尾, 末行(空)的行号要显示 —— 代码
        // 文件编辑器的设置 editor.renderFinalNewline 默认 off(末行行号不渲染)
        // 会经设置扇出到本编辑器, 已在该 def 上标 blockLocked(不进块内作用域),
        // 这里再在创建参数里强制 on 双保险(用户 2026-11-14「换行后行号没出现」)
        renderFinalNewline: "on",
        // 行号右侧的装饰宽:补齐与阅读卡片行号列的差值 —— 卡片行号列宽 =
        // padding 0.9em×2(@13px Consolas = 23.4px,见 index.scss .syfe-cm-cl-n),
        // Monaco 行号数字 2ch = 14px,差 9.4px。不补的话进出编辑代码列整体
        // 横移 9.4px(用户反馈「行号位置变了」)。测试库 lineDecorationsWidth=9.4
        // 实验实测 def token x 14.0 → 23.0,与卡片 23.4 对齐。
        lineDecorationsWidth: 9.4,
        folding: false,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        scrollBeyondLastColumn: 0,
        wordWrap: "off",
        bracketPairColorization: {enabled: false},
        // 点击词带的同词灰底高亮(occurrencesHighlight 默认 singleClick)也是编辑态
        // 独有的视觉噪声 —— 阅读态 colorize 产物没有,关掉两态才一致
        occurrencesHighlight: "off",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        minimap: {enabled: false},
        scrollbar: {
            vertical: "hidden",
            horizontal: "auto",            // 需要时出现,落在 10px 条带里(与阅读态条带等高)
            horizontalScrollbarSize: 10,
            alwaysConsumeMouseWheel: false,
        },
        padding: {top: 8, bottom: 8},
        fontSize: BLOCK_FONT_SIZE,
        lineHeight: BLOCK_LINE_HEIGHT,
        fontFamily: BLOCK_FONT_FAMILY,
        // 语义着色开关(monaco standalone 默认关):python 块经 LSP 虚拟文档拿到
        // semanticTokens 后,扩展主题的语义色才能在编辑态生效 —— 与代码文件
        // (monaco.ts createEditor 同款)对齐。思源配色主题无语义规则,开了也无色可施,
        // 两态/文件依旧一致。
        "semanticHighlighting.enabled": true,
    });
    // 搬运的就是 root 本体(.monaco-editor 是它的子节点,随行)
    S.domNode = root;
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

// ===== 语义层挂钩(python-lsp-bridge 经 setupBlockSemanticBridge 注入)=====
// 模块方向:bridge → 本模块单向注入,本模块不反向 import bridge
// (theme-loader → 本模块的 setGlobalCodeTheme 已构成一条边,再加反向边成环)。
/** 阅读态语义覆盖:colorize 的 TextMate HTML → 叠语义色(python + pyright 就绪时) */
type SemanticOverlayHook = (lang: string, code: string, html: string) => Promise<string>;
/** 编辑态生命周期:块 model 挂载/卸载 → LSP 虚拟文档登记与注销 */
interface BlockLspHooks {
    onBlockMounted(lang: string, code: string, model: monaco.editor.ITextModel): void;
    onBlockUnmounted(model: monaco.editor.ITextModel): void;
}
let semanticOverlayHook: SemanticOverlayHook | null = null;
let blockLspHooks: BlockLspHooks | null = null;

export function setSemanticOverlayHook(h: SemanticOverlayHook | null): void {
    semanticOverlayHook = h;
}

export function setBlockLspHooks(h: BlockLspHooks | null): void {
    blockLspHooks = h;
}

// 清 colorize 缓存并通知订阅者(卡片重渲)。语义 provider 就绪/重启/注销时由
// bridge 调 —— 缓存里可能有语义层未就绪时的纯 TextMate 结果,不清会永远偏色。
export function invalidateColorizeCache(): void {
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
                async (html) => {
                    if (S.colorizeCache.size > COLORIZE_CACHE_LIMIT) S.colorizeCache.clear();
                    // Monaco 每行(含最后一行)都补一个 <br/>:剥掉末尾那个,
                    // 卡片/阅读态盒子才不多出一行空行(my-logseq 同款处理)
                    let out = html.replace(/<br\/>\s*$/, "");
                    // 语义覆盖(python + pyright 就绪时把 LSP 语义色叠上去;
                    // 无钩子/未就绪/失败一律回落纯 TextMate 高亮)
                    if (semanticOverlayHook) {
                        try {
                            out = await semanticOverlayHook(lang || "plaintext", code, out);
                        } catch {
                            // 保持 TextMate 原样
                        }
                    }
                    return out;
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
        // Enter:Monaco 原生按键处理在嵌入场景被 CM6 keymap 抢先 preventDefault
        // (焦点在 Monaco textarea, keydown 冒泡到 cm-content 的 keymap —— 用户
        // 2026-11-14「monaco 代码块里换行不成功」, CDP 传播链插桩实证: target
        // 阶段未 prevent, cm-content 冒泡阶段已 prevent 且模型/文档均无变化)。
        // 显式插入 + 阻断冒泡, CM6 keymap 不再接手; executeEdits 是已验证可靠
        // 的插入路径(与模型 API 复现同款)。
        if (e.keyCode === monaco.KeyCode.Enter) {
            e.browserEvent.preventDefault();
            e.browserEvent.stopPropagation();
            const sel = ed.getSelection();
            ed.executeEdits("enter", [{range: sel, text: "\n"}]);
        }
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

// 高度自适应内容:行数×行高 + 上下 padding(8×2)+ 横条带 10 —— 与阅读态
// (padding 8×2 + ::-webkit-scrollbar 高 10)逐像素等高。
// ⚠ 绝不调 ed.layout(dimension):automaticLayout 模式下 layout() 是「钉成固定尺寸」,
//   部分维度({height})会把 width 钉成 0px 内联,ResizeObserver 从此看不到变化(0→0)
//   永久卡死(实测坐实:meInline width:0px、手动 layout({width,height}) 双维齐传才活)。
//   只写容器 CSS(width:100% 由 ensureEditor 设好,height 在这里显式写),me 作为
//   100% 子元素跟随,RO 全程接管 —— my-logseq 同款(updateHeight 只写 root 高度)。
export const BLOCK_LINE_HEIGHT = 21;
const BLOCK_V_PAD = 16;
const BLOCK_HSCROLL_STRIP = 10;
function relayoutTo(_container: HTMLElement, ed: monaco.editor.IStandaloneCodeEditor): void {
    const lines = ed.getModel()?.getLineCount() ?? 1;
    const h = lines * BLOCK_LINE_HEIGHT + BLOCK_V_PAD + BLOCK_HSCROLL_STRIP;
    if (S.domNode) S.domNode.style.height = `${h}px`;
}

// 挂载后自愈守卫(替换 monaco 自带 automaticLayout):
// 双通道—— ① ResizeObserver 观察 host(root 的宿主),尺寸变化即双维齐传
// layout() 钉回正确值;② setInterval 巡检 2.2s,兜住 RO 不报的脏内联宽
// (lines-content 被焙进 2^24)与 cm6 重建窗口的漏网案例。
// 实测依据:partial-dim layout({height}) 会把 width 钉成 0px;双维齐传
// layout({width,height}) 一次救活(width-fix 实验);自动 RO 在搬运窗口
// 会把 0/2^24 焙死不再自愈。
interface HostObserver {
    ro: ResizeObserver;
    poll: number;
    startedAt: number;
    lastW: number;
}

function stopHostObserver(): void {
    const h = S.hostObserver as HostObserver | null;
    if (!h) return;
    S.hostObserver = null;
    try { h.ro.disconnect(); } catch { /* 忽略 */ }
    window.clearInterval(h.poll);
}

function startHostObserver(container: HTMLElement): void {
    stopHostObserver();
    const applyLayout = () => {
        if (!S.editor || !S.domNode || !S.domNode.isConnected) return;
        const w = S.domNode.clientWidth;
        const lines = S.editor.getModel()?.getLineCount() ?? 1;
        const h = lines * BLOCK_LINE_HEIGHT + BLOCK_V_PAD + BLOCK_HSCROLL_STRIP;
        // 双维齐传:部分维度会把另一维钉成 0(实测);宽 <50 视为重建窗口中的
        // 无布局态,跳过等下一拍
        if (w > 50) S.editor.layout({width: w, height: h});
    };
    const ro = new ResizeObserver(() => {
        if (!S.hostObserver) return;
        // rAF 延一拍:host 尺寸刚变时 clientWidth 可能还是旧值
        requestAnimationFrame(applyLayout);
    });
    ro.observe(container);
    const h: HostObserver = {ro, poll: 0, startedAt: Date.now(), lastW: 0};
    // 巡检通道:每 150ms 共 2.2s,覆盖重建窗口+脏值写入窗口;
    // 终点后停止(用户交互路径由 RO 接管)
    h.poll = window.setInterval(() => {
        const elapsed = Date.now() - h.startedAt;
        if (elapsed > 2200 || !S.domNode || !S.domNode.isConnected) {
            stopHostObserver();
            return;
        }
        applyLayout();
        // 脏内联尺寸巡检:lines-content 的内联 width/height 被焙进 2^24 脏值
        // (0 宽窗口遗留)或被清空后 monaco 布局缓存认为「没变」不再重写 → 0×0
        // 合成层被 Chromium 光栅化跳过 = 空白盒子。两种坏态都直接写成
        // layoutInfo 的正确值(monaco 自己会写的同一对值)。链路有
        // overflow-guard 中间层,必须用后代选择器(直子女链匹配不上空转)
        if (S.domNode && S.editor) {
            const vs = S.domNode.querySelector(".monaco-editor .monaco-scrollable-element > .lines-content") as HTMLElement | null;
            const w = S.domNode.clientWidth;
            if (vs && w > 50) {
                const li = S.editor.getLayoutInfo();
                const vsW = parseFloat(vs.style.width) || 0;
                const vsH = parseFloat(vs.style.height) || 0;
                const badW = vsW > w * 4 + 200 || vsW === 0;
                const badH = vsH > 100000 || vsH === 0;
                if (badW || badH) {
                    vs.style.width = `${li.contentWidth}px`;
                    vs.style.height = `${S.editor.getContentHeight()}px`;
                }
            }
            if (w > 50) {
                const lines = S.editor.getModel()?.getLineCount() ?? 1;
                S.editor.layout({
                    width: w,
                    height: lines * BLOCK_LINE_HEIGHT + BLOCK_V_PAD + BLOCK_HSCROLL_STRIP,
                });
            }
        }
    }, 150);
    S.hostObserver = h;
    // 首拍立即铺一次(不等 RO)
    applyLayout();
}

// 把单例编辑器挂进卡片正文:换 model、搬 DOM、监听内容/Esc/点击外部
export function mountBlockEditor(o: MountBlockOptions): void {
    const ed = ensureEditor();
    unmountBlockEditor();   // 双保险:全局同时只挂一块
    if (S.blockModel && !S.blockModel.isDisposed()) S.blockModel.dispose();
    S.blockModel = monaco.editor.createModel(o.value, o.language);
    // 统一 LF:monaco 在 Windows 上默认 CRLF,会把插入内容转成 \r\n 污染 markdown
    S.blockModel.setEOL(monaco.editor.EndOfLineSequence.LF);
    // 括号配对着色必须在 **MODEL 级**关:编辑器级选项到不了 model —— modelService
    // 按**全局** config 计算 bracketPairColorizationOptions(默认开着),create 传的
    // 编辑器级选项被忽略,括号一直是 VS Code 的 #0431FA 蓝,与阅读态(colorize)
    // 的无彩括号不一致(my-logseq 同款坑同款修法)。updateOptions 的键名是
    // bracketColorizationOptions(历史拼写);老版本 monaco 没有该选项时忽略。
    try {
        S.blockModel.updateOptions({
            bracketColorizationOptions: {
                enabled: false,
                independentColorPoolPerBracketType: false,
            },
        } as monaco.editor.ITextModelUpdateOptions);
    } catch {
        // 老版本 monaco 无该 model 选项
    }
    ed.setModel(S.blockModel);
    // ⭐ 同步驱动一次后台分词。monaco 0.50 的 classic 分词走 DefaultBackgroundTokenizer
    //   → runWhenGlobalIdle = requestIdleCallback(无 timeout 兜底)—— 窗口被遮挡/
    //   失焦时 Chromium 不回调 rIC,分词永远停在 scheduled(bgState 停留 InProgress),
    //   视图里关键词/字符串全落默认色、只剩语义 token 有色(实测坐实:代码文件
    //   model 在窗口启动早期跑完所以正常,块 model 挂载时刻窗口状态差就饿死)。
    //   直接用假 deadline 同步跑完 —— 块内容几~几十行,1ms 量级;内部结构变化时
    //   静默跳过回落 idle 调度。
    try {
        const gt = (S.blockModel as any)._tokenizationTextModelPart?.grammarTokens;
        const bgt = gt?._defaultBackgroundTokenizer;
        if (bgt && typeof bgt._backgroundTokenizeWithDeadline === "function") {
            bgt._backgroundTokenizeWithDeadline({didTimeout: true, timeRemaining: () => 10});
        }
    } catch {
        // 回落 idle 调度(窗口状态好时自愈)
    }
    // Python 块接入 LSP 虚拟文档(语义着色与文件编辑器同源;钩子由
    // python-lsp-bridge 的 setupBlockSemanticBridge 注入,未接线时是 no-op)
    try {
        blockLspHooks?.onBlockMounted(o.language, o.value, S.blockModel);
    } catch {
        // LSP 接线失败不影响编辑可用性
    }
    S.mountedContainer = o.container;
    S.mountedLanguage = o.language;
    S.domNode && o.container.appendChild(S.domNode);
    bindBlockListeners(o, ed);
    startHostObserver(o.container);
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
    startHostObserver(o.container);
    relayoutTo(o.container, ed);
}

// 卸载:归还 DOM 到 stash、dispose 临时 model 与监听
export function unmountBlockEditor(): void {
    if (S.outsideListener) {
        document.removeEventListener("mousedown", S.outsideListener, true);
        S.outsideListener = null;
    }
    stopHostObserver();
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
    // 先注销 LSP 虚拟文档(didClose + 摘 marker),再 dispose model
    try {
        if (S.blockModel) blockLspHooks?.onBlockUnmounted(S.blockModel);
    } catch {
        // ignore
    }
    if (S.blockModel && !S.blockModel.isDisposed()) S.blockModel.dispose();
    S.blockModel = null;
    if (S.editor && S.stash && S.domNode) {
        S.stash.appendChild(S.domNode);
    }
}
