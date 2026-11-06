// eq 修复验证:setValue 换代码(同块起始位置)→ 卡片内容应跟着变(不再滞留)
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const inst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (!inst || !inst._cm6) return "no cm6";
    const cardText = () => {
        const c = document.querySelector(".syfe-cm-codeblock-colorize");
        return c ? c.textContent.replace(/\u00a0/g, " ").slice(0, 40) : null;
    };
    // 初始内容 A(短行,卡片可见)
    inst._cm6.setValue("# eq验证\n\n```python\ncontentA = 1\n```");
    await sleep(1200);
    const a = cardText();
    // 同偏移换内容 B(块起始不变:标题行长度不变)
    inst._cm6.setValue("# eq验证\n\n```python\ncontentB = 2\n```");
    await sleep(1200);
    const b = cardText();
    return JSON.stringify({afterA: a, afterB: b, staleFixed: a === "contentA = 1" && b === "contentB = 2"}, null, 1);
})()
