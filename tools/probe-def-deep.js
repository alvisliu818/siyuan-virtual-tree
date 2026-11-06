// 深挖 def 丢色:进编辑态等 6s,抓第一行完整 HTML + 各 token 类
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) {
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
        await sleep(600);
    }
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    let me = null;
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
        if (me) break;
    }
    if (!me) return "not mounted";
    await sleep(6000);
    const line1 = me.querySelector(".view-line");
    const out = {
        line1Html: line1 ? line1.innerHTML.slice(0, 400) : null,
        spans: [...(me.querySelectorAll(".view-line span[class*='mtk']") || [])].slice(0, 8).map(s => ({cls: s.className, text: s.textContent.slice(0, 10)})),
    };
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(out, null, 1);
})()
