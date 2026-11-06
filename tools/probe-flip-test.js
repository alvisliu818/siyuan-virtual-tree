// 翻转实验:进编辑态 → setModelLanguage plaintext→python → 看 bgState 与视图颜色
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    // 进编辑态(重试)
    let entered = false;
    for (let attempt = 0; attempt < 3 && !entered; attempt++) {
        const t = document.querySelector(".syfe-cm-codeblock-colorize");
        if (!t) return "no card";
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor")) { entered = true; break; }
        const r = t.getBoundingClientRect();
        t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
        for (let i = 0; i < 12; i++) {
            await sleep(300);
            if (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor")) { entered = true; break; }
        }
    }
    if (!entered) return "not mounted";
    const S = window.__syfeMonacoBlock || {};
    const model = S.blockModel;
    if (!model) return "no model";
    const gt = () => model._tokenizationTextModelPart.grammarTokens;
    const viewSpans = () => {
        const me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
        return [...((me && me.querySelectorAll(".view-line span[class*='mtk']")) || [])].slice(0, 4).map(s => ({cls: s.className, text: s.textContent.slice(0, 6)}));
    };
    const before = {bg: gt()._backgroundTokenizationState, spans: viewSpans()};
    // 翻转:setModelLanguage 需要 monaco 命名空间 —— 从 model 的 undoRedoService 等
    // 内部拿不到。改用模型 _languageIdCodec?都不可达。
    // ⭐ 但 S.editor 有 changeModelLanguage?IStandaloneCodeEditor 无此 API。
    // 用 updateOptions 触发不了。真正可达的翻转:在 model 上调内部
    // _tokenizationTextModelPart.grammarTokens.resetTokenization()?
    const gtObj = gt();
    let resetTried = false;
    for (const k of ["resetTokenization", "reset"]) {
        if (typeof gtObj[k] === "function") {
            try { gtObj[k](); resetTried = true; break; } catch { /* ignore */ }
        }
    }
    await sleep(1500);
    const after = {bg: gt()._backgroundTokenizationState, spans: viewSpans(), resetTried};
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify({before, after}, null, 1);
})()
