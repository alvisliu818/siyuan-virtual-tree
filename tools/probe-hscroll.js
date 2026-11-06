// 横向滚动场景探针:开关关 + 围栏内超长代码行,检查 CM6 是否出现横向滚动与行号行为
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const p = window.siyuan.ws.app.plugins.find(x => x.name === "siyuan-virtual-tree");
    const inst = (p.getOpenedTab()["siyuan-file-editor-markdown"] || [])[0];
    if (!inst || !inst._cm6) return "no cm6";
    // 开关关(源码态)+ 重建内容:围栏内放超长无空格行
    p.config.cm6CodeBlockMonaco = false;
    const longCode = "y = \"" + "Z".repeat(1500) + "\" YYYY-LONG-CODE";
    inst._cm6.setValue("```python\nx = 1\n" + longCode + "\n```\n# 渲染夹具一级标题");
    await sleep(800);
    const sc = document.querySelector(".cm-scroller");
    const out = {
        scrollWidth: sc.scrollWidth,
        clientWidth: sc.clientWidth,
        hScrollable: sc.scrollWidth > sc.clientWidth,
    };
    const longLines = [...document.querySelectorAll(".cm-line")].filter(l => l.textContent.includes("YYYY-LONG-CODE"));
    if (longLines.length) {
        const ll = longLines[0];
        out.longLine = {
            width: Math.round(ll.getBoundingClientRect().width),
            visualRows: Math.round(ll.getBoundingClientRect().height / 21),
        };
    }
    // 手动滚到底再滚回,模拟横向滚动(如有)
    sc.scrollLeft = 200;
    await sleep(200);
    const g = document.querySelector(".cm-gutters");
    out.afterHScroll = {
        scrollLeft: sc.scrollLeft,
        gutterLeft: g ? Math.round(g.getBoundingClientRect().left) : null,
        gutterXform: g ? g.style.transform || getComputedStyle(g).transform : null,
    };
    sc.scrollLeft = 0;
    return JSON.stringify(out, null, 1);
})()
