// 文档内 Python 代码块的执行器
//
// 为什么不用持久内核(kernel.execute):内核走的是「发代码 → 拿结果」模型,
// 没有 stdin 通道,input() 直接 EOF 报错。而文档里的代码块经常就是交互式脚本
// (input('你叫什么? ')),必须走**真子进程 + 管道**,让 input() 有真实来源。
//
// 为什么每次都新建进程而不是复用:文档里的代码块之间没有"共享变量"的语义,
// 用户点哪块就跑哪块,复用反而会让状态互相污染。而且内核那种长驻进程
// 一旦被用户代码里的 sys.exit() 带走就废了。
//
// 为什么落到临时 .py 文件再执行:代码块可能有非 ASCII、缩进、CRLF,
// 直接 `python -c "<整段代码>"` 在 Windows 上会被命令行引号规则搞坏。
import {resolvePythonInterpreter} from "../utils/python-kernel";

// ANSI 转义序列:子进程输出可能带颜色,面板是纯文本展示,留着会显示成乱码。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g;

export function stripANSI(text: string): string {
    // Windows 上 Python 的输出全是 \r\n。这里只能删 \r **不能删整个 \r\n** ——
    // 之前用 /\r\n?/g 一起删,结果两行的输出粘成 "你好, AlicePython 3.12.7"。
    return text.replace(ANSI_RE, "");
}

export interface RunHandle {
    /** 向 stdin 写一行(input() 会消费掉它) */
    sendInput(line: string): void;
    /** 中断:杀进程 */
    interrupt(): void;
}

export interface RunOptions {
    code: string;
    cwd: string;
    onOutput: (chunk: string) => void;
    onExit: (code: number) => void;
}

let runSeq = 0;

