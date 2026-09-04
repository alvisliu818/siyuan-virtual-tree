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
function emptyDir(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            fs.rmSync(full, {recursive: true, force: true});
        } else {
            fs.unlinkSync(full);
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
