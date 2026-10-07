import {getNativeRequire} from "./native-require";
import {toSystemPath} from "./system-path";
import {basename} from "./path";
import {isBaiduPath} from "./baidu-path";
import {bdDownloadFile} from "../api/baidu-pan";
import {nativeWriteTempFile} from "../api/native-fs";
import type {OpenWithItem} from "../types";

// 用系统默认(关联)应用打开指定文件 / 在系统资源管理器中定位文件
// 用于"打开方式"菜单与旧版 Office 二进制格式(doc/xls/ppt 等)的外部打开。

// 获取当前平台:win / mac / linux
function detectPlatform(req: (m: string) => any): string {
    try {
        const p = String(req("os").platform()).toLowerCase();
        if (p) return p;
    } catch {
        // os 模块不可用,走浏览器兜底
    }
    const np = (navigator.platform || "").toLowerCase();
    return np;
}

// 后台启动外部命令(detached + stdio ignore,不阻塞编辑器)
function spawnDetached(cp: any, cmd: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const child = cp.spawn(cmd, args, {detached: true, stdio: "ignore"});
        child.on("error", (e: any) => {
            if (settled) return;
            settled = true;
            reject(new Error(`${e?.message || e}`));
        });
        child.on("spawn", () => {
            if (settled) return;
            settled = true;
            try {
                child.unref(); // 允许父进程退出,不阻塞编辑器
            } catch {
                // 忽略
            }
            resolve();
        });
    });
}

// 命令行方式用系统默认应用打开路径(WIN: start / macOS: open / Linux: xdg-open)
async function openViaCommandLine(req: (m: string) => any, sysPath: string): Promise<void> {
    const cp = req("child_process");
    const plat = detectPlatform(req);
    let cmd: string;
    let args: string[];
    if (plat.startsWith("win")) {
        cmd = "cmd";
        args = ["/c", "start", "", sysPath];
    } else if (plat === "darwin" || plat.includes("mac")) {
        cmd = "open";
        args = [sysPath];
    } else {
        cmd = "xdg-open";
        args = [sysPath];
    }
    await spawnDetached(cp, cmd, args);
}

// 获取 Electron shell 模块(渲染进程可用;不可用时返回 null)
function getElectronShell(req: (m: string) => any): any | null {
    try {
        const electron = req("electron");
        return electron?.shell || electron?.remote?.shell || null;
    } catch {
        return null;
    }
}

export async function openWithExternalApp(siyuanPath: string): Promise<void> {
    const sysPath = toSystemPath(siyuanPath);
    const req = getNativeRequire();
    if (!req) {
        throw new Error("当前环境不支持调用外部应用(Node 集成不可用)");
    }

    // 方式1:Electron 的 shell.openPath —— 直接走系统文件关联
    const shell = getElectronShell(req);
    if (shell && typeof shell.openPath === "function") {
        let err = "";
        try {
            // openPath 成功时返回空字符串,失败时返回错误描述
            err = await shell.openPath(sysPath);
        } catch (e: any) {
            err = e?.message || String(e);
        }
        if (!err) return;
        // openPath 失败,回退命令行方式再试
        try {
            await openViaCommandLine(req, sysPath);
            return;
        } catch (e: any) {
            throw new Error(`${err};命令行回退也失败: ${e?.message || e} (${sysPath})`);
        }
    }

    // 方式2:命令行打开
    try {
        await openViaCommandLine(req, sysPath);
    } catch (e: any) {
        throw new Error(`${e?.message || e} (${sysPath})`);
    }
}

// 文件树路径统一的外部打开入口:网盘文件(bdpan://)先下载到系统临时目录再交给系统应用,
// 其余路径直接透传 openWithExternalApp。供 Office/Media Tab 的「外部打开」与文件树菜单共用。
export async function openTreeFileWithExternalApp(path: string): Promise<void> {
    if (isBaiduPath(path)) {
        const temp = await nativeWriteTempFile(basename(path), await bdDownloadFile(path));
        try {
            await openWithExternalApp(temp.tempPath);
        } finally {
            // 打开是异步启动外部进程,延迟清理临时副本
            setTimeout(() => void temp.cleanup(), 30 * 1000);
        }
        return;
    }
    await openWithExternalApp(path);
}

// 在系统文件资源管理器中打开/定位
// - 文件夹:在资源管理器中打开该目录
// - 文件:在资源管理器中定位并选中该文件
export async function revealInSystemExplorer(siyuanPath: string, isDir: boolean): Promise<void> {
    // 文件夹:直接走系统默认打开(即资源管理器打开目录)
    if (isDir) return openWithExternalApp(siyuanPath);

    const sysPath = toSystemPath(siyuanPath);
    const req = getNativeRequire();
    if (!req) {
        throw new Error("当前环境不支持调用系统资源管理器(Node 集成不可用)");
    }

    // 方式1:Electron shell.showItemInFolder —— 定位并选中文件
    const shell = getElectronShell(req);
    if (shell && typeof shell.showItemInFolder === "function") {
        try {
            shell.showItemInFolder(sysPath);
            return;
        } catch {
            // 失败回退命令行
        }
    }

    // 方式2:命令行回退(WIN: explorer /select / macOS: open -R / Linux: 打开父目录)
    const cp = req("child_process");
    const plat = detectPlatform(req);
    let cmd: string;
    let args: string[];
    if (plat.startsWith("win")) {
        cmd = "explorer";
        args = [`/select,${sysPath}`];
    } else if (plat === "darwin" || plat.includes("mac")) {
        cmd = "open";
        args = ["-R", sysPath];
    } else {
        // Linux 无统一的"定位文件"命令,退化为打开所在目录
        cmd = "xdg-open";
        const idx = Math.max(sysPath.lastIndexOf("/"), sysPath.lastIndexOf("\\"));
        args = [idx > 0 ? sysPath.slice(0, idx) : sysPath];
    }
    try {
        await spawnDetached(cp, cmd, args);
    } catch (e: any) {
        throw new Error(`${e?.message || e} (${sysPath})`);
    }
}

