// 极简 CDP eval 探针(Node 22 原生 WebSocket,零依赖):
//   node tools/cdp-eval.js '<js>'          # 在测试工作空间(siyuan-test-ws)窗口执行
//   node tools/cdp-eval.js '<js>' --main  # 显式指定主库窗口(默认拒绝连主库)
// 选窗:按 window.siyuan.config.system.workspaceDir 认测试库,不按 URL 端口猜
// (second-instance 转发后测试库端口是随机的)。测试库窗口没开时直接报错。
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

// 读取某个 page 的工作空间路径。测试库端口是 second-instance 转发后随机的,
// 不能按 URL 端口猜,必须按 workspaceDir 认。
function workspaceOf(wsUrl) {
    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            try { ws.close(); } catch { /* ignore */ }
            resolve("");
        }, 3000);
        ws.onopen = () => ws.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {expression: "window.siyuan?.config?.system?.workspaceDir || ''", returnByValue: true},
        }));
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== 1) return;
            clearTimeout(timer);
            ws.close();
            resolve(String(msg.result?.result?.value || ""));
        };
        ws.onerror = () => {
            clearTimeout(timer);
            resolve("");
        };
    });
}

async function main() {
    // 硬超时:窗口被用户占用/关闭时 CDP 连接与 evaluate 可能无限挂起
    // (探针铁律:脚本必须自带超时;--shot/--console 自有时长不在此限)
    if (!["--shot", "--console"].includes(process.argv[2])) {
        setTimeout(() => { console.error("HARD TIMEOUT (cdp-eval, 25s)"); process.exit(2); }, 25000);
    }
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
    const pages = targets.filter(t => t.type === "page" && /stage\/build\/app/.test(t.url));
    if (!pages.length) {
        console.error("no siyuan window target found");
        process.exit(1);
    }
    // 默认只连测试库(用户约定:测试默认用测试库,主库禁测)。
    // 显式 --main 才连主库;没开测试库窗口时直接报错,绝不悄悄落到主库。
    const wantMain = process.argv.includes("--main");
    let chosen = null;
    for (const p of pages) {
        const wsd = await workspaceOf(p.webSocketDebuggerUrl);
        const isTest = wsd.includes("siyuan-test-ws");
        if (wantMain ? !isTest : isTest) {
            chosen = p;
            break;
        }
    }
    if (!chosen) {
        console.error(wantMain
            ? "no MAIN workspace window found"
            : "no TEST workspace window found; start E:/HOME/Local/sy-cdp/start-sy-test.bat (refusing to probe main workspace)");
        process.exit(1);
    }
    const wsUrl = chosen.webSocketDebuggerUrl;
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
