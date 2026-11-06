// 开关热链验证 v3:修插入遗留的行尾逗号 → false→true→false 两跳真切换
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const settingsPath = "/data/storage/petal/siyuan-virtual-tree/settings.json";
    p.openFile(settingsPath);
    let inst = null;
    for (let i = 0; i < 30; i++) {
        await sleep(300);
        inst = (p.getOpenedTab()["siyuan-file-editor-tab"] || []).find(t => t._path === settingsPath);
        if (inst && inst._editor && inst._editor.getModel()) break;
    }
    if (!inst || !inst._editor) return "settings tab not opened";
    const ed = inst._editor;
    const model = ed.getModel();
    const KEY = '"markdown.cm6CodeBlockMonaco"';
    // 修首轮探针插入遗留:键行末尾缺逗号(下一键跟随) → 补上
    const keyLineNo = model.findMatches(KEY, false, false, false, null, false)[0]?.range.startLineNumber;
    if (!keyLineNo) return "key line not found";
    const keyLine = model.getLineContent(keyLineNo);
    if (!/,\s*$/.test(keyLine)) {
        ed.executeEdits("probe", [{
            range: {startLineNumber: keyLineNo, startColumn: keyLine.length + 1, endLineNumber: keyLineNo, endColumn: keyLine.length + 1},
            text: ",",
        }]);
        await inst.save();
        await sleep(1500);
    }
    const setVal = async (v) => {
        const cur = v ? "false" : "true";
        const m = model.findMatches(KEY + ": " + cur, false, false, false, null, false)[0];
        if (!m) return "anchor(" + v + ") not found";
        ed.executeEdits("probe", [{range: m.range, text: KEY + ": " + (v ? "true" : "false")}]);
        await inst.save();
        await sleep(1500);
        return null;
    };
    const out = {};
    out.before = {cards: document.querySelectorAll(".syfe-cm-codeblock").length, config: p.config.cm6CodeBlockMonaco};
    let err = await setVal(true);
    if (err) return err;
    out.afterTrue = {cards: document.querySelectorAll(".syfe-cm-codeblock").length, config: p.config.cm6CodeBlockMonaco};
    err = await setVal(false);
    if (err) return err;
    out.afterFalse = {cards: document.querySelectorAll(".syfe-cm-codeblock").length, config: p.config.cm6CodeBlockMonaco};
    out.fenceVisibleWhenOff = [...document.querySelectorAll(".cm-line")].some(l => l.textContent.indexOf("```") === 0);
    return JSON.stringify(out, null, 1);
})()
