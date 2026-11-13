// 结构化内核代码块:复用 monaco-block 全局单例基础设施。
// 渲染态 = monaco.editor.colorize 当前主题高亮;点击 = 挂载单例 Monaco 编辑,
// 内容变更回写 PM leaf(整段围栏源码),Esc/点击外部退出。与 CM6 代码卡片同源同主题。
import {
    colorizeCached, mountBlockEditor, unmountBlockEditor, setEditingKey,
    onMonacoThemeChanged, BLOCK_FONT_FAMILY, BLOCK_FONT_SIZE, BLOCK_LINE_HEIGHT,
} from "../monaco-block";
import {resolveFenceLanguageId} from "../../extensions/grammar-loader";

export class CodeBlockView {
    node: any; view: any; getPos: any;
    dom: HTMLElement; preview: HTMLElement; editing = false;
    private themeOff: {dispose(): void} | null = null;

    constructor(node: any, view: any, getPos: any) {
        this.node = node; this.view = view; this.getPos = getPos;
        this.dom = document.createElement("div");
        this.dom.className = "blk blk-codeFence sb";
        this.preview = document.createElement("div");
        this.preview.className = "sb-preview";
        this.preview.contentEditable = "false";
        this.dom.appendChild(this.preview);
        this.paint();
        this.preview.addEventListener("mousedown", e => {
            if (!this.view.editable) return;
            e.preventDefault(); e.stopPropagation(); this.edit();
        });
        this.themeOff = onMonacoThemeChanged(() => { if (!this.editing) this.paint(); });
    }

    private parse(): {open: string; lang: string; code: string; close: string} {
        const lines = this.node.textContent.split("\n");
        const open = lines[0] || "";
        const lang = (/^\s*(```|~~~)\s*([^\s`]*)/.exec(open) || [])[2] || "";
        let end = lines.length;
        if (end > 1 && /^\s*(```|~~~)\s*$/.test(lines[end - 1])) end--;
        const code = lines.slice(1, end).join("\n");
        const close = end < lines.length ? lines[lines.length - 1] : "";
        return {open, lang, code, close};
    }

    private shell(): {wrap: HTMLElement; body: HTMLElement} {
        const wrap = document.createElement("div");
        wrap.className = "code-wrap";
        const label = document.createElement("div");
        label.className = "code-lang";
        label.textContent = this.parse().lang || "text";
        const body = document.createElement("div");
        body.className = "code-body";
        body.style.fontFamily = BLOCK_FONT_FAMILY;
        body.style.fontSize = BLOCK_FONT_SIZE + "px";
        body.style.lineHeight = BLOCK_LINE_HEIGHT + "px";
        wrap.append(label, body);
        return {wrap, body};
    }

    paint(): void {
        const {lang, code} = this.parse();
        this.preview.textContent = "";
        const {wrap, body} = this.shell();
        this.preview.appendChild(wrap);
        colorizeCached(resolveFenceLanguageId(lang), code).then(html => {
            if (this.preview.isConnected && !this.editing) body.innerHTML = html;
        });
    }

    private writeBack(open: string, code: string, close: string): void {
        const pos = this.getPos();
        if (typeof pos !== "number") return;
        const full = open + "\n" + code + (close ? "\n" + close : "");
        const from = pos + 1, to = pos + 1 + this.node.content.size;
        const tr = this.view.state.tr;
        if (full) tr.replaceWith(from, to, this.view.state.schema.text(full));
        else tr.delete(from, to);
        this.view.dispatch(tr);
    }

    edit(): void {
        if (this.editing) return;
        this.editing = true;
        const {lang, code, open, close} = this.parse();
        this.preview.textContent = "";
        const {wrap, body} = this.shell();
        body.className = "code-edit-host";
        this.preview.appendChild(wrap);
        const key = "structured:" + this.getPos();
        setEditingKey(key);
        mountBlockEditor({
            container: body,
            key,
            language: resolveFenceLanguageId(lang),
            value: code,
            onContentChange: v => this.writeBack(open, v, close),
            onExit: () => this.exit(),
        });
    }

    exit(): void {
        if (!this.editing) return;
        this.editing = false;
        unmountBlockEditor();
        setEditingKey(null);
        this.paint();
    }

    update(node: any): boolean {
        if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
        this.node = node;
        if (!this.editing) this.paint();
        return true;
    }

    ignoreMutation(): boolean { return true; }

    destroy(): void {
        this.themeOff?.dispose();
        this.themeOff = null;
        if (this.editing) { unmountBlockEditor(); setEditingKey(null); this.editing = false; }
    }
}