// 验证 toFileUrl / toMarkdownFileLink 逻辑(从 system-path.ts 复制实现,独立测试)
const path = require("path");

function isSiyuanPath(p) {
    if (!p) return false;
    const x = p.replace(/\\/g, "/");
    return x === "/data" || x.startsWith("/data/");
}
function basename(p) {
    const c = p.replace(/[\\/]+$/, "");
    const i = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
    return i >= 0 ? c.slice(i + 1) : c;
}
function toFileUrl(absPath) {
    if (!absPath) return "";
    const norm = absPath.replace(/\\/g, "/");
    if (/^\/\//.test(norm)) return "file://" + norm.replace(/^\/+/, "");
    return "file:///" + norm.replace(/^\/+/, "");
}
function needsAngleBracket(url) {
    return /[ )\]<>]/.test(url);
}
function toMarkdownFileLink(p) {
    const url = toFileUrl(p);
    const label = basename(p).replace(/[[\]\\]/g, "\\$1");
    const md = needsAngleBracket(url) ? `[${label}](<${url}>)` : `[${label}](${url})`;
    return { label, url, md };
}

const tests = [
    "E:\\HOME\\BaiduSyncdisk\\260817\\02_尚硅谷大模型技术之Linux及Shell\\1.笔记\\尚硅谷大模型技术之Linux（Ubuntu）1.0.docx",
    "E:\\a b\\c.md",
    "E:\\a)b\\c(x).md",
    "/home/user/foo bar.md",
    "\\\\server\\share\\x y\\z.md",
    "E:\\HOME\\SiYuan\\data\\assets\\我的 文档#1.md",
];
for (const p of tests) {
    console.log("PATH:", p);
    const r = toMarkdownFileLink(p);
    console.log("  URL:", r.url);
    console.log("  MD :", r.md);
    console.log();
}
// 确认用户那条路径的原始 URL 对应的文件存在
const fs = require("fs");
const userUrl = toFileUrl("E:\\HOME\\BaiduSyncdisk\\260817\\02_尚硅谷大模型技术之Linux及Shell\\1.笔记\\尚硅谷大模型技术之Linux（Ubuntu）1.0.docx");
const real = userUrl.replace(/^file:\/\/\//, "");
console.log("用户文件原始路径:", real);
console.log("文件存在:", fs.existsSync(real), fs.existsSync(real) ? fs.statSync(real).size + " bytes" : "");
