// 内核注册表(Phase 1 → Phase 3a)
//
// 职责:docId → KernelClient 的映射,以及「每个文档用哪个内核」的选择与持久化。
//   Phase 1 只有一个后端(Legacy),但注册表先立起来,这样 Phase 2 加 Jupyter 时
//   调用点完全不用动 —— 它们只认识 getKernel(docId)。
//
// 为什么用 docId 而不是「全局一个」:
//   目标是「A 文档用 python3、B 文档用 deno,互不干扰」。同一份 Notebook 和相邻的
//   markdown 代码块要能记住各自的选择,所以必须有 key。Phase 1 阶段还没人传 docId,
//   全部走同一个默认 key,行为与原来的全局单例完全一致。
//
// **Phase 1 必须行为零变化**:所有入口返回的都是同一个默认实例,
// 和原来的 `singleton` 语义对等。

import {KernelClient, KernelKind} from "./types";
import {LegacyPythonKernel} from "./legacy-python";
import {JupyterKernel} from "./jupyter/jupyter-kernel";
import {KernelSpecInfo, listKernelSpecs} from "./interpreter";

/**
 * 没传 docId 时的默认 key。
 * 之所以叫 global 而不是 "" —— 空字符串太容易被误当成「未设置」传进来。
 */
export const DEFAULT_KERNEL_ID = "__default__";

/** 一个文档的内核选择:后端种类 + Jupyter 时的 kernelspec */
export interface KernelChoice {
    kind: KernelKind;
    /** jupyter 后端专用:kernelspec 名(python3/deno/...) */
    specName?: string;
    /** jupyter 后端专用:kernelspec 资源目录(读 kernel.json 用) */
    specResourceDir?: string;
}

/** docId → 内核实例 */
const instances = new Map<string, KernelClient>();
/** docId → 用户选择的内核。没有记录 = 用默认后端 */
const choices = new Map<string, KernelChoice>();

// ===== 选择持久化(宿主注入,见 registerKernelChoicePersistence) =====

export interface KernelChoicePersistence {
    load(): Promise<Record<string, KernelChoice> | null>;
    save(data: Record<string, KernelChoice>): Promise<void>;
}

let persistence: KernelChoicePersistence | null = null;
let choicesLoaded = false;

/** 宿主(插件)在 onload 时注册存取实现;注册前的选择只在内存里 */
export function registerKernelChoicePersistence(h: KernelChoicePersistence): void {
    persistence = h;
}

/** 从宿主存储加载所有文档的内核选择(幂等,多次调用只加载一次) */
export async function loadKernelChoices(): Promise<void> {
    if (choicesLoaded || !persistence) return;
    choicesLoaded = true;
    try {
        const data = await persistence.load();
        if (data) {
            for (const [k, v] of Object.entries(data)) {
                if (v && (v.kind === "jupyter" || v.kind === "syfe")) choices.set(k, v);
            }
        }
    } catch {
        // 存储坏了不致命:退回默认选择
    }
}

/** 把当前所有选择写回宿主存储 */
export async function saveKernelChoices(): Promise<void> {
    if (!persistence) return;
    try {
        const obj: Record<string, KernelChoice> = {};
        for (const [k, v] of choices) obj[k] = v;
        await persistence.save(obj);
    } catch {
        // 保存失败不致命:下次启动回到默认
    }
}

// ===== 实例创建 =====

function createInstance(choice?: KernelChoice): KernelClient {
    const kind = choice?.kind ?? "syfe";
    switch (kind) {
        case "jupyter": {
            const k = new JupyterKernel();
            if (choice?.specName) k.specName = choice.specName;
            if (choice?.specResourceDir) k.specResourceDir = choice.specResourceDir;
            return k;
        }
        case "syfe":
        default:
            return new LegacyPythonKernel();
    }
}

/** 取该文档的内核,不存在则按需创建。等价于原来的 getPythonKernel() */
export function getKernel(docId: string = DEFAULT_KERNEL_ID): KernelClient {
    const existing = instances.get(docId);
    if (existing) return existing;
    const created = createInstance(choices.get(docId));
    instances.set(docId, created);
    return created;
}

/** 该文档当前选择的内核 */
export function getKernelChoice(docId: string = DEFAULT_KERNEL_ID): KernelChoice | null {
    return choices.get(docId) ?? null;
}

/**
 * 切换内核种类/spec。**会销毁现有实例**,下次 getKernel 时按新选择重建 ——
 * 内核是有状态的,不重启就换后端会让「内存里的变量」凭空消失而用户不知情。
 * 选择会异步写回宿主存储(如果有)。
 */
export function setKernelChoice(docId: string, choice: KernelChoice): void {
    choices.set(docId, choice);
    const existing = instances.get(docId);
    if (existing) {
        instances.delete(docId);
        void existing.shutdown().catch(() => {
            // 关不掉就算了:进程可能已经死了,不必阻塞切换
        });
    }
    void saveKernelChoices();
}

/** 关闭并移除某个文档的内核(切换内核时由 setKernelChoice 内部调用;也可单独用于重启) */
export async function disposeKernel(docId: string): Promise<void> {
    const existing = instances.get(docId);
    if (!existing) return;
    instances.delete(docId);
    try {
        await existing.shutdown();
    } catch {
        // ignore
    }
}

/** 插件卸载时收尾:关掉所有还在跑的内核 */
export async function disposeAllKernels(): Promise<void> {
    const all = Array.from(instances.entries());
    instances.clear();
    for (const [, kernel] of all) {
        try {
            await kernel.shutdown();
        } catch {
            // ignore
        }
    }
}

// ===== kernelspec 列表(菜单数据源) =====

/**
 * 列出本机可用的 Jupyter kernelspec。
 * 拿不到可用解释器时返回空数组(菜单里只剩「内置内核」)。
 */
export async function listAvailableKernels(refresh = false): Promise<KernelSpecInfo[]> {
    return listKernelSpecs({refresh});
}
