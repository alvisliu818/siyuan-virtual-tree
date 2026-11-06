// 重放插件精确 initialize 载荷(从 bundle 抠出的 caps)测耗时
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const req = window.require;
    const cp = req("child_process");
    const ws = window.siyuan.config.system.workspaceDir.replace(/[\\/]+$/, "");
    const entry = ws + "/data/plugins/siyuan-virtual-tree/pyright/langserver.index.js";
    const child = cp.spawn(process.execPath, [entry, "--stdio"], {
        env: {...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: "D:\\programs\\anaconda3\\envs\\ai;" + (process.env.PATH || "")},
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const caps = {
        textDocument: {
            synchronization: {dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false},
            completion: {dynamicRegistration: false, completionItem: {snippetSupport: false, commitCharactersSupport: false, documentationFormat: ["markdown", "plaintext"], deprecatedSupport: true, preselectSupport: false, labelDetailsSupport: true}, completionItemKind: {valueSet: Array.from({length: 25}, (_, i) => i + 1)}, contextSupport: false},
            hover: {dynamicRegistration: false, contentFormat: ["markdown", "plaintext"]},
            signatureHelp: {dynamicRegistration: false, signatureInformation: {documentationFormat: ["markdown", "plaintext"], parameterInformation: {labelOffsetSupport: false}}},
            definition: {dynamicRegistration: false, linkSupport: false},
            declaration: {dynamicRegistration: false, linkSupport: false},
            typeDefinition: {dynamicRegistration: false, linkSupport: false},
            references: {dynamicRegistration: false},
            documentSymbol: {dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true},
            semanticTokens: {dynamicRegistration: true, tokenTypes: ["namespace","type","class","enum","typeParameter","parameter","variable","property","enumMember","function","method","keyword","decorator","selfParameter","clsParameter"], tokenModifiers: ["declaration","definition","readonly","static","async","defaultLibrary","builtin","classMember","parameter"], formats: ["relative"], requests: {range: false, full: {delta: false}}, multilineTokenSupport: false, overlappingTokenSupport: false, serverCancelSupport: false, augmentsSyntaxTokens: true},
            publishDiagnostics: {relatedInformation: true, versionSupport: false, tagSupport: {valueSet: [1, 2]}},
        },
        workspace: {workspaceFolders: true, didChangeWatchedFiles: {dynamicRegistration: false}},
        general: {positionEncodings: ["utf-16"]},
        initializationOptions: {pythonPath: "D:/programs/anaconda3/envs/ai/python.exe"},
    };
    const out = {pid: child.pid, exited: null, elapsedMs: null, errCount: 0};
    child.stderr.on("data", d => { out.errCount++; if (out.errCount <= 3) out["stderr" + out.errCount] = d.toString().slice(0, 150); });
    child.on("exit", c => { out.exited = c; });
    const msg = JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {
        processId: process.pid,
        clientInfo: {name: "siyuan-virtual-tree", version: "1.0.0"},
        rootUri: null,
        workspaceFolders: null,
        capabilities: caps,
        trace: "off",
    }});
    const wire = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    const t0 = Date.now();
    child.stdout.on("data", d => { if (!out.elapsedMs && d.toString().includes("serverInfo")) out.elapsedMs = Date.now() - t0; });
    child.stdin.write(wire);
    await sleep(20000);
    try { child.kill(); } catch { /* ignore */ }
    return JSON.stringify(out, null, 1);
})()
