// 获取原生的 Node.js require 函数
// 在 webpack 打包后,普通的 require 会被 webpack 接管,无法加载 Node 原生模块(如 child_process)
// 使用 __non_webpack_require__(webpack 特有)或 eval('require')(通用)绕过 webpack 模块解析
// 仅在 Electron 渲染进程且开启了 Node 集成时可用

export type NativeRequire = (module: string) => any;

declare const __non_webpack_require__: NativeRequire | undefined;

let cachedNativeRequire: NativeRequire | null = null;

export function getNativeRequire(): NativeRequire | null {
    if (cachedNativeRequire) return cachedNativeRequire;
    // 优先使用 webpack 特有的 __non_webpack_require__
    try {
        if (typeof __non_webpack_require__ !== "undefined") {
            cachedNativeRequire = __non_webpack_require__;
            return cachedNativeRequire;
        }
    } catch {
        // __non_webpack_require__ 未定义,忽略
    }
    // 回退:通过 eval 绕过 webpack 的静态分析
    try {
        const r = (new Function("return typeof require !== 'undefined' ? require : null")) as NativeRequire | null;
        if (r) {
            cachedNativeRequire = r;
            return cachedNativeRequire;
        }
    } catch {
        // 忽略
    }
    return null;
}

// 检测当前环境是否支持 Node 原生模块
export function isNodeModulesAvailable(): boolean {
    const req = getNativeRequire();
    if (!req) return false;
    try {
        req("child_process");
        return true;
    } catch {
        return false;
    }
}
