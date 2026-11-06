// 对比块 model vs 文件 model 的 grammarTokens 内部状态
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    const S = window.__syfeMonacoBlock || {};
    for (let i = 0; i < 20; i++) { await sleep(250); if (S.blockModel) break; }
    if (!S.blockModel) return "not mounted";
    await sleep(2500);
    const bm = S.blockModel;
    const fm = ((p.getOpenedTab()["siyuan-file-editor-tab"] || []).slice(-1)[0]?._editor)?.getModel();
    const desc = (m) => {
        if (!m) return null;
        const part = m._tokenizationTextModelPart;
        const gt = part && part.grammarTokens;
        if (!gt) return {noGrammarTokens: true};
        const out = {};
        for (const k of Object.keys(gt)) {
            const v = gt[k];
            const t = typeof v;
            if (t === "function") continue;
            if (v instanceof Map) out[k] = "Map(" + v.size + ")";
            else if (v instanceof Set) out[k] = "Set(" + v.size + ")";
            else if (v && v.then) out[k] = "Promise";
            else if (t === "object" && v) out[k] = "obj{" + Object.keys(v).slice(0, 6).join(",") + "}";
            else out[k] = v;
        }
        return out;
    };
    const result = {block: desc(bm), file: desc(fm)};
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(result, null, 1);
})()