// === 自定义「打开方式」===

/**
 * 常见编辑器的安装位置候选。
 *
 * 为什么需要:内置预置的 command 填的是通用命令名("code"),它要求 PATH 里有
 * 这个 shim。但 Windows 上装了 VS Code 并不等于 PATH 里有 code.cmd ——
 * 只有用户勾了"添加到 PATH"才有。没勾的占绝大多数,所以必须回退去
 * 安装目录里找 exe。
 *
 * 用文件名而不是完整路径:同一个版本号下不同安装方式(用户安装 / 系统安装 /
 * 便携 / Store)的目录深度差别很大,按目录拼接会漏掉一部分。
 */
function commandCandidates(cmd: string, req: (m: string) => any): Array<{cmd: string; args: string[]}> {
    const out: Array<{cmd: string; args: string[]}> = [];
    const lower = cmd.toLowerCase();
    // 带路径分隔符 = 用户填的就是绝对/相对路径,原样用,不做候选展开
    if (/[\\/]/.test(cmd)) return [{cmd, args: []}];

    out.push({cmd, args: []});
    if (process.platform !== "win32") return out;

    // Windows:按 PATH 顺序展开常见前缀
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    const roots = [local, pf, pf86, sysRoot];

    // 编辑器类命令的 exe 名与命令名不一致:code.cmd → Code.exe
    const exeNames = lower === "code"
        ? ["Code.exe", "code.exe"]
        : lower === "cursor"
            ? ["Cursor.exe"]
            : lower === "windsurf"
          ? ["Windsurf.exe"]
            : lower === "explorer"
              ? ["explorer.exe"]
              : lower === "notepad"
                ? ["notepad.exe"]
                : [cmd + ".exe", cmd + ".EXE"];

    // 每个编辑器自己的可执行文件名与产品目录名也常常不一致
    const dirNames = lower === "code"
        ? ["Microsoft VS Code", "Programs\\Microsoft VS Code"]
        : lower === "cursor"
            ? ["Programs\\cursor", "Cursor"]
            : lower === "windsurf"
              ? ["Programs\\Windsurf", "Windsurf"]
              : [];

    for (const exe of exeNames) {
        for (const root of roots) {
            if (!root) continue;
            for (const dn of dirNames) {
                out.push({cmd: pathJoin(root, dn, exe), args: []});
            }
            // 兜底:直接拼 root/Users/xxx/AppData/... 之外最常见的相对形态
            out.push({cmd: pathJoin(root, exe), args: []});
        }
    }
    return out;
}

function pathJoin(...parts: string[]): string {
    return parts
        .filter(Boolean)
        .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
        .join("\\");
}

/**
 * 按自定义「打开方式」配置启动外部程序。
 *
 * 参数拼装规则:
 *   args 里有 {file} → 就地替换
 *   args 里没有 {file} → 目标路径追加到末尾
 * 后者是绝大多数编辑器的用法(code / cursor / windsurf / notepad 都是
 * "把路径丢给它就行"),写成占位符反而是用户要额外学的语法。
 */
export async function launchOpenWith(item: OpenWithItem, siyuanPath: string): Promise<void> {
    const req = getNativeRequire();
    if (!req) throw new Error("当前环境不支持调用外部程序(Node 集成不可用)");

    // 网盘文件(bdpan://)没有本地路径,得先下载到临时目录
    let targetPath = siyuanPath;
    let tempCleanup: (() => Promise<void>) | null = null;
    if (isBaiduPath(siyuanPath)) {
        const temp = await nativeWriteTempFile(basename(siyuanPath), await bdDownloadFile(siyuanPath));
        targetPath = temp.tempPath;
        tempCleanup = temp.cleanup;
    }

    const sysPath = toSystemPath(targetPath);
    const hasPlaceholder = (item.args || []).some(a => a.includes("{file}"));
    const args = (item.args || []).map(a => a.split("{file}").join(sysPath));
    if (!hasPlaceholder) args.push(sysPath);

    const cp = req("child_process");
    const fs = req("fs") as typeof import("fs");
    const candidates = commandCandidates(item.command, req);

    let lastErr = "";
    try {
        for (const cand of candidates) {
            // 绝对路径候选必须真实存在才能用;PATH 上的命令名交给 spawn 去试
            if (cand.cmd !== item.command) {
                try {
                    if (!fs.existsSync(cand.cmd)) continue;
                } catch {
                    continue;
                }
            }
            try {
                await spawnDetached(cp, cand.cmd, args);
                // 成功:延迟清理网盘临时副本(外部程序可能还在读)
                if (tempCleanup) {
                    setTimeout(() => void tempCleanup!(), 30 * 1000);
                }
                return;
            } catch (e: any) {
                lastErr = e?.message || String(e);
            }
        }
    } catch (e: any) {
        lastErr = e?.message || String(e);
    }

    if (tempCleanup) await tempCleanup();
    throw new Error(
        `找不到命令「${item.command}」。` +
        (lastErr ? `(${lastErr})` : "") +
        `请在设置 → 文件 → 自定义打开方式里确认命令名拼写,` +
        `或改成可执行文件的完整路径。`,
    );
}
