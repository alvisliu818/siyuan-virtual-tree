import {openTab, confirm, showMessage} from "siyuan";
import Vditor from "vditor";
import {MARKDOWN_TAB_TYPE, getImageMime} from "../constants";
import {basename, dirname, sepFor, isSiyuanPath} from "../utils/path";
import {EditorConfig} from "../types";
import {createEditor, getCurrentMode} from "../editor/monaco";
import {getModel, saveModel, markDirty, isDirty, consumePendingReveal} from "../editor/model-manager";
import {readBinaryFile} from "../api/file";
import {createBacklinkPanel, BacklinkPanel} from "../components/backlink-panel";
import {highlightMatches, clearFindHighlights, setCurrentFindHit} from "../components/markdown-find";

// Markdown 编辑 Tab:对齐 Obsidian 的三态编辑器
// - live    实时预览:Vditor ir(即时渲染),光标所在行显示源码、其余实时渲染,可编辑
// - source  源码模式:Monaco,纯 Markdown 文本(带语法高亮),可编辑
// - reading 阅读模式:Vditor wysiwyg 完整渲染 + disabled(),只读
// 内容统一经 model-manager 的 Monaco model 管理(脏标记/保存/多 Tab 共享)。
// 注意:只有 live 模式会把 Vditor 内容同步回 model(reading 不可编辑,source 直接编辑 model)。

// 编辑模式
export type MarkdownMode = "live" | "source" | "reading";

// 插件接口
export interface IPluginForMarkdownTab {
    app: any;
    name: string;
    config: EditorConfig;
    getOpenedTab(): { [key: string]: any[] };
}

// Tab 实例上附加的字段
interface MarkdownTabInstance {
    element: HTMLElement;
    data: { path?: string; mode?: MarkdownMode };
    parent?: { updateTitle?: (t: string) => void; close?: () => void; headElement?: HTMLElement };
    _path?: string;
    _mode?: MarkdownMode;
    _vditor?: Vditor;
    _editor?: import("monaco-editor").editor.IStandaloneCodeEditor;
    _model?: import("monaco-editor").editor.ITextModel;
    _dirtyDot?: HTMLElement;
    _contentEl?: HTMLElement;
    _saving?: boolean;
    _closing?: boolean;
    _themeObserver?: MutationObserver;
    _keydownHandler?: (e: KeyboardEvent) => void;
    _backlink?: BacklinkPanel;
    // ===== 文档内查找(渲染态)状态 =====
    _findHits?: HTMLElement[];   // 当前所有命中元素(按文档顺序)
    _findIndex?: number;         // 当前项下标,-1 = 无命中
    _findQuery?: string;         // 上次搜索词(用于判断是否需要重新高亮)
    _findCase?: boolean;         // 是否区分大小写
    // 图片本地化渲染(相对路径 → blob URL)
    _imgObserver?: MutationObserver;
    _imgDebounce?: number;
    _blobUrlCache?: Map<string, string>;   // 解析后的绝对路径 → blob URL
    _blobUrlReverse?: Map<string, string>; // blob URL → 原始 markdown 路径(还原用)
}

// Vditor 静态资源目录(webpack 已复制 vditor/dist 到插件目录)
// 导出供 Notebook Tab 复用(md 单元格渲染 / 样式)
export const VDITOR_CDN = "/plugins/siyuan-file-editor/vditor";

// ===== window.Lute 保护 =====
// vditor 首次初始化会注入自己的 lute.min.js 并覆写 window.Lute——同名全局,但 vditor 的
// 构建缺 SetTabs/SpinBlockDOM 等思源方法,覆写后思源原生文档的渲染全部报错。
// vditor 只在构造后的 setLute 里读一次全局,之后持有自己的实例;因此把覆写窗口压到最小:
// 创建前换上 vditor 构建(首次由脚本自己覆写),vditor.lute 一就绪立刻还原思源的 Lute。
let syLute: any = null;   // 思源原生 Lute(首次创建 vditor 前快照)
let vdLute: any = null;   // vditor 的 Lute 构建(首次脚本加载后捕获)
let luteRestoreTimer: any = null;

