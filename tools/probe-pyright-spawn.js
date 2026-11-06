// pyright langserver 手动握手测试:ELECTRON_RUN_AS_NODE spawn + initialize 请求
(async () => {
    const req = window.require;
    const cp = req("child_process");
    const ws = window.siyuan.config.system.workspaceDir.replace(/[\\/]+$/, "");
    const entry = ws + "/data/plugins/siyuan-virtual-tree/pyright/langserver.index.js";
    const child = cp.spawn(process.execPath, [entry, "--stdio"], {
        cwd: undefined,
        env: {...process.env, ELECTRON_RUN_AS_NODE: "1"},
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const out = {spawned: true, pid: child.pid, stderr: [], exited: null, initResponse: false, elapsedMs: null};
    child.stderr.on("data", d => out.stderr.push(d.toString().slice(0, 200)));
    child.on("exit", (code) => { out.exited = code; });
    // LSP initialize 请求(Content-Length 头 + JSON)
    const msg = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {
        processId: null, rootUri: null, capabilities: {},
    }});
    const wire = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    const t0 = Date.now();
    child.stdout.on("data", (d) => {
        if (d.toString().includes('"id":1') || d.toString().includes("capabilities")) {
            out.initResponse = true;
            out.elapsedMs = Date.now() - t0;
        }
    });
    child.stdin.write(wire);
    await new Promise(r => setTimeout(r, 20000));
    try { child.kill(); } catch (e) { /* ignore */ }
    return JSON.stringify(out, null, 1);
})()
