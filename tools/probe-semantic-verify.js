// 语义层验证:块阅读态(colorize+覆盖)/ 编辑态(LSP 虚拟文档)/ 代码文件 三方 token 对照
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    if (!p) return "plugin not found";
    p.config.markdownEditor = "cm6";
    p.openMarkdown("E:/HOME/Local/siyuan-test-ws/data/render-fixture.md", "live");
    let tokenSpan = null;
    for (let i = 0; i < 60; i++) {
        await sleep(300);
        const cdiv = document.querySelector(".syfe-cm-codeblock-colorize");
        tokenSpan = cdiv ? [...cdiv.querySelectorAll("span")].find(s => s.textContent === "hello") : null;
        if (tokenSpan) break;
    }
    if (!tokenSpan) return "block not rendered";
    const out = {};
    // ===== 阅读态:hello 的着色(语义覆盖后应为 function 色,不再是 mtk12 蓝粗)=====
    out.readingHello = {
        cls: tokenSpan.className,
        color: getComputedStyle(tokenSpan).color,
        fw: getComputedStyle(tokenSpan).fontWeight,
        inlineStyle: tokenSpan.getAttribute("style") || "",
    };
    const defSpan = [...document.querySelectorAll(".syfe-cm-codeblock-colorize span")].find(s => s.textContent === "def");
    out.readingDef = defSpan ? {cls: defSpan.className, color: getComputedStyle(defSpan).color, style: defSpan.getAttribute("style") || ""} : null;
    // ===== 编辑态:点卡片,等 Monaco 语义渲染 =====
    document.querySelector(".syfe-cm-codeblock").dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    let me = null;
    for (let i = 0; i < 40; i++) {
        await sleep(300);
        me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
        if (me) break;
    }
    if (me) {
        await sleep(1500);   // 等 LSP 语义 token 首拉
        const eHello = [...me.querySelectorAll(".view-line span")].filter(s => s.textContent === "hello").pop();
        out.editingHello = eHello ? {
            cls: eHello.className,
            color: getComputedStyle(eHello).color,
            fw: getComputedStyle(eHello).fontWeight,
        } : null;
        const eName = [...me.querySelectorAll(".view-line span")].filter(s => s.textContent === "print").pop();
        out.editingPrint = eName ? {cls: eName.className, color: getComputedStyle(eName).color} : null;
        // Esc 退出回阅读态
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    }
    return JSON.stringify(out, null, 1);
})()
