// 翻转实验:块 model plaintext→python 强制重分词,看 classic 着色是否回来
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    const S = window.__syfeMonacoBlock || {};
    for (let i = 0; i < 20; i++) { await sleep(250); if (S.blockModel) break; }
    if (!S.blockModel) return "not mounted";
    const before = [...(S.domNode ? S.domNode.querySelectorAll(".view-line span[class*='mtk']") : [])].slice(0, 4).map(s => ({cls: s.className, text: s.textContent.slice(0, 8)}));
    // 翻转
    const model = S.blockModel;
    const mm = model;
    // monaco.editor.setModelLanguage 需要 monaco 命名空间 —— 从 S.editor 的构造器取不到;
    // model.setLanguageLanguageId? 用 model 的内部 setLanguage 不可达。
    // 替代:model.changeLanguage? 0.50 ITextModel 无公开方法 —— 借 setModelLanguage
    // 的等价路径:model.setLanguageIfNeeded? 都不可达。直接试 model 的 setLanguageLanguage。
    // —— 改用还原路径:dispose 前的 model 上没有公开 API,这里只能读不能写。
    // 所以:验证「重设语言」走 read-only 分支 —— 报告内部 tokenization 状态代替。
    let tokState = null;
    try {
        const tok = mm.tokenization || (mm._tokenizationState ? null : null);
        tokState = {
            hasTokenization: !!mm.tokenization,
            state: mm.tokenization && mm.tokenization.state ? "has-state" : "no-state",
        };
    } catch (e) { tokState = {err: e.message}; }
    await sleep(1000);
    const after = [...(S.domNode ? S.domNode.querySelectorAll(".view-line span[class*='mtk']") : [])].slice(0, 4).map(s => ({cls: s.className, text: s.textContent.slice(0, 8)}));
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify({before, tokState, after}, null, 1);
})()
