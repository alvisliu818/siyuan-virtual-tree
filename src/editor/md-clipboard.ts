// Markdown Tab 剪贴板增强(阅读 / 实时预览态)
//
// ===== 背景(实测)=====
// Vditor 的 wysiwyg / ir 模式都自带 copy 处理器(src/ts/wysiwyg/index.ts 的 private copy、
// ir/index.ts 的同名逻辑),它做的是:
//     event.clipboardData.setData("text/plain", lute.VditorDOM2Md(...));
//     event.clipboardData.setData("text/html", "");          // ← 富文本被显式清空
//     event.stopPropagation();  event.preventDefault();
// 于是从阅读/实时预览态复制出去的内容只有纯 Markdown 源码:粘到 Word、邮件、网页富文本框
// 里是一坨带 ** 和 []() 的文本,图片一张都过不去。
//
// 本模块补三块:
//   1. 复制:capture 阶段抢在 Vditor 之前接管 copy/cut,同时写
//        text/html  —— 渲染后的富文本,本地(相对路径)图片内联成 data URI 真带出去
//        text/plain —— Markdown 源码(沿用 Vditor 的 lute 结果,图片是原始路径)
//   2. 右键菜单:选中/指着图片时可以只复制这张图(二进制写进剪贴板)、或复制 Markdown 语法。
//   3. 粘贴:实时预览 / 源码态 Ctrl+V 图片文件 → 落到文档同级的 assets/ 再插入 ![](assets/x.png);
//      阅读态只读,给出提示。
//
// ===== 两个必须同步的坑 =====
// (a) clipboardData 只在事件派发期间可写。一旦 await(哪怕是 fetch 一个 blob:),
//     回来再 setData 会被浏览器静默丢弃。所以 text/html 里的图片内联必须全同步完成 ——
//     这里用 canvas:界面上的图早已解码进 <img>,drawImage + toDataURL 都是同步 API。
// (b) Vditor 在 target 阶段处理 copy 并 stopPropagation,所以监听必须挂在 capture 阶段
//     (挂在 document 上,再按"选区是否在本 Tab 内容区内"筛),否则根本轮不到我们。
//
// Markdown 那一侧的取值顺序有讲究:必须**先**用原始 DOM(还带着 blob: 与 data-syfe-html)
// 走一遍被 patch 过的 lute.dom2md(markdown-tab.ts 的 patchLuteDOM2Md 会把 blob URL 还原成
// md 里写的原始路径、把渲染用的 <img> 还原成原始 <img> 标签),**再**对副本做内联与清洗。
// 顺序反了的话 Markdown 里就会塞进几 MB 的 data URI。

import {Menu, showMessage} from "siyuan";
import type Vditor from "vditor";
import {dirname, extname, joinPath} from "../utils/path";
import {readDir, writeBinaryFile, mkdir} from "../api/file";

// 当前编辑模式(与 tabs/markdown-tab.ts 的 MarkdownMode 同构,刻意不引入那边以避免循环依赖)
export type MdClipboardMode = "live" | "source" | "reading";

// 宿主 Tab 需要提供的能力(全部惰性取值:install 时模型/编辑器可能还没就绪)
export interface MdClipboardHost {
    // Vditor / Monaco 的内容容器(页签存活期间引用不变)
    contentEl(): HTMLElement | undefined;
    // 当前文件绝对路径
    mdPath(): string | undefined;
    // 当前模式
    mode(): MdClipboardMode;
    // 当前 Vditor 实例(源码模式为 undefined)
    vditor(): Vditor | undefined;
    // 插入 Markdown(宿主按当前编辑器形态落地);返回是否已插入
    insertMarkdown(md: string): boolean;
    // 内容变化:打脏标记 + 刷新标题面包屑等
    didEdit(): void;
    // 重新扫描渲染本地图片
    refreshImages(): void;
    // 某张渲染后的图片在 Markdown 里写的原始 src(拿不到返回 null)
    rawSrcFor(img: HTMLImageElement): string | null;
}

export interface MdClipboardHandle {
    destroy(): void;
}

// 单张图内联的像素上限(超了就留原 src,避免一次复制几十 MB 把剪贴板拖死)
// Chromium 的 canvas 面积上限约 268MP,留足余量
const MAX_INLINE_PIXELS = 40 * 1000 * 1000;

