// 比对块 model vs 文件 model 的行 token 元数据(定位分词层差异)
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    // 进编辑态拿块 model
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    let S = window.__syfeMonacoBlock || {};
    for (let i = 0; i < 20; i++) { await sleep(250); if (S.blockModel) break; }
    const bm = S.blockModel;
    if (!bm) return "block model not mounted";
    await sleep(3000);   // 给分词充分时间
    const fm = ((p.getOpenedTab()["siyuan-file-editor-tab"] || []).slice(-1)[0]?._editor)?.getModel();
    const desc = (m, label) => {
        if (!m) return label + ": no model";
        const lt = m.getLineTokens(1);
        const out = {lang: m.getLanguageId(), line1: m.getLineContent(1).slice(0, 40)};
        try {
            // LineTokens:按偏移枚举 className/foreground
            const details = [];
            const n = lt.getCount();
            for (let i = 0; i < Math.min(n, 6); i++) {
                details.push({start: lt.getStartCharacter(i), end: lt.getEndCharacter(i), meta: lt.getMetadata(i).toString(16)});
            }
            out.tokens = details;
        } catch (e) {
            out.tokenErr = e.message;
        }
        return out;
    };
    const result = {block: desc(bm, "block"), file: desc(fm, "file")};
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(result, null, 1);
})()
