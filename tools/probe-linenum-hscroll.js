// 横向滚动行号验证:长代码行让卡片可横滚,滚完后行号应钉在原位(仍在视野内)
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const inst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (!inst || !inst._cm6) return "no cm6";
    // 换成带长行的代码(块放在标题行后,setValue 后光标落在标题行 = 块外 → 卡片态)
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    inst._cm6.setValue('# 行号验证\n\n```python\nx = "' + "L".repeat(1200) + '"\ny = 2\nz = 3\n```');
    await sleep(1200);
    const body = document.querySelector(".syfe-cm-codeblock-body");
    if (!body) return "no body";
    const before = {
        scrollable: body.scrollWidth > body.clientWidth,
        scrollWidth: body.scrollWidth,
        numLeft: (() => { const n = document.querySelector(".syfe-cm-cl-n"); return n ? Math.round(n.getBoundingClientRect().left) : null; })(),
    };
    body.scrollLeft = 300;
    await sleep(300);
    const n = document.querySelector(".syfe-cm-cl-n");
    const code = document.querySelector(".syfe-cm-cl-c");
    const after = {
        scrollLeft: body.scrollLeft,
        numLeft: n ? Math.round(n.getBoundingClientRect().left) : null,
        numVisible: n ? n.getBoundingClientRect().right > 0 : null,
        codeLeft: code ? Math.round(code.getBoundingClientRect().left) : null,
    };
    body.scrollLeft = 0;
    // 恢复夹具内容
    inst._cm6.setValue('# 渲染夹具一级标题\n\n## 二级标题\n\n```python\ndef hello():\n    print("code block")\n```');
    return JSON.stringify({before, after}, null, 1);
})()