// 粘贴落盘的图片子目录名
const ASSET_DIR = "assets";

// Vditor / 本插件的内部标记:复制出去前一律擦掉。
// data-syfe-html 里存的是内联 HTML 图片的原始标签(序列化还原用),绝不能进剪贴板;
// data-marker 是 Vditor 4 给每个块挂的源码标记(#、** 等),Vditor 自己不会影响渲染,
// 但粘到别的编辑器里就是脏数据(实测一轮复制会带上 6 处)。
const DROP_ATTRS = [
    "contenteditable", "spellcheck", "data-block", "data-node-id", "data-type",
    "data-render", "data-marker", "data-syfe-img", "data-syfe-himg", "data-syfe-html",
];

// Vditor 生成的标题锚点 id(wysiwyg-xxx_n / ir-xxx_n),对外没意义,一并去掉
const GEN_ID_PREFIXES = ["wysiwyg-", "ir-"];

// 安装剪贴板增强;返回句柄供 Tab destroy 时卸载
export function installMarkdownClipboard(host: MdClipboardHost): MdClipboardHandle {
    // 当前选区是否落在本 Tab 的内容区里(多个 md 页签各挂一份监听,靠它区分)
    const hasSelectionIn = (content: HTMLElement | undefined): boolean => {
        if (!content) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.collapsed) return false;
        let node: Node | null = range.commonAncestorContainer;
        if (node.nodeType !== 1) node = node.parentNode;
        return !!node && content.contains(node);
    };

    // 取有效选区( caller 保证 hasSelectionIn 已通过 )
    const currentRange = (): Range | null => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        return range.collapsed ? null : range;
    };

    // 把选区内容写出到剪贴板(copy / cut 共用)
    const writeSelection = (ev: ClipboardEvent): boolean => {
        const content = host.contentEl();
        const mode = host.mode();
        // 源码态由 Monaco(editor/monaco.ts 的 Ctrl+C 拦截)处理,这里不插手
        if (mode === "source") return false;
        if (!hasSelectionIn(content)) return false;
        const range = currentRange();
        if (!range) return false;

        // Markdown 必须先用「未加工」的 DOM 算(见文件头说明)
        const mdHolder = document.createElement("div");
        mdHolder.appendChild(range.cloneContents());
        const md = domToMarkdown(host, mdHolder.innerHTML);

        // 富文本:另起一份副本清洗 + 内联图片
        const htmlHolder = document.createElement("div");
        htmlHolder.appendChild(range.cloneContents());
        cleanFragment(htmlHolder);
        inlineImages(htmlHolder);
        const html = htmlHolder.innerHTML;
        // 选区既没文字也没有图:不接管,交回浏览器默认行为
        if (!md && !/<img\b/i.test(html)) return false;

        const data = ev.clipboardData;
        if (!data) return false;
        // 必须在 capture 阶段拦:Vditor 在 target 阶段接管并把 text/html 置空
        ev.preventDefault();
        ev.stopPropagation();
        try {
            data.setData("text/plain", md);
            data.setData("text/html", html);
        } catch {
            return false;
        }
        return true;
    };

    const onCopy = (ev: ClipboardEvent) => {
        writeSelection(ev);
    };

    // 阅读态只读:cut 降级为「复制」。注意这里**只要本 Tab 内有选区就一定拦默认行为** ——
    // 否则 Vditor/浏览器会去删选区内容(只读态 DOM 被改了,后续成像都不对)。
    const onCut = (ev: ClipboardEvent) => {
        if (host.mode() !== "reading") return;
        if (!hasSelectionIn(host.contentEl())) return;
        ev.preventDefault();
        ev.stopPropagation();
        const ok = writeSelection(ev);
        showMessage(ok ? "阅读模式为只读,内容已复制(未剪切)" : "阅读模式为只读", 3000, "info");
    };

    const onPaste = (ev: ClipboardEvent) => {
        const content = host.contentEl();
        const mode = host.mode();
        if (!content || mode === "source") return;  // 源码态由 Monaco 自己处理
        const target = ev.target;
        if (!target || !(target instanceof Node) || !content.contains(target)) return;
        const files = imageFilesOf(ev.clipboardData);
        if (files.length === 0) return;             // 富文本/纯文本交给 Vditor 原生粘贴
        ev.preventDefault();
        ev.stopPropagation();
        if (mode === "reading") {
            showMessage("阅读模式为只读,请先切换到实时预览或源码模式再粘贴", 4000, "info");
            return;
        }
        void pasteImages(host, files);
    };

    // 右键菜单:只接管图片(原生菜单里没有「把这个 blob 图带出去」的入口),
    // 其余目标保持宿主原生菜单不动
    const onContextMenu = (ev: MouseEvent) => {
        const content = host.contentEl();
        if (!content || host.mode() === "source") return;
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const img = t.closest("img") as HTMLImageElement | null;
        if (!img || !content.contains(img)) return;
        ev.preventDefault();
        ev.stopPropagation();
        openImageMenu(host, img, ev);
    };

    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("contextmenu", onContextMenu, true);

    return {
        destroy() {
            document.removeEventListener("copy", onCopy, true);
            document.removeEventListener("cut", onCut, true);
            document.removeEventListener("paste", onPaste, true);
            document.removeEventListener("contextmenu", onContextMenu, true);
        },
    };
}

