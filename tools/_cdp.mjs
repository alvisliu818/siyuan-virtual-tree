// 零依赖 CDP 探针(Node 22 自带 WebSocket,不需要 puppeteer-core)
// 调试思源插件用,对标 debug-siyuan-plugin skill 的 cdp-probe.js
//
// 用法:
//   node tools/_cdp.mjs targets                      列出所有窗口(含工作空间识别)
//   node tools/_cdp.mjs eval '<js>' [--win <端口|关键词>]   在指定窗口执行 JS
//   node tools/_cdp.mjs openws [工作空间路径]          通过 IPC 打开工作空间窗口
//   node tools/_cdp.mjs shot <out.png> [--win ...]     截图
//
// 纪律:主工作空间(6806)只读不写;对测试空间窗口做任何 eval 前用 --win 明确指定。

const CDP_PORT = 9222;

async function listTargets() {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return res.json();
}

// 从窗口 URL 里取内核端口:https://127.0.0.1:<port>/stage/build/app/
function kernelPort(url) {
    const m = String(url || "").match(/127\.0\.0\.1:(\d+)/);
    return m ? Number(m[1]) : 0;
}

async function evalIn(target, expr) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const id = Math.floor(Math.random() * 1e8);
    let result;
    let error;
    const done = new Promise((resolve) => {
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: {
                    expression: expr,
                    awaitPromise: true,
                    returnByValue: true,
                    userGesture: true,
                },
            }));
        });
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== id) return;
            if (msg.result?.exceptionDetails) {
                error = msg.result.exceptionDetails.exception?.description
                    || msg.result.exceptionDetails.text;
            } else {
                result = msg.result?.result?.value;
            }
            resolve();
        });
        ws.addEventListener("error", (e) => {
            error = "ws error: " + (e.message || "unknown");
            resolve();
        });
    });
    const timeout = new Promise((r) => setTimeout(() => { error = error || "超时(30s)"; r(); }, 30000));
    await Promise.race([done, timeout]);
    try { ws.close(); } catch { /* ignore */ }
    return {result, error};
}

function pickTarget(targets, win) {
    const pages = targets.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
    if (!pages.length) throw new Error("没有可用的 page target(思源窗口未打开?)");
    if (!win) return pages;
    const kw = String(win);
    const byPort = pages.find(t => kernelPort(t.url) === Number(kw));
    if (byPort) return byPort;
    const byUrl = pages.find(t => String(t.url).includes(kw) || String(t.title || "").includes(kw));
    if (byUrl) return byUrl;
    throw new Error(`没有匹配 "${kw}" 的窗口。可用端口: ${pages.map(p => kernelPort(p.url)).join(", ")}`);
}

