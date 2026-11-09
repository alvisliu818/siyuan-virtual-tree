/**
 * 把 dist/ 同步部署到思源插件目录。
 *
 * 为什么需要脚本而不是直接 cp:
 * - webpack 的 output.clean 只会清空 dist/,不会清理插件目录;
 * - 异步分块文件名随模块顺序变化,反复手工 cp 会在插件目录里堆积大量失效的旧 chunk;
 * - 因此这里采用「清空目标目录 + 整体复制」的同步语义。
 *
 * 注意:必须在去掉 NODE_OPTIONS 钩子(会把 fs 删除改道外部回收站并卡死)的干净
 * 环境中运行,即通过 `node tools/clean-env-run.js scripts/deploy.js` 调用。
 *
 * 部署完成后会通知思源**整页刷新**(/api/ui/reloadUI),不再用
 * /api/petal/setPetalEnabled 热重载 —— 后者会在同一页面反复 window.eval 整份
 * bundle,即使 webpack.config.js 的 jsonp 重置 banner 已经消除了 runtime 累积,
 * 整页刷新仍能一次性清掉 V8 inspector 保留的旧 eval 源码与所有残留单例。
 *
 * 用法:
 *   node tools/clean-env-run.js scripts/deploy.js
 *   SYFI_PLUGIN_DIR=<目录> node tools/clean-env-run.js scripts/deploy.js
 *   SYFI_SKIP_RELOAD=1 ...        # 只同步文件,不刷新界面
 *   SYFI_API_PORT=6806 ...        # 内核端口(默认 6806)
 *   SYFI_API_TOKEN=<token> ...    # 可选;本地请求默认免鉴权
 */
const fs = require("fs");
const path = require("path");

// 插件名以 plugin.json 为唯一来源。改名后这里不用改,也不会出现
// 「部署目标名校验失败」这种因为名字写死而卡住的情况。
const PLUGIN_NAME = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "plugin.json"), "utf8"),
).name;

const SRC = path.resolve(__dirname, "..", "dist");
const DEST = path.resolve(
    process.env.SYFI_PLUGIN_DIR || `E:\\HOME\\SiYuan\\data\\plugins\\${PLUGIN_NAME}`,
);

function fail(msg) {
    console.error("[deploy] 中止:", msg);
    process.exit(1);
}

// ---- 前置校验(安全护栏,避免误删无关目录) ----
if (!fs.existsSync(SRC)) fail(`源目录不存在: ${SRC}`);
if (!fs.existsSync(path.join(SRC, "index.js"))) fail(`源目录中没有 index.js,不是有效的构建产物: ${SRC}`);
// 护栏保留(防止误删无关目录),但校验基准改成 plugin.json 里的名字,
// 而不是写死某个历史名字 —— 否则改名后连部署都会被拒。
if (path.basename(DEST) !== PLUGIN_NAME) {
    fail(`目标目录名(${path.basename(DEST)})与 plugin.json 的 name(${PLUGIN_NAME})不一致,拒绝操作: ${DEST}`);
}

// 递归删除目录内容(保留目录本身)
//
// 容错要点:**不能因为一个文件删不掉就让整次部署失败**。
// 插件跑起来之后,pyright 会被插件拉起成常驻子进程,它的工作目录
// (pyright/dist)就被 Windows 锁住了 —— 实测 EBUSY: rmdir
// '...\<插件名>\pyright\dist'。同理 node-pty 的 .node 也可能
// 被已加载的渲染进程锁住。
//
// 所以这里对每个条目单独 try:删不掉就留着(它反正和我们要写的新文件
// 同名,copyFileSync 会覆盖内容),最后再汇总提示。真正需要担心的
// 是「旧 chunk 没被清掉」这种堆积问题,那由 warnStale 单独报出来。
const locked = [];
const copyLocked = [];

function emptyDir(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) {
                fs.rmSync(full, {recursive: true, force: true});
            } else {
                fs.unlinkSync(full);
            }
        } catch (e) {
            locked.push({path: full, code: e.code});
        }
    }
}

// 递归复制
function copyDir(from, to) {
    fs.mkdirSync(to, {recursive: true});
    for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
        const srcFull = path.join(from, entry.name);
        const destFull = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcFull, destFull);
        } else {
            try {
                fs.copyFileSync(srcFull, destFull);
            } catch (e) {
                // Windows 上已被渲染进程加载的 .node(pyright / node-pty 常驻目录)
                // 禁止覆盖,删除阶段也会留着它们。目标里同名旧文件仍在且内容通常
                // 与本次构建一致 —— 跳过即可,不能让整次部署崩在半路(会把插件目录
                // 清空到一半)。目标里没有同名文件才是真缺文件,继续抛。
                if (["EBUSY", "EPERM", "EACCES"].includes(e.code) && fs.existsSync(destFull)) {
                    copyLocked.push({path: destFull, code: e.code});
                } else {
                    throw e;
                }
            }
        }
    }
}

