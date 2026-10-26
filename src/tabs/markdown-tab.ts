import {openTab, confirm, showMessage} from "siyuan";
import Vditor from "vditor";
import {MARKDOWN_TAB_TYPE, getImageMime} from "../constants";
import {basename, dirname, sepFor, isSiyuanPath} from "../utils/path";
import {EditorConfig} from "../types";
import {createEditor, getCurrentMode} from "../editor/monaco";
import {getModel, saveModel, markDirty, isDirty, consumePendingReveal} from "../editor/model-manager";
import {readBinaryFile} from "../api/file";
import {nativeStat} from "../api/native-fs";
import {isBaiduPath} from "../utils/baidu-path";
import {createBacklinkPanel, BacklinkPanel} from "../components/backlink-panel";
import {renderPathSegments, showPathSwitchMenu, enableCrumbScroll} from "../components/path-crumbs";
import {applyFileTabHeadIconWhenReady} from "../utils/tab-icon";
import {guardUnsavedClose} from "../utils/close-guard";
import {showFileTreeMenu, findTreeRootEl, buildFileTreeActions, copyText} from "../components/file-tree";
import {enableHeadingCrumbs, flashHeading, scrollToTopOf, scrollParentOf, type HeadingCrumbsHandle, type HeadingCrumb} from "../components/md-heading-crumbs";
// 带位置的文件链接:标题锚点 / 行号(详见 utils/file-ref.ts)
import {buildFileRefMd, slugifyHeading, consumePendingRef, peekPendingRef, type FileRef} from "../utils/file-ref";
// 渲染态行号槽(实时预览/阅读),行级定位的块映射也在这里
import {installMdLineGutter, type MdLineGutterHandle} from "../editor/md-line-gutter";
import {openFileTab} from "./editor-tab";
import {wantsSplitOpen, pickTabOutsideActiveWnd} from "./split-open";
import {showVersionHistory} from "../version-control/version-ui";
import {highlightMatches, clearFindHighlights, setCurrentFindHit} from "../components/markdown-find";
// 剪贴板增强:阅读/实时预览态可连图一起复制,实时预览/源码态可粘贴图片文件落盘
import {installMarkdownClipboard, getVditorLute, type MdClipboardHandle} from "../editor/md-clipboard";
// vditor 与思源共用 window.Lute,且 vditor 那份缺 SetTabs —— 详见 utils/lute-guard 的说明
import {ensureSiyuanLute} from "../utils/lute-guard";

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
    // 标题面包屑(点某项就地滚动定位;语义同 siyuan-breadcrumb)
    _hcrumbsHandle?: HeadingCrumbsHandle;
    // 渲染态行号槽(实时预览/阅读),行级链接定位也靠它的块映射
    _gutterHandle?: MdLineGutterHandle;
    // 外部(链接点击)让已打开的页签直接定位到某个位置
    _applyFileRef?: (ref: FileRef) => void;
    // 剪贴板增强(阅读态连图复制 / 粘贴图片落盘)
    _clipboard?: MdClipboardHandle;
}

// Vditor 静态资源目录(webpack 已复制 vditor/dist 到插件目录)
// 导出供 Notebook Tab 复用(md 单元格渲染 / 样式)
//
// 插件名由 webpack DefinePlugin 注入(见 webpack.config.js),**不要写死**:
// 写死的话插件改名后这个目录就 404,vditor 的 CSS/JS 加载不到,
// markdown 编辑器会变成没有样式的裸 textarea,且不报错。
declare const __SYFE_PLUGIN_NAME__: string;
export const VDITOR_CDN = `/plugins/${__SYFE_PLUGIN_NAME__}/vditor`;

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

