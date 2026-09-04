/**
 * 将 dist/ 目录打包为 build/package.zip(思源集市上架包)。
 *
 * dist/ 保持"只有插件打包文件"的纯净状态,zip 作为二次产物单独输出到 build/。
 * 用法:node scripts/zip-dist.js
 */
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "build");
const OUT_FILE = path.join(OUT_DIR, "package.zip");

// 收集目录下所有文件(相对路径列表)
function walk(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, base, out);
        } else if (entry.isFile()) {
            out.push(path.relative(base, full).split(path.sep).join("/"));
        }
    }
    return out;
}

async function main() {
    if (!fs.existsSync(DIST_DIR)) {
        console.error("[zip-dist] dist/ 不存在,请先运行 npm run build");
        process.exit(1);
    }

    const files = walk(DIST_DIR);
    if (files.length === 0) {
        console.error("[zip-dist] dist/ 为空,无内容可打包");
        process.exit(1);
    }

    const zip = new JSZip();
    for (const rel of files) {
        zip.file(rel, fs.readFileSync(path.join(DIST_DIR, rel)));
    }

    fs.mkdirSync(OUT_DIR, {recursive: true});
    const buf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: {level: 6},
    });
    fs.writeFileSync(OUT_FILE, buf);

    console.log(`[zip-dist] 已打包 ${files.length} 个文件 → ${path.relative(ROOT, OUT_FILE)} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(e => {
    console.error("[zip-dist] 打包失败:", e);
    process.exit(1);
});
