// 挂载时间线:进编辑态后高频采样单例 DOM 去向,定位 detach 时点与自愈行为
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (document.querySelector(".syfe-cm-codeblock-body.is-editing")) {
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
        await sleep(800);
    }
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (!t) return "no card";
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 20), clientY: Math.round(r.y + 8)}));
    const snaps = [];
    for (let i = 0; i < 40; i++) {
        await sleep(150);
        const S = window.__syfeMonacoBlock || {};
        const liveHost = document.querySelector(".syfe-cm-codeblock-body.is-editing .syfe-cm-codeblock-editorhost");
        snaps.push({
            t: i * 150,
            key: S.editingKey ? String(S.editingKey).slice(0, 6) : null,
            conn: !!(S.domNode && S.domNode.isConnected),
            parent: S.domNode && S.domNode.parentElement ? S.domNode.parentElement.className.replace("syfe-cm-codeblock-", "sy-").slice(0, 24) : null,
            liveChild: liveHost ? liveHost.children.length : -1,
            monacoLines: (document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor") || {querySelectorAll: () => []}).querySelectorAll(".view-line").length,
        });
    }
    // 压缩:只保留变化点
    const compact = snaps.filter((s, i) => i === 0 || JSON.stringify(s) !== JSON.stringify(snaps[i - 1]));
    // 退出
    document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    await sleep(400);
    return JSON.stringify(compact, null, 0);
})()
