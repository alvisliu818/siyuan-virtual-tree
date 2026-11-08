/**
 * 跨 `window.eval` 的全局资源清理注册表。
 *
 * 思源用 `window.eval` 加载插件(app/src/plugin/loader.ts 的 runCode),热重载时
 * 会在**同一个页面 JS 上下文**里重新求值整份 bundle。于是所有模块级变量
 * (`let observer = null`、`let globalBound = false`、Map/WeakMap)都被重置,
 * 但上一轮挂在 `window` / `document` 上的监听器、仍然 observe 着 document.body
 * 的 MutationObserver 实例并不会消失 —— 它们按「份数」累积,回调又写 DOM,
 * 形成「DOM 改动 → 全部 observer 回调 → 再改 DOM」的正反馈放大(实测热重载
 * 一次即可让渲染进程涨到 2GB+ 并卡死事件循环)。
 *
 * 处置:把 disposer 存到 **window 上的注册表**(跨 eval 共享),由入口 banner
 * 在下一轮 bundle 求值的最开始统一执行(换届自愈,不依赖思源是否调用
 * onunload),同时 `onunload()` 里再执行一次兜底。
 *
 * 只登记「模块级/全局」资源;已打开 Tab、Dock 实例内部的资源有各自的
 * destroy(),由思源管理,不在此登记,否则换届会把仍在使用的 Tab 拆掉。
 */
const REGISTRY_KEY = "__syfeDisposalRegistry";

interface DisposalRegistry {
    disposers: Set<() => void>;
}

function registry(): DisposalRegistry {
    const w = window as any;
    return w[REGISTRY_KEY] || (w[REGISTRY_KEY] = {disposers: new Set<() => void>()});
}

/** 登记一个清理函数,在本轮插件被卸载/换届时执行。 */
export function onDispose(fn: () => void): void {
    registry().disposers.add(fn);
}

/** 执行并清空全部清理函数(幂等)。 */
export function disposeAllGlobal(): void {
    const r = registry();
    const list = Array.from(r.disposers);
    r.disposers.clear();
    for (const fn of list) {
        try {
            fn();
        } catch {
            // 单个清理失败不能挡住其余清理
        }
    }
}

// 入口 banner 在 webpack runtime 之前执行,那时本模块还没求值,拿不到 import;
// 因此把入口函数挂到 window 上供 banner 直接调用(指向当前轮次的模块作用域)。
(window as any).__syfeDisposeAllGlobal = disposeAllGlobal;
(window as any).__syfeOnDispose = onDispose;
