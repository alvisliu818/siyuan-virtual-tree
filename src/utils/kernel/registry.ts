// 内核注册表(Phase 1)
//
// 职责:docId → KernelClient 的映射。
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

/**
 * 没传 docId 时的默认 key。
 * 之所以叫 global 而不是 "" —— 空字符串太容易被误当成「未设置」传进来。
 */
export const DEFAULT_KERNEL_ID = "__default__";

/** docId → 内核实例 */
const instances = new Map<string, KernelClient>();
/** docId → 用户选择的内核种类。没有记录 = 用默认后端 */
const choices = new Map<string, KernelKind>();

function createInstance(kind: KernelKind): KernelClient {
    switch (kind) {
        case "jupyter":
            // Phase 2 起真正可用。注意:多语言内核(deno 等)要等 Phase 3 的
            // spec 选择传进来(见 JupyterKernel.specName/specResourceDir),
            // 这里的默认实例是 python3 spec
            return new JupyterKernel();
        case "syfe":
        default:
            return new LegacyPythonKernel();
    }
}

/** 取该文档的内核,不存在则按需创建。等价于原来的 getPythonKernel() */
export function getKernel(docId: string = DEFAULT_KERNEL_ID): KernelClient {
    const existing = instances.get(docId);
    if (existing) return existing;
    const kind = choices.get(docId) ?? "syfe";
    const created = createInstance(kind);
    instances.set(docId, created);
    return created;
}

/** 该文档当前选择的内核种类 */
export function getKernelChoice(docId: string = DEFAULT_KERNEL_ID): KernelKind {
    return choices.get(docId) ?? "syfe";
}

/**
 * 切换内核种类。**会销毁现有实例**,下次 getKernel 时按新种类重建 ——
 * 内核是有状态的,不重启就换后端会让「内存里的变量」凭空消失而用户不知情。
 */
export function setKernelChoice(docId: string, kind: KernelKind): void {
    choices.set(docId, kind);
    const existing = instances.get(docId);
    if (existing) {
        instances.delete(docId);
        void existing.shutdown().catch(() => {
            // 关不掉就算了:进程可能已经死了,不必阻塞切换
        });
    }
}

/** 关闭并移除某个文档的内核 */
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

/**
 * TODO(Phase 2/UI):choices 目前只在内存里,插件重载后会丢。
 * 需要接插件存储把它落到 kernels.json —— 这一步依赖 Plugin 实例的 storage API,
 * 不做在这个模块里(它要保持纯逻辑、可被离线验证)。
 */
