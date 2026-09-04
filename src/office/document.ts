import "quill/dist/quill.snow.css";
import {readBinaryFile, writeBinaryFile} from "../api/file";
import {OfficeEngine} from "./types";

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

    // mammoth:docx → HTML
    const mammothMod: any = await import("mammoth/mammoth.browser.js");
    const mammoth = mammothMod.default || mammothMod;
    const converted = await mammoth.convertToHtml({arrayBuffer: buf});
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
