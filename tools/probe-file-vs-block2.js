// 代码文件 token 对照#2:先聚焦文件页签再采样
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 找到 minimap-test.py 的页签并聚焦
    const tabs = [...document.querySelectorAll(".layout-tab-bar .item__text, .fn__flex-1 .item-text, span")].filter(e => e.textContent.trim() === "minimap-test.py");
    if (tabs.length) tabs[0].closest(".item")?.querySelector(".item__full, .item-text")?.click() || tabs[0].click();
    await sleep(800);
    const fileEd = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock") && e.offsetParent !== null);
    if (!fileEd) return "no visible file editor";
    await sleep(400);
    const spans = [...fileEd.querySelectorAll(".view-line span[class*='mtk']")];
    const find = (txt) => {
        const s = spans.find(x => x.textContent.trim() === txt);
        return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
    };
    return JSON.stringify({
        lineCount: fileEd.querySelectorAll(".view-line").length,
        spanCount: spans.length,
        firstLineText: fileEd.querySelector(".view-line")?.textContent?.slice(0, 30),
        def: find("def"), import: find("import"), return: find("return"),
        editorBg: getComputedStyle(fileEd).backgroundColor,
    }, null, 1);
})()