// 把跨行的 <img ...> 标签压成单行。
// 场景:Word/pandoc 导出的 md 属性分行写(<img src="media/x.png"\n style="..."/>),
// Lute 不认跨行的内联 HTML,图片直接显示成源码文本。加两道护栏防误伤:
// 标签最长 500 字符 + 至少含一个换行才处理(避免把代码块里的长示例一起吞)。
function normalizeMultilineImgs(md: string): string {
    return md.replace(/<img\b[^>]{0,500}>/gi, (tag) => {
        if (tag.indexOf("\n") < 0) return tag;
        return tag.replace(/\s*[\r\n]+\s*/g, " ");
    });
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

// 内联 HTML 图片(<img src="..." style="zoom:50%">):Lute 不渲染成真实图片,
// 源码节点有两种模式形态(实测 Lute 输出):
//   WYSIWYG(阅读): <code data-type="html-inline">源码</code>(data-type 在 code 上)
//   IR(实时预览):  <span data-type="html-inline" class="vditor-ir__node">
//                  <code class="vditor-ir__marker">源码</code></span>(data-type 在 span 上)
// 此处解析标签内容,把宿主节点(IR=整个 span,WYSIWYG=code)替换为真实渲染的 img
// (原始标签存入 data-syfe-html,序列化时由 patchLuteDOM2Md 按模式还原,保证无损往返)。
function processHtmlInlineImages(tab: MarkdownTabInstance): void {
    const contentEl = tab._contentEl;
    if (!contentEl) return;
    // 两种形态收敛为 {host: 待替换节点, code: 源码文本所在节点}
    const nodes: Array<{host: HTMLElement; code: HTMLElement}> = [];
    contentEl.querySelectorAll<HTMLElement>('span[data-type="html-inline"]:not([data-syfe-himg])')
        .forEach(span => {
            const code = span.querySelector(":scope > code.vditor-ir__marker");
            if (code) nodes.push({host: span, code: code as HTMLElement});
        });
    contentEl.querySelectorAll<HTMLElement>('code[data-type="html-inline"]:not([data-syfe-himg])')
        .forEach(code => nodes.push({host: code, code}));
    if (nodes.length === 0) return;
    const mdPath = tab._path!;
    nodes.forEach(({host, code}) => {
        // Lute 生成的 code 内容首部带 ZWSP(U+200B),trim() 不会移除,必须显式剔除
        const raw = (code.textContent || "").replace(/\u200B/g, "").trim();
        // 仅处理完整的单个 <img ...> 标签
        if (!/^<img\b/i.test(raw) || !/>$/.test(raw) || /<\/img>/i.test(raw)) return;
        // 解析标签属性(离屏容器不会触发资源加载)
        const tmp = document.createElement("div");
        tmp.innerHTML = raw;
        const parsed = tmp.querySelector("img");
        if (!parsed) return;
        // 光标位于该节点内时跳过:正在编辑原始 HTML,替换节点会破坏选区
        const sel = window.getSelection();
        if (sel && sel.anchorNode && host.contains(sel.anchorNode)) return;
        const src = parsed.getAttribute("src") || "";
        const resolved = resolveAssetSrc(mdPath, src);
        if (resolved === null) return; // 网络/内联图片不处理(浏览器可直接加载)
        host.setAttribute("data-syfe-himg", "1");
        loadBlobUrl(tab, resolved, src).then(url => {
            if (!url || !host.isConnected) return;
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
            host.replaceWith(img);
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

// 覆写 Vditor 实例的 Lute 序列化方法:把渲染用的 img 还原回 Lute 的源码节点形态。
// **两个方法都要补**:WYSIWYG(阅读)取值走 VditorDOM2Md,IR(实时预览)取值走
// VditorIRDOM2Md(vditor.ir.element.innerHTML)。不补 IR 侧的话,渲染态图片在
// 保存时会被 Lute 静默丢弃(实测 VditorIRDOM2Md 对裸 <img> 直接吞掉,标签整个消失)。
// 还原的目标结构随模式不同(与 Lute 各自的 DOM 生成形态一致,已实测无损往返):
//   WYSIWYG: <code data-type="html-inline">原标签</code>(无 ZWSP 也能往返)
//   IR:      <span data-type="html-inline" class="vditor-ir__node">
//            <code class="vditor-ir__marker">原标签</code></span>
function patchLuteDOM2Md(tab: MarkdownTabInstance, vditor: Vditor): void {
    // 注意:Vditor 4 的 lute 挂在 this.vditor.lute(实例内部的 IVditor),顶层 (.lute) 不存在。
    // 早先直接取 (vditor as any).lute 恒为 undefined,补丁等于没打 —— 表现为复制/导出里
    // 出现 blob URL。这里用 getVditorLute 兼容两处。
    const lute = getVditorLute(vditor);
    if (!lute || lute.__syfePatched) return;

    // 渲染用的 <img data-syfe-html="..."> → 对应模式的源码节点
    // (捕获组是 DOM 序列化转义后的原标签,引号已转 &quot;,不会截断)
    const wrap = (html: string, ir: boolean) =>
        html.replace(/<img\b[^>]*\sdata-syfe-html="([^"]*)"[^>]*>/g, (_m, esc: string) => ir
            ? `<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">${esc}</code></span>`
            : `<code data-type="html-inline">${esc}</code>`);

    const patch = (name: "VditorDOM2Md" | "VditorIRDOM2Md", ir: boolean) => {
        if (typeof lute[name] !== "function") return; // 构建/版本差异防御(思源构建已实测两者都在)
        const orig = lute[name].bind(lute);
        lute[name] = (html: string) => {
            html = wrap(html, ir);
            // Markdown 语法图片还原:blob URL → 原始路径
            const reverse = tab._blobUrlReverse!;
            if (reverse.size > 0) {
                reverse.forEach((raw, url) => {
                    html = html.split(url).join(raw);
                });
            }
            return orig(html);
        };
    };
    patch("VditorDOM2Md", false);
    patch("VditorIRDOM2Md", true);
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

// ===== 带位置的链接(文件「双链」)=====
// 复制侧:把「文件 + 当前标题/行号」写成可直接粘进思源的 Markdown 链接;
// 定位侧:打开时按锚点/行号落到对应位置。链接形态见 utils/file-ref.ts。

// 复制一条 Markdown 链接
function copyLinkMd(md: string, okMsg: string): void {
    if (!md) {
        showMessage("无法生成链接(取不到文件的绝对路径)", 3000, "error");
        return;
    }
    void copyText(md).then(
        ok => showMessage(ok ? okMsg : "复制失败", 2500, ok ? "info" : "error"),
    );
}

// 标题元素的纯文本(Vditor ir 模式标题会带源码标记 "# 一级标题")
function headingTextOf(el: HTMLElement): string {
    return (el.textContent || "").replace(/^#{1,6}\s*/, "").replace(/\s+/g, " ").trim();
}

// 在渲染区里按锚点找标题:slug 精确 → 原文 → slug 包含(兼容别的工具写的锚点)
function findHeadingByAnchor(content: HTMLElement | undefined, anchor: string): HTMLElement | null {
    if (!content || !anchor) return null;
    const heads = Array.from(content.querySelectorAll("h1,h2,h3,h4,h5,h6")) as HTMLElement[];
    if (heads.length === 0) return null;
    const want = slugifyHeading(anchor);
    const text = anchor.trim().toLowerCase();
    return heads.find(h => slugifyHeading(headingTextOf(h)) === want)
        || heads.find(h => headingTextOf(h).toLowerCase() === text)
        || heads.find(h => want.length > 0 && slugifyHeading(headingTextOf(h)).indexOf(want) >= 0)
        || null;
}

// 源码文本里按锚点找标题行号(1-based)
function headingLineOfAnchor(text: string, anchor: string): number | null {
    if (!text || !anchor) return null;
    const want = slugifyHeading(anchor);
    const lines = text.split("\n");
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fm = /^\s{0,3}(```|~~~)/.exec(line);
        if (fm) {
            fence = fence === null ? fm[1] : (fence === fm[1] ? null : fence);
            continue;
        }
        if (fence !== null) continue;
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (!m) continue;
        if (slugifyHeading(m[2]) === want) return i + 1;
    }
    return null;
}

// 把位置应用到已渲染的 Vditor 内容(标题锚点 / 行号)
function applyRefToVditor(tab: MarkdownTabInstance, ref: FileRef): void {
    const content = tab._contentEl;
    if (!content) return;
    let el: HTMLElement | null = null;
    if (ref.anchor) el = findHeadingByAnchor(content, ref.anchor);
    if (!el && ref.line) {
        // 行号:优先用行号槽的块映射(与槽位上显示的数字同一套规则,链接必然能落回同一处)
        el = tab._gutterHandle?.lineToBlock(ref.line) ?? null;
    }
    if (!el && ref.line) {
        // 槽位没就绪时的兜底:换算成该行所属的标题再定位(渲染态没有行概念)
        const text = tab._model?.getValue() ?? "";
        const lines = text.split("\n");
        const want = slugifyHeading(lines[Math.max(0, Math.min(lines.length, ref.line) - 1)] || "");
        el = want ? findHeadingByAnchor(content, want) : null;
        if (!el) {
            // 该行正好是标题行时上面能命中;否则退到该行之前最近的标题
            let best = "";
            let fence: string | null = null;
            for (let i = 0; i < Math.min(lines.length, ref.line); i++) {
                const line = lines[i];
                const fm = /^\s{0,3}(```|~~~)/.exec(line);
                if (fm) {
                    fence = fence === null ? fm[1] : (fence === fm[1] ? null : fence);
                    continue;
                }
                if (fence !== null) continue;
                const m = /^(#{1,6})\s+(.*)$/.exec(line);
                if (m) best = m[2].trim();
            }
            el = best ? findHeadingByAnchor(content, best) : null;
        }
    }
    if (!el) return;
    scrollToTopOf(el);
    flashHeading(el);
}

// 按当前模式应用位置(源码态走 Monaco 的行定位)
function applyFileRef(tab: MarkdownTabInstance, ref: FileRef): void {
    if (tab._mode === "source") {
        let line = ref.line ?? 0;
        if (!line && ref.anchor) line = headingLineOfAnchor(tab._model?.getValue() ?? "", ref.anchor) ?? 0;
        if (line > 0 && tab._editor) {
            // 刚 createEditor 时视图还没布局完,50ms 的单次 reveal 会静默丢失(实测),
            // 这里做两次兜底(幂等,重复 reveal 无副作用)
            const doReveal = (focus: boolean) => {
                const ed = tab._editor;
                if (!ed) return;
                ed.revealLineInCenter(line);
                ed.setPosition({lineNumber: line, column: 1});
                if (focus) ed.focus();
            };
            setTimeout(() => doReveal(true), 300);
            setTimeout(() => doReveal(false), 1100);
        }
        return;
    }
    // 渲染态可能还没渲染完(Vditor 异步),给几拍;
    // 纯行号链接等行号槽就绪再跳(块映射在槽里),锚点/混合则直接走标题匹配
    const tryAt = (left: number) => {
        if (ref.line && !ref.anchor && !tab._gutterHandle) {
            if (left > 0) {
                setTimeout(() => tryAt(left - 1), 150);
                return;
            }
        }
        const el = ref.anchor ? findHeadingByAnchor(tab._contentEl, ref.anchor) : null;
        if (el || left <= 0 || (ref.line && tab._gutterHandle)) {
            applyRefToVditor(tab, ref);
            return;
        }
        setTimeout(() => tryAt(left - 1), 150);
    };
    tryAt(8);
}

// 打开 Markdown Tab(同文件去重,聚焦已有 Tab;mode 指定初始模式)
export function openMarkdownTab(plugin: IPluginForMarkdownTab, rawPath: string, mode?: MarkdownMode, opts?: { position?: "right" | "bottom" }): void {
    // 统一正斜杠:入口(资源管理器/挂载配置/接管/反链)可能带反斜杠。不归一会
    // 同一文件两种 key 并存 —— Monaco URI 相同(Map key 不同)→ createModel 抛
    // "Cannot add model because it already exists",且页签复用检查也失效(实测)
    const path = (rawPath || "").replace(/\\/g, "/");
    const opened = plugin.getOpenedTab()[MARKDOWN_TAB_TYPE] || [];
    const matches = opened.filter((c: any) => c?.data?.path === path);
    if (matches.length) {
        // 分栏请求时优先聚焦「活动分屏之外」的已有页签(文档与文件已同屏,不堆页签);
        // 全在活动分屏(聚焦会盖住文档)且要求分栏 → 落到 openTab 新开分栏
        const elsewhere = wantsSplitOpen(opts) ? pickTabOutsideActiveWnd(matches) : null;
        if (!wantsSplitOpen(opts) || elsewhere) {
            const inst = (elsewhere || matches[0]) as any;
            const tab = inst?.parent;
            if (tab?.headElement) {
                (tab.headElement as HTMLElement).click();
            }
            // 链接里带了位置(标题锚点 / 行号)时,复用的页签也要跟着定位。
            // 页签还在初始化(_mode 未定 / Vditor 未渲染)时**不能**把位置消费掉 ——
            // 那会让位置凭空消失;留在队列里,由它自己的 after 回调消费。
            const ref = peekPendingRef(path);
            if (ref && typeof inst?._applyFileRef === "function" && inst._mode) {
                consumePendingRef(path);
                try {
                    inst._applyFileRef(ref);
                } catch {
                    // 定位失败不影响聚焦
                }
            }
            return;
        }
    }
    // 新开分栏:openNewTab 绕过思源 openFile 的复用分支(allModels.custom /
    // getUnInitTab 都无视 position),position 才能走到 wnd.split,见 tabs/split-open.ts
    openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + MARKDOWN_TAB_TYPE,
            icon: "iconMarkdown",
            title: basename(path),
            data: {path, mode},
        },
        position: opts?.position,
        openNewTab: wantsSplitOpen(opts) || undefined,
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
            // 定位用:虚拟文档树面板的「定位」按钮靠该属性识别当前打开的文件
            this.element.dataset.syfePath = path;
            // 兼容旧值:旧版"所见即所得"(wysiwyg)已并入"实时预览"(live)
            // 全局阅读模式(默认开):优先级高于"Markdown 默认模式",打开即只读渲染;
            // 显式指定 mode(如搜索跳转路径)时仍以显式值为准
            const rawMode = (this.data?.mode ||
                (plugin.config.globalReadingMode === true
                    ? "reading"
                    : (plugin.config.markdownDefaultMode || "live"))) as string;
            this._mode = (rawMode === "wysiwyg" ? "live" : rawMode) as MarkdownMode;
            this.element.classList.add("syfe-md-tab", "fn__flex-column");

            this.element.innerHTML = `
                <div class="syfe-md">
                    <div class="syfe-md__bar">
                        <span class="syfe-md__dirty" style="display:none;">●</span>
                        <span class="syfe-md__path syfe-md__crumbs syfe-crumbs-scroll">${renderPathSegments(path)}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__findbtn" title="在文档内查找(Ctrl+F)">
                            <svg class="syfe-md__findicon"><use xlink:href="#iconSearch"></use></svg>
                        </button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="live">实时预览</button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="source">源码</button>
                        <button class="b3-button b3-button--small syfe-md__modebtn" data-mode="reading">阅读</button>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__verbtn" title="历史版本(每次保存自动保留修改前内容)">历史版本</button>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__save">保存</button>
                        <button class="b3-button b3-button--small b3-button--outline syfe-md__morebtn" title="更多操作(与文件树右键菜单一致)">
                            <svg class="syfe-md__findicon"><use xlink:href="#iconMore"></use></svg>
                        </button>
                    </div>
                    <div class="syfe-md__hcrumbs syfe-crumbs-scroll" style="display:none;"></div>
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
            // 页签头图标 → 虚拟文件树同款(重试版:新建与会话恢复的页签都覆盖)
            applyFileTabHeadIconWhenReady(self, path, "iconMarkdown");

            // 标题面包屑:显示光标所在位置的 H1 › H2 › … 路径,点某项就地滚动定位。
            // 语义对齐 siyuan-breadcrumb(页内定位、不跳走、不进入聚焦);
            // 对纯 markdown 文件而言"标题"就是天然的层级路径。
            // 两种渲染引擎共用一套:Vditor 走 DOM 推导,Monaco 走文本推导。
            this._hcrumbsHandle = enableHeadingCrumbs({
                bar: this.element.querySelector(".syfe-md__hcrumbs") as HTMLElement,
                contentEl: () => self._contentEl ?? null,
                caretNode: () => {
                    const sel = window.getSelection();
                    return sel && sel.anchorNode ? sel.anchorNode : null;
                },
                isSource: () => self._mode === "source",
                sourceText: () => self._model?.getValue() ?? "",
                sourceLine: () => self._editor?.getPosition()?.lineNumber ?? 1,
                jump: (crumb) => {
                    if (crumb.element) {
                        // 顺序不能反:先把光标放进标题(面包屑路径随之延伸到这一级),
                        // 再手动滚 —— scrollIntoView 的 smooth 动画会被 Vditor 的
                        // 选区滚动同步抢回去(实测目标又被顶回视口外)
                        try {
                            const sel = window.getSelection();
                            if (sel) {
                                const r = document.createRange();
                                r.selectNodeContents(crumb.element);
                                r.collapse(false);
                                sel.removeAllRanges();
                                sel.addRange(r);
                            }
                        } catch {
                            // 选区失败不影响定位本身
                        }
                        scrollToTopOf(crumb.element);
                        flashHeading(crumb.element);
                    } else if (crumb.line && self._editor) {
                        self._editor.revealLineNearTop(crumb.line);
                        self._editor.setPosition({lineNumber: crumb.line, column: 1});
                        self._editor.focus();
                    }
                },
                // 点文档根图标:回到文档顶部,光标也放回去(面包屑随之回到根)
                // 右键面包屑:复制「能定位到这里」的 Markdown 链接
                // 源码态用行号(?line=),渲染态用标题锚点(#slug)
                copyLink: (crumb: HeadingCrumb | null) => {
                    const p = self._path ?? path;
                    if (!crumb) {
                        copyLinkMd(buildFileRefMd({path: p}), "文件链接已复制,可粘贴到思源文档");
                        return;
                    }
                    const ref: FileRef = (self._mode === "source" && crumb.line)
                        ? {path: p, line: crumb.line, label: crumb.text}
                        : {path: p, anchor: slugifyHeading(crumb.text), label: crumb.text};
                    copyLinkMd(buildFileRefMd(ref), "标题链接已复制,粘贴到思源文档点击可定位");
                },
                jumpDocStart: () => {
                    const content = self._contentEl;
                    if (!content) return;
                    if (self._mode === "source" && self._editor) {
                        self._editor.revealLineNearTop(1);
                        self._editor.setPosition({lineNumber: 1, column: 1});
                        self._editor.focus();
                        return;
                    }
                    // 滚动容器在 content 内部:ir 模式是 div.vditor-reset(wysiwyg/sv 是 pre.vditor-reset)。
                    // 注意 pre.vditor-reset 与 div.vditor-reset 并存,pre 那个高度为 0 不可滚,
                    // 所以候选里挑第一个真正可滚动的,而不是第一个匹配的。
                    // 滚动容器是 content 内的 .vditor-reset(ir/sv 模式),但它与另一个同名的
                    // 空元素(pre/div 不定,高度 0)并存,且哪个可滚会随渲染时机变化,
                    // 所以枚举全部 .vditor-reset,挑第一个真正可滚动的。
                    const resets = Array.from(content.querySelectorAll(".vditor-reset")) as HTMLElement[];
                    const sc = resets.find(el => el.scrollHeight > el.clientHeight + 1) ??
                        scrollParentOf((content.querySelector("h1,h2,h3,h4,h5,h6,p,div") as HTMLElement) || content);
                    if (sc) {
                        sc.scrollTop = 0;
                    } else {
                        // 兜底:content 自身或其可滚祖先也一并归零
                        content.scrollTop = 0;
                        const outer = scrollParentOf(content);
                        if (outer) outer.scrollTop = 0;
                    }
                    const first = content.querySelector("h1,h2,h3,h4,h5,h6") || content;
                    try {
                        const sel = window.getSelection();
                        if (sel) {
                            const r = document.createRange();
                            r.setStart(first, 0);
                            r.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(r);
                        }
                    } catch {
                        // 选区失败不影响回到顶部本身
                    }
                },
            });

            // 顶栏面包屑(与编辑器 Tab 同款):点某段路径列出同级文件/文件夹,
            // 点文件直接切换打开。之前这里是纯文本路径,看起来像面包屑但点不动。
            const crumbEl = this.element.querySelector(".syfe-md__path") as HTMLElement;
            enableCrumbScroll(crumbEl);
            const crumbClick = (e: MouseEvent) => {
                const seg = (e.target as HTMLElement).closest(".syfe-editor__seg") as HTMLElement | null;
                if (!seg) return;
                const dir = seg.dataset.dir;
                if (!dir) return;
                void showPathSwitchMenu((p) => openFileTab(plugin, p), dir, seg, path);
            };
            crumbEl.addEventListener("click", crumbClick);

            // 顶栏最右侧「更多」:弹出与文件树右键一致的完整文件菜单,
            // 对齐原生思源面包屑的「更多」按钮 —— 不用回树里也能重命名/复制链接等
            const moreBtn = this.element.querySelector(".syfe-md__morebtn") as HTMLElement;
            const fileTreeActions = buildFileTreeActions(plugin as any);
            moreBtn.addEventListener("click", (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const rootEl = findTreeRootEl(path);
                showFileTreeMenu(e, path, false, rootEl, rootEl?.dataset.path || "", fileTreeActions);
            });

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
                    // 标题增删/改名会改变面包屑内容
                    self._hcrumbsHandle?.refresh();
                });
                // 光标移动:标题路径随位置变
                editor.onDidChangeCursorPosition(() => self._hcrumbsHandle?.refresh());
                // 初次进入源码态也补一次(此时面包屑可能还停留在 Vditor 的旧路径上)
                self._hcrumbsHandle?.refresh();
                // 搜索结果跳转;没有显式行号时看链接带来的位置(标题锚点在此换算成行)
                let revealLine = reveal !== undefined ? reveal : consumePendingReveal(path);
                if (reveal === undefined) {
                    const ref = consumePendingRef(path);
                    if (ref) {
                        revealLine = ref.line
                            ?? (ref.anchor ? (headingLineOfAnchor(self._model?.getValue() ?? "", ref.anchor) ?? null) : null);
                    }
                }
                if (revealLine !== null) {
                    // 刚 createEditor 时视图还没布局完,单次 50ms 的 reveal 会静默丢失(实测),
                    // 双发兜底(幂等);反向链接跳转与 ?line= 链接都走这里
                    const doReveal = (focus: boolean) => {
                        if (self._editor !== editor) return;   // 已切走,别对旧编辑器操作
                        editor.revealLineInCenter(revealLine);
                        editor.setPosition({lineNumber: revealLine, column: 1});
                        if (focus) editor.focus();
                    };
                    setTimeout(() => doReveal(true), 300);
                    setTimeout(() => doReveal(false), 1100);
                }
            };

            // 创建 Vditor 实例。两种形态共用一套配置:
            // - live    : mode="ir" 即时渲染(光标所在行显示源码、其余实时渲染)+ 工具栏,可编辑
            // - reading : mode="wysiwyg" 完整渲染 + 无工具栏 + disabled(),只读
            // 注意:创建前必须先等到思源自己的 Lute 就位。vditor 的 md2html 会读全局
            // window.Lute 建实例;我们的 lute-guard 已经把 vditor 那份 lute.min.js
            // 拦在外面(占位 script 让它根本不会下载),所以它拿到的必然是思源的构建
            // —— 而思源构建是 vditor 构建的超集,直接用没问题。
            // 若思源还没懒加载(开起来的第一个页签常常撞上),这里主动补载一次。
            const enterVditor = async (vdMode: "ir" | "wysiwyg", readOnly: boolean) => {
                await ensureSiyuanLute();
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
                    value: normalizeMultilineImgs(self._model?.getValue() ?? ""),
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
                        // setPadding() 按 (容器宽 - maxWidth) / 2 设左右 padding,默认 800
                        // 会把内容列钉死在 800px 居中 —— 窗口越宽两侧空白越大,用户看到的
                        // "内容只显示一半,另一半被空白挤占" 就是它(阅读/实时预览都中招)。
                        // 给超大值让 padding 恒取最小值(35px),内容随窗口通栏
                        maxWidth: 1000000,
                        theme: {
                            current: isDark ? "dark" : "light",
                            path: `${VDITOR_CDN}/dist/css/content-theme`,
                        },
                    },
                    input: () => {
                        markDirty(path, true);
                        updateDirtyUI(true);
                        // 编辑中标题结构会变,顺带刷新面包屑
                        self._hcrumbsHandle?.refresh();
                    },
                    // 异步渲染完成后:补丁序列化方法 + 扫描初始图片 + 启动观察器
                    after: () => {
                        // vditor.lute 在异步 init 完成后才存在,必须在此 patch
                        // (构造函数返回时 lute 尚未赋值,立即 patch 会静默失败)
                        patchLuteDOM2Md(self, vditor);
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
                        // Vditor 是异步渲染的:面包屑的首次 refresh 跑在它前面时拿不到任何标题,
                        // 渲染完成这里必须补一次,否则刚打开的文档面包屑一直是空的
                        self._hcrumbsHandle?.refresh();
                        // 链接带来的位置(标题锚点 / 行号):渲染完成才能查得到标题元素。
                        // 先消费再装槽位,且槽位安装失败不能吞掉定位
                        const ref = consumePendingRef(path);
                        try {
                            self._gutterHandle?.dispose();
                        } catch {
                            // 忽略
                        }
                        try {
                            self._gutterHandle = installMdLineGutter({
                                contentEl: () => self._contentEl ?? null,
                                source: () => self._model?.getValue() ?? "",
                                copyLineLink: (line: number) => copyLinkMd(
                                    buildFileRefMd({path, line, label: `${basename(path)}:${line}`}),
                                    "行链接已复制,粘贴到思源文档点击可定位",
                                ),
                            });
                        } catch (e) {
                            console.warn("[syfe-ref] 行号槽安装失败:", e);
                        }
                        if (ref) applyFileRef(self, ref);
                    },
                });
                self._vditor = vditor;
                // 构造后立即尝试 patch(lute 可能已就绪;未就绪由 after 回调兜底)
                patchLuteDOM2Md(self, vditor);
                // 兜底扫描(after 可能早于图片 DOM 插入;观察器此时未启动需手动扫一次)
                setTimeout(() => processImages(self), 200);
            };

            // 实时预览(类 Obsidian Live Preview)
            const enterLive = () => void enterVditor("ir", false);
            // 阅读模式(类 Obsidian Reading):完整渲染 + 只读
            const enterReading = () => void enterVditor("wysiwyg", true);

            // 模式切换按钮
            this.element.querySelector<HTMLElement>(".syfe-md__bar")!.addEventListener("click", (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                if (target.closest(".syfe-md__save")) {
                    save();
                    return;
                }
                if (target.closest(".syfe-md__verbtn")) {
                    showVersionHistory(plugin as any, path, {
                        onRestore: () => {
                            // 恢复写的是 model:渲染态(Vditor)需重进当前模式以反映新内容;
                            // 源码模式 Monaco 直接跟着 model 走,无需处理
                            if (self._mode === "reading") enterReading();
                            else if (self._mode === "live") enterLive();
                        },
                    });
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

            // ===== 剪贴板增强 =====
            // 阅读 / 实时预览态:Vditor 自带的 copy 只写 Markdown、text/html 置空,
            // 图片跟不过去 —— md-clipboard 在 capture 阶段接管,补写内联了 data URI 的富文本。
            this._clipboard = installMarkdownClipboard({
                contentEl: () => self._contentEl,
                mdPath: () => self._path,
                mode: () => self._mode ?? "live",
                vditor: () => self._vditor,
                insertMarkdown: (md: string) => {
                    if (self._mode === "live" && self._vditor) {
                        try {
                            self._vditor.insertValue(md);
                            return true;
                        } catch {
                            return false;
                        }
                    }
                    if (self._mode === "source" && self._editor && self._model) {
                        try {
                            const sel = self._editor.getSelection();
                            if (!sel) return false;
                            self._editor.executeEdits("syfe-paste-image", [
                                {range: sel, text: md, forceMoveMarkers: true},
                            ]);
                            self._editor.pushUndoStop();
                            return true;
                        } catch {
                            return false;
                        }
                    }
                    return false;
                },
                didEdit: () => {
                    markDirty(path, true);
                    updateDirtyUI(true);
                    self._hcrumbsHandle?.refresh();
                },
                refreshImages: () => processImages(self),
                // 渲染用的 img.src 可能是 blob URL,反查回 md 里写的原始路径
                rawSrcFor: (img: HTMLImageElement) => {
                    const src = img.getAttribute("src") || "";
                    if (!src) return null;
                    const raw = self._blobUrlReverse?.get(src);
                    if (raw) return raw;
                    return /^(https?:|data:|file:)/i.test(src) ? src : null;
                },
            });
            // 供 openMarkdownTab 复用已开页签时直接定位(思源正文点带位置的链接走这里)
            self._applyFileRef = (ref: FileRef) => applyFileRef(self, ref);

            (async () => {
                try {
                    self._model = await getModel(path);
                } catch (e) {
                    self._contentEl!.innerHTML = `<div class="syfe-editor__error">加载失败: ${escapeHTML(String(e))}</div>`;
                    return;
                }
                // 本地路径且文件不存在:getModel 会静默用空内容(便于新建),这里补一条
                // 明确提示 —— 否则"打开一个空白页签"让人以为内容丢了(实测踩过:路径抄错)。
                // 注意插在页签容器(bar 之下)而不是 contentEl:后续 enterXxx 会清空 contentEl
                if (!self._model.getValue() && isSiyuanPath(path) === false && !isBaiduPath(path)) {
                    const stat = nativeStat(path);
                    if (!stat && !self.element.querySelector(".syfe-md__missing")) {
                        self.element.querySelector(".syfe-md__bar")!.insertAdjacentHTML("afterend",
                            `<div class="syfe-md__missing">⚠ 文件不存在或不可读: ${escapeHTML(path)}。可以直接输入内容并保存来创建它。</div>`);
                    }
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
            const discardThenClose = () => {
                markDirty(path, false);
                self._closing = true;
                try {
                    self.parent?.close?.();
                } catch {
                    // 已关闭
                }
            };
            const saveThenClose = () => {
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
            };
            // 行为由设置项「关闭未保存标签页时」决定:ask 弹确认 / discard 直接放弃 / save 直接保存
            return guardUnsavedClose(basename(path), saveThenClose, discardThenClose);
        },
        destroy(this: MarkdownTabInstance) {
            destroyVditor(this);
            destroyMonaco(this);
            this._clipboard?.destroy();
            this._clipboard = undefined;
            this._hcrumbsHandle?.dispose();
            this._hcrumbsHandle = undefined;
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
    // 行号槽跟着 Vditor 走(挂在 .vditor-reset 里,destroy 会清空内容)
    try {
        tab._gutterHandle?.dispose();
    } catch {
        // 忽略
    }
    tab._gutterHandle = undefined;
    if (tab._vditor) {
        try {
            tab._vditor.destroy();
        } catch {
            // 忽略
        }
        tab._vditor = undefined;
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
