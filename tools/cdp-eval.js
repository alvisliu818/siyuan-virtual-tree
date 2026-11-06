// 极简 CDP eval 探针(Node 22 原生 WebSocket,零依赖):
//   node tools/cdp-eval.js '<js>'          # 在测试工作空间思源窗口执行,打印结果
//   node tools/cdp-eval.js '<js>' --port 9222
// 选窗:优先 URL 端口与 9222 /json/list 中 siyuan-test-ws 关键词,不碰主库窗口。
const http = require("http");

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let buf = "";
            res.on("data", (c) => (buf += c));
            res.on("end", () => resolve(JSON.parse(buf)));
        }).on("error", reject);
    });
}

async function main() {
    let js = process.argv[2];
    if (!js) {
        console.error("usage: node tools/cdp-eval.js '<js>'");
        process.exit(1);
    }
    // 以 .js 结尾且文件存在 → 从文件读(长探针脚本免引号转义)
    if (/\.js$/.test(js) && require("fs").existsSync(js)) {
        js = require("fs").readFileSync(js, "utf8");
    }
    const targets = await getJson("http://127.0.0.1:9222/json/list");
    // 选思源主窗口 page:URL 是 https://127.0.0.1:<port>/stage/build/app/
    const pages = targets.filter(t => t.type === "page" && /stage\/build\/app/.test(t.url));
    if (!pages.length) {
        console.error("no siyuan window target found");
        process.exit(1);
    }
    const wsUrl = pages[0].webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, {resolve, reject});
        ws.send(JSON.stringify({id: mid, method, params}));
    });
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    // 截图模式:node tools/cdp-eval.js --shot out.png
    if (process.argv[2] === "--shot") {
        await send("Page.enable", {});
        const s = await send("Page.captureScreenshot", {format: "png"});
        require("fs").writeFileSync(process.argv[3], Buffer.from(s.data, "base64"));
        console.log("saved", process.argv[3]);
        ws.close();
        process.exit(0);
    }
    // console 捕获模式:node tools/cdp-eval.js --console <毫秒> ['<过滤词>'] [reload]
    // reload 参数:先挂监听再触发刷新(抓 onload 期日志);内部复合 onmessage,
    // 不丢 evaluate 的响应解析。
    if (process.argv[2] === "--console") {
        await send("Runtime.enable", {});
        await send("Page.enable", {});
        const filter = process.argv[4] || "";
        const logs = [];
        const baseHandler = ws.onmessage;
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === "Runtime.consoleAPICalled") {
                const text = (msg.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
                if (!filter || text.includes(filter)) logs.push(`[${msg.params.type}] ${text}`);
            }
            if (baseHandler) baseHandler(ev);
        };
        if (process.argv[5] === "reload") {
            send("Page.enable", {})
                .then(() => send("Page.reload", {}));
        }
        await new Promise(r => setTimeout(r, parseInt(process.argv[3] || "8000", 10)));
        console.log(logs.join("\n") || "(no matching console output)");
        ws.close();
        process.exit(0);
    }
    const r = await send("Runtime.evaluate", {
        expression: js,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    if (r.exceptionDetails) {
        console.error("EXCEPTION:", JSON.stringify(r.exceptionDetails, null, 2));
    } else {
        const v = r.result.value;
        console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
    }
    ws.close();
    process.exit(0);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
