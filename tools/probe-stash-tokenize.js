// stash 单例分词测试:setModel 新 python model → 采样 stash 编辑器的 token
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const S = window.__syfeMonacoBlock || {};
    if (!S.editor || !S.stash) return "no singleton/stash";
    const model = window.__syfeTestModel = (window.__syfeTestModel && !window.__syfeTestModel.isDisposed())
        ? window.__syfeTestModel
        : null;
    if (!model) {
        // 通过 S.editor 自己创建(避免直接引用 monaco 命名空间)
        // createModel 不可达 —— 复用块挂载链路:借用 mountBlockEditor?太重。
        // 直接用 stash 编辑器 + 既有 model 不可行,先看 S.editor 现状:
        return JSON.stringify({
            hasEditor: !!S.editor,
            stashHasEditor: !!S.stash.querySelector(".monaco-editor"),
            domNodeParent: S.domNode && S.domNode.parentElement ? S.domNode.parentElement.className.slice(0, 30) : null,
        });
    }
})()
