// 宽态时间线:构造长行 → 等稳定 → 多次滚动尝试 + 实时 rect
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const inst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (!inst || !inst._cm6) return "no cm6";
    inst._cm6.setValue('# 行号验证\n\n```python\nx = "' + "L".repeat(1200) + '"\nshort = 2\n```');
    await sleep(2500);   // 等渲染+覆盖链完全稳定
    const body = document.querySelector(".syfe-cm-codeblock-body");
    if (!body) return "no body";
    const snap = (tag) => {
        const n = body.querySelector(".syfe-cm-cl-n");
        const row = body.querySelector(".syfe-cm-cl");
        return {
            tag,
            scrollW: body.scrollWidth,
            clientW: body.clientWidth,
            scrollLeft: body.scrollLeft,
            rowW: row ? Math.round(row.getBoundingClientRect().width) : null,
            numLeft: n ? Math.round(n.getBoundingClientRect().left) : null,
        };
    };
    const out = [snap("stable")];
    body.scrollLeft = 300;
    out.push(snap("assign300"));
    await sleep(300);
    out.push(snap("after300ms"));
    body.scrollLeft = 600;
    await sleep(50);
    out.push(snap("assign600"));
    return JSON.stringify(out, null, 1);
})()
