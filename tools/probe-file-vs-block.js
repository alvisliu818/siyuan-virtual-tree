// 代码文件 vs 块内编辑态:token 颜色同源性对照
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    // 打开 py 代码文件(插件的文件编辑器 = Monaco)
    p.openFile ? p.openFile("E:/HOME/Local/siyuan-test-ws/data/minimap-test.py") : p.openCodeFile?.("E:/HOME/Local/siyuan-test-ws/data/minimap-test.py");
    // 等 monaco 文件编辑器出现(不在代码块卡片内的那个)
    let fileEd = null;
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        fileEd = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock"));
        if (fileEd) break;
    }
    if (!fileEd) return "file editor not opened";
    await sleep(600);
    const out = {};
    const sample = (me, label) => {
        const spans = [...me.querySelectorAll(".view-line span[class*='mtk']")].slice(0, 40);
        const find = (txt) => {
            const s = spans.find(x => x.textContent.trim() === txt);
            return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
        };
        return {
            editorBg: getComputedStyle(me).backgroundColor,
            def: find("def"), import: find("import"), return: find("return"),
        };
    };
    out.fileEditor = sample(fileEd, "file");
    // 恢复:焦点交回
    return JSON.stringify(out, null, 1);
})()
