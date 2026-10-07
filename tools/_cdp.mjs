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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // 注意:winIdx 为 -1(未传 --win)时不能按 i !== winIdx+1 过滤,那会误删第一个位置参数
    const positional = winIdx >= 0 ? rest.filter((_, i) => i !== winIdx && i !== winIdx + 1) : rest;

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

    if (cmd === "key") {
        // 通用按键注入(Input.dispatchKeyEvent),**不碰焦点**。
        //
        // 为什么需要它:type 子命令会先去聚焦 .xterm-helper-textarea,
        // 那是给终端用的;要操作编辑器正文里的内容时聚焦它反而会抢走选区,
        // 按键全都落到终端上去了(实测 Backspace 删不掉代码块里的字符)。
        //
        // 用法:key <键名或字符> [--win X]
        //   key Backspace / key Enter / key Escape / key abc
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
        // 常见键 → Windows 虚拟键码;不在表里的按普通字符逐个打
        const VK = {
            Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 46,
            ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
            Home: 36, End: 35, PageUp: 33, PageDown: 34,
        };
        for (const key of positional) {
            const vk = VK[key];
            if (vk) {
                const common = {windowsVirtualKeyCode: vk, key, code: key.length === 1 ? "Key" + key.toUpperCase() : key};
                await send("Input.dispatchKeyEvent", {type: "rawKeyDown", ...common});
                await send("Input.dispatchKeyEvent", {type: "keyUp", ...common});
            } else {
                for (const ch of key) {
                    await send("Input.dispatchKeyEvent", {type: "keyDown", text: ch, unmodifiedText: ch});
                    await send("Input.dispatchKeyEvent", {type: "keyUp", text: ch, unmodifiedText: ch});
                }
            }
            await wait(40);
        }
        ws.close();
        console.log("已发送按键:", positional.join(" + "));
        return;
    }

    if (cmd === "front") {
        // 把窗口提到前台并取消最小化。
        // 最小化/后台的 Electron 窗口不绘制(requestAnimationFrame 不触发),
        // 很多东西会一直挂着不初始化 —— 抓不到任何报错但就是不工作,很容易误判。
        const t = pickTarget(targets, win);
        const port = kernelPort(t.url);
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener("open", res);
            ws.addEventListener("error", () => rej(new Error("ws 连接失败")));
        });
        ws.send(JSON.stringify({id: 1, method: "Page.bringToFront"}));
        ws.send(JSON.stringify({
            id: 2,
            method: "Browser.setWindowBounds",
            params: {windowId: Number(t.windowId) || 0, bounds: {windowState: "normal"}},
        }));
        await wait(1200);
        try { ws.close(); } catch { /* ignore */ }
        const after = (await listTargets()).find((x) => kernelPort(x.url) === port);
        const state = after ? await evalIn(after, "document.visibilityState") : {error: "窗口消失"};
        console.log(`已请求前台;visibilityState=${state.result ?? state.error}`);
        return;
    }

    if (cmd === "mouse") {
        // 真实鼠标输入(Input.dispatchMouseEvent)。
        // 合成 MouseEvent 经常不灵:思源的文件树/标签栏有自己的命中判定
        // (closest(".b3-list-item__text")、isNotCtrl、双击计时器等),走原生事件最稳。
        // 用法:mouse <x> <y> [--clicks 2] [--moveto] [--win <端口>]
        const [sx, sy] = positional;
        const ci = rest.indexOf("--clicks");
        const clicks = ci >= 0 ? Number(rest[ci + 1]) : 1;
        const moveFirst = rest.includes("--moveto");
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
        const x = Number(sx);
        const y = Number(sy);
        if (moveFirst) {
            await send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y, button: "none"});
        }
        for (let c = 1; c <= clicks; c++) {
            await send("Input.dispatchMouseEvent", {type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: c});
            await send("Input.dispatchMouseEvent", {type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: c});
            if (c < clicks) await wait(80);
        }
        ws.close();
        console.log(`已在 (${x}, ${y}) 点击 ${clicks} 下`);
        return;
    }

    if (cmd === "reload") {
        // 页面重载。题目:reload 会断掉当前 ws,wevSuperSize 的 done promise 可能
        // 永远不 resolve;所以这里不等 Runtime.evaluate 的回包,只等它超时后
        // 再重新列一次 target 确认窗口活着。
        const t = pickTarget(targets, win);
        const port = kernelPort(t.url);
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        ws.addEventListener("open", () => ws.send(JSON.stringify({
            id: 1, method: "Page.reload", params: {ignoreCache: false},
        })));
        await wait(1500);
        try { ws.close(); } catch { /* ignore */ }
        // 轮询直到重载完成(页面能响应 eval)
        let ok = false;
        for (let i = 0; i < 20; i++) {
            await wait(1500);
            const fresh = (await listTargets()).find((x) => kernelPort(x.url) === port);
            if (!fresh) continue;
            const r = await evalIn(fresh, "document.readyState");
            if (!r.error && r.result === "complete") { ok = true; break; }
        }
        console.log(ok ? `窗口 ${port} 重载完成` : `窗口 ${port} 重载后 30s 仍未就绪`);
        return;
    }

    console.log("用法: targets | eval '<js>' [--win X] | evalFile <path> [--win X] | type <text> [--win X] | key <键名/字符> [--win X] | openws [path] [--win X] | shot out.png [--win X] | reload [--win X] | front [--win X] | mouse <x> <y> [--clicks N] [--win X]");
}

main().catch(e => {
    console.error("失败:", e.message);
    process.exit(1);
});