// 每次运行一个独立临时文件;放在插件目录下的 tmp/,思源工作空间同步时不会带上
function tempScriptDir(): string {
    const wsDir = window.siyuan.config?.system?.workspaceDir || "";
    const dir = `${wsDir}/data/temp/syfe-code-run`;
    try {
        const fs = window.require("fs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    } catch {
        // 建不了目录就走相对路径,后面 spawn 会失败并把错误回报给用户
    }
    return dir;
}

/** 执行一段 Python 代码;返回句柄。同步抛错表示根本没起来。 */
export function runPythonCode(options: RunOptions): RunHandle {
    const python = resolvePythonInterpreter();
    if (!python) {
        throw new Error("未找到 Python。请安装 Python 3 并确保 python 在 PATH 中");
    }

    const runId = `${Date.now().toString(36)}-${(runSeq++).toString(36)}`;
    const script = `${tempScriptDir()}/run-${runId}.py`;
    const fs = window.require("fs");
    // BOM 必须写:Windows 上 Python 3 默认按本地代码页读源文件,
    // 没有 BOM 会把 UTF-8 中文当 GBK 解,语法错误都是莫名其妙的那种
    fs.writeFileSync(script, "\ufeff" + options.code.replace(/\r\n/g, "\n"), {encoding: "utf8"});

    const child = window.require("child_process").spawn(python.cmd, [...python.args, "-u", script], {
        cwd: options.cwd || undefined,
        env: {
            ...window.process?.env,
            PYTHONIOENCODING: "utf-8",   // 双保险:输出固定 UTF-8
            PYTHONNOUSERSITE: "1",
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => options.onOutput(stripANSI(chunk)));
    child.stderr.on("data", (chunk: string) => options.onOutput(stripANSI(chunk)));

    let exited = false;
    child.on("error", (e: any) => {
        if (exited) return;
        exited = true;
        cleanup();
        options.onOutput(`\n[无法启动进程] ${e?.message || e}\n`);
        options.onExit(-1);
    });
    child.on("exit", (code: number) => {
        if (exited) return;
        exited = true;
        cleanup();
        options.onExit(code ?? 0);
    });

    function cleanup() {
        try {
            if (fs.existsSync(script)) fs.unlinkSync(script);
        } catch {
            // 临时文件删不掉不影响功能,temp 目录会被思源定期清理
        }
    }

    return {
        sendInput(line: string) {
            if (exited || child.stdin.destroyed) return;
            try {
                // 必须补换行:input() 读到的是一行,不给 \n 它会一直等
                child.stdin.write(line.replace(/\r?\n$/, "") + "\n");
            } catch {
                // 进程可能刚退出,忽略
            }
        },
        interrupt() {
            if (exited) return;
            try {
                child.kill();
            } catch {
                // 已退出
            }
        },
    };
}

/** 从代码块 DOM 里取源码(.hljs 里是渲染过的,要从 textContent 还原) */
export function extractCode(blockElement: Element): string {
    const codeEl = blockElement.querySelector(".hljs");
    if (!codeEl) return "";
    // .hljs 的第一个子元素 div.fn__none 是行号槽(内容为空),跳过
    let text = "";
    codeEl.childNodes.forEach((node) => {
        if (node.nodeType === 1) {
            const el = node as HTMLElement;
            if (el.classList.contains("fn__none")) return;
            text += el.textContent || "";
        } else {
            text += node.textContent || "";
        }
    });
    // 行号槽是绝对定位渲染的,textContent 会把每个换行都保留 —— 去掉尾部空行
    return text.replace(/\n+$/, "");
}

/** 取代码块声明的语言(小写,空串表示没写) */
export function extractLang(blockElement: Element): string {
    const el = blockElement.querySelector(".protyle-action__language");
    return (el?.textContent || "").trim().toLowerCase();
}
// ===== 内核模式(Task D / Phase 3b):代码块走注册表的持久内核 =====
//
// 与上面 runPythonCode(干净子进程)的关键差异:
//   - 变量跨块保留(同一个 docId 共享一个内核实例,见 registry)
//   - 没有 stdin 通道:Legacy 内核本就没有,input() 会 EOF;Jupyter 内核
//     allow_stdin=false。input() 的交互脚本请走「干净运行」
//   - 中断:Jupyter 后端保留变量,Legacy 是杀进程+重放历史
//
// 输出走 kernel.onEvent 转发(流式,与面板的 onOutput 兼容);
// execute 的 Promise 在单元格结束时 resolve,onExit 在那时触发。

import {getKernel, disposeKernel} from "../utils/kernel/registry";

export interface KernelRunOptions {
    docId: string;
    code: string;
    onOutput: (chunk: string) => void;
    onExit: (exitCode: number) => void;
}

/** 用文档绑定的持久内核执行代码。返回 null 表示内核拿不到(理论上不发生)。 */
export function runKernelCode(options: KernelRunOptions): RunHandle | null {
    let kernel;
    try {
        kernel = getKernel(options.docId);
    } catch {
        return null;
    }
    if (!kernel) return null;

    let inputHinted = false;
    const unsub = kernel.onEvent((ev) => {
        if (ev.type === "stream") {
            options.onOutput(ev.text);
        } else if (ev.type === "execute_result") {
            const text = ev.data?.["text/plain"];
            if (typeof text === "string" && text.trim()) options.onOutput(text + "\n");
        }
    });

    void kernel.execute(options.code).then((outcome) => {
        unsub();
        if (!outcome) {
            // execute 超时或内核没起来:与代码报错明确区分(Phase 3b 验收项 ④)
            options.onOutput("[内核未响应:可能启动失败,或执行超过了超时时间。可用「重置内核」后重试]\n");
            options.onExit(-1);
            return;
        }
        // 纯异常且没有任何流式输出时,把 traceback 补进输出(带 ANSI 色的先不管,面板自己不认色)
        if (outcome.error && !outcome.stdout && !outcome.stderr) {
            options.onOutput((outcome.error.traceback || []).join("\n") + "\n");
        }
        options.onExit(outcome.ok ? 0 : 1);
    }).catch((e) => {
        unsub();
        options.onOutput(String(e?.message || e) + "\n");
        options.onExit(-1);
    });

    return {
        sendInput(line: string): void {
            // 内核无 stdin:只提示一次,避免用户以为输入框坏了
            if (!inputHinted) {
                inputHinted = true;
                options.onOutput("[内核模式不支持 input();请用面板上的「干净运行」执行交互式脚本]\n");
            }
            void line;
        },
        interrupt(): void {
            void kernel.interrupt();
        },
    };
}

/** 重置文档绑定的内核(销毁实例,下次执行自动重建) */
export function resetDocKernel(docId: string): Promise<void> {
    return disposeKernel(docId);
}
