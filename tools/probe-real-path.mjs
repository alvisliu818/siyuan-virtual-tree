// 用户真实路径终验:点击卡片 → 不做任何 scrollIntoView/探针滚动 → 检查页面横滚与布局
import fs from "node:fs";

const OUT = "E:/HOME/Code/siyuan/siyuan-virtual-tree/tools/_style-probe-out";
const log = (...a) => console.log("[probe]", ...a);

function cdpConnect(wsUrl) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () => {
            const send = (method, params = {}, sessionId) => new Promise((res2, rej2) => {
                const mid = ++id; pending.set(mid, {res: res2, rej: rej2});
                ws.send(JSON.stringify({id: mid, method, params, ...(sessionId ? {sessionId} : {})}));
            });
            res({send, close: () => ws.close()});
        });
        ws.addEventListener("error", () => rej(new Error("ws-error")));
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && pending.has(msg.id)) {
                const {res: r2, rej: j2} = pending.get(msg.id); pending.delete(msg.id);
                msg.error ? j2(new Error(JSON.stringify(msg.error))) : r2(msg.result);
            }
        });
    });
}

async function evalIn(cdp, sid, expression) {
    const r = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sid);
    if (r.exceptionDetails) throw new Error("eval-exception: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result?.value;
}

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
let picked = null;
for (const p of list.filter(t => t.type === "page")) {
    try {
        const c = await cdpConnect(p.webSocketDebuggerUrl);
        const r = await c.send("Target.attachToTarget", {targetId: p.id, flatten: true});
        const sid = r.sessionId;
        const dir = await evalIn(c, sid, "window.siyuan?.config?.system?.workspaceDir ?? ''").catch(() => "");
        if (dir.includes("siyuan-test-ws")) picked = {c, sid};
        else c.close();
    } catch {}
}
if (!picked) { log("FATAL: no test target"); process.exit(2); }
const {c, sid} = picked;

// 刷新 + 开文件(文档顶部,卡片天然在视口内,无需任何滚动)
await evalIn(c, sid, "location.reload(); true").catch(() => {});
await new Promise(r => setTimeout(r, 6000));
for (let i = 0; i < 15; i++) {
    const ok = await evalIn(c, sid, "!!window.siyuan?.ws?.app").catch(() => false);
    if (ok) break;
    await new Promise(r => setTimeout(r, 1000));
}
await evalIn(c, sid, `(async () => {
    const app = window.siyuan?.ws?.app || window.siyuan?.app;
    const target = (app?.plugins ?? []).find(p => typeof p.openMarkdown === "function");
    target.config = target.config ?? {};
    target.config.markdownEditor = "cm6";
    target.openMarkdown("E:/HOME/Local/siyuan-test-ws/data/20261006184719-k75sezg/style-probe.md", "live");
    await new Promise(r => setTimeout(r, 2200));
    return true;
})()`);

// 真实点击(唯一动作;卡片首卡在视口顶部区域)
const m = await evalIn(c, sid, `(async () => {
    const pick = () => [...document.querySelectorAll(".syfe-cm-codeblock")].filter(el => !el.closest(".cm-measurement") && el.getBoundingClientRect().height > 0);
    const card = pick()[0];
    if (!card) return {err: "no card"};
    const r0 = card.getBoundingClientRect();
    card.querySelector(".syfe-cm-codeblock-body").dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, view: window}));
    // 等 monaco 挂载(settle 循环 2s 覆盖重建窗口)
    await new Promise(r => setTimeout(r, 2400));
    const G = window.__syfeMonacoBlock;
    const root = G?.domNode;
    const me = root?.querySelector(":scope > .monaco-editor");
    const cardNow = root?.closest(".syfe-cm-codeblock");
    const r1 = cardNow?.getBoundingClientRect();
    const vs = me?.querySelector(".lines-content");
    const sc = me?.querySelector(".monaco-scrollable-element");
    return {
        editing: G?.editingKey,
        // 页面横流判定:卡片点击前后 x 位置不漂移
        cardXBefore: Math.round(r0.x),
        cardXAfter: Math.round(r1?.x ?? -1),
        xDrift: r1 ? Math.abs(Math.round(r1.x) - Math.round(r0.x)) : null,
        // 布局
        meW: Math.round(me?.getBoundingClientRect().width ?? 0),
        meH: Math.round(me?.getBoundingClientRect().height ?? 0),
        liW: G.editor ? G.editor.getLayoutInfo().width : null,
        vsW: vs?.style.width ?? null,
        scSW: sc?.scrollWidth ?? null,
        // 编辑器内容首行(验证内容在渲染)
        firstLine: me?.querySelector(".view-line")?.textContent?.slice(0, 30) ?? null,
        lnEls: me ? me.querySelectorAll(".line-numbers").length : null,
        sliderH: Math.round(me?.querySelector(".scrollbar.horizontal .slider")?.getBoundingClientRect().height ?? 0),
    };
})()`);
log("real-path:", JSON.stringify(m, null, 1));

const shot = await c.send("Page.captureScreenshot", {format: "png"}, sid);
fs.mkdirSync(OUT, {recursive: true});
fs.writeFileSync(OUT + "/real-path.png", Buffer.from(shot.data, "base64"));
log("shot saved");
process.exit(0);
