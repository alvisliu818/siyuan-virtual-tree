// window.Lute 守卫
//
// ===== 背景(这个坑很致命) =====
// vditor 初始化时会用自己的 <script src=".../dist/js/lute/lute.min.js"> 把
// window.Lute 整个覆写掉。同名全局、但**构建不同**:
//   - 思源自带(/stage/protyle/js/lute/lute.min.js)有 SetTabs / SetCustomBlock
//   - vditor 那份没有
// 而思源的 protyle/render/setLute.ts 建的是**全局单例**:
//   luteInstance = setLute(options)   // 里面会调 lute.SetTabs(true)
// 只要在 vditor 覆写期间创建过这个单例(哪怕一次),之后所有新建的文档编辑器
// 都拿不到能用的 Lute —— 现象是新建文档标签页一片空白:
// protyle 元素停在 breadcrumb + table-control + style,永远没有 .protyle-wysiwyg,
// 控制台只有一句 "SetTabs is not a function" 的未捕获 rejection。
//
// ===== 为什么可以让 vditor 直接使用思源的 Lute =====
// 实测比对两个构建的实例方法集合(2026-10,思源 3.8.6 / vditor 3.10.x):
//   思源 111 个、vditor 109 个;
//   思源多出 SetCustomBlock、SetTabs;
//   **vditor 没有任何一个方法是思源没有的**。
// 也就是说思源的 lute 是 vditor 那份的严格超集,vditor 直接拿来用完全够
// (md2html → setLute 里那 21 个 SetXxx/PutXxx 一个个都在)。
// 于是最稳的做法就是:window.Lute 恒等于思源的构建,vditor 那份不许上位。
//
// ===== 三层防护 =====
// 1) 属性 trap:把 window.Lute 变成 getter/setter。写入值先做实例能力探测,
//    缺 SetTabs 的一律收进回收槽,不改变对外可见的值。
// 2) 占位脚本:vditor 的 addScript 先查 id="vditorLuteScript",存在就短路。
//    提前插一个空壳 <script>,它连自己的 lute.min.js 都不会去请求。
// 3) 自愈:插件加载时若发现 window.Lute 已被污染,主动补载思源自带的
//    lute.min.js 顶回去 —— 不用重启思源就能恢复新建文档的能力。

const SIYUAN_LUTE_URL = "/stage/protyle/js/lute/lute.min.js";
const PLACEHOLDER_ID = "vditorLuteScript";   // vditor 的 addScript 认这个 id
const REPAIR_ID = "syfeSiyuanLuteScript";    // 自愈时自建的脚本 id

let siyuanLute: any = null;      // 思源构建(对外暴露的就是它)
let sidelinedLute: any = null;   // 被扣下的构建(vditor 的),留着备查
let trapInstalled = false;
let loading: Promise<boolean> | null = null;

// 已经做过能力探测的值不再重复探测 —— 每次探测都要 New() 一个 WASM 实例,
// 而 window.Lute 的写入次数取决于其他插件的行为。
const probed = new WeakMap<any, boolean>();

// 实例能力探测:能 New() 出来且带 SetTabs 的,才是思源那套
function isSiyuanLute(value: any): boolean {
    if (!value || typeof value.New !== "function") return false;
    const cached = probed.get(value);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
        const instance = value.New();
        ok = !!instance && typeof instance.SetTabs === "function";
    } catch {
        ok = false;
    }
    probed.set(value, ok);
    return ok;
}

function installTrap(): void {
    if (trapInstalled) return;
    trapInstalled = true;

    const existing = (window as any).Lute;
    if (isSiyuanLute(existing)) siyuanLute = existing;
    else if (existing) sidelinedLute = existing;   // 已被污染:自愈时再顶掉

    // 必须保留 configurable:思源自己后续仍会重新赋值 window.Lute(它就是正常通路),
    // 其它插件也可能换。我们只是"选择性接受",不是彻底封死。
    Object.defineProperty(window, "Lute", {
        configurable: true,
        enumerable: true,
        get: () => siyuanLute ?? sidelinedLute ?? undefined,
        set: (value: any) => {
            if (value === siyuanLute || value === sidelinedLute) return;
            if (isSiyuanLute(value)) {
                siyuanLute = value;
                return;
            }
            // 缺 SetTabs:一律扣下。思源的 Lute 是它的超集,vditor 直接用我们这份。
            sidelinedLute = value;
        },
    });
}

// 插空壳 script,让 vditor 的 addScript 短路,连它自己的 lute.min.js 都不请求
function installPlaceholder(): void {
    if (document.getElementById(PLACEHOLDER_ID)) return;
    const el = document.createElement("script");
    el.id = PLACEHOLDER_ID;
    el.type = "text/javascript";
    el.textContent = "";
    document.head.appendChild(el);
}

// 补载思源自带的 lute(幂等)。脚本执行时会走 window.Lute 的 setter,由 trap 收下。
function loadSiyuanLute(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const el = document.createElement("script");
        el.id = REPAIR_ID;
        el.src = SIYUAN_LUTE_URL;
        el.async = true;
        el.onload = () => resolve(!!siyuanLute);
        el.onerror = () => resolve(false);
        document.head.appendChild(el);
    });
}

/** 确保 window.Lute 一定是思源的构建(vditor 创建前调用)。 */
export async function ensureSiyuanLute(): Promise<boolean> {
    installTrap();
    installPlaceholder();
    if (siyuanLute) return true;
    loading = loading || loadSiyuanLute();
    return loading;
}

/** 插件入口调用:装守卫;若已处于被污染状态则自愈。 */
export function installLuteGuard(): void {
    installTrap();
    installPlaceholder();
    // 有值但不是思源构建 —— 说明这一轮会话里 vditor 已经抢过一次,立刻顶回去。
    //(window.Lute 完全为空属于正常:思源自己还没懒加载,留给 ensureSiyuanLute 处理)
    if (sidelinedLute && !siyuanLute) {
        void ensureSiyuanLute().then((ok) => {
            if (!ok) {
                console.warn("[siyuan-file-editor] 未能恢复思源的 Lute,新建文档可能打不开");
            }
        });
    }
}

/** 调试用。 */
export function luteGuardState(): {siyuan: boolean; sidelined: boolean} {
    return {siyuan: !!siyuanLute, sidelined: !!sidelinedLute};
}
