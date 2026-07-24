/**
 * 将 .src/ 目录打包成 dist/package.zip
 * zip 内部结构：文件直接在根（plugin.json / index.js / index.css / i18n/）
 */
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const root = process.cwd();
const srcDir = path.join(root, ".src");
const distDir = path.join(root, "dist");
const zipPath = path.join(distDir, "package.zip");

if (!fs.existsSync(srcDir)) {
  console.error("`.src` directory not found. Run build first.");
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

const zip = new AdmZip();

function addDir(dir, zipPath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const entryPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDir(fullPath, entryPath);
    } else {
      zip.addLocalFile(fullPath, zipPath);
    }
  }
}

addDir(srcDir);
zip.writeZip(zipPath);

const stats = fs.statSync(zipPath);
console.log(`Created ${path.relative(root, zipPath)} (${(stats.size / 1024).toFixed(1)} KB)`);
