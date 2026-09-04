import JSZip from "jszip";
import {readBinaryFile, writeBinaryFile} from "../api/file";
import {OfficeEngine, OfficeToolbarAction} from "./types";

// 演示文稿引擎:.pptx(ZIP + OOXML)渲染预览 + 文本框的文本级编辑
//
// 能力边界(重要):
// - 支持:幻灯片渲染预览、文本框内容编辑并写回、图片/图形按原始位置显示。
// - 不支持:新增/删除/拖拽形状、图形样式与动画编辑、版式与母版修改。
//   这类能力属于桌面级演示软件范畴,超出本插件目标。

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
// 1 px = 9525 EMU(914400 EMU / inch ÷ 96 px / inch)
const EMU_PER_PX = 9525;

function emuToPx(v: number): number {
    return v / EMU_PER_PX;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 取首个匹配的元素(Document 与 Element 都支持 getElementsByTagNameNS)
function firstNS(el: Document | Element, name: string): Element | null {
    const list = el.getElementsByTagNameNS("*", name);
    return list.length ? list[0] : null;
}

// 在元素属性中按本地名查找(兼容带命名空间的属性,如 r:embed)
function attrByLocalName(el: Element, localName: string): string | null {
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if (a.localName === localName || a.name === localName) return a.value;
    }
    return null;
}

// 取 <a:solidFill><a:srgbClr val="RRGGBB"> 的颜色
function solidColor(el: Element | null): string {
    if (!el) return "";
    const c = firstNS(el, "srgbClr");
    if (c) return c.getAttribute("val") || "";
    return "";
}

// 将 rel 的 Target(相对 ppt/slides/)解析为 zip 内路径
function resolveRelTarget(target: string): string {
    const parts = ("ppt/slides/" + target).split("/");
    const stack: string[] = [];
    for (const p of parts) {
        if (p === "" || p === ".") continue;
        if (p === "..") stack.pop();
        else stack.push(p);
    }
    return stack.join("/");
}

// 单个文本框 / 图形渲染结果
interface TextShapeView {
    sp: Element;
    el: HTMLElement;
    original: string;
}

// 幻灯片渲染后的引用
interface SlideView {
    name: string;
    el: HTMLElement;
    texts: TextShapeView[];
}

