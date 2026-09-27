import "quill/dist/quill.snow.css";
import JSZip from "jszip";
import {readBinaryFile, writeBinaryFile} from "../api/file";
import {OfficeEngine} from "./types";

// mammoth 默认只转换正文,会丢弃「页面页眉/页脚」里的内容。很多文档的标题/抬头就放在页眉里,
// 导致「标题内容没有显示 / 内容显示不完整」。这里额外从 docx 包里抽取页眉页脚文本,
// 以只读面板的形式展示在编辑器上下方(不进入 Quill 模型,保存时不会写回正文)。
// 标题样式映射:英文 + 中文(中文 Word 默认样式名为「标题 1」..「标题 6」)。
// 不映射时 mammoth 会把它们当成普通段落,标题既不变大也不作为标题呈现。
const HEADING_STYLE_MAP: string[] = [
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Heading 5'] => h5:fresh",
    "p[style-name='Heading 6'] => h6:fresh",
    "p[style-name='标题 1'] => h1:fresh",
    "p[style-name='标题 2'] => h2:fresh",
    "p[style-name='标题 3'] => h3:fresh",
    "p[style-name='标题 4'] => h4:fresh",
    "p[style-name='标题 5'] => h5:fresh",
    "p[style-name='标题 6'] => h6:fresh",
];

function decodeXmlEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, "&");
}

// 从 docx(zip)里抽取所有页眉 / 页脚的文本段落(仅展示用)
async function extractHeaderFooterText(buf: ArrayBuffer): Promise<{header: string[]; footer: string[]}> {
    try {
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files);
        const headerFiles = names.filter((n) => /^word\/header\d*\.xml$/i.test(n));
        const footerFiles = names.filter((n) => /^word\/footer\d*\.xml$/i.test(n));

        const collect = async (files: string[]): Promise<string[]> => {
            const paras: string[] = [];
            for (const f of files) {
                const xml = await zip.files[f].async("string");
                let doc: Document;
                try {
                    doc = new DOMParser().parseFromString(xml, "application/xml");
                } catch {
                    continue;
                }
                const pNodes = Array.from(doc.getElementsByTagName("w:p"));
                for (const p of pNodes) {
                    const tNodes = Array.from(p.getElementsByTagName("w:t"));
                    const text = tNodes
                        .map((t) => decodeXmlEntities(t.textContent || ""))
                        .join("")
                        .trim();
                    if (text) paras.push(text);
                }
            }
            return paras;
        };

        return {header: await collect(headerFiles), footer: await collect(footerFiles)};
    } catch {
        return {header: [], footer: []};
    }
}

// 中文数字 → 级别
const ZH_NUM_LEVEL: Record<string, number> = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6};

// 从 styles.xml 动态生成标题样式映射。很多中文文档(尤其 WPS / 教程模板)的标题样式
// 不叫「Heading N」,而是「一级标题」「二级标题」等自定义名,mammoth 默认映射不上,
// 导致标题被当普通段落渲染(「标题内容没有显示」)。识别两类信号:
// 1) 样式带 w:outlineLvl(大纲级别,语义上就是标题)→ 映射为对应级别的 h1-h6;
// 2) 样式名匹配「N级标题」/「标题 N」/「Heading N」→ 映射为 hN。
async function buildHeadingStyleMap(buf: ArrayBuffer): Promise<string[]> {
    const map: string[] = [];
    try {
        const zip = await JSZip.loadAsync(buf);
        const stylesFile = zip.file("word/styles.xml");
        if (!stylesFile) return map;
        const xml = await stylesFile.async("string");
        const blocks = xml.split(/<w:style[\s>]/).slice(1);
        for (const raw of blocks) {
            const block = "<w:style " + raw.split("</w:style>")[0];
            const nameMatch = block.match(/<w:name w:val="([^"]+)"/);
            if (!nameMatch) continue;
            const name = nameMatch[1];
            if (name.includes("'")) continue; // 名字含引号无法安全写入 styleMap,跳过
            let level = 0;
            const outline = block.match(/<w:outlineLvl w:val="(\d+)"/);
            if (outline) {
                level = Number(outline[1]) + 1;
            } else {
                const m1 = name.match(/^(?:heading|标题)\s*([1-6])$/i);
                const m2 = name.match(/^([一二三四五六])级标题$/);
                if (m1) level = Number(m1[1]);
                else if (m2) level = ZH_NUM_LEVEL[m2[1]] || 0;
            }
            if (level >= 1 && level <= 6) {
                map.push(`p[style-name='${name}'] => h${level}:fresh`);
            }
        }
    } catch {
        // 解析失败不影响主流程
    }
    return map;
}

