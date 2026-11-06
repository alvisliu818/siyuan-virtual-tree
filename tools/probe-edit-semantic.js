// 编辑态语义采样:点卡片正文(模拟真实点击)进编辑态 → 等 Monaco + LSP → 采样 → 退出
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 先退干净
    if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) {
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
        await sleep(800);
    }
    // 点正文(colorize 层,阅读态可见内容)
    const target = document.querySelector(".syfe-cm-codeblock-colorize") || document.querySelector(".syfe-cm-codeblock");
    if (!target) return "no card";
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    // 等编辑态 + 语义 token(LSP 首拉)
    let me = null;
    for (let i = 0; i < 50; i++) {
        await sleep(300);
        me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
        if (me) break;
    }
    if (!me) return "editing not reached";
    await sleep(2500);
    const pick = (t) => {
        const ss = [...me.querySelectorAll(".view-line span")].filter(x => x.textContent.trim() === t);
        const s = ss[ss.length - 1];
        return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
    };
    const result = {hello: pick("hello"), def: pick("def"), print: pick("print")};
    // 退出回阅读态
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(500);
    return JSON.stringify(result, null, 1);
})()
