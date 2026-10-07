// Jupyter Notebook(.ipynb)查看、编辑与运行 Tab。
// - 查看:代码/Markdown/Raw 单元格渲染,已保存的执行输出(文本/图片/HTML/JSON/错误)
// - 编辑:点击单元格进入 Monaco 就地编辑;添加/删除/上移/下移/切换单元格类型;写回 nbformat JSON
// - 运行:代码单元格可点 ▶ 或 Shift+Enter 执行,走**自带的持久 Python 内核**
//   (utils/python-kernel.ts + tools/syfe-kernel.py),不是 Jupyter 协议。
//   为什么不走 jupyter_client/ipykernel:那套依赖 zmq 与整套 Jupyter 协议,
//   而实际只需要「发代码 → 拿 stdout/stderr/结果值/异常」,自己实现更轻。
//   思源本体 650 条内核路由里也没有任何 Python 执行端点,接不上外部内核。
//   执行结果按 nbformat 4 规范写回 cell.outputs / cell.execution_count,
//   所以存盘后用 Jupyter / VS Code 打开也是合法的。
// 结构对齐 office-tab:独立 _dirty + 保存/重载 + beforeDestroy 确认。
import {openTab, confirm, showMessage} from "siyuan";
import * as monaco from "monaco-editor";
import Vditor from "vditor";
import {NOTEBOOK_TAB_TYPE} from "../constants";
import {basename} from "../utils/path";
import {readTextFile, writeFile} from "../api/file";
import {getCurrentMode} from "../editor/monaco";
import {getActiveThemeName} from "../extensions/theme-loader";
import {EditorConfig} from "../types";
import {VDITOR_CDN, ensureVditorCSS} from "./markdown-tab";
// Vditor.preview 会读全局 window.Lute,vditor 那份缺 SetTabs —— 见 utils/lute-guard
import {ensureSiyuanLute} from "../utils/lute-guard";
import {
    getPythonKernel, isPythonAvailable, disposePythonKernel,
    type ExecuteOutcome, type KernelStatus,
} from "../utils/python-kernel";

// Tab 所需的插件接口
export interface IPluginForNotebookTab {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
}

// nbformat 4 单元格/笔记本(宽松类型:源文件可能有各种形状)
interface NbCell {
    cell_type: string;
    source?: any;
    metadata?: any;
    outputs?: any[];
    execution_count?: number | null;
    id?: string;
}

interface Notebook {
    nbformat: number;
    nbformat_minor: number;
    metadata: any;
    cells: NbCell[];
}

// Tab 实例附加字段
interface NotebookTabInstance {
    element: HTMLElement;
    data: { path?: string };
    parent?: { updateTitle?: (t: string) => void; headElement?: HTMLElement; close?: () => void };
    _path?: string;
    _nb?: Notebook | null;
    _rawText?: string;          // 解析失败时的原始文本(JSON 兜底编辑)
    _rawMode?: boolean;         // JSON 兜底编辑模式
    _dirty?: boolean;
    _saving?: boolean;
    _closing?: boolean;
    _activeIdx?: number | null; // 当前选中单元格(新单元格插入其后)
    _editIdx?: number | null;   // 正在就地编辑的单元格
    _editEditor?: monaco.editor.IStandaloneCodeEditor | null;
    _editModel?: monaco.editor.ITextModel | null;
    /** 阅读态的只读编辑器:cell index → {editor, model}。与编辑态共用同一套 create 选项 */
    _roEditors?: Map<number, {editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel}>;
    /** 阅读态懒加载观察器:只有滚进视口(带余量)的单元格才建 monaco 实例 */
    _roObserver?: IntersectionObserver | null;
    _onKey?: (e: KeyboardEvent) => void;
    _escHandler?: (e: KeyboardEvent) => void;
    _clickHandler?: (e: MouseEvent) => void;
    _dblHandler?: (e: MouseEvent) => void;
    // ---- Python 内核(执行单元格)----
    /** 正在执行(或准备执行)的单元格索引 —— 用它做单格 spinner 与重复点击拦截 */
    _runningIdx?: number | null;
    /** 笔记本声明的语言不是 python 时置 false,隐藏所有运行入口 */
    _canRun?: boolean;
    /** 内核状态订阅的退订函数 */
    _statusUnsub?: () => void;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 去掉 ANSI 颜色转义(错误 traceback 用)
function stripANSI(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// 单元格 source 兼容 string / string[] 两种 nbformat 形态
function getSourceText(cell: NbCell): string {
    const src = cell.source;
    if (Array.isArray(src)) return src.join("");
    return String(src ?? "");
}

// 写回 source 时保留原有形态(数组按行拆分,保留除最后一行外的换行)
function setSourceText(cell: NbCell, text: string): void {
    if (Array.isArray(cell.source)) {
        cell.source = text.length ? text.split(/(?<=\n)/) : [""];
    } else {
        cell.source = text;
    }
}

// 输出 data 的值同样可能是 string 或 string[]
function mimeText(v: any): string {
    if (Array.isArray(v)) return v.join("");
    return String(v ?? "");
}

// notebook 内核语言 → Monaco language id
const NB_LANG_MAP: Record<string, string> = {
    python: "python", r: "r", julia: "julia", bash: "shell", shell: "shell",
    sh: "shell", zsh: "shell", javascript: "javascript", js: "javascript",
    typescript: "typescript", ts: "typescript", c: "c", "c++": "cpp", cpp: "cpp",
    java: "java", sql: "sql", go: "go", rust: "rust", ruby: "ruby", php: "php",
};

function notebookLang(nb: Notebook | null | undefined): string {
    const raw = String(nb?.metadata?.language_info?.name || "").toLowerCase();
    return NB_LANG_MAP[raw] || "plaintext";
}

function monacoTheme(): string {
    return getActiveThemeName() ?? (getCurrentMode() === 1 ? "siyuan-dark" : "siyuan-light");
}

// 代码区的行高(px)。**固定 px 而非倍数**:倍数(如 1.5)会被 monaco 按字号
// 向上取整,得到 20/21px 这种随字号跳变的实际行高,排版会轻微抖动。
const CODE_LINE_HEIGHT = 20;

/**
 * 代码单元格 monaco 的**唯一**选项来源 —— 编辑态与阅读态共用,只差 readOnly。
 *
 * 为什么必须共用:阅读态以前是 `monaco.editor.colorize()` 生成的静态 `<pre>`,
 * 和真编辑器是两条独立的渲染路径,字体/行高/padding/行号/背景任何一项对不上,
 * 一点进编辑整块内容就「跳一下」。既然阅读态也用 monaco 实例了,就把选项收口到
 * 一个函数里 —— 以后调样式只改这一处,两态不可能再漂移。
 */
function codeEditorOptions(cfg: EditorConfig | undefined, readonly: boolean): monaco.editor.IStandaloneEditorConstructionOptions {
    return {
        theme: monacoTheme(),
        automaticLayout: true,
        minimap: {enabled: false},
        scrollBeyondLastLine: false,
        // 行号:阅读态与编辑态都显示(用户要求)。因为两态现在共用同一份选项,
        // 行号占位宽度天然一致,点进编辑不会再因为"多出行号槽"而整体右移。
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        glyphMargin: false,
        wordWrap: "on",
        fontSize: cfg?.fontSize ?? 13,
        lineHeight: CODE_LINE_HEIGHT,
        tabSize: cfg?.tabSize ?? 4,
        renderLineHighlight: "none",
        scrollbar: {alwaysConsumeMouseWheel: false},
        padding: {top: 4, bottom: 4},
        folding: true,
        // 去掉编辑器的额外装饰,让两态观感一致
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        readOnly: readonly,
        // domReadOnly 让 DOM 上变成 contenteditable=false —— 只给 readOnly 的话
        // 底层 textarea 仍可聚焦,用户能在阅读态里敲出内容却没处显示。
        domReadOnly: readonly,
        // 光标:阅读态不该有闪烁光标,避免看起来还能敲字
        cursorBlinking: readonly ? "solid" : "smooth",
        cursorStyle: "line",
    };
}

/**
 * 阅读态的高度计算。
 *
 * monaco 的高度由**容器**决定,而容器是 `height: auto` —— 所以必须显式回写高度,
 * 否则格子会塌成 0。下限用「一行 + 上下 padding」,与单行单元格的高度一致。
 */
function fitEditorHeight(host: HTMLElement, editor: monaco.editor.IStandaloneCodeEditor): void {
    try {
        host.style.height = Math.max(CODE_LINE_HEIGHT + 8, editor.getContentHeight()) + "px";
    } catch {
        // 忽略:编辑器已 dispose
    }
}

// 打开 Notebook Tab(同文件去重,聚焦已有 Tab)
export function openNotebookTab(plugin: IPluginForNotebookTab, path: string, opts?: { position?: "right" | "bottom" }): void {
    const opened = plugin.getOpenedTab()[NOTEBOOK_TAB_TYPE] || [];
    const existing = opened.find((c: any) => c?.data?.path === path);
    if (existing) {
        const tab = (existing as any).parent;
        if (tab?.headElement) {
            (tab.headElement as HTMLElement).click();
        }
        return;
    }
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + NOTEBOOK_TAB_TYPE,
            icon: "iconFile",
            title: basename(path),
            data: {path},
        },
        position: opts?.position,
    } as any);
}

