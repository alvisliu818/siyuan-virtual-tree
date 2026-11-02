// cm6 代码块卡片样式验证探针 v2:过滤测量克隆、按 key 定位真卡
import fs from "node:fs";

const OUT = "E:/HOME/Code/siyuan/siyuan-virtual-tree/tools/_style-probe-out";
fs.mkdirSync(OUT, {recursive: true});
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
            res({ws, send, close: () => ws.close()});
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

async function evalIn(cdp, sessionId, expression) {
    const r = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}, sessionId);
    if (r.exceptionDetails) throw new Error("eval-exception: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result?.value;
}

const PICK_CARDS = `real = [...document.querySelectorAll(".syfe-cm-codeblock")].filter(c => !c.closest(".cm-measurement") && c.getBoundingClientRect().height > 0);`;

async function main() {
    const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    let picked = null, pickedSess = "";
    for (const p of list.filter(t => t.type === "page")) {
        try {
            const c = await cdpConnect(p.webSocketDebuggerUrl);
            const r = await c.send("Target.attachToTarget", {targetId: p.id, flatten: true});
            const sid = r.sessionId;
            let wsDir = "";
            try { wsDir = await evalIn(c, sid, "window.siyuan?.config?.system?.workspaceDir ?? ''"); } catch {}
            if (wsDir.includes("siyuan-test-ws")) { picked = c; pickedSess = sid; }
            else { try { c.close(); } catch {} }
        } catch {}
    }
    if (!picked) { log("FATAL: 未找到测试库 target"); process.exit(2); }
    const cdp = picked, sid = pickedSess;
    log("picked test workspace");

    // 引擎确认(cm6)
    const eng = await evalIn(cdp, sid, `(() => {
        const app = window.siyuan?.ws?.app || window.siyuan?.app;
        const target = (app?.plugins ?? []).find(p => typeof p.openMarkdown === "function");
        if (!target) return null;
        target.config = target.config ?? {};
        target.config.markdownEditor = "cm6";
        return target.config.markdownEditor;
    })()`);
    log("engine:", eng);

    const path = "E:/HOME/Local/siyuan-test-ws/data/20261006184719-k75sezg/style-probe.md";
    await evalIn(cdp, sid, `(async () => {
        const app = window.siyuan?.ws?.app || window.siyuan?.app;
        const target = (app?.plugins ?? []).find(p => typeof p.openMarkdown === "function");
        target.openMarkdown(${JSON.stringify(path)}, "live");
        await new Promise(r => setTimeout(r, 2600));
        return true;
    })()`);
    log("openMarkdown done");

    // 只测真卡
    const checks = await evalIn(cdp, sid, `(() => {
        ${PICK_CARDS}
        const cards = real;
        const out = {cardCount: cards.length};
        if (!cards.length) return out;
        const first = cards[0];
        const head = first.querySelector(".syfe-cm-codeblock-head");
        const body = first.querySelector(".syfe-cm-codeblock-body");
        const lang = first.querySelector(".syfe-cm-codeblock-lang");
        const copy = first.querySelector(".syfe-cm-codeblock-copy");
        out.first = {
            lang: lang?.textContent, cls: lang?.className,
            headH: head ? Math.round(head.getBoundingClientRect().height) : null,
            headBB: head ? getComputedStyle(head).borderBottomWidth : null,
            headTLR: head ? getComputedStyle(head).borderTopLeftRadius : null,
            bodyWS: body ? getComputedStyle(body).whiteSpace : null,
            bodyOX: body ? getComputedStyle(body).overflowX : null,
            bodyBg: body ? getComputedStyle(body).backgroundColor : null,
            bodyLH: body ? getComputedStyle(body).lineHeight : null,
            langTT: lang ? getComputedStyle(lang).textTransform : null,
            copyR: copy ? Math.round(copy.getBoundingClientRect().right) : null,
            headR: head ? Math.round(head.getBoundingClientRect().right) : null,
            cardH: Math.round(first.getBoundingClientRect().height),
        };
        // 长行卡(python)横向溢出
        const longCard = cards.find(c => (c.querySelector(".syfe-cm-codeblock-lang")?.textContent || "") === "python" && c !== first) || cards[cards.length - 1];
        const lbody = longCard?.querySelector(".syfe-cm-codeblock-body");
        const lcol = longCard?.querySelector(".syfe-cm-codeblock-colorize");
        out.long = {
            scrollW: lbody?.scrollWidth, clientW: lbody?.clientWidth,
            overflow: lbody ? lbody.scrollWidth > lbody.clientWidth : null,
            colScrollW: lcol?.scrollWidth,
            bodyStyleOX: lbody ? getComputedStyle(lbody).overflowX : null,
        };
        out.langs = cards.map(c => (c.querySelector(".syfe-cm-codeblock-lang")?.textContent ?? "") + "/" + Math.round(c.getBoundingClientRect().height));
        return out;
    })()`);
    log("checks:", JSON.stringify(checks, null, 1));

    // 点击真实的第一张卡进编辑态,按 key 找挂载结果
    const edChecks = await evalIn(cdp, sid, `(async () => {
        var real;
        ${PICK_CARDS}
        const card = real[0];
        if (!card) return {err: "no real card"};
        const key = card.dataset.blockKey;
        const body = card.querySelector(".syfe-cm-codeblock-body");
        body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, view: window}));
        await new Promise(r => setTimeout(r, 2600));
        // 重新取真卡(重建后 DOM 换新)
        ${PICK_CARDS}
        const cardNow = real.find(c => c.dataset.blockKey === key) || real[0];
        const bodyNow = cardNow?.querySelector(".syfe-cm-codeblock-body");
        const isEditing = bodyNow?.classList.contains("is-editing");
        const me = cardNow?.querySelector(".monaco-editor");
        const out = {key, isEditing: !!isEditing, hasMonaco: !!me};
        if (me) {
            out.lineNumbers = me.querySelectorAll(".line-numbers").length;
            const slider = me.querySelector(".monaco-scrollable-element > .scrollbar.horizontal");
            out.hSliderH = slider?.querySelector(".slider")?.getBoundingClientRect().height ?? null;
            out.hVisible = slider ? getComputedStyle(slider).display !== "none" && slider.getBoundingClientRect().height > 0 : false;
            out.monacoBg = getComputedStyle(me).backgroundColor;
            const host = cardNow.querySelector(".syfe-cm-codeblock-editorhost");
            out.hostPadL = host ? getComputedStyle(host).paddingLeft : null;
            out.hostPadR = host ? getComputedStyle(host).paddingRight : null;
            out.bodyPad = bodyNow ? getComputedStyle(bodyNow).padding : null;
            out.bodyOX = bodyNow ? getComputedStyle(bodyNow).overflowX : null;
            const surface = getComputedStyle(document.documentElement).getPropertyValue("--b3-theme-surface").trim();
            out.surfaceVar = surface;
            // 统一转 rgb 三元组比对(变量可能是 hex,计算值是 rgb());经临时节点归一化
            const rgb = (c) => {
                const d = document.createElement("i");
                d.style.color = c;
                document.body.appendChild(d);
                const v = getComputedStyle(d).color;
                d.remove();
                return (v.match(/\\d+/g) || []).slice(0, 3).join(",");
            };
            out.bgSurface = rgb(out.monacoBg) === rgb(surface);
            // 长行是否可横向滚(编辑态)
            const scrollable = me.querySelector(".monaco-scrollable-element");
            out.edScrollW = scrollable ? scrollable.scrollWidth : null;
            out.edClientW = scrollable ? scrollable.clientWidth : null;
        }
        return out;
    })()`);
    log("edit-checks:", JSON.stringify(edChecks, null, 1));

    const shot1 = await cdp.send("Page.captureScreenshot", {format: "png"}, sid).catch(() => null);
    if (shot1?.data) fs.writeFileSync(OUT + "/edit-state.png", Buffer.from(shot1.data, "base64"));
    await evalIn(cdp, sid, `(async () => {
        document.body.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true, view: window}));
        await new Promise(r => setTimeout(r, 700));
        return true;
    })()`);
    const shot2 = await cdp.send("Page.captureScreenshot", {format: "png"}, sid).catch(() => null);
    if (shot2?.data) fs.writeFileSync(OUT + "/read-state.png", Buffer.from(shot2.data, "base64"));

    const f = checks.first ?? {};
    const L = checks.long ?? {};
    const E = edChecks ?? {};
    const verdict = {
        cards3plus: (checks.cardCount ?? 0) >= 3,
        head22: f.headH === 22,
        noHeadBorder: f.headBB === "0px",
        headRadius: f.headTLR === "6px",
        nowrap: f.bodyWS === "pre",
        readHscroll: f.bodyOX === "scroll",
        langEmptyMarked: (f.cls || "").includes("is-empty"),
        lowercase: f.langTT === "lowercase",
        copyPinnedRight: f.copyR != null && f.headR != null && f.headR - f.copyR < 40,
        editing: E.isEditing === true,
        monaco: E.hasMonaco === true,
        noLineNumbers: E.lineNumbers === 0,
        hslider10: E.hSliderH === 10,
        bgSurface: E.bgSurface === true,
    };
    const pass = Object.values(verdict).filter(Boolean).length;
    log("VERDICT:", pass + "/" + Object.keys(verdict).length, JSON.stringify(verdict, null, 1));
    fs.writeFileSync(OUT + "/verdict.json", JSON.stringify({checks, edChecks, verdict}, null, 2));
    process.exit(0);
}

main().catch(e => { console.error("[probe] FATAL:", e); process.exit(1); });