// EMF/WMF 是 Word 矢量图格式,浏览器不能渲染;mammoth 默认把所有图片 base64 内联,
// 一份带多张 EMF 的文档会让 HTML 膨胀到几十上百 MB,编辑器直接卡死/截断
// (「内容显示不完整」)。这里跳过这两类不可显示的图片,其余图片保持内联。
function makeConvertImage(mammoth: any) {
    try {
        if (!mammoth?.images?.imgElement) return undefined;
        return mammoth.images.imgElement((el: any) => {
            const type = String(el?.contentType || "");
            if (/emf|wmf/i.test(type)) {
                return Promise.resolve({});
            }
            return el.readAsBase64String().then((b64: string) => ({
                src: "data:" + type + ";base64," + b64,
            }));
        });
    } catch {
        return undefined;
    }
}

// 文档引擎:.docx → HTML(mammoth) → Quill 富文本编辑 → HTML → .docx(docx)
// 说明:往返转换会有一定格式损耗(复杂版式、页眉页脚、图片等不保留),正文内容与
// 基础格式(标题/粗斜体/下划线/删除线/列表/链接/表格)可正常往返。

// 行内样式上下文
interface InlineCtx {
    bold?: boolean;
    italics?: boolean;
    underline?: boolean;
    strike?: boolean;
}

const EMPTY_INLINE: InlineCtx = {};

// 行内节点 → TextRun 数组
function inlineRuns(nodes: ChildNode[], D: any, ctx: InlineCtx): any[] {
    const runs: any[] = [];
    for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || "";
            if (!text) continue;
            runs.push(
                new D.TextRun({
                    text,
                    bold: ctx.bold || undefined,
                    italics: ctx.italics || undefined,
                    underline: ctx.underline ? {} : undefined,
                    strike: ctx.strike || undefined,
                }),
            );
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        if (tag === "br") {
            runs.push(new D.TextRun({break: 1}));
            continue;
        }
        if (tag === "a") {
            const href = el.getAttribute("href") || "";
            const inner = inlineRuns(Array.from(el.childNodes), D, ctx);
            const children = inner.length ? inner : [new D.TextRun({text: el.textContent || ""})];
            if (/^(https?:|mailto:|ftp:)/i.test(href)) {
                runs.push(new D.ExternalHyperlink({link: href, children}));
            } else {
                runs.push(...children);
            }
            continue;
        }

        const next: InlineCtx = {...ctx};
        if (tag === "b" || tag === "strong") next.bold = true;
        else if (tag === "i" || tag === "em") next.italics = true;
        else if (tag === "u" || tag === "ins") next.underline = true;
        else if (tag === "s" || tag === "del" || tag === "strike") next.strike = true;
        else if (tag === "span") {
            // 编辑器常以 style 而非语义标签表达格式
            const style = (el.getAttribute("style") || "").toLowerCase().replace(/\s+/g, "");
            if (style.includes("font-weight:bold") || style.includes("font-weight:700") || style.includes("font-weight:600")) next.bold = true;
            if (style.includes("font-style:italic")) next.italics = true;
            if (style.includes("text-decoration:underline")) next.underline = true;
            if (style.includes("line-through")) next.strike = true;
        }
        runs.push(...inlineRuns(Array.from(el.childNodes), D, next));
    }
    return runs;
}

