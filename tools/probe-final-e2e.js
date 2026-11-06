// 最终 E2E:阅读态语义色 → 进编辑态(挂载健康)→ 编辑态语义色 → 退出 → 围栏 → 收起
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    if (!p) return "no plugin";
    p.config.markdownEditor = "cm6";
    p.openMarkdown("E:/HOME/Local/siyuan-test-ws/data/render-fixture.md", "live");
    // 1) 等阅读态卡片(语义覆盖完成)
    let hello = null;
    for (let i = 0; i < 50; i++) {
        await sleep(300);
        hello = [...document.querySelectorAll(".syfe-cm-codeblock-colorize span")].filter(x => x.textContent.trim() === "hello").pop();
        if (hello) break;
    }
    if (!hello) return "no block";
    const out = {};
    out.readingHello = {color: getComputedStyle(hello).color, inline: hello.getAttribute("style") || ""};
    // 文本完整性:覆盖器重建不得吞字(colorize 用 NBSP 代替空格、<br> 不产生
    // textContent 换行,归一后逐字符比对)
    const cdiv = document.querySelector(".syfe-cm-codeblock-colorize");
    const expected = "def hello():" + "    " + "print(" + '"' + "code block" + '"' + ")";
    out.textIntegrity = cdiv ? (cdiv.textContent.replace(/\u00a0/g, " ") === expected) : "no-div";

    // 2) 点进编辑态
    const r = hello.closest(".syfe-cm-codeblock-colorize").getBoundingClientRect();
    hello.closest(".syfe-cm-codeblock-colorize").dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    let me = null;
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
        if (me) break;
    }
    out.mounted = !!me;
    if (me) {
        await sleep(2500);   // LSP 语义首拉
        const pick = (t) => {
            const ss = [...me.querySelectorAll(".view-line span")].filter(x => x.textContent.trim() === t);
            const s = ss[ss.length - 1];
            return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
        };
        out.editingHello = pick("hello");
        out.editingDef = pick("def");
        out.editingBrackets = [...me.querySelectorAll("[class*='bracket-highlighting']")].length;
        out.editingOutline = getComputedStyle(me).outlineStyle;
        // 3) 退出(点编辑器外的文档区)
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
        await sleep(800);
    }
    // 4) 回阅读态:卡片 + 语义色保持
    const back = [...document.querySelectorAll(".syfe-cm-codeblock-colorize span")].filter(x => x.textContent.trim() === "hello").pop();
    out.backToReading = back ? {color: getComputedStyle(back).color, card: !!document.querySelector(".syfe-cm-codeblock")} : null;
    // 5) 围栏开关:点语言标签
    const lang = document.querySelector(".syfe-cm-codeblock-head .syfe-cm-codeblock-lang");
    if (lang) {
        lang.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
        await sleep(800);
        out.fenceShown = [...document.querySelectorAll(".cm-line")].some(l => l.textContent.indexOf("```") === 0);
        out.cardGone = !document.querySelector(".syfe-cm-codeblock");
        // 收起:光标移出块
        const p2 = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
        const inst = (p2.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
        if (inst && inst._cm6) inst._cm6.revealLine(1, false);
        await sleep(800);
        out.fenceCollapsed = !!document.querySelector(".syfe-cm-codeblock");
    }
    return JSON.stringify(out, null, 1);
})()
