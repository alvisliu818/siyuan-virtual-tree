// 复现插件版 initialize:pythonPath + rootUri + capabilities,测响应耗时
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const req = window.require;
    const cp = req("child_process");
    const ws = window.siyuan.config.system.workspaceDir.replace(/[\\/]+$/, "");
    const entry = ws + "/data/plugins/siyuan-virtual-tree/pyright/langserver.index.js";
    const child = cp.spawn(process.execPath, [entry, "--stdio"], {
        cwd: ws + "/data",   // 插件的 workspaceRoot 语义(首个 didOpen 文件目录)
        env: {...process.env, ELECTRON_RUN_AS_NODE: "1"},
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const out = {pid: child.pid, exited: null, stderr: [], elapsedMs: null, serverInfo: null};
    child.stderr.on("data", d => out.stderr.push(d.toString().slice(0, 150)));
    child.on("exit", c => { out.exited = c; });
    const msg = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {
        processId: process.pid,
        clientInfo: {name: "siyuan-virtual-tree", version: "1.0.0"},
        rootUri: "file:///" + (ws + "/data").replace(/\\/g, "/").replace(/^\/?/, ""),
        workspaceFolders: [{uri: "file:///" + (ws + "/data").replace(/\\/g, "/").replace(/^\/?/, ""), name: "workspace"}],
        capabilities: {initializationOptions: {}},
        initializationOptions: {pythonPath: "D:/programs/anaconda3/envs/ai/python.exe"},
        trace: "off",
    }});
    const wire = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    const t0 = Date.now();
    child.stdout.on("data", d => {
        const s = d.toString();
        if (!out.elapsedMs && s.includes("serverInfo")) {
            out.elapsedMs = Date.now() - t0;
            try { out.serverInfo = JSON.parse(s.slice(s.indexOf("{"))).result.serverInfo; } catch { /* ignore */ }
        }
    });
    child.stdin.write(wire);
    await sleep(30000);
    try { child.kill(); } catch { /* ignore */ }
    return JSON.stringify(out, null, 1);
})()
