// 深挖#3:编辑态 DOM 细节 —— def 灰框是谁、蓝线是谁、括号着色、横向溢出
(async () => {
    const me = document.querySelector(".syfe-cm-codeblock-body.is-editing .monaco-editor");
    if (!me) return "not in editing state";
    const out = {};
    // 1) "def" span 的类与背景
    const defSpan = [...me.querySelectorAll(".view-line span")].find(s => s.textContent === "def");
    if (defSpan) {
        const s = getComputedStyle(defSpan);
        out.defSpan = {cls: defSpan.className, color: s.color, bg: s.backgroundColor, fw: s.fontWeight, fst: s.fontStyle};
    }
    // 2) 卡片底部蓝线:扫描编辑态卡片内所有背景非透明的元素
    const card = document.querySelector(".syfe-cm-codeblock-body.is-editing");
    const painted = [];
    card.querySelectorAll("*").forEach(el => {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && !bg.startsWith("rgb(246, 246, 246)")) {
            const r = el.getBoundingClientRect();
            if (r.height > 0 && r.height < 14 && r.width > 100) {   // 细条元素
                painted.push({cls: (el.className || "").toString().slice(0, 60), bg, h: Math.round(r.height), w: Math.round(r.width)});
            }
        }
    });
    out.thinPainted = painted.slice(0, 8);
    // 3) 横向溢出与滚动条
    const scrollable = me.querySelector(".monaco-scrollable-element");
    const vs = me.querySelector(".lines-content");
    out.overflow = {
        scrollableW: scrollable ? scrollable.clientWidth : null,
        contentW: vs ? Math.round(parseFloat(vs.style.width) || vs.scrollWidth) : null,
        hSlider: (() => {
            const sl = me.querySelector(".scrollbar.horizontal > .slider");
            if (!sl) return null;
            const r = sl.getBoundingClientRect();
            return {w: Math.round(r.width), visible: r.width > 0 && getComputedStyle(sl).opacity !== "0"};
        })(),
    };
    // 4) 括号着色再次确认
    out.brackets = [...me.querySelectorAll("[class*='bracket-highlighting']")].slice(0, 4).map(b => ({
        cls: b.className, color: getComputedStyle(b).color, text: b.textContent,
    }));
    // 5) word highlight(occurrences)装饰存在性
    out.wordHighlight = [...me.querySelectorAll(".view-overlays .wordHighlight, .view-overlays .selectionHighlight, [class*='wordHighlight']")].length;
    return JSON.stringify(out, null, 1);
})()
