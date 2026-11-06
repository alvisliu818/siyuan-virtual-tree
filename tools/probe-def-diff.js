// def 着色差异剖析:块编辑态 vs 文件编辑器的 view-line 原始 HTML + mtk22 规则
(() => {
    const blockEd = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
    const fileEd = [...document.querySelectorAll(".monaco-editor")].find(e => !e.closest(".syfe-cm-codeblock") && e.offsetParent !== null);
    const out = {};
    if (blockEd) {
        const line1 = blockEd.querySelector(".view-line");
        out.blockFirstLineHtml = line1 ? line1.innerHTML.slice(0, 300) : null;
    }
    if (fileEd) {
        const defLine = [...fileEd.querySelectorAll(".view-line")].find(l => l.textContent.includes("def"));
        out.fileDefLineHtml = defLine ? defLine.innerHTML.slice(0, 300) : null;
    }
    // 主题 CSS:mtk22 / mtk1 规则
    const css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
    const m22 = css.match(/\.mtk22\s*\{[^}]*\}/);
    const m11 = css.match(/\.mtk11\s*\{[^}]*\}/);
    const m12 = css.match(/\.mtk12\s*\{[^}]*\}/);
    out.rules = {mtk22: m22 && m22[0], mtk11: m11 && m11[0], mtk12: m12 && m12[0]};
    return JSON.stringify(out, null, 1);
})()