async function describe(targets) {
    const rows = [];
    for (const t of targets.filter(x => x.type === "page")) {
        const port = kernelPort(t.url);
        let ws = "?";
        if (t.webSocketDebuggerUrl) {
            const r = await evalIn(t, "(window.siyuan?.config?.system?.workspaceDir) || (window.siyuan ? 'siyuan-ok' : 'no-siyuan')");
            ws = r.error ? "eval失败" : String(r.result);
        }
        rows.push({内核端口: port, 工作空间: ws, 标题: (t.title || "").slice(0, 40)});
    }
    console.table(rows);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const winIdx = rest.indexOf("--win");
    const win = winIdx >= 0 ? rest[winIdx + 1] : undefined;
    const positional = rest.filter((_, i) => i !== winIdx && i !== winIdx + 1);

    const targets = await listTargets();

    if (cmd === "targets") {
        await describe(targets);
        return;
    }

    if (cmd === "eval" || cmd === "evalFile") {
        // evalFile 从文件读 JS,避开 shell 传参的编码/引号坑(中文标识符会被搞坏)
        const expr = cmd === "evalFile"
            ? (await import("node:fs")).readFileSync(positional[0], "utf8")
            : positional[0];
        if (!expr) throw new Error("缺少 JS 表达式");
        const t = pickTarget(targets, win);
        const port = kernelPort(t.url);
        const r = await evalIn(t, expr);
        console.log(`[窗口 内核端口 ${port}]`);
        if (r.error) console.log("ERROR:", r.error);
        else console.log(typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
        return;
    }

    if (cmd === "openws") {
        // 反斜杠会被序列化吃掉,必须运行时拼(gotchas 记录)
        const wsPath = positional[0] || "E:\\HOME\\Local\\siyuan-test-ws";
        const t = pickTarget(targets, win);
        const js = `(() => {
            const p = ${JSON.stringify(wsPath)}.split("\\\\").join(String.fromCharCode(92));
            require("electron").ipcRenderer.send("siyuan-open-workspace", {workspace: p, lang: "zh-CN"});
            return "sent: " + p;
        })()`;
        const r = await evalIn(t, js);
        console.log(r.error ? "ERROR: " + r.error : String(r.result));
        return;
    }

    if (cmd === "shot") {
        const out = positional[0] || "shot.png";
        const t = pickTarget(targets, win);
        const fs = await import("node:fs");
        const r = await evalIn(t, "1"); // 先确认窗口活着
        if (r.error) throw new Error("窗口不可用: " + r.error);
        // 走 CDP Page.captureScreenshot
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        const data = await new Promise((resolve, reject) => {
            const id = Math.floor(Math.random() * 1e8);
            const timer = setTimeout(() => reject(new Error("截图超时(窗口可能被最小化)")), 20000);
            ws.addEventListener("open", () => ws.send(JSON.stringify({id, method: "Page.captureScreenshot", params: {format: "png"}})));
            ws.addEventListener("message", (ev) => {
                const m = JSON.parse(ev.data);
                if (m.id !== id) return;
                clearTimeout(timer);
                if (m.result?.data) resolve(m.result.data);
                else reject(new Error("无截图数据: " + JSON.stringify(m).slice(0, 200)));
            });
            ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("ws error")); });
        });
        fs.writeFileSync(out, Buffer.from(data, "base64"));
        console.log("已保存", out);
        return;
    }

    if (cmd === "type") {
        // 真实按键注入(Input.dispatchKeyEvent),走 xterm 的输入链路
        const text = positional[0] || "";
        const t = pickTarget(targets, win);
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        let msgId = 0;
        const pending = new Map();
        const send = (method, params) => new Promise((resolve, reject) => {
            const id = ++msgId + Math.floor(Math.random() * 1e6);
            pending.set(id, {resolve, reject});
            ws.send(JSON.stringify({id, method, params}));
        });
        ws.addEventListener("message", (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                if (m.error) p.reject(new Error(m.error.message));
                else p.resolve(m.result);
            }
        });
        await new Promise((res, rej) => {
            ws.addEventListener("open", res);
            ws.addEventListener("error", () => rej(new Error("ws 连接失败")));
        });

        // 先聚焦 xterm 的辅助 textarea
        const focused = await evalIn(t, `(() => {
            const ta = document.querySelector(".xterm-helper-textarea");
            if (!ta) return "no textarea";
            ta.focus();
            return document.activeElement === ta ? "focused" : "focus-failed";
        })()`);
        console.log("聚焦:", focused.result ?? focused.error);

        for (const ch of text) {
            await send("Input.dispatchKeyEvent", {type: "keyDown", text: ch, unmodifiedText: ch});
            await send("Input.dispatchKeyEvent", {type: "keyUp", text: ch, unmodifiedText: ch});
            await new Promise(r => setTimeout(r, 30));
        }
        // 回车
        await send("Input.dispatchKeyEvent", {type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter"});
        await send("Input.dispatchKeyEvent", {type: "char", text: "\r"});
        await send("Input.dispatchKeyEvent", {type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter"});
        console.log("已输入:", JSON.stringify(text));
        ws.close();
        return;
    }

    console.log("用法: targets | eval '<js>' [--win X] | evalFile <path> [--win X] | type <text> [--win X] | openws [path] [--win X] | shot out.png [--win X]");
}

main().catch(e => {
    console.error("失败:", e.message);
    process.exit(1);
});
