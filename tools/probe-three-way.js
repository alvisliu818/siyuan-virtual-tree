// 三方对照:块阅读态(语义覆盖后) vs 块编辑态 vs 代码文件 —— hello/def/print 颜色
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const out = {};
    const card = document.querySelector(".syfe-cm-codeblock");
    if (card) {
        // 若在编辑态先退出
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) {
            document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
            await sleep(600);
        }
        const pick = (txt) => {
            const s = [...document.querySelectorAll(".syfe-cm-codeblock-colorize span")].filter(x => x.textContent.trim() === txt).pop();
            return s ? {cls: s.className, color: getComputedStyle(s).color, inline: s.getAttribute("style") || ""} : null;
        };
        out.reading = {hello: pick("hello"), def: pick("def"), print: pick("print")};
    }
    // 打开代码文件(minimap-test.py)并聚焦
    p.openFile("E:/HOME/Local/siyuan-test-ws/data/minimap-test.py");
    let fileEd = null;
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        fileEd = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock") && e.offsetParent !== null);
        if (fileEd) break;
    }
    if (fileEd) {
        await sleep(1500);   // 等语义 token
        const pick = (txt) => {
            const s = [...fileEd.querySelectorAll(".view-line span[class*='mtk']")].filter(x => x.textContent.trim() === txt).pop();
            return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
        };
        out.file = {hello: pick("hello"), def: pick("def"), print: pick("print"), name: pick("name")};
    }
    return JSON.stringify(out, null, 1);
})()