// 新建单元格(nbformat 4.5+ 的单元格带 id,与文件里现有单元格保持一致)
function makeCell(type: "code" | "markdown", withId: boolean): NbCell {
    const cell: NbCell = type === "code"
        ? {cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ""}
        : {cell_type: "markdown", metadata: {}, source: ""};
    if (withId) cell.id = Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);
    return cell;
}

// 单元格徽章文案
function cellBadge(cell: NbCell): string {
    if (cell.cell_type === "code") return "代码";
    if (cell.cell_type === "markdown") return "MD";
    return "RAW";
}

// 渲染输出区 HTML(流/错误/富输出)
//
// 没有输出时返回空串,不再渲染"无输出(…)"占位提示 —— 笔记本靠留白分隔格子,
// 每个没跑过的格子下面都挂一行灰字提示,整页看下来全是噪音。
// 配套:.syfe-nb__outs 有 :empty 规则,容器空时不显示(避免只剩一条虚线)。
function renderOutputsHTML(cell: NbCell): string {
    const outs = Array.isArray(cell.outputs) ? cell.outputs : [];
    if (outs.length === 0) {
        return "";
    }
    const parts: string[] = [];
    for (const out of outs) {
        const type = String(out?.output_type || "");
        if (type === "stream") {
            parts.push(`<pre class="syfe-nb__out syfe-nb__out--stream">${escapeHTML(stripANSI(mimeText(out.text)))}</pre>`);
            continue;
        }
        if (type === "error") {
            const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : String(out.traceback ?? "");
            parts.push(`<div class="syfe-nb__out syfe-nb__out--error"><div class="syfe-nb__err-name">${escapeHTML(String(out.ename || "Error"))}: ${escapeHTML(String(out.evalue || ""))}</div><pre>${escapeHTML(stripANSI(tb))}</pre></div>`);
            continue;
        }
        const data = out?.data;
        if ((type === "execute_result" || type === "display_data") && data) {
            // 按显示优先级挑 MIME
            const pick = (mime: string) => (data[mime] !== undefined ? mime : null);
            const mime = pick("image/png") || pick("image/jpeg") || pick("image/gif")
                || pick("image/svg+xml") || pick("text/markdown") || pick("text/html")
                || pick("application/json") || pick("text/plain");
            if (!mime) continue;
            const value = data[mime];
            if (mime.startsWith("image/")) {
                const b64 = mimeText(value).replace(/\s/g, "");
                parts.push(`<div class="syfe-nb__out syfe-nb__out--img"><img src="data:${mime};base64,${b64}" /></div>`);
            } else if (mime === "text/markdown") {
                parts.push(`<div class="syfe-nb__out syfe-nb__out--md" data-md="${encodeURIComponent(mimeText(value))}"></div>`);
            } else if (mime === "text/html") {
                // 沙箱 iframe(禁脚本),防恶意笔记本注入
                parts.push(`<iframe class="syfe-nb__out syfe-nb__out--html" sandbox="" srcdoc="${escapeHTML(mimeText(value))}"></iframe>`);
            } else if (mime === "application/json") {
                let pretty: string;
                try {
                    pretty = JSON.stringify(typeof value === "string" ? JSON.parse(mimeText(value)) : value, null, 2);
                } catch {
                    pretty = mimeText(value);
                }
                parts.push(`<pre class="syfe-nb__out">${escapeHTML(pretty)}</pre>`);
            } else {
                parts.push(`<pre class="syfe-nb__out">${escapeHTML(mimeText(value))}</pre>`);
            }
            continue;
        }
        // 未知输出类型跳过
    }
    // 有 outputs 但全是渲染不了的类型:同样返回空串(容器会 :empty 隐藏),
    // 与"没有输出"的观感保持一致
    return parts.join("");
}

// 内核 richData 里我们自己不渲染的 MIME —— nbformat 允许只存 text/plain
const KNOWN_MIMES = new Set([
    "text/plain", "text/html", "text/markdown", "image/png",
    "image/jpeg", "image/gif", "image/svg+xml", "application/json",
]);

/**
 * 把一次执行的结果翻译成 nbformat 4 的 outputs 数组。
 *
 * 为什么严格按规范写:存盘后用户可能用 Jupyter / VS Code 打开这个 ipynb,
 * 字段形状不对就会显示异常。顺序也按 Jupyter 的惯例:先 stream(输出)、
 * 再 execute_result(末尾表达式求值结果)、最后 error。
 */
