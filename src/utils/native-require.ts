// 获取原生的 Node.js require 函数
// 在 webpack 打包后,普通的 require 会被 webpack 接管,无法加载 Node 原生模块(如 child_process)
// 使用 __non_webpack_require__(webpack 特有)或 eval('require')(通用)绕过 webpack 模块解析
// 仅在 Electron 渲染进程且开启了 Node 集成时可用

export type NativeRequire = (module: string) => any;

declare const __non_webpack_require__: NativeRequire | undefined;

let cachedNativeRequire: NativeRequire | null = null;

// 思源加载插件时注入的 require 形参(app/src/plugin/loader.ts 的 requireFunc)
// 对非 "siyuan" 的键走 window.require?.(key) —— 无 Node 集成时**返回 undefined 而不抛错**。
// 所以"调用没抛异常"不能作为判据,必须确认拿到了真的模块对象。
function resolvesNodeBuiltin(req: NativeRequire): boolean {
    try {
        const cp = req("child_process");
        return !!cp && typeof cp.exec === "function";
    } catch {
        return false;
    }
}

export function getNativeRequire(): NativeRequire | null {
    if (cachedNativeRequire) return cachedNativeRequire;
    const candidates: NativeRequire[] = [];
    // 优先使用 webpack 特有的 __non_webpack_require__(编译后就是插件工厂的 require 形参)
    try {
        if (typeof __non_webpack_require__ === "function") candidates.push(__non_webpack_require__);
    } catch {
        // __non_webpack_require__ 未定义,忽略
    }
    // 回退:通过 eval 绕过 webpack 的静态分析。
    // 必须**调用**这个匿名函数:它本身只是个工厂,直接当 require 用会把任意模块名都解析成 require 函数自己
    try {
        const r = new Function("return typeof require !== 'undefined' ? require : null")();
        if (typeof r === "function") candidates.push(r as NativeRequire);
    } catch {
        // 忽略
    }
    for (const r of candidates) {
        if (resolvesNodeBuiltin(r)) {
            cachedNativeRequire = r;
            return cachedNativeRequire;
        }
    }
    return null;
}

// 检测当前环境是否支持 Node 原生模块
export function isNodeModulesAvailable(): boolean {
    return getNativeRequire() !== null;
}
