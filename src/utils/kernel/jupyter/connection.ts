// connection.json 的生成(Phase 2 / 方案 A)
//
// 关键事实(已从本机 anaconda 的 ipykernel/kernelapp.py 核实):
//   **内核是 bind 方,客户端是 connect 方。**
//   shell/stdin/control 三个通道内核侧都是 ROUTER(bind),iopub 是 PUB(bind),
//   heartbeat 是 ROUTER(bind);客户端用 DEALER/SUB/REQ 去 connect。
//   所以我们要做的是「分配空闲端口 → 写进 connection.json → 内核启动时 bind」,
//   自己绝不能先占这些端口,否则内核 bind 失败直接起不来。
//
// (方案文档初稿写的「shell ROUTER(bind)」是方向反了的,已在此订正。)

import {getNativeRequire} from "../../native-require";

/** connection.json 的完整结构(字段名是 ipykernel 侧约定,一个都不能改) */
export interface KernelConnectionInfo {
    ip: string;
    transport: "tcp";
    shell_port: number;
    iopub_port: number;
    stdin_port: number;
    control_port: number;
    hb_port: number;
    signature_scheme: "hmac-sha256";
    key: string;
    kernel_name: string;
}

/** 分配 n 个当前空闲的 TCP 端口(绑定 0 号端口让系统分配,随即释放) */
export async function findFreePorts(n: number): Promise<number[]> {
    const req = getNativeRequire();
    if (!req) return [];
    const net = req("net");
    const ports: number[] = [];
    // 串行分配:并行抢端口有极小概率拿到同一个(系统复用刚释放的),串行最稳
    for (let i = 0; i < n; i++) {
        ports.push(await new Promise<number>((resolve, reject) => {
            const srv = net.createServer();
            srv.on("error", reject);
            srv.listen(0, "127.0.0.1", () => {
                const addr = srv.address();
                const port = typeof addr === "object" && addr ? addr.port : 0;
                srv.close(() => resolve(port));
            });
        }));
    }
    return ports;
}

/** 生成随机 key(ipykernel 默认 hmac-sha256,hex 文本形式写进 connection.json) */
export function newSessionKey(): string {
    const crypto = getNativeRequire()?.("crypto");
    return crypto ? crypto.randomBytes(32).toString("hex") : "";
}

/**
 * 生成并写出 connection.json,返回文件路径与内容。
 * 文件放在系统临时目录:内核进程要读它,且不用时可以直接删。
 */
export async function writeConnectionFile(kernelName = "python3"): Promise<{path: string; info: KernelConnectionInfo}> {
    const req = getNativeRequire();
    if (!req) throw new Error("当前环境不支持 Node 原生模块,无法生成 connection.json");
    const fs = req("fs") as typeof import("fs");
    const pathMod = req("path") as typeof import("path");
    const os = req("os") as typeof import("os");

    const [shell, iopub, stdin, control, hb] = await findFreePorts(5);
    const info: KernelConnectionInfo = {
        ip: "127.0.0.1",
        transport: "tcp",
        shell_port: shell,
        iopub_port: iopub,
        stdin_port: stdin,
        control_port: control,
        hb_port: hb,
        signature_scheme: "hmac-sha256",
        key: newSessionKey(),
        kernel_name: kernelName,
    };

    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "syfe-jupyter-"));
    const connPath = pathMod.join(dir, "connection.json");
    fs.writeFileSync(connPath, JSON.stringify(info, null, 2), "utf8");
    return {path: connPath, info};
}
