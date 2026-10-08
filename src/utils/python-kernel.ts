// Phase 1 之后本文件退化为**兼容门面**,真正的实现已经搬到 ./kernel/ 下:
//   kernel/types.ts         — KernelClient 接口与配套类型
//   kernel/legacy-python.ts — 旧的内置 Python 内核(syfe-kernel.py 协议)
//   kernel/registry.ts      — docId → 内核实例,「按文档选内核」的落点
//   kernel/interpreter.ts   — Jupyter 解释器探测(Phase 0)
//
// 为什么保留这个门面而不是直接改所有 import:
//   现有 5 处 import 分散在 index.ts / notebook-tab.ts / editor-tab.ts /
//   code-block-run-exec.ts / python-lsp-bridge.ts。一次全改会让 Phase 1 的 diff
//   从「可审查的搬迁」变成「遍布全仓的重构」,而 Phase 1 的验收标准是行为零变化 ——
//   diff 越小越好归因。等 Jupyter 后端落地后再统一迁到 ./kernel/* 并删掉本文件。
//
// ⚠️ 新代码请直接 import "./kernel/registry" / "./kernel/types",不要再依赖这里。

export * from "./kernel/types";
export {LegacyPythonKernel as PythonKernel, resolvePythonInterpreter} from "./kernel/legacy-python";
export {
    DEFAULT_KERNEL_ID, disposeAllKernels, disposeKernel, getKernel, getKernelChoice, setKernelChoice,
} from "./kernel/registry";

import {KernelClient} from "./kernel/types";
import {LegacyPythonKernel} from "./kernel/legacy-python";
import {DEFAULT_KERNEL_ID, disposeAllKernels, getKernel} from "./kernel/registry";

/**
 * 兼容入口:取默认内核。
 *
 * 语义与原来的全局单例**完全一致** —— 同一个 key 反复调用返回同一个实例。
 * 返回类型保持具体类型而不是 KernelClient,是为了让现有调用点(以及将来可能出现的
 * Legacy 专有用法)不会因为这次搬迁就编译不过;等调用点全部迁走后这里可以收紧。
 */
export function getPythonKernel(): LegacyPythonKernel | null {
    const k = getKernel(DEFAULT_KERNEL_ID);
    return (k as LegacyPythonKernel) || null;
}

/** Python 是否可用(探测解释器是否存在,不启动内核) */
export function isPythonAvailable(): boolean {
    const k = new LegacyPythonKernel();
    try {
        // 复用内核内部的探测逻辑:能解析出解释器就说明有
        return (k as any).resolvePython() !== null;
    } catch {
        return false;
    }
}

/** 插件卸载时的收尾 */
export async function disposePythonKernel(): Promise<void> {
    await disposeAllKernels();
}

/** 导出一下 key,方便调用点在不改的情况下也能指定 docId */
export {KernelClient};
