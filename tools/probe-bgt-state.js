// 对照两 model 的 background tokenization 状态 + too-large 标志
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    // 先确保文件 tab 打开
    p.openFile("E:/HOME/Local/siyuan-test-ws/data/minimap-test.py");
    await sleep(2000);
    // 再进块编辑态(带重试:点击目标可能在重建窗口中被替换)
    const S0 = window.__syfeMonacoBlock || {};
    let entered = false;
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
        const t = document.querySelector(".syfe-cm-codeblock-colorize");
        if (!t) return "no card";
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) { entered = true; break; }
        const r = t.getBoundingClientRect();
        t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
        for (let i = 0; i < 12; i++) {
            await sleep(300);
            if (document.querySelector(".syfe-cm-codeblock-body.is-editing .syfe-cm-codeblock-editorhost")) { entered = true; break; }
        }
    }
    const S = window.__syfeMonacoBlock || {};
    for (let i = 0; i < 20; i++) { await sleep(250); if (S.blockModel) break; }
    if (!S.blockModel) return "not mounted";
    await sleep(3000);
    const bm = S.blockModel;
    const fm = ((p.getOpenedTab()["siyuan-file-editor-tab"] || []).slice(-1)[0]?._editor)?.getModel();
    const desc = (m) => {
        if (!m) return "no model";
        const part = m._tokenizationTextModelPart;
        const gt = part && part.grammarTokens;
        if (!gt) return {noGrammarTokens: true};
        return {
            bgState: gt._backgroundTokenizationState,
            tooLarge: m._isTooLargeForTokenization,
            attachedViews: gt._attachedViewStates && gt._attachedViewStates._store && gt._attachedViewStates._store._toDispose ? gt._attachedViewStates._store._toDispose.length : "?",
            tokenizer: gt._tokenizer ? !!gt._tokenizer.tokenizationSupport : null,
            defaultBgTokenizerScheduled: gt._defaultBackgroundTokenizer ? gt._defaultBackgroundTokenizer._isScheduled : "?",
        };
    };
    const viewColors = {
        block: (() => { const me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor"); const s = me && me.querySelector(".view-line span[class*='mtk']"); return s ? s.className : null; })(),
        file: (() => { const fe = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock") && e.offsetParent !== null); const dl = fe && [...fe.querySelectorAll(".view-line")].find(l => l.textContent.includes("def")); const s = dl && dl.querySelector("span[class*='mtk']"); return s ? s.className : null; })(),
    };
    const result = {block: desc(bm), file: desc(fm), viewColors};
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(result, null, 1);
})()
