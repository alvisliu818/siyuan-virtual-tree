// 探 monaco model 内部分词数据结构(0.50 内部形态)
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    const S = window.__syfeMonacoBlock || {};
    for (let i = 0; i < 20; i++) { await sleep(250); if (S.blockModel) break; }
    if (!S.blockModel) return "not mounted";
    await sleep(2500);
    const m = S.blockModel;
    const out = {};
    const keys = Object.keys(m);
    out.modelKeys = keys.filter(k => /token/i.test(k));
    try {
        const tok = m.tokenization;
        out.tokKeys = tok ? Object.keys(tok) : null;
        if (tok && tok.tokenizationState) out.stateKind = typeof tok.tokenizationState;
        if (tok && tok.state) out.hasState = !!tok.state;
    } catch (e) { out.tokErr = e.message; }
    // _tokens(旧内部)或 languageId
    try {
        out.langId = m.getLanguageId();
        const internal = m._tokens || (m.tokenization && m.tokenization._tokens);
        if (internal) {
            out.internalKeys = Object.keys(internal).slice(0, 10);
            // _tokenizationState / _defaultTokenizationState
            out.defTok = internal._defaultTokenizationState !== undefined ? "present" : "absent";
            out.tokStateKind = internal._tokenizationState ? (internal._tokenizationState.kind ?? typeof internal._tokenizationState) : null;
        }
    } catch (e) { out.intErr = e.message; }
    // 语言注册侧:LanguageService/registry 状态 —— 借 model.languageId 的 tokenization 支持
    try {
        // TokenizationRegistry 不可达,但 model 内部有 languageIdCode
        out.mightBeDefault = m.getLanguageId() === "python";
    } catch (e) { /* ignore */ }
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(out, null, 1);
})()
