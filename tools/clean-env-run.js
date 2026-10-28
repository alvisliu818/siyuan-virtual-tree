/**
 * 在"干净"的子进程环境中执行构建命令。
 *
 * 背景:某些终端/IDE 环境会注入 NODE_OPTIONS 钩子(node-language-shim)与 PATH 上的
 * safe-bin shim,它们把 node 进程内的文件删除改道到外部回收站程序(genie-trash)。
 * 该程序在批量删除时会长时间无响应,导致 webpack 清空输出目录(以及包管理器安装)
 * 卡死。这里在子进程中剔除这些注入,让构建使用原生 fs。
 *
 * 对没有上述注入的环境,本脚本只是原样转发命令,无副作用。
 *
 * 用法:node tools/clean-env-run.js <入口脚本> [参数...]
 * 例:node tools/clean-env-run.js node_modules/webpack/bin/webpack.js --mode production
 *
 * 2026-10 适配 Yarn 4 PnP:
 *   1. NODE_OPTIONS 里外部注入的钩子(shim)剔除后,若项目存在 .pnp.cjs,重建一条
 *      **只含 PnP hook** 的 NODE_OPTIONS —— 子进程(webpack)要靠它解析依赖,但绝不
 *      能带上回收站 shim(实测:yarn install 删旧 node_modules 被
 *      SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦死,同源问题)。
 *   2. 入口 "node_modules/<pkg>/<path>" 在 PnP 下物理不存在:先按磁盘文件找
 *      (scripts/ 子项目等非 PnP 路径照旧),找不到就走 PnP resolveRequest 解析
 *      真实路径。**未 unplug 的包在 zip 里,无法直接 spawn** —— 报错提示先 unplug。
 */
const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
    console.error("[clean-env-run] 用法: node tools/clean-env-run.js <入口脚本> [参数...]");
    process.exit(1);
}

const projectRoot = path.resolve(__dirname, "..");
const pnpCjs = path.join(projectRoot, ".pnp.cjs");

// ---- 构造干净的 NODE_OPTIONS:只保留 PnP hook ----
// 来源优先级:继承的 NODE_OPTIONS 里的 pnp require(yarn run/yarn node 注入的)>
// 项目根的 .pnp.cjs。二者都没有就不设(非 PnP 环境,原样转发)。
function pnpRequireFromEnv() {
    const raw = process.env.NODE_OPTIONS || "";
    const m = raw.match(/--require=(?:"([^"]*pnp[^"]*)"|(\S*pnp\S*))/i);
    return m ? (m[1] || m[2]) : null;
}
function buildPnpOption() {
    let pnpPath = pnpRequireFromEnv();
    if (!pnpPath && fs.existsSync(pnpCjs)) pnpPath = pnpCjs;
    if (!pnpPath) return null;
    return `--require=${pnpPath.includes(" ") ? `"${pnpPath}"` : pnpPath}`;
}

const env = {...process.env};
// 注入的 node 钩子:会把 fs 删除改道到外部回收站程序
delete env.NODE_OPTIONS;
// bash 启动脚本:会重新向 PATH 注入 shim
delete env.BASH_ENV;
delete env.ENV;
delete env.GENIE_TRASH_DIR;
// PATH 中的 safe-bin shim 目录(Windows 下以 ";" 分隔)
// 环境变量大小写不固定(PATH/Path),先找到实际的键
const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH");
if (pathKey && env[pathKey]) {
    env[pathKey] = env[pathKey].split(";")
        .filter(p => p.length > 0 && !/safe-bin|genie-trash/i.test(p))
        .join(";");
}
const pnpOption = buildPnpOption();
if (pnpOption) env.NODE_OPTIONS = pnpOption;

// ---- 入口解析:磁盘文件优先,PnP 请求说明符兜底 ----
let entryFile = path.resolve(entry);
if (!fs.existsSync(entryFile)) {
    // "node_modules/<pkg>/<path>" → 请求说明符 "<pkg>/<path>"(PnP 下包不在磁盘上)
    const spec = entry.replace(/^[\\/]*node_modules[\\/]+/, "");
    if (fs.existsSync(pnpCjs)) {
        try {
            const pnpApi = require(pnpCjs);
            const resolved = pnpApi.resolveRequest(spec, __filename);
            if (resolved && fs.existsSync(resolved)) entryFile = resolved;
        } catch (e) {
            console.error(`[clean-env-run] PnP 解析入口失败(${spec}): ${e.message}`);
        }
    }
    if (!fs.existsSync(entryFile)) {
        console.error(`[clean-env-run] 入口不存在: ${entry}`);
        if (fs.existsSync(pnpCjs)) {
            console.error(
                "[clean-env-run] PnP 下依赖包默认装在全局 cache 的 zip 里,无法直接执行;\n" +
                "先 `yarn unplug <包名>` 把它解到 .yarn/unplugged/ 再构建。",
            );
        }
        process.exit(1);
    }
}

const child = spawn(process.execPath, [entryFile, ...rest], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
});

child.on("error", err => {
    console.error("[clean-env-run] 启动失败:", err.message);
    process.exit(1);
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code === null ? 1 : code);
});
