// 回归验证#1:重新打开夹具 → 阅读态采样 → 点进编辑态采样 → 点语言标签看围栏 → 再点收起
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    if (!p) return "plugin not found";
    p.config.markdownEditor = "cm6";
    p.openMarkdown("E:/HOME/Local/siyuan-test-ws/data/render-fixture.md", "live");
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        const b = document.querySelector(".syfe-cm-codeblock-colorize span[class*='mtk']");
        if (b) break;
    }
    const out = {};
    const me0 = document.querySelector(".syfe-cm-codeblock .monaco-editor");
    // ===== 编辑态:点卡片 =====
    document.querySelector(".syfe-cm-codeblock").dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor")) break;
    }
    const me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
    if (!me) { out.editing = "NOT REACHED"; return JSON.stringify(out); }
    out.editing = {
        brackets: [...me.querySelectorAll("[class*='bracket-highlighting']")].map(b => ({
            cls: b.className, color: getComputedStyle(b).color, text: b.textContent,
        })).slice(0, 4),
        wordHighlight: me.querySelectorAll("[class*='wordHighlight']").length,
        outline: getComputedStyle(me).outlineStyle + " " + getComputedStyle(me).outlineWidth,
        parenSpan: (() => {
            const s = [...me.querySelectorAll(".view-line span")].find(x => x.textContent === "(");
            return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
        })(),
    };
    // ===== 点语言标签 → 围栏应显现(退出 Monaco) =====
    const lang = document.querySelector(".syfe-cm-codeblock-head .syfe-cm-codeblock-lang");
    lang.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    await sleep(800);
    const bodyAfter = document.querySelector(".syfe-cm-codeblock-body");
    out.afterLangClick = {
        cardGone: !document.querySelector(".syfe-cm-codeblock"),
        monacoUnmounted: !document.querySelector(".syfe-cm-codeblock .monaco-editor"),
        // 围栏可见性:CM 内容里出现 ``` 行
        fenceVisible: (() => {
            const lines = [...document.querySelectorAll(".cm-content .cm-line")].map(l => l.textContent);
            return {open: lines.some(t => t.startsWith("```")), total: lines.length};
        })(),
        cursorOnFence: (() => {
            const sel = document.querySelector(".cm-content .cm-selectionBackground, .cm-caret");
            return !!sel;
        })(),
    };
    // ===== 再点语言(此时无卡片,语言标签不存在)→ 用光标模拟:点击块外收起 =====
    return JSON.stringify(out, null, 1);
})()