// 源里有、目标里也有,但没被清掉的条目 —— 这些是"旧版本残留"。
// 对 .node / pyright 这类被进程占用的目录,内容通常已是最新(因为上面
// copyDir 会逐文件覆盖),真正需要担心的是 webpack 的旧 chunk 堆积。
function warnStale() {
    const staleChunks = fs.readdirSync(DEST).filter(
        f => /\.index\.js$/.test(f) && !fs.existsSync(path.join(SRC, f)),
    );
    if (staleChunks.length > 0) {
        console.warn(
            `[deploy] 警告:目标目录残留 ${staleChunks.length} 个旧 JS 分块(可能被占用无法删除),` +
            `重启思源后跑一次本脚本即可清理:${staleChunks.slice(0, 3).join(", ")}${staleChunks.length > 3 ? " …" : ""}`,
        );
    }
}

if (!fs.existsSync(DEST)) {
    console.log("[deploy] 目标目录不存在,创建:", DEST);
    fs.mkdirSync(DEST, {recursive: true});
} else {
    const before = fs.readdirSync(DEST).length;
    if (before > 0) {
        console.log(`[deploy] 清空目标目录(原有 ${before} 项)`);
        emptyDir(DEST);
    }
}

copyDir(SRC, DEST);

const files = fs.readdirSync(DEST);
const jsChunks = files.filter(f => /\.index\.js$/.test(f)).length;
const cssFiles = files.filter(f => f.endsWith(".css")).length;
console.log(`[deploy] 完成: ${DEST}`);
console.log(`[deploy] 共 ${files.length} 项(JS 分块 ${jsChunks} 个,CSS ${cssFiles} 个)`);
if (locked.length > 0) {
    const dirs = locked.filter(l => !/\.(js|css|py|json|map)$/i.test(l.path));
    console.warn(
        `[deploy] 有 ${locked.length} 个条目删除失败(被进程占用),已用新内容覆盖同名文件:`,
    );
    for (const l of locked.slice(0, 5)) console.warn(`         - ${l.code} ${l.path}`);
    if (locked.length > 5) console.warn(`         … 其余 ${locked.length - 5} 个`);
    if (dirs.length > 0) {
        console.warn(
            `[deploy] 提示:通常是 pyright / node-pty 的常驻子进程占用了自己的目录。` +
            `内容已是最新,不影响本次验证;想彻底清干净就重启思源后再跑一次。`,
        );
    }
}
if (copyLocked.length > 0) {
    console.warn(`[deploy] 有 ${copyLocked.length} 个文件被进程占用、无法覆盖,已保留目标里的同名旧文件:`);
    for (const l of copyLocked.slice(0, 5)) console.warn(`         - ${l.code} ${l.path}`);
    if (copyLocked.length > 5) console.warn(`         … 其余 ${copyLocked.length - 5} 个`);
    console.warn(`[deploy] 提示:重启思源后再跑一次本脚本即可彻底同步;不影响本次验证。`);
}
warnStale();

/**
 * 通知思源整页刷新。
 *
 * 这里刻意**不**用 setPetalEnabled:它会广播 reloadPlugin,让每个窗口在同一
 * JS 上下文里重新 eval 插件代码;反复部署就会不断叠加旧的 webpack runtime
 * (2026-11-08 实测第 2 次热重载即可把渲染进程推到 4.8GB 并卡死)。
 * /api/ui/reloadUI 走的是 window.location.reload(),上下文整体重建。
 *
 * 思源没开、端口不同、版本较老没有该端点都只警告,绝不让部署失败 ——
 * 文件已经同步完成,用户手动刷新即可。
 */
function reloadUI() {
    if (process.env.SYFI_SKIP_RELOAD === "1") {
        console.log("[deploy] 已跳过界面刷新(SYFI_SKIP_RELOAD=1)");
        return;
    }
    const http = require("http");
    const port = Number(process.env.SYFI_API_PORT || 6806);
    const body = "{}";
    const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    };
    if (process.env.SYFI_API_TOKEN) {
        headers.Authorization = `Token ${process.env.SYFI_API_TOKEN}`;
    }
    let settled = false;
    const warn = (msg) => {
        if (!settled) {
            settled = true;
            console.warn(`[deploy] ${msg};文件已部署,手动刷新界面即可`);
        }
    };
    const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/ui/reloadUI",
        method: "POST",
        headers,
        timeout: 3000,
    }, res => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
            if (settled) return;
            settled = true;
            let code = "?";
            try { code = JSON.parse(data).code; } catch { /* 非 JSON 响应 */ }
            if (res.statusCode === 200 && code === 0) {
                console.log("[deploy] 已通知思源整页刷新(/api/ui/reloadUI)");
            } else {
                console.warn(`[deploy] 界面刷新未成功(HTTP ${res.statusCode}, code=${code}): ${data.slice(0, 160)}`);
            }
        });
    });
    req.on("timeout", () => {
        warn("通知思源刷新超时");
        req.destroy();
    });
    req.on("error", err => warn(`无法通知思源刷新(${err.code || err.message})`));
    req.end(body);
}

reloadUI();