// ===== 取 Markdown =====
// 走被 patch 过的 lute 序列化方法(blob: → md 原文里的路径,内联 HTML 图 → 原始标签),
// 模式要对:wysiwyg 取 VditorDOM2Md、ir 取 VditorIRDOM2Md,取错的话 Lute 会静默吞掉节点。
function domToMarkdown(host: MdClipboardHost, html: string): string {
    const vd = host.vditor();
    // Vditor 4 把 lute 挂在实例内部的 IVditor 上(this.vditor.lute = setLute(...)),
    // 直接取 vditor.lute 是 undefined —— 两处都兼容,避免版本差异
    const lute = getVditorLute(vd);
    if (!lute) return plainTextOf(html);
    const ir = currentVditorMode(vd) === "ir";
    const name = ir ? "VditorIRDOM2Md" : "VditorDOM2Md";
    if (typeof lute[name] !== "function") return plainTextOf(html);
    try {
        const md = lute[name](html);
        return (md || "").trim();
    } catch {
        // lute 偶发抛错(异常输入)时退化为纯文本,总比什么都不给强
        return plainTextOf(html);
    }
}

// 取 Vditor 的 lute 实例:Vditor 4 挂在 this.vditor.lute 上,顶层 .lute 不存在,两处都兼容
export function getVditorLute(vd: Vditor | undefined): any {
    if (!vd) return undefined;
    return (vd as any).lute || (vd as any).vditor?.lute || undefined;
}

function currentVditorMode(vd: Vditor | undefined): string {
    try {
        return String((vd as any).vditor?.currentMode || "wysiwyg");
    } catch {
        return "wysiwyg";
    }
}

// 拿不到 lute 时的兜底:剥标签取纯文本
function plainTextOf(html: string): string {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return (holder.textContent || "").trim();
}

// ===== 富文本清洗 =====
// 擦掉编辑器的内部标记与 IR 模式残留的语法标记(形如 <span class="vditor-ir__marker">**</span>),
// 否则粘出去会连带 ** 、[]( 这类只服务于源码对齐的字符。
function cleanFragment(root: HTMLElement): void {
    root.querySelectorAll(".vditor-ir__marker").forEach(el => el.remove());
    root.querySelectorAll("[data-type='math-inline'], [data-type='html-inline']").forEach(el => {
        // data-type 是 Lute 的源码节点标记,对外部粘贴目标没有意义:摘掉属性、保留子节点
        el.removeAttribute("data-type");
    });
    const all = [root].concat(Array.from(root.querySelectorAll("*")) as HTMLElement[]);
    for (const el of all) {
        // attributes 是 live 集合,先拷快照再删
        for (const attr of Array.from(el.attributes)) {
            if (DROP_ATTRS.indexOf(attr.name) >= 0) el.removeAttribute(attr.name);
            else if (attr.name === "class" && /vditor-/.test(attr.value)) el.removeAttribute("class");
            else if (attr.name === "id" && GEN_ID_PREFIXES.some(p => attr.value.indexOf(p) === 0)) el.removeAttribute("id");
        }
    }
}

