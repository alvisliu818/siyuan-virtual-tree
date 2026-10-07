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
 * 用法:
 *   node tools/clean-env-run.js scripts/deploy.js
 *   SYFI_PLUGIN_DIR=<目录> node tools/clean-env-run.js scripts/deploy.js
 */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "dist");
const DEST = path.resolve(
    process.env.SYFI_PLUGIN_DIR || "E:\\HOME\\SiYuan\\data\\plugins\\siyuan-file-editor",
);

function fail(msg) {
    console.error("[deploy] 中止:", msg);
    process.exit(1);
}

// ---- 前置校验(安全护栏,避免误删无关目录) ----
if (!fs.existsSync(SRC)) fail(`源目录不存在: ${SRC}`);
if (!fs.existsSync(path.join(SRC, "index.js"))) fail(`源目录中没有 index.js,不是有效的构建产物: ${SRC}`);
if (path.basename(DEST) !== "siyuan-file-editor") {
    fail(`目标目录名不是 siyuan-file-editor,拒绝操作: ${DEST}`);
}

// 递归删除目录内容(保留目录本身)
//
// 容错要点:**不能因为一个文件删不掉就让整次部署失败**。
// 插件跑起来之后,pyright 会被插件拉起成常驻子进程,它的工作目录
// (pyright/dist)就被 Windows 锁住了 —— 实测 EBUSY: rmdir
// '...\siyuan-file-editor\pyright\dist'。同理 node-pty 的 .node 也可能
// 被已加载的渲染进程锁住。
//
// 所以这里对每个条目单独 try:删不掉就留着(它反正和我们要写的新文件
// 同名,copyFileSync 会覆盖内容),最后再汇总提示。真正需要担心的
// 是「旧 chunk 没被清掉」这种堆积问题,那由 warnStale 单独报出来。
const locked = [];

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
            fs.copyFileSync(srcFull, destFull);
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
warnStale();
