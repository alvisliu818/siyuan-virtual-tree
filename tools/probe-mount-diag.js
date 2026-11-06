// 挂载诊断:捕获 console 错误 + 单例去向,定位 mountBlockEditor 静默失败点
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...a) => { logs.push("[E] " + a.map(x => (x && x.stack) ? x.stack.slice(0, 300) : String(x)).join(" ").slice(0, 300)); origError(...a); };
    console.warn = (...a) => { logs.push("[W] " + a.map(String).join(" ").slice(0, 200)); origWarn(...a); };
    window.addEventListener("error", (e) => logs.push("[uncaught] " + (e.error && e.error.stack ? e.error.stack.slice(0, 300) : e.message)));
    try {
        // 退出可能存在的编辑态
        if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) {
            document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
            await sleep(800);
        }
        const S = window.__syfeMonacoBlock || {};
        const before = {
            editorInStash: !!(S.stash && S.stash.querySelector(".monaco-editor")),
            editorInDoc: !!document.querySelector(".syfe-cm-codeblock .monaco-editor"),
            editingKey: S.editingKey,
            domNodeConnected: !!(S.domNode && S.domNode.isConnected),
        };
        // 进编辑态:实时查询 + 实时点击
        const t = document.querySelector(".syfe-cm-codeblock-colorize");
        if (!t) { console.error = origError; console.warn = origWarn; return "no card"; }
        const r = t.getBoundingClientRect();
        t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
        await sleep(2500);
        const S2 = window.__syfeMonacoBlock || {};
        const after = {
            editingKey: S2.editingKey,
            editorInStash: !!(S2.stash && S2.stash.querySelector(".monaco-editor")),
            editorInDoc: !!document.querySelector(".syfe-cm-codeblock .monaco-editor"),
            domNodeConnected: !!(S2.domNode && S2.domNode.isConnected),
            domNodeParent: S2.domNode && S2.domNode.parentElement ? S2.domNode.parentElement.className.slice(0, 40) : null,
            hostChildren: (() => { const h = document.querySelector(".syfe-cm-codeblock-body.is-editing .syfe-cm-codeblock-editorhost"); return h ? h.children.length : "no-host"; })(),
        };
        // 退出
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
        await sleep(500);
        console.error = origError; console.warn = origWarn;
        return JSON.stringify({before, after, logs: logs.slice(0, 10)}, null, 1);
    } catch (e) {
        console.error = origError; console.warn = origWarn;
        return JSON.stringify({fatal: e.message, stack: (e.stack || "").slice(0, 400), logs: logs.slice(0, 10)});
    }
})()