// 块级节点 → Paragraph / Table 数组
function blockChildren(nodes: ChildNode[], D: any, listLevel: number): any[] {
    const out: any[] = [];
    for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = (node.textContent || "").trim();
            if (t) out.push(new D.Paragraph({children: [new D.TextRun({text: t})]}));
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        if (/^h[1-6]$/.test(tag)) {
            const level = Number(tag.slice(1));
            const heading = D.HeadingLevel[`HEADING_${level}`];
            const runs = inlineRuns(Array.from(el.childNodes), D, EMPTY_INLINE);
            out.push(new D.Paragraph({heading, children: runs.length ? runs : [new D.TextRun({text: ""})]}));
            continue;
        }
        if (tag === "p" || tag === "blockquote" || tag === "pre" || tag === "address") {
            const runs = inlineRuns(Array.from(el.childNodes), D, EMPTY_INLINE);
            out.push(new D.Paragraph({children: runs.length ? runs : [new D.TextRun({text: ""})]}));
            continue;
        }
        if (tag === "ul" || tag === "ol") {
            const items = Array.from(el.children).filter(c => c.tagName.toLowerCase() === "li");
            for (const li of items) {
                const runs = inlineRuns(Array.from(li.childNodes), D, EMPTY_INLINE);
                const opts: any = {children: runs.length ? runs : [new D.TextRun({text: ""})]};
                if (tag === "ul") {
                    opts.bullet = {level: listLevel};
                } else {
                    opts.numbering = {reference: "syfe-ordered-list", level: listLevel};
                }
                out.push(new D.Paragraph(opts));
                // 嵌套列表
                const nested = Array.from(li.children).filter(c => {
                    const t = c.tagName.toLowerCase();
                    return t === "ul" || t === "ol";
                });
                if (nested.length) out.push(...blockChildren(nested, D, listLevel + 1));
            }
            continue;
        }
        if (tag === "table") {
            const rows = Array.from((el as HTMLTableElement).rows || []);
            if (rows.length) {
                const tableRows = rows.map(tr => {
                    const cells = Array.from(tr.children).filter(c => {
                        const t = c.tagName.toLowerCase();
                        return t === "td" || t === "th";
                    });
                    return new D.TableRow({
                        children: cells.map(cell => {
                            const kids = blockChildren(Array.from(cell.childNodes), D, 0);
                            return new D.TableCell({
                                children: kids.length ? kids : [new D.Paragraph({children: [new D.TextRun({text: ""})]})],
                            });
                        }),
                    });
                });
                out.push(new D.Table({rows: tableRows, width: {size: 100, type: D.WidthType.PERCENTAGE}}));
            }
            continue;
        }
        if (tag === "br") {
            out.push(new D.Paragraph({children: [new D.TextRun({text: ""})]}));
            continue;
        }
        if (tag === "img" || tag === "script" || tag === "style") continue;
        // 其他容器(div/section 等):递归展开
        out.push(...blockChildren(Array.from(el.childNodes), D, listLevel));
    }
    return out;
}

// HTML 字符串 → docx 的 Document
function htmlToDocxDocument(html: string, D: any): any {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    let children = blockChildren(Array.from(container.childNodes), D, 0);
    if (!children.length) {
        children = [new D.Paragraph({children: [new D.TextRun({text: ""})]})];
    }
    return new D.Document({
        // 有序列表需要预定义编号配置
        numbering: {
            config: [
                {
                    reference: "syfe-ordered-list",
                    levels: [0, 1, 2, 3, 4].map(level => ({
                        level,
                        format: D.LevelFormat.DECIMAL,
                        text: "%" + (level + 1) + ".",
                        alignment: D.AlignmentType.START,
                    })),
                },
            ],
        },
        sections: [{children}],
    });
}

