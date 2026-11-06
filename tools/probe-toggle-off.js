// 开关验证:在插件编辑器里改 settings.json 加 cm6CodeBlockMonaco:false 并保存 → 热生效链
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const settingsPath = "/data/storage/petal/siyuan-virtual-tree/settings.json";
    p.openFile(settingsPath);
    let inst = null;
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        inst = (p.getOpenedTab()["siyuan-file-editor-tab"] || []).find(t => (t._path || "").toLowerCase().endsWith("settings.json"));
        if (inst && inst._editor && inst._editor.getModel() && inst._editor.getModel().getValue().length > 10) break;
    }
    if (!inst || !inst._editor) return "settings tab not opened";
    const ed = inst._editor;
    const model = ed.getModel();
    if (!model.getValue().includes("cm6CodeBlockMonaco")) {
        // 在 "markdown.editor" 行后插入开关(带逗号收尾的行)
        const m = model.findMatches('"markdown.editor"', false, false, false, null, false)[0];
        if (!m) return "anchor not found";
        const line = model.getLineContent(m.range.startLineNumber);
        const at = {startLineNumber: m.range.startLineNumber, startColumn: line.length + 1, endLineNumber: m.range.startLineNumber, endColumn: line.length + 1};
        ed.executeEdits("probe", [{range: at, text: ",\n    \"markdown.cm6CodeBlockMonaco\": false"}]);
    }
    await inst.save();
    await sleep(1200);   // flush(400ms) + handleSettingsFileSaved + 扇出重建
    const cards = document.querySelectorAll(".syfe-cm-codeblock").length;
    const fenceLine = [...document.querySelectorAll(".cm-line")].some(l => l.textContent.indexOf("```") === 0);
    return JSON.stringify({saved: true, cards, fenceVisible: fenceLine, editingKey: (window.__syfeMonacoBlock || {}).editingKey || null});
})()
