// 对照:一次性匿名 model + 简编辑器,验证 TextMate 分词是否正常
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-9999px;top:0;width:600px;height:100px;";
    document.body.appendChild(holder);
    try {
        const monacoNs = window.monaco;
        if (!monacoNs) return "no window.monaco";
        const model = monacoNs.editor.createModel("def hello():\n    print(\"code block\")", "python");
        const ed = monacoNs.editor.create(holder, {
            model,
            automaticLayout: false,
            lineNumbers: "off",
            "semanticHighlighting.enabled": true,
        });
        await sleep(2500);
        const spans = [...ed.querySelectorAll(".view-line span[class*='mtk']")].slice(0, 8).map(s => ({cls: s.className, text: s.textContent.slice(0, 10)}));
        ed.dispose();
        model.dispose();
        holder.remove();
        return JSON.stringify(spans, null, 1);
    } catch (e) {
        holder.remove();
        return "ERR " + e.message;
    }
})()
