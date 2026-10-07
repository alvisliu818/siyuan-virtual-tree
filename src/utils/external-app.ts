import {getNativeRequire} from "./native-require";
import {toSystemPath} from "./system-path";
import {basename} from "./path";
import {isBaiduPath} from "./baidu-path";
import {bdDownloadFile} from "../api/baidu-pan";
import {nativeWriteTempFile} from "../api/native-fs";

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