export async function createDocumentEngine(
    path: string,
    onDirtyChange: (dirty: boolean) => void,
): Promise<OfficeEngine> {
    const buf = await readBinaryFile(path);

    // 抽取页眉/页脚文本(只读展示,不进入 Quill 模型,保存时不会写回正文)
    const hf = await extractHeaderFooterText(buf);

    // 动态识别文档自定义标题样式(如「一级标题」),避免标题被渲染成普通段落
    const dynamicStyleMap = await buildHeadingStyleMap(buf);

    // mammoth:docx → HTML(正文)
    // 注意:convertToHtml 的签名是 (input, options),styleMap/convertImage 必须放在第二个
    // 参数里,混进第一个参数会被静默忽略
    const mammothMod: any = await import("mammoth/mammoth.browser.js");
    const mammoth = mammothMod.default || mammothMod;
    const convertImage = makeConvertImage(mammoth);
    const converted = await mammoth.convertToHtml(
        {arrayBuffer: buf},
        {
            styleMap: [...HEADING_STYLE_MAP, ...dynamicStyleMap],
            includeDefaultStyleMap: true,
            ...(convertImage ? {convertImage} : {}),
        },
    );
    const initialHTML: string = converted?.value || "";

    // Quill:富文本编辑
    const quillMod: any = await import("quill");
    const Quill = quillMod.default || quillMod;

    const root = document.createElement("div");
    root.className = "syfe-office syfe-office--doc";
    const editorEl = document.createElement("div");
    editorEl.className = "syfe-office__doc-editor";
    root.appendChild(editorEl);

    const quill = new Quill(editorEl, {
        theme: "snow",
        placeholder: "开始编辑文档…",
        modules: {
            toolbar: [
                [{header: [1, 2, 3, 4, 5, 6, false]}],
                ["bold", "italic", "underline", "strike"],
                [{list: "ordered"}, {list: "bullet"}],
                [{align: []}],
                ["link", "blockquote", "code-block"],
                [{color: []}, {background: []}],
                ["clean"],
            ],
        },
    });

    let dirty = false;
    let loading = true;
    if (initialHTML) {
        try {
            quill.clipboard.dangerouslyPasteHTML(0, initialHTML);
        } catch {
            quill.root.innerHTML = initialHTML;
        }
    }

    // 页眉/页脚:只读面板,放在工具栏下方与编辑区下方(不进入 Quill 模型)
    const buildPanel = (paras: string[], cls: string, label: string): HTMLElement | null => {
        if (!paras.length) return null;
        const panel = document.createElement("div");
        panel.className = cls;
        panel.setAttribute("data-label", label);
        panel.innerHTML = paras.map((t) => `<p>${t}</p>`).join("");
        return panel;
    };
    const headerPanel = buildPanel(hf.header, "syfe-docx-header-panel", "页眉");
    const footerPanel = buildPanel(hf.footer, "syfe-docx-footer-panel", "页脚");
    if (headerPanel) root.insertBefore(headerPanel, editorEl);
    if (footerPanel) root.appendChild(footerPanel);

    const onChange = () => {
        if (loading) return;
        if (!dirty) {
            dirty = true;
            onDirtyChange(true);
        }
    };
    quill.on("text-change", onChange);
    loading = false;

    return {
        root,
        editable: true,
        isDirty: () => dirty,
        onDirtyChange: () => {},
        async save() {
            const html: string =
                typeof quill.getSemanticHTML === "function" ? quill.getSemanticHTML() : quill.root.innerHTML;
            const D: any = await import("docx");
            const doc = htmlToDocxDocument(html, D);
            const out = (await D.Packer.toArrayBuffer(doc)) as ArrayBuffer;
            await writeBinaryFile(path, out);
            dirty = false;
            onDirtyChange(false);
        },
        dispose() {
            try {
                quill.off("text-change", onChange);
            } catch {
                // 忽略
            }
            root.innerHTML = "";
        },
    };
}
