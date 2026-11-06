// 围栏态收起:光标移到块外(模拟点击块外一行)→ 卡片应回来
(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")];
    const fenceIdx = lines.findIndex(l => l.textContent.startsWith("```") || l.textContent.trim() === "$$" || l.textContent.includes("|"));
    // 点击公式块下方区域外的一行(比如第 0 行标题)让光标离开代码块
    const target = lines[0];
    if (!target) return "no lines";
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, clientX: Math.round(r.x + 5), clientY: Math.round(r.y + 5)}));
    return "clicked line 0";
})()