export async function createPresentationEngine(
    path: string,
    onDirtyChange: (dirty: boolean) => void,
): Promise<OfficeEngine> {
    const buf = await readBinaryFile(path);
    const zip = await JSZip.loadAsync(buf);

    // 幻灯片尺寸(EMU),缺省按 4:3 处理
    let slideW = emuToPx(9144000);
    let slideH = emuToPx(6858000);
    const presFile = zip.file("ppt/presentation.xml");
    if (presFile) {
        const presText = await presFile.async("string");
        const presDoc = new DOMParser().parseFromString(presText, "application/xml");
        const sldSz = firstNS(presDoc, "sldSz");
        if (sldSz) {
            const cx = Number(sldSz.getAttribute("cx"));
            const cy = Number(sldSz.getAttribute("cy"));
            if (cx > 0) slideW = emuToPx(cx);
            if (cy > 0) slideH = emuToPx(cy);
        }
    }

    // 媒体文件 → data URI(用于渲染图片)
    const media: Record<string, string> = {};
    const MIME: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        bmp: "image/bmp",
        tif: "image/tiff",
        tiff: "image/tiff",
        svg: "image/svg+xml",
    };
    const mediaFiles = zip.file(/^ppt\/media\/.+/);
    await Promise.all(
        mediaFiles.map(async f => {
            const ext = (f.name.split(".").pop() || "").toLowerCase();
            const mime = MIME[ext];
            if (!mime) return; // emf/wmf 等浏览器无法直接显示,跳过
            try {
                const b64 = await f.async("base64");
                media[f.name] = `data:${mime};base64,${b64}`;
            } catch {
                // 单个媒体失败不影响整体
            }
        }),
    );

    // 按编号排序列出所有幻灯片
    const slideFiles = zip
        .file(/^ppt\/slides\/slide\d+\.xml$/)
        .slice()
        .sort((a, b) => {
            const na = Number((a.name.match(/(\d+)\.xml$/) || [])[1] || 0);
            const nb = Number((b.name.match(/(\d+)\.xml$/) || [])[1] || 0);
            return na - nb;
        });
    if (!slideFiles.length) {
        throw new Error("未找到任何幻灯片(ppt/slides/slideN.xml)");
    }

    // 缓存每个 slide 的 XML 文本与 DOM,保存时回写
    const slideDocs = new Map<string, {text: string; doc: XMLDocument}>();
    for (const f of slideFiles) {
        const text = await f.async("string");
        const doc = new DOMParser().parseFromString(text, "application/xml");
        slideDocs.set(f.name, {text, doc});
    }

    // 读取某个 slide 的关系映射(rId → 目标路径)
    const relsCache = new Map<string, Record<string, string>>();
    async function relsOf(slideName: string): Promise<Record<string, string>> {
        if (relsCache.has(slideName)) return relsCache.get(slideName)!;
        const relFile = zip.file(`ppt/slides/_rels/${slideName}.rels`);
        const out: Record<string, string> = {};
        if (relFile) {
            const text = await relFile.async("string");
            const doc = new DOMParser().parseFromString(text, "application/xml");
            Array.from(doc.getElementsByTagNameNS("*", "Relationship")).forEach(rel => {
                const id = rel.getAttribute("Id");
                const target = rel.getAttribute("Target");
                if (id && target) out[id] = target;
            });
        }
        relsCache.set(slideName, out);
        return out;
    }

    // ===== 渲染 =====
    const root = document.createElement("div");
    root.className = "syfe-office syfe-office--ppt";
    const scroll = document.createElement("div");
    scroll.className = "syfe-office__ppt-scroll";
    const stage = document.createElement("div");
    stage.className = "syfe-office__ppt-stage";
    scroll.appendChild(stage);

    // 缩放指示条(缩放按钮由 toolbarActions 提供,挂到 Tab 工具栏)
    const zoomBar = document.createElement("div");
    zoomBar.className = "syfe-office__ppt-zoombar";
    root.appendChild(zoomBar);
    root.appendChild(scroll);

    // ===== 缩放 =====
    let zoom = 1;
    const zoomLabel = document.createElement("span");
    zoomLabel.className = "syfe-office__zoom";
    zoomBar.appendChild(zoomLabel);
    function applyZoom() {
        stage.style.zoom = String(zoom);
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }
    function fitWidth() {
        // 此时元素尚未挂载,需在挂载后由 resize() 调用才生效
        const avail = scroll.clientWidth - 32;
        if (avail > 0 && slideW > 0) zoom = Math.min(3, Math.max(0.1, avail / slideW));
        applyZoom();
    }
    applyZoom();

    let dirty = false;
    const slidesView: SlideView[] = [];

    // 将 <a:p> 段落渲染为 HTML
    function parasToHTML(txBody: Element): string {
        const paras = Array.from(txBody.getElementsByTagNameNS("*", "p"));
        return paras
            .map(p => {
                const pPr = firstNS(p, "pPr");
                const algn = pPr ? pPr.getAttribute("algn") || "" : "";
                let align = "left";
                if (algn === "ctr") align = "center";
                else if (algn === "r") align = "right";
                else if (algn === "j") align = "justify";
                const runs = Array.from(p.getElementsByTagNameNS("*", "r"));
                const inner = runs
                    .map(r => {
                        const t = firstNS(r, "t");
                        const text = escapeHTML(t ? t.textContent || "" : "");
                        if (!text) return "";
                        const rPr = firstNS(r, "rPr");
                        let style = "";
                        if (rPr) {
                            if (rPr.getAttribute("b") === "1") style += "font-weight:700;";
                            if (rPr.getAttribute("i") === "1") style += "font-style:italic;";
                            const u = rPr.getAttribute("u");
                            if (u && u !== "none") style += "text-decoration:underline;";
                            const sz = Number(rPr.getAttribute("sz"));
                            if (sz > 0) style += `font-size:${(sz / 100).toFixed(1)}pt;`;
                            const color = solidColor(rPr);
                            if (color) style += `color:#${color};`;
                        }
                        return `<span style="${style}">${text}</span>`;
                    })
                    .join("");
                return `<div style="text-align:${align};min-height:1em;">${inner || "&nbsp;"}</div>`;
            })
            .join("");
    }

    // 文本框原始纯文本(段落间以换行分隔)
    function txBodyPlainText(txBody: Element): string {
        const paras = Array.from(txBody.getElementsByTagNameNS("*", "p"));
        return paras
            .map(p => Array.from(p.getElementsByTagNameNS("*", "t")).map(t => t.textContent || "").join(""))
            .join("\n");
    }

    let pendingLoad = true;
    for (const f of slideFiles) {
        const rec = slideDocs.get(f.name)!;
        const doc = rec.doc;
        const slideEl = document.createElement("div");
        slideEl.className = "syfe-office__ppt-slide";
        slideEl.style.width = `${slideW}px`;
        slideEl.style.height = `${slideH}px`;

        const texts: TextShapeView[] = [];

        // 文本图形 p:sp
        const sps = Array.from(doc.getElementsByTagNameNS("*", "sp"));
        for (const sp of sps) {
            const txBody = firstNS(sp, "txBody");
            const xfrm = firstNS(sp, "xfrm");
            const off = xfrm ? firstNS(xfrm, "off") : null;
            const ext = xfrm ? firstNS(xfrm, "ext") : null;
            if (!txBody || !off || !ext) continue;
            const x = emuToPx(Number(off.getAttribute("x") || 0));
            const y = emuToPx(Number(off.getAttribute("y") || 0));
            const w = emuToPx(Number(ext.getAttribute("cx") || 0));
            const h = emuToPx(Number(ext.getAttribute("cy") || 0));
            const el = document.createElement("div");
            el.className = "syfe-office__ppt-shape";
            el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
            const inner = document.createElement("div");
            inner.className = "syfe-office__ppt-text";
            inner.contentEditable = "true";
            inner.spellcheck = false;
            inner.innerHTML = parasToHTML(txBody);
            el.appendChild(inner);
            slideEl.appendChild(el);
            const view: TextShapeView = {
                sp,
                el: inner,
                original: txBodyPlainText(txBody),
            };
            inner.addEventListener("input", () => {
                if (pendingLoad) return;
                if (!dirty) {
                    dirty = true;
                    onDirtyChange(true);
                }
            });
            texts.push(view);
        }

        // 图片 p:pic(仅渲染,不可编辑)
        const pics = Array.from(doc.getElementsByTagNameNS("*", "pic"));
        const rels = await relsOf(f.name.split("/").pop() || "");
        for (const pic of pics) {
            const spPr = firstNS(pic, "spPr");
            const xfrm = spPr ? firstNS(spPr, "xfrm") : null;
            const off = xfrm ? firstNS(xfrm, "off") : null;
            const ext = xfrm ? firstNS(xfrm, "ext") : null;
            const blip = firstNS(pic, "blip");
            if (!off || !ext || !blip) continue;
            const rid = attrByLocalName(blip, "embed");
            if (!rid || !rels[rid]) continue;
            const mediaPath = resolveRelTarget(rels[rid]);
            const src = media[mediaPath];
            if (!src) continue;
            const x = emuToPx(Number(off.getAttribute("x") || 0));
            const y = emuToPx(Number(off.getAttribute("y") || 0));
            const w = emuToPx(Number(ext.getAttribute("cx") || 0));
            const h = emuToPx(Number(ext.getAttribute("cy") || 0));
            const img = document.createElement("img");
            img.className = "syfe-office__ppt-pic";
            img.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
            img.src = src;
            img.draggable = false;
            slideEl.appendChild(img);
        }

        // 幻灯片序号
        const idx = document.createElement("div");
        idx.className = "syfe-office__ppt-index";
        idx.textContent = String(slidesView.length + 1);
        slideEl.appendChild(idx);

        stage.appendChild(slideEl);
        slidesView.push({name: f.name, el: slideEl, texts});
    }
    pendingLoad = false;

    // 写回:把新文本写入某个 <a:p> 段落
    function setParagraphText(p: Element, text: string, doc: XMLDocument, tmplRun: Element | null) {
        const runs = Array.from(p.getElementsByTagNameNS("*", "r"));
        let run: Element;
        if (runs.length) {
            run = runs[0];
            for (let i = 1; i < runs.length; i++) {
                const r = runs[i];
                if (r.parentNode) r.parentNode.removeChild(r);
            }
        } else if (tmplRun) {
            run = tmplRun.cloneNode(true) as Element;
            p.appendChild(run);
        } else {
            run = doc.createElementNS(A_NS, "a:r");
            const t = doc.createElementNS(A_NS, "a:t");
            run.appendChild(t);
            p.appendChild(run);
        }
        const ts = Array.from(run.getElementsByTagNameNS("*", "t"));
        let tEl: Element;
        if (ts.length) {
            tEl = ts[0];
            for (let i = 1; i < ts.length; i++) {
                const t = ts[i];
                if (t.parentNode) t.parentNode.removeChild(t);
            }
        } else {
            tEl = doc.createElementNS(A_NS, "a:t");
            run.appendChild(tEl);
        }
        tEl.textContent = text;
        // 清掉残留换行,避免与新的段落划分冲突
        Array.from(p.getElementsByTagNameNS("*", "br")).forEach(b => {
            if (b.parentNode) b.parentNode.removeChild(b);
        });
    }

    // 写回:把整段文本写入图形
    function writeTextToShape(sp: Element, text: string, doc: XMLDocument) {
        const txBody = firstNS(sp, "txBody");
        if (!txBody) return;
        const paras = Array.from(txBody.getElementsByTagNameNS("*", "p"));
        if (!paras.length) return;
        const tmplRun = firstNS(txBody, "r");
        const tmplP = paras[0];
        paras.forEach(p => {
            if (p.parentNode) p.parentNode.removeChild(p);
        });
        const lines = text.split("\n");
        lines.forEach((line, i) => {
            const pEl = (i === 0 ? tmplP : (tmplP.cloneNode(true) as Element));
            setParagraphText(pEl, line, doc, tmplRun);
            txBody.appendChild(pEl);
        });
    }

    return {
        root,
        editable: true,
        isDirty: () => dirty,
        onDirtyChange: () => {},
        async save() {
            // 收集各幻灯片中已修改的文本框,写回 XML
            for (const slide of slidesView) {
                let changed = false;
                const rec = slideDocs.get(slide.name);
                if (!rec) continue;
                for (const tv of slide.texts) {
                    const text = (tv.el.innerText || "").replace(/\r/g, "");
                    if (text === tv.original) continue;
                    writeTextToShape(tv.sp, text, rec.doc);
                    tv.original = text;
                    changed = true;
                }
                if (changed) {
                    const ser = new XMLSerializer().serializeToString(rec.doc);
                    // 补回 XML 声明,保证与 Office 生成的文件一致
                    const out = ser.startsWith("<?xml")
                        ? ser
                        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${ser}`;
                    zip.file(slide.name, out);
                }
            }
            const out = await zip.generateAsync({type: "arraybuffer"});
            await writeBinaryFile(path, out);
            dirty = false;
            onDirtyChange(false);
        },
        resize() {
            fitWidth();
        },
        dispose() {
            stage.innerHTML = "";
        },
        toolbarActions: [
            {
                label: "缩小",
                onClick: () => {
                    zoom = Math.max(0.1, Number((zoom - 0.1).toFixed(2)));
                    applyZoom();
                },
            },
            {
                label: "放大",
                onClick: () => {
                    zoom = Math.min(3, Number((zoom + 0.1).toFixed(2)));
                    applyZoom();
                },
            },
            {
                label: "适应宽度",
                onClick: () => fitWidth(),
            },
        ],
    };
}
