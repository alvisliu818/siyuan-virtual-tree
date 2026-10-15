// 关闭未保存页签的行为:设置项「关闭未保存标签页时的行为」。
//   ask     = 弹确认(保存/放弃),默认,历史行为
//   discard = 不提示直接放弃修改并关闭
//   save    = 不提示直接保存后关闭
//
// 为什么用模块级单例而不是把 config 传进页签:思源自定义页签实例只拿得到
// openTab 时的 data,四个 tab 类型的 beforeDestroy 都在 init 闭包外,
// 走实例传递要改每条初始化链 —— 由 index.ts 在加载配置/保存设置时注入一次即可。

import {confirm} from "siyuan";

export type CloseUnsavedAction = "ask" | "discard" | "save";

let current: CloseUnsavedAction = "ask";

export function setCloseUnsavedAction(a: CloseUnsavedAction | undefined | null): void {
    current = a === "discard" || a === "save" ? a : "ask";
}

export function getCloseUnsavedAction(): CloseUnsavedAction {
    return current;
}

/**
 * 页签 beforeDestroy 的统一守卫。
 *
 * 三条路径最终都以「标记 _closing + parent.close()」真正关闭
 * (close() 会再次触发 beforeDestroy,那时 _closing 已置位,直接放行)。
 * 返回 false 阻止本次销毁,等待真正关闭动作完成。
 */
export function guardUnsavedClose(
    name: string,
    saveThenClose: () => void,
    discardThenClose: () => void,
): boolean {
    const action = getCloseUnsavedAction();
    if (action === "save") {
        // 必须延后一拍:beforeDestroy 里同步调 parent.close() 是重入,
        // 会被销毁管线吞掉(e2e 实测:同步路径页签不关);确认弹窗路径
        // 天然异步所以没有这个问题,discard/save 两条短路路径用 setTimeout 对齐。
        window.setTimeout(saveThenClose, 0);
        return false;
    }
    if (action === "discard") {
        window.setTimeout(discardThenClose, 0);
        return false;
    }
    confirm("未保存的修改", `「${name}」有未保存的修改,是否保存?`, saveThenClose, discardThenClose);
    return false;
}
