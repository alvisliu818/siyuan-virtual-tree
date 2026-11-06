// 独立 pyright 实例:didOpen fixture 代码 → 解码 semanticTokens/full 五元组
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const req = window.require;
    const cp = req("child_process");
    const pathMod = req("path");
    const os = req("os");
    const ws = window.siyuan.config.system.workspaceDir.replace(/[\\/]+$/, "");
    const entry = ws + "/data/plugins/siyuan-virtual-tree/pyright/langserver.index.js";
    const code = "def hello():\n    print(\"code block\")";
    const filePath = pathMod.join(os.tmpdir(), "syfe-blocks", "block-manual-probe.py");
    const child = cp.spawn(process.execPath, [entry, "--stdio"], {
        env: {...process.env, ELECTRON_RUN_AS_NODE: "1"},
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const send = (obj) => {
        const m = JSON.stringify(obj);
        child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`);
    };
    const buffers = [];
    child.stdout.on("data", d => buffers.push(d));
    const readResponses = async (wantIds, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const all = Buffer.concat(buffers).toString("utf8");
            const parts = all.split("Content-Length:").slice(1).map(p => {
                const m = p.match(/\d+\r\n\r\n([\s\S]+)/);
                return m ? m[1] : "";
            });
            for (const body of parts) {
                try {
                    const j = JSON.parse(body.slice(0, body.lastIndexOf("}") + 1));
                    if (wantIds.includes(j.id)) return j;
                } catch { /* 未完整 */ }
            }
            await sleep(200);
        }
        return null;
    };
    send({jsonrpc: "2.0", id: 1, method: "initialize", params: {processId: null, rootUri: null, capabilities: {}}});
    await readResponses([1], 20000);
    send({jsonrpc: "2.0", method: "initialized", params: {}});
    send({jsonrpc: "2.0", method: "textDocument/didOpen", params: {textDocument: {
        uri: "file:///" + filePath.replace(/\\/g, "/").replace(/^\/?/, ""), languageId: "python", version: 1, text: code,
    }}});
    await sleep(2500);   // 等分析
    send({jsonrpc: "2.0", id: 2, method: "textDocument/semanticTokens/full", params: {textDocument: {uri: "file:///" + filePath.replace(/\\/g, "/").replace(/^\/?/, "")}}});
    const resp = await readResponses([2], 15000);
    try { child.kill(); } catch { /* ignore */ }
    if (!resp) return "no semantic tokens response";
    const data = resp.result && resp.result.data ? resp.result.data : [];
    // 五元组 → 可读
    const lines = code.split("\n");
    let line = 0, col = 0;
    const out = [];
    for (let i = 0; i + 4 < data.length; i += 5) {
        const dl = data[i], ds = data[i + 1], len = data[i + 2], tt = data[i + 3], mods = data[i + 4];
        line += dl;
        col = dl > 0 ? ds : col + ds;
        out.push({text: (lines[line] || "").slice(col, col + len), line, col, len, type: tt, mods});
    }
    return JSON.stringify({count: data.length / 5, tokens: out}, null, 1);
})()