function outcomeToOutputs(o: ExecuteOutcome): any[] {
    const outs: any[] = [];
    // stdout / stderr 各自合成一条 stream
    // (nbformat 的 stream 用 name 区分 stdout/stderr,不能合成一条)
    if (o.stdout) outs.push({output_type: "stream", name: "stdout", text: o.stdout});
    if (o.stderr) outs.push({output_type: "stream", name: "stderr", text: o.stderr});

    // 末表达式结果:有富媒体 mime 就整份存(图片 base64 等),
    // 补一个 text/plain 兜底给不支持富媒体的阅读器
    if (o.richData && Object.keys(o.richData).length > 0) {
        const data: Record<string, string> = {};
        let kept = 0;
        for (const [mime, val] of Object.entries(o.richData)) {
            if (mime === "text/plain" || KNOWN_MIMES.has(mime)) {
                data[mime] = val;
                kept++;
            }
        }
        if (kept > 0) {
            if (data["text/plain"] === undefined && o.result !== undefined) {
                data["text/plain"] = o.result;
            }
            outs.push({
                output_type: "execute_result",
                execution_count: o.executionCount,
                data,
                metadata: {},
            });
        }
    } else if (o.result !== undefined && o.result !== null) {
        outs.push({
            output_type: "execute_result",
            execution_count: o.executionCount,
            data: {"text/plain": o.result},
            metadata: {},
        });
    }

    if (o.error) {
        outs.push({
            output_type: "error",
            ename: o.error.ename,
            evalue: o.error.evalue,
            // traceback 必须是非空字符串数组,空数组会让部分阅读器渲染出空白
            traceback: o.error.traceback?.length ? o.error.traceback : [o.error.ename + ": " + o.error.evalue],
        });
    }
    return outs;
}

// 笔记本声明的语言是不是 Python(只有 Python 内核,别的语言不显示运行入口)
function isPythonNotebook(nb: Notebook | null | undefined): boolean {
    if (!nb) return false;
    const info = nb.metadata?.language_info || {};
    const name = String(info.name || "").toLowerCase();
    if (name === "python" || name === "py" || name.startsWith("python")) return true;
    // 老笔记本可能没有 language_info,退而看 kernelspec 的 display_name
    const kernel = String(nb.metadata?.kernelspec?.display_name || "").toLowerCase();
    return kernel.includes("python");
}

