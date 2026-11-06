// 聚焦 minimap-test.py 页签后采样文件编辑器 token
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 找页签并点击
    const items = [...document.querySelectorAll(".layout-tab-bar .item, .fn__flex-column .item")];
    const tab = items.find(it => it.textContent.includes("minimap-test.py"));
    if (tab) {
        const head = tab.querySelector(".item__full") || tab.querySelector(".item-text") || tab;
        head.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
        head.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
        head.click();
    }
    await sleep(1000);
    const fileEd = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock") && e.offsetParent !== null);
    if (!fileEd) return "no visible file editor";
    await sleep(2000);
    const pick = (txt) => {
        const s = [...fileEd.querySelectorAll(".view-line span[class*='mtk']")].filter(x => x.textContent.trim() === txt).pop();
        return s ? {cls: s.className, color: getComputedStyle(s).color} : null;
    };
    const line0 = fileEd.querySelector(".view-line")?.textContent?.slice(0, 25);
    return JSON.stringify({line0, hello: pick("hello"), def: pick("def"), print: pick("print"), name: pick("name"), sys: pick("sys")}, null, 1);
})()
