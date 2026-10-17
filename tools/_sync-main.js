// 逐文件容错同步 dist → 主库插件目录(原生模块 .node 被运行中的思源锁住时跳过)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.resolve(__dirname, "..", "dist");
const DEST = process.env.SYFI_PLUGIN_DIR || "E:\\HOME\\SiYuan\\data\\plugins\\siyuan-virtual-tree";
const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");

function walk(d, base = d, out = []) {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f, base, out);
        else if (e.isFile()) out.push(path.relative(base, f));
    }
    return out;
}

const files = walk(SRC);
let ok = 0, skip = 0;
const skipped = [];
for (const rel of files) {
    const s = path.join(SRC, rel);
    const t = path.join(DEST, rel);
    try {
        fs.mkdirSync(path.dirname(t), {recursive: true});
        if (fs.existsSync(t) && md5(s) === md5(t)) { ok++; continue; }
        fs.copyFileSync(s, t);
        ok++;
    } catch (e) {
        skip++;
        if (skipped.length < 6) skipped.push(rel);
    }
}
console.log("[sync-main] copied/kept:", ok, "| skipped(locked):", skip);
if (skipped.length) console.log("[sync-main] skipped sample:", skipped.join(", "));
for (const f of ["index.js", "index.css", "plugin.json", "icon.png"]) {
    const a = path.join(SRC, f), b = path.join(DEST, f);
    console.log(md5(a) === md5(b) ? "[sync-main] OK  " : "[sync-main] DIFF", f, (fs.statSync(b).size / 1024).toFixed(1) + "KB");
}