// 创建 Notebook Tab 的 addTab 配置
export function createNotebookTabConfig(_plugin: IPluginForNotebookTab) {
    return {
        type: NOTEBOOK_TAB_TYPE,
        init(this: NotebookTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定文件路径</div>`;
                return;
            }
            this._path = path;
            this._dirty = false;
            this._saving = false;
            this._closing = false;
            this._activeIdx = null;
            this._editIdx = null;
            this._nb = null;
            this._rawMode = false;
            this._runningIdx = null;
            // 内核可用性:机器上有 python **且** 笔记本自己声明的是 Python。
            // 两者缺一就不显示运行入口 —— 给 R/JS 笔记本挂一个跑不了的 ▶
            // 比不给更糟,用户会以为插件坏了。
            this._canRun = isPythonAvailable() && isPythonNotebook(this._nb);
            this.element.classList.add("syfe-nb-tab");

            const name = basename(path);
            this.element.innerHTML = `
                <div class="syfe-nb__bar">
                    <span class="syfe-nb__kind">Notebook</span>
                    <span class="syfe-nb__meta"></span>
                    <span class="syfe-nb__kernel"></span>
                    <span class="syfe-nb__dirty" style="display:none;">●</span>
                    <span class="syfe-nb__actions">
                        <button class="b3-button b3-button--text" data-act="add-code" title="在当前单元格后插入代码单元格">+ 代码</button>
                        <button class="b3-button b3-button--text" data-act="add-md" title="在当前单元格后插入 Markdown 单元格">+ Markdown</button>
                        <span class="syfe-nb__runall" style="display:none;">
                            <button class="b3-button b3-button--text" data-act="run-all" title="按从上到下顺序执行全部代码单元格">▶ 运行全部</button>
                            <button class="b3-button b3-button--text" data-act="restart" title="清空内核的变量与导入,重新开始(不影响已保存的输出)">重启内核</button>
                        </span>
                        <button class="b3-button b3-button--text" data-act="save">保存</button>
                        <button class="b3-button b3-button--text" data-act="reload">重载</button>
                    </span>
                </div>
                <div class="syfe-nb__body"><div class="syfe-nb__loading">正在加载…</div></div>`;

            const barEl = this.element.querySelector(".syfe-nb__bar") as HTMLElement;
            const bodyEl = this.element.querySelector(".syfe-nb__body") as HTMLElement;
            const dirtyEl = this.element.querySelector(".syfe-nb__dirty") as HTMLElement;
            const metaEl = this.element.querySelector(".syfe-nb__meta") as HTMLElement;
            const self = this;

            // 字号/行高以 CSS 变量的形式挂在 Tab 根上。两态都用 monaco 实例后
            // 它们其实由 codeEditorOptions 直接传参决定了,但仍然挂出来 ——
            // 输出的 <pre>(stream/JSON)不是 monaco 渲染的,得靠同一份变量
            // 才能跟代码区视觉对齐。
            this.element.style.setProperty(
                "--syfe-nb-code-font-size", (_plugin.config?.fontSize ?? 13) + "px",
            );
            this.element.style.setProperty(
                "--syfe-nb-code-line-height", CODE_LINE_HEIGHT + "px",
            );

            const setDirty = (d: boolean) => {
                self._dirty = d;
                dirtyEl.style.display = d ? "" : "none";
                try {
                    self.parent?.updateTitle?.((d ? "● " : "") + name);
                } catch {
                    // 忽略
                }
            };

            // ===== 阅读态的只读 monaco 实例 =====
            // 以前阅读态是 monaco.editor.colorize() 吐的静态 <pre>,与编辑态是两条
            // 渲染路径,字体度量/内边距/背景/行号任一处对不上就会在切换时"跳"。
            // 现在两态都用 monaco,差异从"两套渲染"降级为"一个 readOnly 开关"。

            if (!self._roEditors) self._roEditors = new Map();

            // 销毁某格的只读实例
            const disposeRO = (idx: number) => {
                const rec = self._roEditors?.get(idx);
                if (!rec) return;
                self._roEditors?.delete(idx);
                try {
                    rec.editor.dispose();
                } catch {
                    // 忽略
                }
                try {
                    rec.model.dispose();
                } catch {
                    // 忽略
                }
            };

            // 销毁全部只读实例(render 重建 DOM / 单元格结构变化 / Tab 关闭时都要走)
            const disposeAllRO = () => {
                if (!self._roEditors) return;
                for (const idx of Array.from(self._roEditors.keys())) disposeRO(idx);
            };

            // 为第 idx 格创建只读实例。已在编辑态的那格跳过。
            const mountRO = (idx: number) => {
                if (!self._nb || !self._roEditors) return;
                const cell = self._nb.cells[idx];
                if (!cell || cell.cell_type === "markdown") return;
                if (self._editIdx === idx) return;
                const host = bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
                if (!host) return;
                // 已有且代码没变 → 复用,避免重复 tokenize(重绘时很贵)
                const exist = self._roEditors.get(idx);
                const text = getSourceText(cell);
                if (exist && exist.model.getValue() === text) return;
                disposeRO(idx);
                const model = monaco.editor.createModel(text, notebookLang(self._nb));
                const editor = monaco.editor.create(host, codeEditorOptions(_plugin.config, true));
                editor.setModel(model);
                host.classList.add("syfe-nb__src--ro");
                editor.onDidContentSizeChange(() => fitEditorHeight(host, editor));
                fitEditorHeight(host, editor);
                self._roEditors.set(idx, {editor, model});
            };

            // 视口懒加载:几百个单元格时不能一次建几百个 monaco 实例
            // (每个都是一整套 DOM + tokenize)。用 IntersectionObserver 只为
            // 滚进视口(带 400px 余量)的单元格建实例,离开视口则销毁,
            // 这样内存与实例数都被压到跟"当前看得到多少格"同量级。
            const RO_MARGIN = 400;
            const setupROObserver = () => {
                if (typeof IntersectionObserver === "undefined") {
                    // 老环境没有 IO:退化成全部创建(小笔记本可接受)
                    return false;
                }
                try {
                    self._roObserver?.disconnect();
                } catch {
                    // 忽略
                }
                const io = new IntersectionObserver((entries) => {
                    for (const en of entries) {
                        const el = en.target as HTMLElement;
                        const idx = Number(el.dataset.src);
                        if (!Number.isInteger(idx)) continue;
                        if (en.isIntersecting) mountRO(idx);
                        else disposeRO(idx);
                    }
                }, {root: bodyEl, rootMargin: `${RO_MARGIN}px 0px`});
                self._roObserver = io;
                return true;
            };

            // 重建后重新挂观察 + 补一次 mount(IO 首帧是异步的,
            // 不主动 mount 的话首屏会短暂显示空白)
            const refreshRO = () => {
                const hasIO = setupROObserver();
                bodyEl.querySelectorAll<HTMLElement>("[data-src]").forEach(el => {
                    self._roObserver?.observe(el);
                    if (!hasIO) {
                        const idx = Number(el.dataset.src);
                        if (Number.isInteger(idx)) mountRO(idx);
                    }
                });
            };

            // 提交就地编辑并把该格恢复成阅读视图(静默,不触发整表重绘)。
            //
            // 返回被提交的单元格索引,没在编辑则返回 null。
            //
            // **恢复只读实例必须在这里做**,不能只交给调用方:退出编辑要把编辑
            // 容器清空(否则只读实例建在带 .syfe-nb__celledit 的宿主上),清空之后
            // 如果没人重挂只读实例,那一格就是一个空 div —— 表现为「保存时正在
            // 编辑的单元格白屏」。save()/withCells()/load() 都走这个函数,
            // 谁漏一步都是白屏,所以收口在这里。
            const commitCellEditorSilent = (restore = true): number | null => {
                if (self._editIdx === null || self._editIdx === undefined) return null;
                const idx = self._editIdx;
                const cell = self._nb?.cells[idx];
                if (cell && self._editEditor) setSourceText(cell, self._editEditor.getValue());
                try {
                    self._editEditor?.dispose();
                } catch {
                    // 忽略
                }
                try {
                    self._editModel?.dispose();
                } catch {
                    // 忽略
                }
                self._editEditor = null;
                self._editModel = null;
                self._editIdx = null;
                // 编辑实例 dispose 不会把 host 上的 class 清干净,不清会让只读
                // 实例建在带 .syfe-nb__celledit 的容器上,样式互相污染。
                const host = bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
                if (host) {
                    host.classList.remove("syfe-nb__celledit");
                    host.innerHTML = "";
                    // 重挂只读实例。markdown 格这里什么都不做(它显示的是 Vditor
                    // 视图,不是 monaco),它的视图恢复交给 restoreMarkdownView。
                    // restore=false 用于调用方紧接着就要整表重建的场合(render/load),
                    // 那时再挂一次纯属浪费。
                    if (restore && cell && cell.cell_type !== "markdown") mountRO(idx);
                }
                return idx;
            };

            // markdown 格退出编辑时把 Vditor 渲染视图放回去
            const restoreMarkdownView = (idx: number) => {
                const cell = self._nb?.cells[idx];
                if (!cell || cell.cell_type !== "markdown") return;
                const view = bodyEl.querySelector(`[data-mdview="${idx}"]`) as HTMLDivElement | null;
                if (view) {
                    view.style.display = "";
                    try {
                        const isDark = getCurrentMode() === 1;
                        Vditor.preview(view, getSourceText(cell), {
                            mode: isDark ? "dark" : "light",
                            cdn: VDITOR_CDN,
                            theme: {current: isDark ? "dark" : "light", path: `${VDITOR_CDN}/dist/css/content-theme`},
                        });
                    } catch {
                        view.innerHTML = `<pre>${escapeHTML(getSourceText(cell))}</pre>`;
                    }
                }
                const mh = bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
                if (mh) mh.style.display = "none";
            };

            // 提交并恢复单元格的渲染视图。
            // **只重挂这一格,不走 render() 全量重绘** —— 全量重绘会连带 dispose
            // 所有只读实例、重跑全部 Vditor 预览,滚动位置和其他格的实例生命周期
            // 都被搅乱(几十格的笔记本会明显卡一下)。
            const commitCellEditor = () => {
                const idx = commitCellEditorSilent();
                if (idx === null) return;
                restoreMarkdownView(idx);
            };

            const markChanged = () => setDirty(true);

            // 顶部元信息
            const renderMeta = () => {
                // 运行相关入口的显隐统一在这里收口,避免散落在 render/load 两处
                const runAll = barEl.querySelector(".syfe-nb__runall") as HTMLElement | null;
                if (runAll) runAll.style.display = self._canRun ? "" : "none";
                if (!self._canRun) {
                    renderKernelState("stopped");
                    return;
                }
                if (!self._nb) {
                    metaEl.textContent = "原始 JSON";
                    return;
                }
                const kernel = self._nb.metadata?.kernelspec?.display_name || self._nb.metadata?.language_info?.display_name || "";
                const lang = self._nb.metadata?.language_info?.name || "";
                metaEl.textContent = `${lang ? lang + (kernel ? " · " + kernel : "") : kernel} · ${self._nb.cells.length} 格`;
            };

// 渲染单元格列表(scrollTop 保持:局部重绘不跳动)
   const render = () => {
        // restore=false:紧接着就要 innerHTML 整体重建,宿主节点会被换掉,
        // 这里重挂的只读实例下一秒就被 dispose,不如省掉。
    commitCellEditorSilent(false);
                if (!self._nb) {
                    renderRawMode();
                    return;
                }
                const st = bodyEl.scrollTop;
                const cells = self._nb.cells;
                // innerHTML 整体重建会连宿主节点一起换掉,先前的只读实例
                // 全部失去挂载点 —— 必须先 dispose,否则每次重绘都漏一批
                // monaco 实例(编辑器本身不会因为 DOM 被移除而自毁)。
                disposeAllRO();
                bodyEl.innerHTML = cells.length === 0
                    ? `<div class="syfe-nb__empty">空笔记本,用顶部按钮添加单元格</div>`
                    : cells.map((cell, i) => {
                        const srcBody = cell.cell_type === "markdown"
                            ? `<div class="syfe-nb__mdview" data-mdview="${i}" title="双击编辑源码"></div><div class="syfe-nb__src" data-src="${i}" style="display:none;"></div>`
                            // 代码格的源码区是**空容器**,内容由只读 monaco 实例填。
                            // 故意不放 <pre> 兜底:没有实例时(懒加载未命中)留空即可,
                            // 放一份静态文本反而会在实例挂上来的一瞬替换闪烁。
                            : `<div class="syfe-nb__src" data-src="${i}" title="点击编辑"></div>`;
                        const outs = cell.cell_type === "code"
                            ? `<div class="syfe-nb__outs">${renderOutputsHTML(cell)}</div>`
                            : "";
                        const exec = cell.cell_type === "code" && cell.execution_count != null
                            ? `<span class="syfe-nb__exec">[${cell.execution_count}]</span>` : "";
                        const toggle = cell.cell_type === "code" ? "MD" : "⌨";
                        // 运行按钮:只给代码单元格、且内核可用时才出现
                        const running = self._runningIdx === i;
                        const runBtn = (cell.cell_type === "code" && self._canRun)
                            ? `<span class="syfe-nb__cellbtn syfe-nb__cellbtn--run${running ? " syfe-nb__cellbtn--busy" : ""}" data-act="run" data-idx="${i}" title="${running ? "执行中…" : "运行此单元格(Shift+Enter)"}">${running ? "◌" : "▶"}</span>`
                            : "";
                        return `
                        <div class="syfe-nb__cell syfe-nb__cell--${escapeHTML(cell.cell_type)}${self._activeIdx === i ? " syfe-nb__cell--active" : ""}${running ? " syfe-nb__cell--running" : ""}" data-idx="${i}">
                            <div class="syfe-nb__cellbar">
                                <span class="syfe-nb__badge">${cellBadge(cell)}</span>${exec}
                                <span class="fn__flex-1"></span>
                                ${runBtn}
                                <span class="syfe-nb__cellbtn" data-act="up" data-idx="${i}" title="上移">↑</span>
                                <span class="syfe-nb__cellbtn" data-act="down" data-idx="${i}" title="下移">↓</span>
                                <span class="syfe-nb__cellbtn" data-act="type" data-idx="${i}" title="切换为 ${toggle === "MD" ? "Markdown" : "代码"}">${toggle}</span>
                                <span class="syfe-nb__cellbtn" data-act="edit" data-idx="${i}" title="编辑源码">✎</span>
                                <span class="syfe-nb__cellbtn syfe-nb__cellbtn--del" data-act="del" data-idx="${i}" title="删除单元格">×</span>
                            </div>
                            ${srcBody}${outs}
                        </div>`;
                    }).join("");
                bodyEl.scrollTop = st;
                renderMeta();

                // 异步增强:md 渲染 + 代码区只读实例
                if (!self._nb) return;
                const isDark = getCurrentMode() === 1;
                cells.forEach((cell, i) => {
                    if (cell.cell_type === "markdown") {
                        const view = bodyEl.querySelector(`[data-mdview="${i}"]`) as HTMLDivElement | null;
                        if (view) {
                            try {
                                Vditor.preview(view, getSourceText(cell), {
                                    mode: isDark ? "dark" : "light",
                                    cdn: VDITOR_CDN,
                                    theme: {current: isDark ? "dark" : "light", path: `${VDITOR_CDN}/dist/css/content-theme`},
                                });
                            } catch (e) {
                                view.innerHTML = `<pre>${escapeHTML(getSourceText(cell))}</pre>`;
                            }
                        }
                    }
                });
                // 代码格:挂只读 monaco(视口内才建,见 refreshRO)
                refreshRO();
                // 输出里的 markdown 输出同样渲染
                bodyEl.querySelectorAll<HTMLElement>("[data-md]").forEach(el => {
                    const md = decodeURIComponent(el.dataset.md || "");
                    if (md) {
                        try {
                            Vditor.preview(el as HTMLDivElement, md, {
                                mode: isDark ? "dark" : "light",
                                cdn: VDITOR_CDN,
                                theme: {current: isDark ? "dark" : "light", path: `${VDITOR_CDN}/dist/css/content-theme`},
                            });
                        } catch {
                            el.innerHTML = `<pre>${escapeHTML(md)}</pre>`;
                        }
                    }
                });
            };

            // 就地编辑某单元格(Monaco)
            const openCellEditor = (idx: number) => {
                if (!self._nb) return;
                const cell = self._nb.cells[idx];
                if (!cell) return;
                if (self._editIdx === idx) return;
                commitCellEditor();
                const host = bodyEl.querySelector(`[data-src="${idx}"]`) as HTMLElement | null;
                if (!host) return;
                // 这一格即将变成可编辑实例,先把它上面的只读实例拆掉 ——
                // 同一块 DOM 上不能同时挂两个 monaco 实例。
                disposeRO(idx);
                const mdView = bodyEl.querySelector(`[data-mdview="${idx}"]`) as HTMLElement | null;
                if (mdView) mdView.style.display = "none";
                host.style.display = "";
                host.classList.remove("syfe-nb__src--ro");
                host.innerHTML = "";
                const lang = cell.cell_type === "markdown" ? "markdown" : notebookLang(self._nb);
                const model = monaco.editor.createModel(getSourceText(cell), lang);
                host.classList.add("syfe-nb__celledit");
                // 与阅读态共用同一份选项(见 codeEditorOptions),只差 readOnly。
                // 两态字号/行高/padding/行号/换行天然一致,切换时不会跳。
                const editor = monaco.editor.create(host, {
                    ...codeEditorOptions(_plugin.config, false),
                    model,
                });
                editor.onDidContentSizeChange(() => fitEditorHeight(host, editor));
                fitEditorHeight(host, editor);
                // 有内容改动即标脏;失焦(点击其他位置)自动提交。Monaco 会吞 Escape 等按键,
                // Esc 提交由 document 捕获阶段的 _escHandler 兜底。
                editor.onDidChangeModelContent(() => markChanged());
                editor.onDidBlurEditorWidget(() => {
                    if (self._editIdx === idx) commitCellEditor();
                });
                // Shift+Enter = 运行本格(Jupyter 习惯)。
                // 用 addAction 而不是挂 DOM 事件:monaco 会吞掉编辑器内的按键冒泡,
                // 只有走 Keybinding 才能拿到。
                editor.addAction({
                    id: "syfe-nb-run-cell",
                    label: "运行此单元格",
                    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
                    run: () => {
                        // 先把内容落回 cell 再跑,否则执行的是上一版代码
                        if (self._editIdx === idx && self._editEditor) {
                            setSourceText(cell, self._editEditor.getValue());
                            markChanged();
                        }
                        commitCellEditorSilent();
                        void runCell(idx);
                    },
                });
                editor.focus();
                self._editIdx = idx;
                self._editEditor = editor;
                self._editModel = model;
                self._activeIdx = idx;
                bodyEl.querySelectorAll(".syfe-nb__cell--active").forEach(el => el.classList.remove("syfe-nb__cell--active"));
                bodyEl.querySelector(`.syfe-nb__cell[data-idx="${idx}"]`)?.classList.add("syfe-nb__cell--active");
            };

// 结构操作(先静默提交正在编辑的单元格)
            const withCells = (fn: (cells: NbCell[]) => void) => {
         if (!self._nb) return;
       // 紧接着就是 render(),不用重挂只读实例
   commitCellEditorSilent(false);
                fn(self._nb.cells);
                markChanged();
                render();
            };

            const addCell = (type: "code" | "markdown") => {
                withCells(cells => {
                    const at = self._activeIdx != null && self._activeIdx >= 0 && self._activeIdx < cells.length
                        ? self._activeIdx + 1 : cells.length;
                    const withId = cells.some(c => c.id) || (self._nb?.nbformat_minor ?? 0) >= 5;
                    cells.splice(at, 0, makeCell(type, withId));
                    self._activeIdx = at;
                });
                // 新建后直接进入编辑
                if (self._activeIdx != null) openCellEditor(self._activeIdx);
            };

            const moveCell = (idx: number, delta: number) => {
                withCells(cells => {
                    const to = idx + delta;
                    if (to < 0 || to >= cells.length) return;
                    const [c] = cells.splice(idx, 1);
                    cells.splice(to, 0, c);
                    if (self._activeIdx === idx) self._activeIdx = to;
                });
            };

            const deleteCell = (idx: number) => {
                withCells(cells => {
                    cells.splice(idx, 1);
                    if (self._activeIdx === idx) self._activeIdx = null;
                });
            };

            const toggleCellType = (idx: number) => {
                withCells(cells => {
                    const cell = cells[idx];
                    if (!cell) return;
                    if (cell.cell_type === "code") {
                        cell.cell_type = "markdown";
                        delete cell.outputs;
                        delete cell.execution_count;
                    } else {
                        cell.cell_type = "code";
                        cell.outputs = [];
                        cell.execution_count = null;
                    }
                });
            };

            // ===== Python 内核:运行单元格 =====

            // 切换单元格上的运行态(只改这一格的 DOM,不整表重绘,
            // 否则正在编辑的单元格会被销毁、光标位置丢失)
            const setCellRunning = (idx: number, running: boolean) => {
                const cellEl = bodyEl.querySelector(`.syfe-nb__cell[data-idx="${idx}"]`);
                if (!cellEl) return;
                cellEl.classList.toggle("syfe-nb__cell--running", running);
                const btn = cellEl.querySelector('[data-act="run"]') as HTMLElement | null;
                if (btn) {
                    btn.textContent = running ? "◌" : "▶";
                    btn.setAttribute("title", running ? "执行中…" : "运行此单元格(Shift+Enter)");
                    btn.classList.toggle("syfe-nb__cellbtn--busy", running);
                }
            };

            /**
             * 只重绘第 idx 格的输出区 + 执行序号,其余 DOM 一概不动。
             *
             * 为什么值得单独写一个:执行完如果走 render(),会 dispose 全部只读
             * monaco 实例、重跑一遍所有 Vditor 预览 —— 有 Python LSP 在跑时
             * 那个代价更明显(几十格的笔记本能卡到半秒),而且正在编辑的别格会被
             * 重建,光标位置与滚动位置一起丢。
             */
            const refreshCellOutputs = (idx: number) => {
                if (!self._nb) return;
                const cell = self._nb.cells[idx];
                if (!cell) return;
                const cellEl = bodyEl.querySelector(`.syfe-nb__cell[data-idx="${idx}"]`);
                if (!cellEl) {
                    render();
                    return;
                }
                // 输出区
                const outsEl = cellEl.querySelector(".syfe-nb__outs") as HTMLElement | null;
                if (outsEl) {
                    outsEl.innerHTML = renderOutputsHTML(cell);
                    // 输出里可能有 markdown(富输出),补一次渲染
                    const isDark = getCurrentMode() === 1;
                    outsEl.querySelectorAll<HTMLElement>("[data-md]").forEach(el => {
                        const md = decodeURIComponent(el.dataset.md || "");
                        if (!md) return;
                        try {
                            Vditor.preview(el as HTMLDivElement, md, {
                                mode: isDark ? "dark" : "light",
                                cdn: VDITOR_CDN,
                                theme: {current: isDark ? "dark" : "light", path: `${VDITOR_CDN}/dist/css/content-theme`},
                            });
                        } catch {
                            el.innerHTML = `<pre>${escapeHTML(md)}</pre>`;
                        }
                    });
                }
                // [n] 序号:原来没有结果时是空占位,现在才第一次出现
                const bar = cellEl.querySelector(".syfe-nb__cellbar") as HTMLElement | null;
                if (bar) {
                    const old = bar.querySelector(".syfe-nb__exec");
                    if (cell.execution_count != null) {
                        if (old) old.textContent = `[${cell.execution_count}]`;
                        else {
                            const span = document.createElement("span");
                            span.className = "syfe-nb__exec";
                            span.textContent = `[${cell.execution_count}]`;
                            bar.insertBefore(span, bar.querySelector(".fn__flex-1"));
                        }
                    } else if (old) {
                        old.remove();
                    }
                }
            };

            // 反映内核状态到工具栏(启动中/就绪/不可用)
            const renderKernelState = (status: KernelStatus, detail?: string) => {
                const badge = barEl.querySelector(".syfe-nb__kernel") as HTMLElement | null;
                if (!badge) return;
                if (status === "ready") {
                    badge.textContent = "内核就绪";
                    badge.className = "syfe-nb__kernel syfe-nb__kernel--ready";
                    badge.title = detail || "持久 Python 内核已就绪,变量在单元格之间保持";
                } else if (status === "starting") {
                    badge.textContent = "内核启动中…";
                    badge.className = "syfe-nb__kernel syfe-nb__kernel--busy";
                    badge.title = "正在拉起 Python 内核进程";
                } else if (status === "error") {
                    badge.textContent = "内核不可用";
                    badge.className = "syfe-nb__kernel syfe-nb__kernel--error";
                    badge.title = detail || "无法启动 Python 内核,请确认 python 在 PATH 中";
                } else {
                    badge.textContent = "";
                    badge.className = "syfe-nb__kernel";
                }
            };

            /** 执行第 idx 个代码单元格,结果写回 cell.outputs / execution_count */
            const runCell = async (idx: number) => {
                if (!self._canRun || self._rawMode) return;
                const cell = self._nb?.cells[idx];
                if (!cell || cell.cell_type !== "code") return;
                // 正在跑一格时:再点就是「中断」(Windows 上中断 = 杀进程+重放历史)
                if (self._runningIdx !== null && self._runningIdx !== undefined) {
                    if (self._runningIdx === idx) {
                        await interruptKernel();
                    }
                    return;
                }
                // 先把这格的编辑内容提交回 cell,否则跑的是旧代码
                if (self._editIdx === idx && self._editEditor) {
                    setSourceText(cell, self._editEditor.getValue());
                }
                const code = getSourceText(cell);
                if (!code.trim()) {
                    showMessage("空单元格,没有可执行的代码", 2000, "info");
                    return;
                }
                const kernel = getPythonKernel();
                if (!kernel) {
                    showMessage("未找到 Python 内核,请确认 python 在 PATH 中", 5000, "error");
                    return;
                }
                self._runningIdx = idx;
                self._activeIdx = idx;
                setCellRunning(idx, true);
                // 立刻标脏:即使执行失败,输出也已经变了
                markChanged();
                try {
                    const outcome = await kernel.execute(code);
                    if (!outcome) {
                        cell.outputs = [{
                            output_type: "error", ename: "KernelError",
                            evalue: "内核未响应", traceback: ["内核启动失败或已被关闭"],
                        }];
                        cell.execution_count = null;
                    } else {
                        cell.outputs = outcomeToOutputs(outcome);
                        cell.execution_count = outcome.executionCount;
                    }
                } catch (e) {
                    cell.outputs = [{
                        output_type: "error", ename: "PluginError",
                        evalue: String(e), traceback: [String(e)],
                    }];
                } finally {
                    self._runningIdx = null;
                    setCellRunning(idx, false);
                    markChanged();
                    // 只重绘这一格的输出区 —— 走 render() 会 dispose 全部只读
                    // monaco 实例、重跑一遍 Vditor,几十格的笔记本能明显卡一下,
                    // 而且正在编辑的别格也会被重建(光标/滚动位置丢失)。
                    refreshCellOutputs(idx);
                }
            };

            const runAllCells = async () => {
                if (!self._canRun || self._rawMode) return;
                const cells = self._nb?.cells || [];
                for (let i = 0; i < cells.length; i++) {
                    if (cells[i].cell_type !== "code") continue;
                    const code = getSourceText(cells[i]);
                    if (!code.trim()) continue;
                    await runCell(i);
                    // 整表重绘后 cells 引用会变(下一次 render 重建了 DOM 但
                    // 数据对象还是同一个),这里每次都重新取,避免索引失效
                    if (self._runningIdx !== null) return; // 被中断,停下
                }
            };

            const restartKernel = async () => {
                const kernel = getPythonKernel();
                if (!kernel) {
                    showMessage("未找到 Python 内核", 3000, "error");
                    return;
                }
                const ok = await kernel.reset();
                showMessage(ok ? "内核已重启,变量与导入已清空" : "内核重启失败", 3000, ok ? "info" : "error");
            };

            const interruptKernel = async () => {
                const kernel = getPythonKernel();
                const idx = self._runningIdx;
                if (!kernel || idx === null || idx === undefined) return;
                await kernel.interrupt();
                self._runningIdx = null;
                setCellRunning(idx, false);
                showMessage("已中断(内核会重建并重放之前执行过的代码)", 3000, "info");
                // 只补这一格的输出区(中断会把正在跑的那格标成错误输出)
                refreshCellOutputs(idx);
            };

            // 加载文件
            const load = async () => {
                // md 单元格的预览走 Vditor.preview → 内部要读全局 window.Lute。
                // 思源是懒加载它自己的 lute 的,开起来的第一个页签很可能赶上还没就位;
                // 而且必须保证 vditor 那份(缺 SetTabs)不会顶上来 —— 详见 utils/lute-guard。
                await ensureSiyuanLute();
                // 重载会换掉整批宿主节点,先把只读实例与观察器收掉
                try {
                    self._roObserver?.disconnect();
                    self._roObserver = null;
                } catch {
                    // 忽略
                }
                disposeAllRO();
                bodyEl.innerHTML = `<div class="syfe-nb__loading">正在加载…</div>`;
                try {
                    const text = await readTextFile(path);
                    let nb: Notebook | null = null;
                    let parseError = "";
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed && Array.isArray(parsed.cells) && Number(parsed.nbformat) >= 4) {
                            nb = parsed as Notebook;
                        } else if (parsed && Array.isArray(parsed?.worksheets)) {
                            parseError = "检测到旧版 nbformat 3 笔记本,暂不支持,请用 Jupyter 转换为 nbformat 4";
                        } else {
                            parseError = "不是有效的 nbformat 4 笔记本";
                        }
                    } catch (e) {
                        parseError = `JSON 解析失败: ${e}`;
                    }
                    if (nb) {
                        self._nb = nb;
                        self._rawMode = false;
                        // 语言信息在文件里,加载完才能判断能不能跑
                        self._canRun = isPythonAvailable() && isPythonNotebook(nb);
                        render();
                    } else {
                        // 兜底:原始 JSON 编辑
                        self._nb = null;
                        self._rawText = text;
                        self._rawMode = true;
                        renderRawMode(parseError);
                    }
                } catch (e) {
                    bodyEl.innerHTML = `<div class="syfe-nb__loading">读取失败: ${escapeHTML(String(e))}</div>`;
                }
            };

            // 原始 JSON 兜底编辑(解析失败 / nbformat 3)
            const renderRawMode = (err?: string) => {
                // 没有单元格就没有可运行的东西。重载时必须一并清掉 ——
                // 否则「Python 笔记本 → 保存成坏 JSON → 重载」之后,工具栏上
                // 会留着一个点了必然无反应(甚至报空单元格)的「运行全部」。
                self._canRun = false;
                renderMeta();
                // 切到 raw 模式 = 上一批单元格的宿主节点全被换掉,
                // 只读实例与观察器必须先收掉,否则它们的宿主已不存在,
                // IO 也还在 observe 着一批脱离文档的节点。
                try {
                    self._roObserver?.disconnect();
                    self._roObserver = null;
                } catch {
                    // 忽略
                }
                disposeAllRO();
                bodyEl.innerHTML = `
                    ${err ? `<div class="syfe-nb__banner">${escapeHTML(err)} — 已切换为原始 JSON 编辑,可修复后保存</div>` : ""}
                    <div class="syfe-nb__raw"></div>`;
                const host = bodyEl.querySelector(".syfe-nb__raw") as HTMLElement;
                const model = monaco.editor.createModel(self._rawText ?? "", "json");
                const editor = monaco.editor.create(host, {
                    model,
                    theme: monacoTheme(),
                    automaticLayout: true,
                    minimap: {enabled: true},
                    scrollBeyondLastLine: false,
                    fontSize: _plugin.config?.fontSize ?? 13,
                });
                model.onDidChangeContent(() => {
                    self._rawText = editor.getValue();
                    markChanged();
                });
                // 记录引用供保存/销毁使用
                self._editEditor = editor;
                self._editModel = model;
            };

const save = async () => {
      if (self._saving) return;
      self._saving = true;
     try {
      if (self._rawMode) {
                await writeFile(path, self._rawText ?? "");
   } else {
        if (!self._nb) return;
   // 保存**不退出编辑态**。直接把当前编辑内容落到数据模型再写盘,
        // 不走 commitCellEditorSilent —— 那会把用户正在编辑的那格换成只读视图,
      // 光标与滚动位置一起丢,想接着改还得再点一次。
      // 注意这里只能动 source,不能碰 _editEditor(编辑器还得留着给用户继续敲)。
   if (self._editIdx !== null && self._editIdx !== undefined) {
    const cell = self._nb.cells[self._editIdx];
         if (cell && self._editEditor) setSourceText(cell, self._editEditor.getValue());
          }
            await writeFile(path, JSON.stringify(self._nb, null, 1));
        }
        setDirty(false);
        showMessage("已保存", 2000, "info");
    } catch (e) {
        showMessage(`保存失败: ${e}`, 5000, "error");
    } finally {
        self._saving = false;
    }
};

            const reload = () => {
                if (self._dirty) {
                    confirm("未保存的修改", "重载会丢弃当前修改,确定重载吗?", () => {
                        setDirty(false);
                        commitCellEditor();
                        void load();
                    }, () => {});
                    return;
                }
                void load();
            };

            // 交互:工具栏 + 单元格按钮(事件委托在 body 上)
            bodyEl.addEventListener("click", (e: MouseEvent) => {
                const actEl = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
                if (actEl) {
                    const act = actEl.dataset.act!;
                    const idx = actEl.dataset.idx !== undefined ? Number(actEl.dataset.idx) : null;
                    if (act === "up" && idx !== null) moveCell(idx, -1);
                    else if (act === "down" && idx !== null) moveCell(idx, 1);
                    else if (act === "del" && idx !== null) deleteCell(idx);
                    else if (act === "type" && idx !== null) toggleCellType(idx);
                    else if (act === "edit" && idx !== null) openCellEditor(idx);
                    else if (act === "run" && idx !== null) void runCell(idx);
                    return;
                }
                // 点击单元格:选中;点代码源码区进入编辑
                const cellEl = (e.target as HTMLElement).closest(".syfe-nb__cell") as HTMLElement | null;
                if (!cellEl) {
                    commitCellEditor();
                    return;
                }
                const idx = Number(cellEl.dataset.idx);
                if (e.target instanceof HTMLElement && e.target.closest(`[data-src="${idx}"]`) && self._nb?.cells[idx]?.cell_type !== "markdown") {
                    openCellEditor(idx);
                    return;
                }
                if (self._activeIdx !== idx) {
                    self._activeIdx = idx;
                    bodyEl.querySelectorAll(".syfe-nb__cell--active").forEach(el => el.classList.remove("syfe-nb__cell--active"));
                    cellEl.classList.add("syfe-nb__cell--active");
                }
            });
            // Markdown 单元格双击进入编辑
            bodyEl.addEventListener("dblclick", (e: MouseEvent) => {
                const cellEl = (e.target as HTMLElement).closest(".syfe-nb__cell") as HTMLElement | null;
                if (!cellEl || !self._nb) return;
                const idx = Number(cellEl.dataset.idx);
                if (self._nb.cells[idx]?.cell_type === "markdown") openCellEditor(idx);
            });

            barEl.addEventListener("click", (e: MouseEvent) => {
                const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
                if (!btn) return;
                const act = btn.dataset.act;
                if (act === "add-code") addCell("code");
                else if (act === "add-md") addCell("markdown");
                else if (act === "run-all") void runAllCells();
                else if (act === "restart") void restartKernel();
                else if (act === "save") void save();
                else if (act === "reload") reload();
            });

            // Ctrl/Cmd + S 保存;Esc 提交就地编辑
            this._onKey = (e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
                    e.preventDefault();
                    e.stopPropagation();
                    void save();
                } else if (e.key === "Escape" && self._editIdx !== null) {
                    e.stopPropagation();
                    commitCellEditor();
                }
            };
            this.element.addEventListener("keydown", this._onKey);
            // Monaco 会吞掉编辑器内按键的冒泡,Esc 提交挂在 document 捕获阶段兜底
            this._escHandler = (e: KeyboardEvent) => {
                if (e.key === "Escape" && self._editIdx !== null && self.element.contains(e.target as Node)) {
                    commitCellEditor();
                }
            };
            document.addEventListener("keydown", this._escHandler, true);

            // 启动内核并订阅状态 → 工具栏徽章。
            // 必须在 load() 判定完语言之后再调:init 阶段 self._nb 还是 null,
            // 那时算出来的 _canRun 恒为 false。
            const ensureKernel = () => {
                if (!self._canRun) return;
                const k = getPythonKernel();
                if (!k) {
                    renderKernelState("error", "未找到 Python 内核");
                    return;
                }
                if (!self._statusUnsub) {
                    // 退订函数存到实例上,destroy 时必须调用,
                    // 否则关掉 Tab 后内核状态变化还会往已销毁的 DOM 上写
                    self._statusUnsub = k.onStatus((status, detail) => renderKernelState(status, detail));
                    renderKernelState("starting");
                }
                void k.start().then((ok) => {
                    // 徽章的 tooltip 显示具体解释器路径,方便用户确认用的是哪个 python
                    const detail = ok
                        ? (k.kernelInfo ? `${k.kernelInfo.executable}(Python ${k.kernelInfo.version})` : "")
                        : "启动失败";
                    renderKernelState(ok ? "ready" : "error", detail);
                });
            };

            void load().then(ensureKernel);
        },
        resize(this: NotebookTabInstance) {
            // Monaco automaticLayout 自适应,无需处理
        },
        beforeDestroy(this: NotebookTabInstance): boolean | void {
            if (!this._dirty || this._closing) return;
            const self = this;
            const doClose = () => {
                self._closing = true;
                try {
                    self.parent?.close?.();
                } catch {
                    // 已关闭
                }
            };
            confirm("未保存的修改", `「${basename(this._path || "")}」有未保存的修改,是否保存?`, () => {
                const doSave = async () => {
                    if (self._rawMode) {
                        await writeFile(self._path || "", self._rawText ?? "");
                    } else if (self._nb) {
                        if (self._editIdx !== null && self._editEditor) {
                            setSourceText(self._nb.cells[self._editIdx!], self._editEditor.getValue());
                        }
                        await writeFile(self._path || "", JSON.stringify(self._nb, null, 1));
                    }
                };
                doSave().then(doClose).catch(() => showMessage("保存失败", 3000, "error"));
            }, doClose);
            return false; // 阻止本次关闭,等待用户选择
        },
        destroy(this: NotebookTabInstance) {
            // 退订内核状态,否则关掉 Tab 后内核事件还会往已销毁的 DOM 上写
            if (this._statusUnsub) {
                try {
                    this._statusUnsub();
                } catch {
                    // 忽略
                }
                this._statusUnsub = undefined;
            }
            if (this._onKey) {
                this.element.removeEventListener("keydown", this._onKey);
                this._onKey = undefined;
            }
            if (this._escHandler) {
                document.removeEventListener("keydown", this._escHandler, true);
                this._escHandler = undefined;
            }
            // 阅读态的只读实例必须在这里全部 dispose —— 关掉 Tab 后 DOM 节点会
            // 脱离文档,但 monaco 实例不会自毁,漏掉就是每个 notebook Tab 泄漏
            // 几十个编辑器(连同它们的 model 与 tokenize 结果)。
            if (this._roObserver) {
                try {
                    this._roObserver.disconnect();
                } catch {
                    // 忽略
                }
                this._roObserver = null;
            }
            if (this._roEditors) {
                for (const [, rec] of this._roEditors) {
                    try {
                        rec.editor.dispose();
                    } catch {
                        // 忽略
                    }
                    try {
                        rec.model.dispose();
                    } catch {
                        // 忽略
                    }
                }
                this._roEditors.clear();
                this._roEditors = undefined;
            }
            try {
                this._editEditor?.dispose();
            } catch {
                // 忽略
            }
            try {
                this._editModel?.dispose();
            } catch {
                // 忽略
            }
            this._editEditor = null;
            this._editModel = null;
            this._nb = null;
            this._runningIdx = null;
            // 注:内核进程**不**在这里关 —— 它是全局单例,多个 notebook Tab
            // 可能同时开着(而且用户可能正在跑长任务)。它由插件卸载时
            // index.ts 的 disposePythonKernel() 统一收尾。
        },
    };
}
