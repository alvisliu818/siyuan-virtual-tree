import {getNativeRequire} from "./native-require";
import {toSystemPath} from "./system-path";

// 用系统默认(关联)应用打开指定文件
// 用于旧版 Office 二进制格式(doc/xls/ppt 等)这类无法在浏览器内解析的场景。

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

export async function openWithExternalApp(siyuanPath: string): Promise<void> {
    const sysPath = toSystemPath(siyuanPath);
    const req = getNativeRequire();
    if (!req) {
        throw new Error("当前环境不支持调用外部应用(Node 集成不可用)");
    }

    // 方式1:Electron 的 shell.openPath —— 最可靠,直接走系统文件关联
    let shell: any = null;
    try {
        const electron = req("electron");
        shell = electron?.shell || electron?.remote?.shell;
    } catch {
        shell = null; // electron 模块不可用,回退到命令行
    }
    if (shell && typeof shell.openPath === "function") {
        const err = await shell.openPath(sysPath);
        // openPath 成功时返回空字符串,失败时返回错误描述
        if (err) throw new Error(`打开失败: ${err}`);
        return;
    }

    // 方式2:命令行回退(WIN: start / macOS: open / Linux: xdg-open)
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
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const child = cp.spawn(cmd, args, {detached: true, stdio: "ignore"});
        child.on("error", (e: any) => {
            if (settled) return;
            settled = true;
            reject(new Error(`打开失败: ${e?.message || e}`));
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
