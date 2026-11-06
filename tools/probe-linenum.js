// 行号验证:阅读态行号列(定宽/sticky/对齐)+ 横向滚动行为 + 编辑态 Monaco 行号
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const inst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (!inst || !inst._cm6) return "no cm6";
    const out = {};
    // 阅读态行号
    const nums = [...document.querySelectorAll(".syfe-cm-cl-n")];
    const cells = [...document.querySelectorAll(".syfe-cm-cl")];
    out.reading = {
        rows: cells.length,
        numbers: nums.map(n => n.textContent),
        alignedX: (() => {
            const xs = new Set(nums.map(n => Math.round(n.getBoundingClientRect().left)));
            return xs.size === 1;
        })(),
        sticky: nums.length ? getComputedStyle(nums[0]).position : null,
    };
    // 长行 + 横向滚动:往卡片里塞长代码行(改文档由模型 API 走,不落盘验证即可)
    const body = document.querySelector(".syfe-cm-codeblock-body");
    if (body) {
        body.scrollLeft = 120;   // 强制横滚(内容若不够宽则 scrollLeft 归 0)
        await sleep(200);
        const n1 = document.querySelector(".syfe-cm-cl-n");
        out.hScroll = {
            scrollLeft: body.scrollLeft,
            numLeftAfterScroll: n1 ? Math.round(n1.getBoundingClientRect().left) : null,
            numStillVisible: n1 ? n1.getBoundingClientRect().left >= 0 : null,
        };
        body.scrollLeft = 0;
    }
    // 编辑态:点进卡片 → Monaco 行号
    const t = document.querySelector(".syfe-cm-codeblock-colorize");
    if (t) {
        const r = t.getBoundingClientRect();
        t.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 30), clientY: Math.round(r.y + 8)}));
        let me = null;
        for (let i = 0; i < 20; i++) {
            await sleep(300);
            me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
            if (me) break;
        }
        if (me) {
            await sleep(1200);
            const ln = me.querySelector(".margin-view-overlays .line-numbers");
            out.editing = {
                lineNumbers: !!ln,
                sample: ln ? ln.textContent : null,
                marginW: (() => { const m = me.querySelector(".margin"); return m ? Math.round(m.getBoundingClientRect().width) : null; })(),
            };
            document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
            await sleep(500);
        }
    }
    return JSON.stringify(out, null, 1);
})()
