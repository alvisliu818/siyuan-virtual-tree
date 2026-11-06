// 深挖#2:当前主题名 + colorize HTML 结构 + 代码文件编辑器对照
(async () => {
    const S = window.__syfeMonacoBlock || {};
    const out = {themeName: S.themeName};
    // colorize HTML 结构(首个代码块)
    const cdiv = document.querySelector(".syfe-cm-codeblock-body:not(.is-editing) .syfe-cm-codeblock-colorize")
        || document.querySelector(".syfe-cm-codeblock-colorize");
    if (cdiv) {
        out.colorizeHtmlHead = cdiv.innerHTML.slice(0, 400);
        // mtk span 采样:前 3 个带 mtk 类的
        out.mtkSpans = [...cdiv.querySelectorAll("span[class*='mtk']")].slice(0, 5).map(t => ({
            cls: t.className, color: getComputedStyle(t).color, text: t.textContent.slice(0, 12),
        }));
    }
    // 编辑态 monaco 内 mtk 采样(若在编辑态)
    const me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
    if (me) {
        out.monacoMtk = [...me.querySelectorAll("span[class*='mtk']")].slice(0, 5).map(t => ({
            cls: t.className, color: getComputedStyle(t).color, text: t.textContent.slice(0, 12),
        }));
    }
    // 主题 CSS:文档里 monaco 主题 style 的 editor.background 规则
    const themeCss = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n");
    const bgRule = themeCss.match(/\.monaco-editor\s*,\s*\.monaco-editor-background\s*\{[^}]*\}/);
    out.themeBgRule = bgRule ? bgRule[0] : null;
    const mtk1 = themeCss.match(/\.mtk1\s*\{[^}]*\}/);
    out.mtk1Rule = mtk1 ? mtk1[0] : null;
    return JSON.stringify(out, null, 1);
})()
