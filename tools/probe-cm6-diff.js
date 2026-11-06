// 实测两态样式差异:打开 render-fixture.md(CM6 live)→ 阅读态采样 → 点进代码块 → 编辑态采样
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    if (!p) return "plugin not found";
    p.config.markdownEditor = "cm6";
    p.openMarkdown("E:/HOME/Local/siyuan-test-ws/data/render-fixture.md", "live");
    // 等渲染(标签打开 + colorize 异步完成)
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        const b = document.querySelector(".syfe-cm-codeblock-body");
        if (b && b.querySelector(".syfe-cm-codeblock-colorize .mtk1, .syfe-cm-codeblock-colorize span")) break;
    }
    const cs = (el) => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return {bg: s.backgroundColor, color: s.color, ff: s.fontFamily, fs: s.fontSize, lh: s.lineHeight, pad: s.padding, h: el.getBoundingClientRect().height, w: Math.round(el.getBoundingClientRect().width)};
    };
    const out = {};
    // ===== 阅读态 =====
    const body = document.querySelector(".syfe-cm-codeblock-body");
    if (!body) return "codeblock body not found";
    out.reading = {
        body: cs(body),
        colorizeDiv: cs(body.querySelector(".syfe-cm-codeblock-colorize")),
        firstToken: (() => {
            const t = body.querySelector(".syfe-cm-codeblock-colorize span.mtk1, .syfe-cm-codeblock-colorize span");
            if (!t) return null;
            const s = getComputedStyle(t);
            return {cls: t.className, color: s.color, fs: s.fontSize, ff: s.fontFamily};
        })(),
        cmEditorBg: cs(document.querySelector(".cm-editor")),
    };
    // ===== 点进代码块 → 编辑态 =====
    const wrap = document.querySelector(".syfe-cm-codeblock");
    wrap.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor")) break;
    }
    const ebody = document.querySelector(".syfe-cm-codeblock-body.is-editing");
    if (!ebody) { out.editing = "editing state not reached"; return JSON.stringify(out); }
    const me = ebody.querySelector(".monaco-editor");
    out.editing = {
        body: cs(ebody),
        monacoEditor: cs(me),
        monacoBackground: cs(me.querySelector(".monaco-editor-background")),
        margin: cs(me.querySelector(".margin")),
        editorHost: cs(ebody.querySelector(".syfe-cm-codeblock-editorhost")),
        firstToken: (() => {
            const t = me.querySelector(".view-line span.mtk1, .view-line span");
            if (!t) return null;
            const s = getComputedStyle(t);
            return {cls: t.className, color: s.color, fs: s.fontSize, ff: s.fontFamily};
        })(),
        viewLines: cs(me.querySelector(".view-lines")),
    };
    // 首字符 x 坐标对比(阅读 colorize 首行 vs 编辑 view-line)
    const rl = body.querySelector(".syfe-cm-codeblock-colorize");
    const vl = me.querySelector(".view-lines");
    out.charX = {
        reading: rl ? Math.round(rl.getBoundingClientRect().left) : null,
        editing: vl ? Math.round(vl.getBoundingClientRect().left) : null,
    };
    return JSON.stringify(out, null, 1);
})()