function armVditorLute(vditor: Vditor): void {
    try {
        if (!syLute) syLute = (window as any).Lute ?? null;
        if (vdLute) (window as any).Lute = vdLute;
        if (luteRestoreTimer) clearInterval(luteRestoreTimer);
        luteRestoreTimer = setInterval(() => {
            if ((vditor as any).lute) disarmVditorLute();
        }, 3);
    } catch {
        // 忽略:保护失败不影响编辑器本身
    }
}

function disarmVditorLute(): void {
    if (luteRestoreTimer) {
        clearInterval(luteRestoreTimer);
        luteRestoreTimer = null;
    }
    try {
        if (!vdLute && (window as any).Lute !== syLute) vdLute = (window as any).Lute;
        if (syLute) (window as any).Lute = syLute;
    } catch {
        // 忽略
    }
}

// 超过此大小(字节)的 Markdown 强制源码模式(Vditor 大内容性能差)
const WYSIWYG_MAX_SIZE = 512 * 1024;

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 注入 Vditor 主样式(幂等;导出供 Notebook Tab 复用)
export function ensureVditorCSS(): void {
    if (document.querySelector(`link[data-syfe-vditor]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${VDITOR_CDN}/dist/index.css`;
    link.setAttribute("data-syfe-vditor", "1");
    document.head.appendChild(link);
}

// ===== 图片本地化渲染 =====
// WYSIWYG 模式下 <img src="xxx.png"> 由浏览器按思源页面 URL 解析,相对路径必然 404。
// 方案:读取图片文件生成 blob URL 替换 src 显示;
// 同时覆写 vditor.lute.VditorDOM2Md,在 Markdown 序列化前把 blob URL 还原为原始路径,
// 保证 getValue()/撤销栈/复制/保存输出干净(已实测:data-* 属性不进 Markdown)。

// 解析 markdown 中的图片地址;返回 null 表示无需处理(已是可用 URL)
function resolveAssetSrc(mdPath: string, src: string): string | null {
    if (!src) return null;
    // 网络/内联/锚点地址不动
    if (/^(https?:|data:|blob:|file:|mailto:|\/\/|#)/i.test(src)) return null;
    // 思源虚拟路径 /data/... 原样
    if (isSiyuanPath(src)) return src;
    // 系统绝对路径(Windows 盘符/UNC/POSIX)原样,交给读取层判断
    if (/^[A-Za-z]:[\\/]/.test(src) || src.startsWith("\\\\") || src.startsWith("/")) return src;
    // 相对路径:基于 md 文件目录解析 ./ 与 ../
    const baseDir = dirname(mdPath);
    if (!baseDir) return null;
    const sep = sepFor(baseDir);
    const parts = baseDir.split(/[\\/]+/).filter(Boolean);
    for (const seg of src.split(/[\\/]+/)) {
        if (!seg || seg === ".") continue;
        if (seg === "..") {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    let result = parts.join(sep);
    if (baseDir.startsWith("/") && !result.startsWith("/")) result = "/" + result;
    return result;
}

// 扫描内容区,将未处理的相对路径 img 替换为 blob URL
function processImages(tab: MarkdownTabInstance): void {
    processMdImages(tab);
    processHtmlInlineImages(tab);
}

// Markdown 语法图片(![](path)):Lute 已渲染为真实 <img>,仅需替换 src
function processMdImages(tab: MarkdownTabInstance): void {
    const contentEl = tab._contentEl;
    if (!contentEl) return;
    const imgs = contentEl.querySelectorAll<HTMLImageElement>("img:not([data-syfe-img]):not([data-syfe-himg])");
    if (imgs.length === 0) return;
    const mdPath = tab._path!;
    imgs.forEach(img => {
        img.setAttribute("data-syfe-img", "1");
        const raw = img.getAttribute("src") || "";
        const resolved = resolveAssetSrc(mdPath, raw);
        if (resolved === null) return;
        loadBlobUrl(tab, resolved, raw).then(url => {
            // Tab 可能已销毁或 img 已被 Vditor 重渲染移除
            if (url && img.isConnected) img.src = url;
        });
    });
}

// 内联 HTML 图片(<img src="..." style="zoom:50%">):Lute 在 WYSIWYG 中渲染为
// <code data-type="html-inline"> 源码文本而非真实图片。
// 此处解析标签内容,将 code 替换为真实渲染的 img(原始标签存入 data-syfe-html,
// 序列化时由 patchLuteDOM2Md 还原为 code,保证文档无损往返)。
function processHtmlInlineImages(tab: MarkdownTabInstance): void {
    const contentEl = tab._contentEl;
    if (!contentEl) return;
    const codes = contentEl.querySelectorAll<HTMLElement>('code[data-type="html-inline"]:not([data-syfe-himg])');
    if (codes.length === 0) return;
    const mdPath = tab._path!;
    Array.from(codes).forEach(code => {
        // Lute 生成的 code 内容首部带 ZWSP(U+200B),trim() 不会移除,必须显式剔除
        const raw = (code.textContent || "").replace(/\u200B/g, "").trim();
        // 仅处理完整的单个 <img ...> 标签
        if (!/^<img\b/i.test(raw) || !/>$/.test(raw) || /<\/img>/i.test(raw)) return;
        // 解析标签属性(离屏容器不会触发资源加载)
        const tmp = document.createElement("div");
        tmp.innerHTML = raw;
        const parsed = tmp.querySelector("img");
        if (!parsed) return;
        // 光标位于该 code 内时跳过:正在编辑原始 HTML,替换节点会破坏选区
        const sel = window.getSelection();
        if (sel && sel.anchorNode && code.contains(sel.anchorNode)) return;
        const src = parsed.getAttribute("src") || "";
        const resolved = resolveAssetSrc(mdPath, src);
        if (resolved === null) return; // 网络/内联图片不处理(浏览器可直接加载)
        code.setAttribute("data-syfe-himg", "1");
        loadBlobUrl(tab, resolved, src).then(url => {
            if (!url || !code.isConnected) return;
            const img = document.createElement("img");
            // 复制原标签属性(alt/style/width/height 等);
            // 过滤 on* 事件处理器(防 XSS)与 srcset(相对路径会失效)
            for (const attr of Array.from(parsed.attributes)) {
                if (/^on/i.test(attr.name) || attr.name === "srcset") continue;
                img.setAttribute(attr.name, attr.value);
            }
            img.setAttribute("src", url);
            img.setAttribute("data-syfe-himg", "1");
            img.setAttribute("data-syfe-html", raw); // 原始标签,序列化还原用
            code.replaceWith(img);
        });
    });
}

// 读取图片文件并生成 blob URL(带缓存;失败时尝试 URL 解码后再读)
async function loadBlobUrl(tab: MarkdownTabInstance, resolved: string, raw: string): Promise<string | null> {
    const cache = tab._blobUrlCache!;
    const cached = cache.get(resolved);
    if (cached) return cached;
    let buf: ArrayBuffer | null = null;
    try {
        buf = await readBinaryFile(resolved);
    } catch {
        try {
            buf = await readBinaryFile(decodeURIComponent(resolved));
        } catch {
            return null;
        }
    }
    const url = URL.createObjectURL(new Blob([buf], {type: getImageMime(resolved)}));
    cache.set(resolved, url);
    tab._blobUrlReverse!.set(url, raw);
    return url;
}

// 覆写 Vditor 实例的 Lute 序列化方法:把 innerHTML 中的 blob URL 还原为原始 markdown 路径
function patchLuteDOM2Md(tab: MarkdownTabInstance, vditor: Vditor): void {
    const lute = (vditor as any).lute;
    if (!lute || lute.__syfePatched) return;
    const orig = lute.VditorDOM2Md.bind(lute);
    lute.VditorDOM2Md = (html: string) => {
        // 1) 内联 HTML 图片还原:渲染用的 <img data-syfe-html="..."> →
        //    <code data-type="html-inline">原标签</code>(实测:无 ZWSP 也能无损往返)
        html = html.replace(/<img\b[^>]*\sdata-syfe-html="([^"]*)"[^>]*>/g, (_m, esc: string) => {
            return `<code data-type="html-inline">${esc}</code>`;
        });
        // 2) Markdown 语法图片还原:blob URL → 原始路径
        const reverse = tab._blobUrlReverse!;
        if (reverse.size > 0) {
            reverse.forEach((raw, url) => {
                html = html.split(url).join(raw);
            });
        }
        return orig(html);
    };
    lute.__syfePatched = true;
}

// 安全网:对 getValue() 结果再做一次 blob URL 字符串还原。
// patchLuteDOM2Md 依赖 vditor.lute(Vditor 异步 init 后才赋值),
// 万一 patch 未生效(时序问题),此处兜底防止 blob URL 被写入文件。
function restoreBlobRefs(tab: MarkdownTabInstance, value: string): string {
    const reverse = tab._blobUrlReverse;
    if (!reverse || reverse.size === 0) return value;
    reverse.forEach((raw, url) => {
        value = value.split(url).join(raw);
    });
    return value;
}

// 统一取值入口:getValue + blob 还原兜底
function getVditorValue(tab: MarkdownTabInstance): string {
    const v = tab._vditor?.getValue() ?? "";
    return restoreBlobRefs(tab, v);
}

// 打开 Markdown Tab(同文件去重,聚焦已有 Tab;mode 指定初始模式)
export function openMarkdownTab(plugin: IPluginForMarkdownTab, path: string, mode?: MarkdownMode, opts?: { position?: "right" | "bottom" }): void {
    const opened = plugin.getOpenedTab()[MARKDOWN_TAB_TYPE] || [];
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
            id: plugin.name + MARKDOWN_TAB_TYPE,
            icon: "iconMarkdown",
            title: basename(path),
            data: {path, mode},
        },
        position: opts?.position,
    } as any);
}

