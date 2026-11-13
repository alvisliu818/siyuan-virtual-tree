// 结构化内核 KaTeX 懒加载：复用 vditor 自带 katex（与 cm6-render 同一资源路径与
// data-syfe-katex 缓存属性），不新增依赖、不复制字体。异步返回 window.katex。
declare const __SYFE_PLUGIN_NAME__: string;

let katexPromise: Promise<any> | null = null;

export function getKatex(): Promise<any> {
    if (katexPromise) return katexPromise;
    katexPromise = new Promise((resolve) => {
        try {
            const w = window as any;
            if (w.katex) {
                resolve(w.katex);
                return;
            }
            const base = `/plugins/${__SYFE_PLUGIN_NAME__}/vditor/dist/js/katex`;
            if (!document.querySelector("link[data-syfe-katex]")) {
                const css = document.createElement("link");
                css.rel = "stylesheet";
                css.href = `${base}/katex.min.css`;
                css.setAttribute("data-syfe-katex", "1");
                document.head.appendChild(css);
            }
            const script = document.createElement("script");
            script.src = `${base}/katex.min.js`;
            script.setAttribute("data-syfe-katex", "1");
            script.onload = () => resolve((window as any).katex || null);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        } catch {
            resolve(null);
        }
    });
    return katexPromise;
}

// ===== 离屏延迟渲染(虚拟滚动友好) =====
// 大文档(1.md 487 公式)若一次性渲染全部 KaTeX 会产生数万 DOM 节点。
// 离屏先放轻量占位,进视口(含 300px 预渲染边距)才真正渲染,显著降低初始 DOM。
// 用 scroll/resize 驱动 + getBoundingClientRect 判定(不依赖 IntersectionObserver:
// 窗口被遮挡时 IO/rAF 回调会被 Chromium 饿死,导致公式永不渲染)。渲染过一次不回收。
const pending = new Map<Element, () => void>();
let listening = false;
let timer: number | undefined;

function check(): void {
    timer = undefined;
    const vh = window.innerHeight;
    for (const [el, render] of [...pending]) {
        if (!el.isConnected) { pending.delete(el); continue; }
        const r = el.getBoundingClientRect();
        if (r.top < vh + 300 && r.bottom > -300) {
            pending.delete(el);
            render();
        }
    }
    // 兜底轮询:scroll 事件可能不触发(程序滚动/遮挡窗口),pending 非空时持续复查
    if (pending.size > 0 && timer === undefined) timer = window.setTimeout(check, 300);
}

function schedule(): void {
    if (timer === undefined) timer = window.setTimeout(check, 16);
}

function ensureListen(): void {
    if (listening) return;
    listening = true;
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
}

/** 元素进入视口时执行一次 render(离屏延迟渲染入口) */
export function lazyRender(el: Element, render: () => void): void {
    pending.set(el, render);
    ensureListen();
    schedule();
}