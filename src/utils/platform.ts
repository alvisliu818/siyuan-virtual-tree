// 前端形态判定。
//
// 移动端与桌面端加载的是同一份插件 bundle(plugin.json frontends: ["all"]),
// 但移动端把 addTab / openTab / addStatusBar 编译成了空实现
// (思源 app/src/plugin/API.ts 的 `/// #if MOBILE` 分支),getOpenedTab 恒返回空数组,
// 也没有 Node 集成。onload 里一旦有代码使用这些 API 的返回值就会抛 TypeError,
// 而思源对 onload 异常只 console.error 然后跳过 kernelInit / onLayoutReady ——
// 表现为插件半初始化:后面的 dock 一个都注册不上。
//
// 所以形态判定必须在 onload 最前可用,且不能依赖布局已就绪。

import {isNodeModulesAvailable} from "./native-require";

/** 移动端布局对象,思源移动端启动时挂上(见思源 app/src/types/index.d.ts 的 mobile?: 字段) */
function hasMobileLayoutObject(): boolean {
    return !!(window as any).siyuan?.mobile;
}

/** 思源官方 isMobile() 的同款判据(app/src/util/functions.ts),覆盖布局对象尚未挂上的窗口期 */
function hasMobileSidebar(): boolean {
    try {
        return !!document.getElementById("sidebar");
    } catch {
        return false;
    }
}

function hasMobileUserAgent(): boolean {
    return /Android|iPhone|iPad|iPod|HarmonyOS|Windows Phone|Mobile Safari/i.test(navigator.userAgent || "");
}

/**
 * 是否移动端形态(原生 App 与手机浏览器都算)。
 *
 * 三重信号取或:布局对象 → 侧栏 DOM → UA。刻意**不做缓存**:
 * onload 执行时布局可能还没建好,早先一次否定结果会把整个会话钉死在桌面分支。
 * 三个判据都是常数开销,按调用频率(每次 onload / 每次点击)无需缓存。
 */
export function isMobileFrontend(): boolean {
    return hasMobileLayoutObject() || hasMobileSidebar() || hasMobileUserAgent();
}

/**
 * 是否具备 Node 集成(Electron 桌面端)。
 *
 * 与 isMobileFrontend 是两个独立维度:桌面浏览器同样没有 Node,
 * 但它有完整的页签系统。涉及 fs / child_process / electron 的能力用这个判据,
 * 涉及 addTab / Monaco / 终端 UI 的能力用 isMobileFrontend。
 */
export function hasNodeIntegration(): boolean {
    return isNodeModulesAvailable();
}