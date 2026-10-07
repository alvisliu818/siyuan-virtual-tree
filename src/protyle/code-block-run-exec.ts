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