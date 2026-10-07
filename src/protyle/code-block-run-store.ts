// 文档内 Python 代码块的运行输出存档
//
// 为什么单独一个文件而不是塞进 EditorConfig:
// 同 open-with-store —— saveSettings() 是整体覆写 this.config,列表类数据放进去
// 必须四处同步,漏一处就把用户数据清空了。这里独立存 code-block-run.json。
//
// 键是块 ID(data-node-id),值是该代码块的输出与折叠状态。
// 输出正文可能有几十 KB(带 ANSI 彩色输出更甚),所以 JSON 里直接存字符串,
// 不做结构化拆分 —— 渲染时按纯文本处理即可。
import type {Plugin} from "siyuan";

const STORAGE_KEY = "code-block-run.json";
const DATA_VERSION = 1;

export interface CodeBlockOutput {
    /** stdout + stderr 合并后的纯文本(ANSI 已剥离) */
    output: string;
    /** 折叠状态:true = 只显示标题条 */
    collapsed: boolean;
    /** 上次运行的结束时间(毫秒时间戳),用于面板上显示 */
    finishedAt: number;
    /** 退出码;非 0 表示出错 */
    exitCode: number;
}

type CodeBlockRunData = {
    version: number;
    blocks: Record<string, CodeBlockOutput>;
};

export const CODE_BLOCK_RUN_CHANGED_EVENT = "syfe:code-block-run-changed";

/** 存档加载完成 —— 订阅者据此重刷 UI(见 code-block-run.ts) */
export const CODE_BLOCK_RUN_LOADED_EVENT = "syfe:code-block-run-loaded";

let cached: CodeBlockRunData = {version: DATA_VERSION, blocks: {}};
let loaded = false;
let saveTimer: any = null;
let pendingPlugin: Plugin | null = null;

function dispatchChanged(blockId?: string): void {
    try {
        window.dispatchEvent(new CustomEvent(CODE_BLOCK_RUN_CHANGED_EVENT, {detail: {blockId}}));
    } catch {
        // 非浏览器环境(单测)忽略
    }
}

/** 存档可能是手改过的,脏字段一律按缺省处理 */
function sanitizeOutput(raw: any): CodeBlockOutput | null {
    if (!raw || typeof raw !== "object") return null;
    const output = typeof raw.output === "string" ? raw.output : "";
    if (!output) return null;   // 空输出 = 没运行过,不值得留一条
    return {
        output,
        collapsed: raw.collapsed === true,
        finishedAt: Number(raw.finishedAt) || 0,
        exitCode: Number.isFinite(raw.exitCode) ? Number(raw.exitCode) : 0,
    };
}

export async function loadCodeBlockRunData(plugin: Plugin): Promise<void> {
    pendingPlugin = plugin;
    try {
        const data = await plugin.loadData(STORAGE_KEY);
        if (data && typeof data === "object" && data.blocks && typeof data.blocks === "object") {
            const blocks: Record<string, CodeBlockOutput> = {};
            Object.keys(data.blocks).forEach((id) => {
                const item = sanitizeOutput(data.blocks[id]);
                if (item) blocks[id] = item;
            });
            cached = {version: Number(data.version) || DATA_VERSION, blocks};
        } else {
            cached = {version: DATA_VERSION, blocks: {}};
        }
    } catch (e) {
        console.error("[siyuan-file-editor] 加载代码块输出失败:", e);
        cached = {version: DATA_VERSION, blocks: {}};
    }
    loaded = true;
    // 关键:registerCodeBlockRun 在 onload(同步)里就调了,而这里是 onLayoutReady(更晚)。
    // 注册时那一次 decorate 拿到的存档是空的,面板全被建成隐藏的空壳 ——
    // 不广播的话,已打开文档里的输出永远补不回来(重载窗口后实测输出不见了)。
    try {
        window.dispatchEvent(new CustomEvent(CODE_BLOCK_RUN_LOADED_EVENT));
    } catch {
        // 非浏览器环境(单测)忽略
    }
}

// 写盘合并到 300ms 一次:连续运行时每收到一段输出就存一次的话,
// 一次运行能触发几十次 saveData,拖慢 UI 且没必要。
function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushCodeBlockRunData();
    }, 300);
}

export async function flushCodeBlockRunData(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const plugin = pendingPlugin;
    if (!plugin) return;
    try {
        await plugin.saveData(STORAGE_KEY, cached);
    } catch (e) {
        console.error("[siyuan-file-editor] 保存代码块输出失败:", e);
    }
}

/** 读某个块的输出(同步,渲染路径不能等) */
export function getCodeBlockOutput(blockId: string): CodeBlockOutput | null {
    if (!loaded) return null;
    return cached.blocks[blockId] || null;
}

/** 记录一次运行结果 */
export function setCodeBlockOutput(blockId: string, output: CodeBlockOutput): void {
    cached.blocks[blockId] = output;
    scheduleSave();
    dispatchChanged(blockId);
}

/** 追加一段输出(运行中流式写) */
export function appendCodeBlockOutput(blockId: string, chunk: string): void {
    if (!chunk) return;
    const cur = cached.blocks[blockId];
    if (cur) {
        cur.output += chunk;
        scheduleSave();
    } else {
        cached.blocks[blockId] = {output: chunk, collapsed: false, finishedAt: 0, exitCode: 0};
        scheduleSave();
    }
    dispatchChanged(blockId);
}

/** 只更新折叠状态,不碰输出正文 */
export function setCodeBlockCollapsed(blockId: string, collapsed: boolean): void {
    const cur = cached.blocks[blockId];
    if (!cur) return;
    cur.collapsed = collapsed;
    scheduleSave();
    dispatchChanged(blockId);
}

/** 删除某个块的输出(面板上的「清空」按钮) */
export function clearCodeBlockOutput(blockId: string): void {
    if (!cached.blocks[blockId]) return;
    delete cached.blocks[blockId];
    scheduleSave();
    dispatchChanged(blockId);
}