// ===== 图片内联(必须全同步,见文件头)=====
function inlineImages(root: HTMLElement): void {
    const imgs = Array.from(root.querySelectorAll("img"));
    for (const img of imgs) {
        const src = img.getAttribute("src") || "";
        if (!src) continue;
        // 已经是自包含的,或本来就是外部可加载的地址:不动
        if (/^(data:|https?:|file:|\/\/)/i.test(src)) continue;
        const dataUrl = imgToDataUrlSync(img, src);
        if (dataUrl) img.setAttribute("src", dataUrl);
    }
}

// 把已解码的 <img> 画到 canvas 再导出 data URI —— 全同步,不依赖任何异步读取。
// 代价是重新编码一次(按原格式走:jpep→jpeg 0.92、webp→webp、其余→png),
// 好处是不占额外内存、也不用管 blob URL 什么时候失效。
function imgToDataUrlSync(img: HTMLImageElement, src: string): string | null {
    try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return null;                    // 没加载完 / SVG 无固有尺寸
        if (w * h > MAX_INLINE_PIXELS) return null;   // 超大图:放弃内联,保留原地址
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, w, h);
        const mime = canvasMime(src);
        // quality 仅对 jpeg / webp 生效,传 undefined 不影响 png
        return canvas.toDataURL(mime, mime === "image/png" ? undefined : 0.92);
    } catch {
        // 画布被污染(跨域图)或其他异常:保留原地址
        return null;
    }
}

function canvasMime(src: string): string {
    const ext = extname(src.split(/[?#]/)[0]);
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    // canvas 只画 GIF 的第一帧,转 PNG 语义更明确
    return "image/png";
}

// ===== 图片右键菜单 =====
function openImageMenu(host: MdClipboardHost, img: HTMLImageElement, ev: MouseEvent): void {
    const menu = new Menu();
    menu.addItem({
        icon: "iconCopy",
        label: "复制图片",
        click: () => void copyImageToClipboard(img),
    });
    const raw = host.rawSrcFor(img);
    menu.addItem({
        icon: "iconMarkdown",
        label: "复制为 Markdown 语法",
        click: () => void copyMarkdownImage(host, img, raw),
    });
    if (raw) {
        menu.addItem({
            icon: "iconLink",
            label: "复制图片路径",
            click: () => void copyTextSafe(raw, "图片路径已复制"),
        });
    }
    menu.open({x: ev.clientX, y: ev.clientY});
}

// 把图片二进制写进剪贴板(可以直接粘到 Word / 聊天窗口 / 画图)。
// blob: 地址能 fetch 到原始字节,优先用;失败再退回 canvas 转 PNG。
async function copyImageToClipboard(img: HTMLImageElement): Promise<void> {
    const src = img.getAttribute("src") || "";
    let blob: Blob | null = null;
    if (/^blob:/i.test(src)) {
        try {
            const resp = await fetch(src);
            blob = await resp.blob();
        } catch {
            blob = null;
        }
    }
    if (!blob) {
        const dataUrl = imgToDataUrlSync(img, src);
        if (!dataUrl) {
            showMessage("该图片暂不支持复制,请用右键菜单复制路径", 3000, "info");
            return;
        }
        blob = dataUrlToBlob(dataUrl);
    }
    if (!blob) {
        showMessage("复制失败:无法读取图片数据", 3000, "error");
        return;
    }
    try {
        await navigator.clipboard.write([new ClipboardItem({[blob.type || "image/png"]: blob})]);
        showMessage("图片已复制到剪贴板", 2000, "info");
    } catch {
        showMessage("复制失败:当前环境不支持写入图片到剪贴板", 3000, "error");
    }
}

async function copyMarkdownImage(host: MdClipboardHost, img: HTMLImageElement, raw: string | null): Promise<void> {
    const alt = img.getAttribute("alt") || "";
    const src = raw || img.getAttribute("src") || "";
    await copyTextSafe(`![${alt}](${src})`, "已复制 Markdown 图片语法");
}

async function copyTextSafe(text: string, okMsg: string): Promise<void> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            throw new Error("no clipboard api");
        }
        showMessage(okMsg, 2000, "info");
    } catch {
        showMessage("复制失败", 3000, "error");
    }
}

