// 横向滚动拒绝排查:computed overflow / 手动滚动各方式 / 层级结构
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const body = document.querySelector(".syfe-cm-codeblock-body");
    if (!body) return "no body";
    const out = {};
    const cs = getComputedStyle(body);
    out.computed = {overflowX: cs.overflowX, overflowY: cs.overflowY, width: cs.width, maxWidth: cs.maxWidth, display: cs.display};
    out.structure = {
        parentClass: body.parentElement.className,
        parentOverflow: getComputedStyle(body.parentElement).overflowX,
        gpClass: body.parentElement.parentElement.className,
        gpOverflow: getComputedStyle(body.parentElement.parentElement).overflowX,
    };
    // 各滚动方式
    body.scrollLeft = 300;
    out.afterAssign = body.scrollLeft;
    body.scrollTo({left: 300, behavior: "instant"});
    await sleep(100);
    out.afterScrollTo = body.scrollLeft;
    body.scrollBy({left: 300});
    await sleep(100);
    out.afterScrollBy = body.scrollLeft;
    // 行的实际宽度与容器
    const row = body.querySelector(".syfe-cm-cl");
    out.row = row ? {w: Math.round(row.getBoundingClientRect().width), minW: getComputedStyle(row).minWidth} : null;
    out.bodyRect = {w: Math.round(body.getBoundingClientRect().width), scrollW: body.scrollWidth, clientW: body.clientWidth};
    // wheel 事件模拟
    body.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true, deltaX: 300, deltaY: 0}));
    await sleep(100);
    out.afterWheel = body.scrollLeft;
    return JSON.stringify(out, null, 1);
})()
