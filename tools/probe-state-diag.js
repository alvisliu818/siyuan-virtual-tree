// 状态诊断:卡片/编辑态/围栏态 + colorize span 覆盖情况
(() => {
    const card = !!document.querySelector(".syfe-cm-codeblock");
    const editing = !!document.querySelector(".syfe-cm-codeblock-body.is-editing");
    const body = document.querySelector(".syfe-cm-codeblock-body");
    const fenceLine = [...document.querySelectorAll(".cm-line")].some(l => l.textContent.indexOf("```") === 0);
    const hello = [...document.querySelectorAll(".syfe-cm-codeblock-colorize span")].filter(x => x.textContent.trim() === "hello").pop();
    return JSON.stringify({
        card, editing, fenceLine,
        bodyCls: body ? body.className : null,
        hello: hello ? {color: getComputedStyle(hello).color, inline: hello.getAttribute("style") || ""} : null,
    });
})()
