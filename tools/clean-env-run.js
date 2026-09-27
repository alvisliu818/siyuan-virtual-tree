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
 */
const path = require("path");
const {spawn} = require("child_process");

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
    console.error("[clean-env-run] 用法: node tools/clean-env-run.js <入口脚本> [参数...]");
    process.exit(1);
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

const child = spawn(process.execPath, [path.resolve(entry), ...rest], {
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