// 创建 addTab 配置(捕获 plugin 闭包)
export function createMarkdownTabConfig(plugin: IPluginForMarkdownTab) {
    return {
        type: MARKDOWN_TAB_TYPE,
        init(this: MarkdownTabInstance) {
            const path = this.data?.path;
            if (!path) {
                this.element.innerHTML = `<div class="syfe-empty">未指定文件路径</div>`;
                return;
            }
            this._path = path;
            // 兼容旧值:旧版"所见即所得"(wysiwyg)已并入"实时预览"(live)
            const rawMode = (this.data?.mode || plugin.config.markdownDefaultMode || "live") as string;
            this._mode = (rawMode === "wysiwyg" ? "live" : rawMode) as MarkdownMode;
            this.element.classList.add("syfe-md-tab", "fn__flex-column");

            this.element.innerHTML = `
                <div class="syfe-md">
                    <div class="syfe-md__bar">
                        <span class="syfe-md__dirty" style="display:none;">●</span>
                        <span class="syfe-md__path">${escapeHTML(path)}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__findbtn" title="在文档内查找(Ctrl+F)">
                            <svg class="syfe-md__findicon"><use xlink:href="#iconSearch"></use></svg>
                        </button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="live">实时预览</button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="source">源码</button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="reading">阅读</button>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__save">保存</button>
                    </div>
                    <div class="syfe-md__find" style="display:none;">
                        <input class="b3-text-field syfe-md__findinput" placeholder="查找内容" />
                        <span class="syfe-md__findcount">0/0</span>
                        <button class="b3-button b3-button--small syfe-md__findcase" title="区分大小写">Aa</button>
                        <button class="b3-button b3-button--small syfe-md__findprev" title="上一个(Shift+Enter)">↑</button>
                        <button class="b3-button b3-button--small syfe-md__findnext" title="下一个(Enter)">↓</button>
                        <button class="b3-button b3-button--small syfe-md__findclose" title="关闭(Esc)">✕</button>
                    </div>
                    <div class="syfe-md__backlink"></div>
                    <div class="syfe-md__content fn__flex-1"></div>
                </div>`;

            this._contentEl = this.element.querySelector(".syfe-md__content") as HTMLElement;
            this._dirtyDot = this.element.querySelector(".syfe-md__dirty") as HTMLElement;
            const self = this;

            // 反向链接面板(默认收起,展开时懒扫描)
            this._backlink = createBacklinkPanel(plugin as any, path);
            (this.element.querySelector(".syfe-md__backlink") as HTMLElement).appendChild(this._backlink.el);

            // 图片本地化渲染:缓存 + DOM 观察器(捕获 Vditor 每次重渲染插入的 img)
            // 注意:观察器在 Vditor 初始渲染完成后才启动(enterWysiwyg 的 after 回调),
            // 初始渲染期间替换节点会破坏 Vditor 分块粘贴的选区(addRange 报错)
            this._blobUrlCache = new Map();
            this._blobUrlReverse = new Map();
            this._imgObserver = new MutationObserver(() => {
                // 防抖:用户粘贴大块内容时 Vditor 分块渲染,等 DOM 稳定后再处理
                if (self._imgDebounce) window.clearTimeout(self._imgDebounce);
                self._imgDebounce = window.setTimeout(() => processImages(self), 150);
            });

            const updateDirtyUI = (dirty: boolean) => {
                if (self._dirtyDot) self._dirtyDot.style.display = dirty ? "" : "none";
                const title = (dirty ? "● " : "") + basename(path);
                try {
                    self.parent?.updateTitle?.(title);
                } catch {
                    // 忽略
                }
            };

            // 保存:WYSIWYG 模式先同步 Vditor 内容到 model,再统一落盘
            const save = async () => {
                if (self._saving) return;
                self._saving = true;
                try {
                    // live 模式先把 Vditor 内容同步回 model(含 blob 还原兜底);
                    // source 模式 Monaco 直接改 model、reading 模式不可编辑,都无需同步
                    if (self._mode === "live" && self._vditor && self._model) {
                        // 取值走 lute.dom2md(读 DOM),先清掉查找高亮避免多余 span 参与序列化
                        if (self._findHits && self._findHits.length > 0) {
                            clearFindHighlights(self._contentEl);
                            self._findHits = [];
                            self._findIndex = -1;
                        }
                        self._model.setValue(getVditorValue(self));
                    }
                    await saveModel(path);
                    updateDirtyUI(false);
                    showMessage("已保存", 2000, "info");
                } catch (e) {
                    showMessage(`保存失败: ${e}`, 5000, "error");
                } finally {
                    self._saving = false;
                }
            };
            (self as any).save = save;

            // 模式按钮高亮
            const syncModeButtons = () => {
                self.element.querySelectorAll<HTMLElement>(".syfe-md__modebtn").forEach(btn => {
                    btn.classList.toggle("b3-button--primary", btn.dataset.mode === self._mode);
                });
            };

            // ===== 文档内查找(实时预览 / 阅读模式)=====
            // 源码模式直接用 Monaco 自带的查找(见 findbtn 点击分支)
            const findBar = self.element.querySelector(".syfe-md__find") as HTMLElement;
            const findInput = self.element.querySelector(".syfe-md__findinput") as HTMLInputElement;
            const findCount = self.element.querySelector(".syfe-md__findcount") as HTMLElement;

            const closeFind = () => {
                findBar.style.display = "none";
                self._findHits = [];
                self._findIndex = -1;
                clearFindHighlights(self._contentEl);
            };

            // 在渲染态里查一次并高亮;dir=1 下一个 / -1 上一个
            const runFind = (dir: 1 | -1, fromStart = false) => {
                if (self._mode === "source") {
                    // 交给 Monaco
                    try {
                        self._editor?.focus();
                        const action = self._editor?.getAction?.("actions.find");
                        if (action) {
                            void action.run();
                            return;
                        }
                    } catch {
                        // 忽略
                    }
                }
                const q = findInput.value;
                if (!q.trim()) {
                    closeFind();
                    return;
                }
                // 首次搜索(或查询词变了)重新高亮
                if (fromStart || self._findQuery !== q) {
                    self._findHits = highlightMatches(self._contentEl, q, self._findCase === true);
                    self._findQuery = q;
                    self._findIndex = self._findHits.length > 0 ? 0 : -1;
                }
                const hits = self._findHits || [];
                if (hits.length === 0) {
                    findCount.textContent = "0/0";
                    self._findIndex = -1;
                    return;
                }
                self._findIndex = setCurrentFindHit(
                    hits,
                    fromStart ? 0 : (self._findIndex ?? 0) + dir,
                );
                findCount.textContent = `${(self._findIndex ?? 0) + 1}/${hits.length}`;
            };

            const openFind = () => {
                if (self._mode === "source") {
                    try {
                        self._editor?.focus();
                        const action = self._editor?.getAction?.("actions.find");
                        if (action) {
                            void action.run();
                            return;
                        }
                    } catch {
                        // 忽略
                    }
                }
                findBar.style.display = "";
                findInput.focus();
                findInput.select();
            };

            // 查找栏交互(事件委托)
            findBar.addEventListener("click", (e: MouseEvent) => {
                const t = e.target as HTMLElement;
                if (t.closest(".syfe-md__findnext")) runFind(1);
                else if (t.closest(".syfe-md__findprev")) runFind(-1);
                else if (t.closest(".syfe-md__findcase")) {
                    self._findCase = self._findCase !== true;
                    (self.element.querySelector(".syfe-md__findcase") as HTMLElement)
                        .classList.toggle("b3-button--primary", self._findCase === true);
                    runFind(1, true);   // 切换后强制重新高亮
                } else if (t.closest(".syfe-md__findclose")) {
                    closeFind();
                    self._contentEl?.focus();
                }
            });
            findInput.addEventListener("input", () => runFind(1, true));
            findInput.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    runFind(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeFind();
                    self._contentEl?.focus();
                }
            });
            (self.element.querySelector(".syfe-md__findbtn") as HTMLElement)
                .addEventListener("click", () => {
                    if (findBar.style.display === "none") openFind();
                    else closeFind();
                });

            // Ctrl+F:源码模式留给 Monaco,渲染态打开查找栏
            self.element.addEventListener("keydown", (e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
                    if (self._mode === "source") return; // Monaco 自己处理
                    e.preventDefault();
                    openFind();
                }
            });

            // 切换到源码模式;reveal 指定跳转行号(搜索结果),未指定则尝试消费待跳转请求
            const enterSource = (reveal?: number) => {
                closeFind();   // 离开渲染态:关掉查找栏并清高亮
                // reading 模式不可编辑,内容以 model 为准;live 模式需先从 Vditor 同步最新内容
                const content = self._mode === "live" ? getVditorValue(self) : (self._model?.getValue() ?? "");
                destroyVditor(self);
                self._contentEl?.classList.remove("syfe-md__content--reading");
                if (self._imgDebounce) {
                    window.clearTimeout(self._imgDebounce);
                    self._imgDebounce = undefined;
                }
                self._imgObserver?.disconnect();
                if (self._model) {
                    self._model.setValue(content);
                }
                self._mode = "source";
                syncModeButtons();
                const editor = createEditor(self._contentEl!, self._model!, path, plugin.config, save);
                self._editor = editor;
                editor.onDidChangeModelContent(() => {
                    markDirty(path, true);
                    updateDirtyUI(true);
                });
                // 搜索结果跳转
                const revealLine = reveal !== undefined ? reveal : consumePendingReveal(path);
                if (revealLine !== null) {
                    setTimeout(() => {
                        editor.revealLineInCenter(revealLine);
                        editor.setPosition({lineNumber: revealLine, column: 1});
                    }, 50);
                }
            };

            // 创建 Vditor 实例。两种形态共用一套配置:
            // - live    : mode="ir" 即时渲染(光标所在行显示源码、其余实时渲染)+ 工具栏,可编辑
            // - reading : mode="wysiwyg" 完整渲染 + 无工具栏 + disabled(),只读
            const enterVditor = (vdMode: "ir" | "wysiwyg", readOnly: boolean) => {
                closeFind();   // 离开源码态:关掉查找栏并清高亮
                destroyMonaco(self);
                // 同一容器上可能已有 Vditor(live ⇄ reading 切换),必须先销毁
                destroyVditor(self);
                self._mode = readOnly ? "reading" : "live";
                syncModeButtons();
                // 阅读模式打标记,便于样式隐藏编辑态 UI
                self._contentEl!.classList.toggle("syfe-md__content--reading", readOnly);
                // 初始渲染期间不处理图片(见 init 中观察器说明),先断开
                self._imgObserver?.disconnect();
                const isDark = getCurrentMode() === 1;
                ensureVditorCSS();
                const vditor = new Vditor(self._contentEl!, {
                    mode: vdMode,
                    value: self._model?.getValue() ?? "",
                    cdn: VDITOR_CDN,
                    lang: "zh_CN",
                    theme: isDark ? "dark" : "classic",
                    height: "100%",
                    // 阅读模式不显示工具栏
                    toolbar: readOnly ? [] : [
                        "headings", "bold", "italic", "strike", "|",
                        "list", "ordered-list", "check", "quote", "|",
                        "code", "inline-code", "link", "table", "|",
                        "undo", "redo",
                    ],
                    cache: {enable: false},
                    placeholder: "输入 Markdown 内容...",
                    // 默认 800ms:撤销栈提交防抖期间 Ctrl+Z 会被 vditor 吞掉
                    //(toolbar 热键分发 preventDefault 模拟点击 undo 按钮,按钮未启用时不执行撤销,
                    // 原生撤销也被 preventDefault 挡住)→ 打字后立刻撤销无响应。调短消除死区,
                    // 顺带让脏标记更及时。
                    undoDelay: 100,
                    preview: {
                        theme: {
                            current: isDark ? "dark" : "light",
                            path: `${VDITOR_CDN}/dist/css/content-theme`,
                        },
                    },
                    input: () => {
                        markDirty(path, true);
                        updateDirtyUI(true);
                    },
                    // 异步渲染完成后:补丁序列化方法 + 扫描初始图片 + 启动观察器
                    after: () => {
                        // vditor.lute 在异步 init 完成后才存在,必须在此 patch
                        // (构造函数返回时 lute 尚未赋值,立即 patch 会静默失败)
                        patchLuteDOM2Md(self, vditor);
                        // vditor 已持有自己的 lute 实例,立刻还原思源的 window.Lute
                        disarmVditorLute();
                        // 阅读模式:渲染完成后置为只读
                        if (readOnly) {
                            try {
                                vditor.disabled();
                            } catch {
                                // 忽略
                            }
                        }
                        processImages(self);
                        // 初始渲染完成,启动观察器捕获后续编辑插入的图片(阅读模式无编辑)
                        if (self._contentEl && !readOnly) {
                            self._imgObserver?.observe(self._contentEl, {childList: true, subtree: true});
                        }
                    },
                });
                self._vditor = vditor;
                // vditor 初始化会注入自己的 lute 脚本覆写 window.Lute:先武装保护,
                // vditor.lute 一就绪(轮询)或 after 回调时还原思源的 Lute
                armVditorLute(vditor);
                // 构造后立即尝试 patch(lute 可能已就绪;未就绪由 after 回调兜底)
                patchLuteDOM2Md(self, vditor);
                // 兜底扫描(after 可能早于图片 DOM 插入;观察器此时未启动需手动扫一次)
                setTimeout(() => processImages(self), 200);
            };

            // 实时预览(类 Obsidian Live Preview)
            const enterLive = () => enterVditor("ir", false);
            // 阅读模式(类 Obsidian Reading):完整渲染 + 只读
            const enterReading = () => enterVditor("wysiwyg", true);

            // 模式切换按钮
            this.element.querySelector<HTMLElement>(".syfe-md__bar")!.addEventListener("click", (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                if (target.closest(".syfe-md__save")) {
                    save();
                    return;
                }
                const btn = target.closest(".syfe-md__modebtn") as HTMLElement | null;
                if (!btn) return;
                const next = btn.dataset.mode as MarkdownMode;
                if (next === self._mode) return;
                if (next === "source") {
                    enterSource();
                } else if (next === "reading") {
                    // 阅读模式渲染 model,先把 live 的编辑内容同步回去,避免丢改动
                    if (self._mode === "live" && self._vditor && self._model) {
                        self._model.setValue(getVditorValue(self));
                    }
                    enterReading();
                } else {
                    enterLive();
                }
            });

            // Ctrl+S(WYSIWYG 模式下思源会拦截,需 capture 拦截;源码模式由 Monaco 内部处理)
            this._keydownHandler = (e: KeyboardEvent) => {
                if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
                if (!self.element.isConnected) return;
                const active = document.activeElement;
                if (active && self._contentEl?.contains(active)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    save();
                }
            };
            window.addEventListener("keydown", this._keydownHandler, true);

            // 主题跟随思源明暗模式(Vditor 动态切换;Monaco 由全局主题管理)
            this._themeObserver = new MutationObserver(() => {
                if ((self._mode === "live" || self._mode === "reading") && self._vditor) {
                    const isDark = getCurrentMode() === 1;
                    try {
                        self._vditor.setTheme(isDark ? "dark" : "classic", isDark ? "dark" : "light");
                    } catch {
                        // 忽略
                    }
                }
            });
            this._themeObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["data-theme"],
            });

            (async () => {
                try {
                    self._model = await getModel(path);
                } catch (e) {
                    self._contentEl!.innerHTML = `<div class="syfe-editor__error">加载失败: ${escapeHTML(String(e))}</div>`;
                    return;
                }
                updateDirtyUI(isDirty(path));

                // 初始模式:显式指定 > 待跳转行(强制源码) > 大文件强制源码 > 配置默认
                const revealLine = consumePendingReveal(path);
                let initialMode = self._mode;
                if (revealLine !== null) {
                    initialMode = "source";
                } else if ((self._model.getValue().length) > WYSIWYG_MAX_SIZE) {
                    initialMode = "source";
                    showMessage("文件较大,已使用源码模式打开", 3000, "info");
                }
                if (initialMode === "source") {
                    enterSource(revealLine ?? undefined);
                } else if (initialMode === "reading") {
                    enterReading();
                } else {
                    enterLive();
                }
                syncModeButtons();
            })();
        },
        beforeDestroy(this: MarkdownTabInstance): boolean | void {
            const path = this._path;
            if (!path || this._closing || !isDirty(path)) {
                return;
            }
            const self = this;
            confirm(
                "未保存的修改",
                `「${basename(path)}」有未保存的修改,是否保存?`,
                () => {
                    // 保存后关闭(仅 live 模式需把 Vditor 内容同步到 model)
                    if (self._mode === "live" && self._vditor && self._model) {
                        self._model.setValue(getVditorValue(self));
                    }
                    saveModel(path)
                        .then(() => {
                            self._closing = true;
                            try {
                                self.parent?.close?.();
                            } catch {
                                // 已关闭
                            }
                        })
                        .catch(() => showMessage("保存失败", 3000, "error"));
                },
                () => {
                    markDirty(path, false);
                    self._closing = true;
                    try {
                        self.parent?.close?.();
                    } catch {
                        // 已关闭
                    }
                },
            );
            return false; // 阻止本次关闭,等待用户选择
        },
        destroy(this: MarkdownTabInstance) {
            destroyVditor(this);
            destroyMonaco(this);
            this._themeObserver?.disconnect();
            this._themeObserver = undefined;
            this._backlink?.dispose();
            this._backlink = undefined;
            // 图片本地化渲染清理:断开观察器并释放所有 blob URL
            if (this._imgDebounce) {
                window.clearTimeout(this._imgDebounce);
                this._imgDebounce = undefined;
            }
            this._imgObserver?.disconnect();
            this._imgObserver = undefined;
            this._blobUrlCache?.forEach(url => {
                try {
                    URL.revokeObjectURL(url);
                } catch {
                    // 忽略
                }
            });
            this._blobUrlCache?.clear();
            this._blobUrlReverse?.clear();
            if (this._keydownHandler) {
                window.removeEventListener("keydown", this._keydownHandler, true);
                this._keydownHandler = undefined;
            }
        },
        resize(this: MarkdownTabInstance) {
            try {
                this._editor?.layout();
            } catch {
                // 忽略
            }
        },
    };
}

// 销毁 Vditor 实例并清空容器
function destroyVditor(tab: MarkdownTabInstance): void {
    if (tab._vditor) {
        try {
            tab._vditor.destroy();
        } catch {
            // 忽略
        }
        tab._vditor = undefined;
        // 若该实例还在初始化(轮询未触发),销毁时停止轮询并还原思源 Lute
        disarmVditorLute();
    }
    if (tab._contentEl) tab._contentEl.innerHTML = "";
}

// 销毁 Monaco 编辑器(不 dispose model:多 Tab 共享)
function destroyMonaco(tab: MarkdownTabInstance): void {
    if (tab._editor) {
        try {
            tab._editor.dispose();
        } catch {
            // 忽略
        }
        tab._editor = undefined;
    }
    if (tab._contentEl) tab._contentEl.innerHTML = "";
}
