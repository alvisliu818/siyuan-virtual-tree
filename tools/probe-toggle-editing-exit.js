// 边界验证:开态进编辑 → 关开关 → 自动退出编辑态(单例卸载 + 卡片回落源码)
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const settingsPath = "/data/storage/petal/siyuan-virtual-tree/settings.json";
    // 1) 先开开关
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
    const setVal = async (v) => {
        const cur = v ? "false" : "true";
        const m = model.findMatches(KEY + ": " + cur, false, false, false, null, false)[0];
        if (!m) return "anchor(" + v + ") not found";
        ed.executeEdits("probe", [{range: m.range, text: KEY + ": " + (v ? "true" : "false")}]);
        await inst.save();
        await sleep(1500);
        return null;
    };
    let err = await setVal(true);
    if (err) return err;
    // 切回 md 页签
    const mdInst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (mdInst && mdInst.parent && mdInst.parent.headElement) mdInst.parent.headElement.click();
    await sleep(1500);
    // 2) 进编辑态
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card after enabling";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    let mounted = false;
    for (let i = 0; i < 20; i++) {
        await sleep(300);
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor")) { mounted = true; break; }
    }
    // 3) 关开关 → 应自动退出编辑态
    await setVal(false);
    const after = {
        editingKey: (window.__syfeMonacoBlock || {}).editingKey || null,
        monacoInDoc: !!document.querySelector(".syfe-cm-codeblock .monaco-editor"),
        cards: document.querySelectorAll(".syfe-cm-codeblock").length,
        fenceVisible: [...document.querySelectorAll(".cm-line")].some(l => l.textContent.indexOf("```") === 0),
    };
    return JSON.stringify({mounted, after}, null, 1);
})()