function dataUrlToBlob(dataUrl: string): Blob | null {
    try {
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return null;
        const head = dataUrl.slice(0, comma);
        const body = dataUrl.slice(comma + 1);
        if (!/;base64$/i.test(head)) return null;
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = (head.slice(5).replace(/;base64$/i, "") || "image/png");
        return new Blob([bytes], {type: mime});
    } catch {
        return null;
    }
}

// ===== 粘贴图片 =====
function imageFilesOf(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    // files 与 items 内容有重叠,files 更直接;部分来源只出现在 items 里,两边都扫一遍
    if (data.files && data.files.length > 0) {
        for (const f of Array.from(data.files)) {
            if (/^image\//i.test(f.type)) files.push(f);
        }
    }
    if (files.length === 0 && data.items && data.items.length > 0) {
        for (const it of Array.from(data.items)) {
            if (it.kind === "file" && /^image\//i.test(it.type)) {
                const f = it.getAsFile();
                if (f) files.push(f);
            }
        }
    }
    return files;
}

async function pasteImages(host: MdClipboardHost, files: File[]): Promise<void> {
    const mdPath = host.mdPath();
    if (!mdPath) return;
    const dir = dirname(mdPath);
    if (!dir) {
        showMessage("无法定位文档所在目录", 3000, "error");
        return;
    }
    const assetDir = joinPath(dir, ASSET_DIR);
    try {
        // 已存在时思源 putFile / 原生 fs 都可能报错,先探测一次列出已有名字
        await mkdir(assetDir);
    } catch {
        // 目录多半已存在,继续(真失败会在写文件时报出来)
    }
    const inserted: string[] = [];
    let failed = 0;
    for (const f of files) {
        try {
            const ext = extOfFile(f);
            const name = await pickAssetName(assetDir, f.name && extname(f.name) ? f.name : `paste-${Date.now()}${ext}`);
            const dest = joinPath(assetDir, name);
            await writeBinaryFile(dest, await f.arrayBuffer());
            // 统一按 POSIX 相对路径写 md 语法,Vditor/浏览器都能吃
            inserted.push(`![](${encodeMdPath(ASSET_DIR + "/" + name)})`);
        } catch (e) {
            failed += 1;
            showMessage(`图片保存失败: ${e}`, 4000, "error");
        }
    }
    if (inserted.length === 0) return;
    if (host.insertMarkdown(inserted.join("\n\n"))) {
        host.didEdit();
        // 落盘刚完成,等编辑器把节点插进去再扫一遍本地图片
        setTimeout(() => host.refreshImages(), 80);
        showMessage(failed > 0 ? `已粘贴 ${inserted.length} 张,${failed} 张失败` : `已粘贴 ${inserted.length} 张图片`, 2500, "info");
    } else {
        showMessage(`图片已保存到 ${assetDir},但未能插入到文档`, 4000, "error");
    }
}

function extOfFile(f: File): string {
    if (f.name && extname(f.name)) return extname(f.name);
    const t = (f.type || "").toLowerCase();
    if (t === "image/jpeg") return ".jpg";
    if (t === "image/webp") return ".webp";
    if (t === "image/gif") return ".gif";
    if (t === "image/svg+xml") return ".svg";
    if (t === "image/bmp") return ".bmp";
    return ".png";
}

// md 里写相对路径;空格等字符按 URL 编码,避免 ![](a b.png) 被 Markdown 在空格处截断
function encodeMdPath(rel: string): string {
    return rel.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// 目标位置已存在同名文件时追加 -1 / -2 …(读不到目录就直接用原名字走写) 
async function pickAssetName(dir: string, desired: string): Promise<string> {
    let existing: Set<string> | null = null;
    try {
        existing = new Set((await readDir(dir)).map(e => e.name || ""));
    } catch {
        existing = null;
    }
    if (!existing || !existing.has(desired)) return desired;
    const ext = extname(desired);
    const stem = desired.slice(0, desired.length - ext.length) || desired;
    for (let i = 1; i < 1000; i++) {
        const cand = `${stem}-${i}${ext}`;
        if (!existing.has(cand)) return cand;
    }
    return `${stem}-${Date.now()}${ext}`;
}
