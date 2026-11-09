// CM6 富渲染:图表类围栏代码块(mermaid 等)渲染为图,而非 Monaco colorize 源码卡片。
//
// 复用 Vditor 自带的整套图表渲染管线:插件随包部署的 vditor/dist/js/ 下已有
// mermaid / flowchart.js / graphviz / echarts / markmap / plantuml / abcjs /
// wavedrom / smiles-drawer 等本地资源,Vditor 类把这些渲染器作为静态方法导出,
// 统一约定 = 扫描 element 内的 ".language-xxx" 元素 → 读代码 → 懒加载脚本 →
// 把 SVG/Canvas 写进该元素 innerHTML → 打 data-processed="true" 防重复。
//
// 三类 Vditor 默认管线在 CM6 replace widget 内不可靠,这里自实现补齐:
//  - mindmap: Vditor.mindmapRender 要求 data-code 为 URL 编码的 echarts tree
//    JSON;把 markdown 标题/列表层级转成 tree 再喂给它(本地 echarts 出图)
//  - markmap: 官方 markmap-lib/view + d3-timer.timerFlush() 强制 transition
//    同步落位(不再依赖窗口前台/rAF),保留 markmap 自己的脑图风格
//  - plantuml: Vditor 直接 <object src="plantuml.com/...">,浏览器离线/被墙空白;
//    改用思源可配置服务器(editor.plantUMLServePath)+ 内核代理 /api/network/proxy
//    取回 SVG 文本 → blob URL <img>,失败则保留源码(不空白)
//
// 图表卡片与普通代码卡片共用 CodeBlockWidget 的头部(语言标签/复制)与编辑宿主:
// 点卡片仍进 Monaco 编辑源码(CSS 隐藏图),退出编辑重建 widget 再渲染图。
import Vditor from "vditor";
import {Transformer} from "markmap-lib";
import {Markmap, deriveOptions} from "markmap-view";
import {timerFlush} from "d3-timer";
import {VDITOR_CDN, ensureVditorCSS} from "../utils/vditor-assets";

type DiagramKind =
    | "mermaid" | "flowchart" | "graphviz" | "echarts" | "markmap"
    | "mindmap" | "plantuml" | "abc" | "wavedrom" | "smiles";

/**
 * md 围栏语言名 → 图表渲染器种类(键全小写)。
 * markmap 用官方 markmap-lib/view(不是 Vditor 打包那份);d3 transition 的
 * 「窗口后台不落位」问题由 d3-timer 的 timerFlush() 同步刷新解决,见
 * renderMarkmap。
 */
const LANG_ALIASES: Record<string, DiagramKind> = {
    mermaid: "mermaid", mmd: "mermaid",
    flowchart: "flowchart", flow: "flowchart",
    graphviz: "graphviz", dot: "graphviz", gv: "graphviz",
    echarts: "echarts", chart: "echarts",
    markmap: "markmap",
    mindmap: "mindmap",
    plantuml: "plantuml", puml: "plantuml",
    abc: "abc", abcjs: "abc",
    wavedrom: "wavedrom",
    smiles: "smiles",
};

export function diagramKindOf(lang: string): DiagramKind | null {
    return LANG_ALIASES[String(lang || "").trim().toLowerCase()] ?? null;
}

export function isDiagramLang(lang: string): boolean {
    return diagramKindOf(lang) !== null;
}

/** 思源明暗(mode 1 = dark);Vditor 渲染器用 theme === "dark" 切暗色图表 */
function currentTheme(): string {
    const mode = (window as any)?.siyuan?.config?.appearance?.mode ?? 0;
    return mode === 1 ? "dark" : "classic";
}

function loadScriptOnce(src: string, flag: string): Promise<boolean> {
    if ((window as any)[flag]) return Promise.resolve(true);
    return new Promise(resolve => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
    });
}

/** 内核代理 /api/network/proxy 的 URL 参数编码(与 api/baidu-pan.ts 同款) */
function b64url(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TreeNode {
    name: string;
    children?: TreeNode[];
}

/** markdown 标题(及 "- " 列表项)层级 → echarts tree 节点 */
function markdownToTree(md: string): TreeNode {
    const roots: TreeNode[] = [];
    const stack: Array<{level: number; node: TreeNode}> = [];
    for (const raw of md.split(/\r?\n/)) {
        const line = raw.trim();
        const h = /^(#{1,6})\s+(.+)$/.exec(line);
        if (h) {
            const level = h[1].length;
            const node: TreeNode = {name: h[2].trim()};
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            if (stack.length) {
                const parent = stack[stack.length - 1].node;
                (parent.children || (parent.children = [])).push(node);
            } else {
                roots.push(node);
            }
            stack.push({level, node});
        } else {
            const li = /^[-*+]\s+(.+)$/.exec(line);
            if (li && stack.length) {
                const parent = stack[stack.length - 1].node;
                (parent.children || (parent.children = [])).push({name: li[1].trim()});
            }
        }
    }
    return roots.length === 1 ? roots[0] : {name: "", children: roots};
}

/** mindmap:Vditor 渲染器读 data-code(URL 编码的 tree JSON) */
async function renderMindmap(host: HTMLElement, target: HTMLElement, code: string): Promise<void> {
    try {
        // echarts.init 需要非零高度;按节点数动态定高,避免 3 个节点占 320px 空白
        const nodeCount = code.split(/\r?\n/).filter(l => /^\s*(#{1,6}|[-*+])\s+/.test(l)).length;
        target.style.height = `${Math.max(140, Math.min(420, nodeCount * 30 + 60))}px`;
        target.textContent = "";
        target.setAttribute("data-code", encodeURIComponent(JSON.stringify(markdownToTree(code))));
        Vditor.mindmapRender(host, VDITOR_CDN, currentTheme());
    } catch {
        target.setAttribute("data-processed", "fallback");
        target.textContent = code;
    }
}

/**
 * markmap:官方 markmap-lib/view(d3 布局)。
 * ⚠ d3 transition 的 tick 默认走 requestAnimationFrame,窗口在后台/不可见时
 *   rAF 暂停 → setData/fit 的坐标永远停在初始值(节点全叠左上角)。
 *   duration:0 + `timerFlush()` 同步执行所有到期 d3 timer,把 transition
 *   立即推进到终态,不依赖窗口前台;`void mm.fit()` 不 await(其内部 Promise
 *   同样等 rAF),再 flush 一次确保 fit 的 transform 也落位。
 */
async function renderMarkmap(host: HTMLElement, target: HTMLElement, code: string): Promise<void> {
    try {
        if (!target.isConnected) {
            target.setAttribute("data-processed", "fallback");
            return;
        }
        // 固定 px 尺寸:D3 不能解析 width:100% 的相对长度(SVGLength 异常)
        const nodeCount = code.split(/\r?\n/).filter(l => /^\s*(#{1,6}|[-*+])\s+/.test(l)).length;
        const w = Math.max(360, (host.clientWidth || 600) - 24);
        const h = Math.max(140, Math.min(480, nodeCount * 30 + 60));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        svg.style.display = "block";
        svg.style.margin = "0 auto";
        target.textContent = "";
        target.appendChild(svg);   // 先挂载:getBBox/getBoundingClientRect 才有值

        const {root, frontmatter} = new Transformer().transform(code);
        const mm = Markmap.create(svg, {
            ...deriveOptions(frontmatter?.markmap),
            duration: 0,
            autoFit: false,
            spacingHorizontal: 80,
            paddingX: 16,
        }, root);
        timerFlush();              // setData 的 transition → 立即落位
        void mm.fit();
        timerFlush();              // fit 的 transform → 立即落位
        window.setTimeout(() => {
            try {
                timerFlush();
                if (svg.isConnected) void mm.fit();
                timerFlush();
            } catch { /* ignore */ }
        }, 80);
        target.setAttribute("data-processed", "true");
    } catch {
        target.setAttribute("data-processed", "fallback");
        target.textContent = code;
    }
}

// ===== PlantUML:SVG 持久化缓存(插件 petal 目录)+ 离线自动补渲染 =====
// 缓存键 = 服务器 URL(含编码后的源码),内容变/服务器变自动失效。
// 走插件 loadData/saveData → <工作空间>/data/storage/petal/siyuan-virtual-tree/
// syfe-plantuml-cache.json,与窗口端口/origin 无关(解决 localStorage 在
// second-instance 随机端口下换 origin 丢缓存的问题)。
const PLANTUML_CACHE_FILE = "syfe-plantuml-cache.json";
const PLANTUML_CACHE_MAX_ITEMS = 150;
const PLANTUML_CACHE_MAX_CHARS = 1_500_000;
interface PlantUmlCacheEntry {
    svg: string;
    ts: number;
}
type PlantUmlCacheData = Record<string, PlantUmlCacheEntry>;

/** petal 缓存的内存镜像(null = 尚未加载);所有读写都经它,避免并发 saveData 覆盖 */
let plantUmlCacheMirror: PlantUmlCacheData | null = null;
let plantUmlCacheLoading: Promise<void> | null = null;
let plantUmlCacheWriteChain: Promise<void> = Promise.resolve();
/** 会话内内存缓存(同一 SVG 不重复解析 petal JSON) */
const PLANTUML_MEMORY = new Map<string, string>();

function plantUmlPlugin(): any {
    const plugins = (window as any)?.siyuan?.ws?.app?.plugins;
    return Array.isArray(plugins) ? plugins.find((p: any) => p?.name === "siyuan-virtual-tree") : null;
}

async function ensurePlantUmlCache(): Promise<void> {
    if (plantUmlCacheMirror) return;
    if (plantUmlCacheLoading) return plantUmlCacheLoading;
    plantUmlCacheLoading = (async () => {
        let data: unknown = {};
        try {
            const raw = await plantUmlPlugin()?.loadData?.(PLANTUML_CACHE_FILE);
            // 思源各版本 loadData 可能返回原始字符串或已解析对象
            data = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {});
        } catch {
            data = {};   // 文件不存在/损坏:当空缓存
        }
        plantUmlCacheMirror = (data && typeof data === "object" && !Array.isArray(data))
            ? data as PlantUmlCacheData : {};
    })();
    return plantUmlCacheLoading;
}

async function plantUmlSvgFor(url: string): Promise<string | null> {
    const mem = PLANTUML_MEMORY.get(url);
    if (mem) return mem;
    await ensurePlantUmlCache();
    const hit = plantUmlCacheMirror?.[url];
    if (typeof hit?.svg === "string" && /<svg/i.test(hit.svg)) {
        PLANTUML_MEMORY.set(url, hit.svg);
        return hit.svg;
    }
    return null;
}

async function rememberPlantUmlSvg(url: string, svg: string): Promise<void> {
    PLANTUML_MEMORY.set(url, svg);
    await ensurePlantUmlCache();
    const all = plantUmlCacheMirror || (plantUmlCacheMirror = {});
    all[url] = {svg, ts: Date.now()};
    // LRU:按 ts 倒序保留,限制条数与总字符数
    const kept: Array<[string, PlantUmlCacheEntry]> = [];
    let chars = 0;
    for (const [k, v] of Object.entries(all).sort((a, b) => b[1].ts - a[1].ts)) {
        chars += k.length + (v.svg?.length || 0);
        if (kept.length >= PLANTUML_CACHE_MAX_ITEMS || chars > PLANTUML_CACHE_MAX_CHARS) break;
        kept.push([k, v]);
    }
    plantUmlCacheMirror = Object.fromEntries(kept);
    // 串行落盘:多个块同时渲染成功时,后写覆盖前写会丢条目
    plantUmlCacheWriteChain = plantUmlCacheWriteChain.then(async () => {
        const snapshot = plantUmlCacheMirror;
        try {
            await plantUmlPlugin()?.saveData?.(PLANTUML_CACHE_FILE, snapshot);
        } catch { /* 落盘失败不阻断渲染,会话内内存仍可用 */ }
    }).catch(() => undefined);
    return plantUmlCacheWriteChain;
}

async function fetchPlantUmlSvg(url: string): Promise<string | null> {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 8000);
    try {
        const token = (window as any)?.siyuan?.config?.system?.conf?.api?.token;
        const resp = await fetch(`/api/network/proxy?u=${b64url(url)}&h=${b64url("{}")}&t=8s`, {
            headers: token ? {Authorization: `Token ${token}`} : {},
            signal: ctl.signal,
        });
        const text = await resp.text();
        return resp.ok && /<svg/i.test(text) ? text : null;
    } catch {
        return null;   // 离线/超时/代理不可用
    } finally {
        window.clearTimeout(timer);
    }
}

function showPlantUmlSvg(target: HTMLElement, svgText: string): void {
    const blobUrl = URL.createObjectURL(new Blob([svgText], {type: "image/svg+xml"}));
    const img = document.createElement("img");
    img.alt = "PlantUML";
    img.onload = () => URL.revokeObjectURL(blobUrl);
    img.onerror = () => URL.revokeObjectURL(blobUrl);
    img.src = blobUrl;
    target.textContent = "";
    target.appendChild(img);
    delete target.dataset.syfePlantumlPending;
    delete target.dataset.syfePlantumlUrl;
    target.setAttribute("data-processed", "true");
}

/** 离线且无缓存的卡片:网络恢复后自动把源码换成图,不需用户手动切模式 */
let plantUmlRetryStarted = false;
async function retryPendingPlantUml(): Promise<void> {
    const pending = Array.from(document.querySelectorAll<HTMLElement>("[data-syfe-plantuml-pending]"));
    for (const target of pending) {
        if (!target.isConnected) continue;
        const url = target.dataset.syfePlantumlUrl;
        if (!url) continue;
        const cached = await plantUmlSvgFor(url);
        const svgText = cached || await fetchPlantUmlSvg(url);
        if (!svgText) continue;
        if (!cached) await rememberPlantUmlSvg(url, svgText);
        showPlantUmlSvg(target, svgText);
    }
}

function startPlantUmlRetry(): void {
    if (plantUmlRetryStarted) return;
    plantUmlRetryStarted = true;
    window.addEventListener("online", () => void retryPendingPlantUml());
    // 定时兜底:浏览器不一定派发 online(代理/服务器恢复、内网切换)
    window.setInterval(() => void retryPendingPlantUml(), 20000);
}

/** plantuml:本地编码器 + 可配置服务器 + 内核代理取 SVG + 持久化缓存 */
async function renderPlantUml(target: HTMLElement, code: string): Promise<void> {
    try {
        const ok = await loadScriptOnce(
            `${VDITOR_CDN}/dist/js/plantuml/plantuml-encoder.min.js`, "plantumlEncoder");
        const enc = ok ? (window as any).plantumlEncoder?.encode?.(code) : "";
        const base = (window as any)?.siyuan?.config?.editor?.plantUMLServePath
            || "https://www.plantuml.com/plantuml/svg/~1";
        if (!enc) {
            target.setAttribute("data-processed", "fallback");
            return;
        }
        const url = /~1/.test(base) ? base + enc : base.replace(/\/?$/, "/") + "~1" + enc;
        // ★ 先查 petal 持久缓存:渲染过的图离线也照样显示,不再退回源码
        let svgText = await plantUmlSvgFor(url);
        if (!svgText) {
            svgText = await fetchPlantUmlSvg(url);
            if (svgText) await rememberPlantUmlSvg(url, svgText);
        }
        if (svgText && target.isConnected) {
            showPlantUmlSvg(target, svgText);
            return;
        }
        // 从未渲染过 + 当前离线:唯一无法凭空生成的情况 —— 临时源码,
        // 并挂自动重试(online 事件 / 20s 定时),网络恢复即换成图
        target.textContent = code;
        target.dataset.syfePlantumlPending = "1";
        target.dataset.syfePlantumlUrl = url;
        target.setAttribute("data-processed", "fallback");
        startPlantUmlRetry();
    } catch {
        target.setAttribute("data-processed", "fallback");
        target.textContent = code;
    }
}

/**
 * 把图表代码块渲染进 host。Vditor 的渲染器是 fire-and-forget(内部 addScript
 * .then),这里用 MutationObserver 等 data-processed / SVG 出现后回调重测高度。
 * 返回 false = 不是图表语言,调用方应回退到 colorize 源码卡片。
 */
export function renderDiagram(
    host: HTMLElement,
    lang: string,
    code: string,
    onRendered?: () => void,
): boolean {
    const kind = diagramKindOf(lang);
    if (!kind) return false;
    ensureVditorCSS();

    host.classList.add("syfe-cm-diagram", "vditor-reset");
    const target = document.createElement("div");
    target.className = `language-${kind}`;
    // echarts 的 adapter 读 innerText、其他读 textContent;white-space 由 CSS 保证
    target.textContent = code;
    host.appendChild(target);

    let done = false;
    let obs: MutationObserver | null = null;
    const finish = () => {
        if (done) return;
        done = true;
        obs?.disconnect();
        onRendered?.();
    };

    // CM6 widget 的 toDOM 阶段 DOM 还没挂进文档 —— Vditor 图表渲染(mermaid v11
    // 的 render 会往 body 插临时节点、echarts 读 innerText)必须在挂载后跑。
    // 短轮询等挂载(最多 ~400ms);彻底切走/销毁则放弃,只留源码占位文本。
    let tries = 0;
    const start = () => {
        if (!host.isConnected) {
            if (tries++ < 20) window.setTimeout(start, 20);
            return;
        }
        const theme = currentTheme();
        try {
            switch (kind) {
                case "mermaid": Vditor.mermaidRender(host, VDITOR_CDN, theme); break;
                case "flowchart": Vditor.flowchartRender(host, VDITOR_CDN); break;
                case "graphviz": Vditor.graphvizRender(host, VDITOR_CDN); break;
                case "echarts": Vditor.chartRender(host, VDITOR_CDN, theme); break;
                case "abc": Vditor.abcRender(host, VDITOR_CDN); break;
                case "wavedrom": Vditor.wavedromRender(host, VDITOR_CDN); break;
                case "smiles": Vditor.SMILESRender(host, VDITOR_CDN, theme); break;
                case "mindmap": void renderMindmap(host, target, code); break;
                case "markmap": void renderMarkmap(host, target, code); break;
                case "plantuml": void renderPlantUml(target, code); break;
            }
        } catch {
            return;   // 渲染器抛错时保留源码文本,不阻断页签
        }
        // 渲染完成通知:图表高度变化要让 CM6 重新测量(行高/行号/虚拟视口)。
        // 观察整个 host 而不是只 target —— 部分 Vditor 渲染器会另建元素承载图。
        obs = new MutationObserver(() => {
            const inTarget = !!target.querySelector("svg, canvas, img, object");
            const inHost = !!host.querySelector("svg, canvas, img, object");
            if (inHost && !inTarget) target.style.display = "none";
            if (target.hasAttribute("data-processed") ||
                target.classList.contains("vditor-reset--error") ||
                inTarget || inHost) {
                finish();
            }
        });
        obs.observe(host, {
            attributes: true,
            attributeFilter: ["data-processed", "class"],
            childList: true,
            subtree: true,
        });
        // 兜底:资源加载慢/渲染器不打标记时也要重测一次,并断掉观察器
        window.setTimeout(() => {
            obs?.disconnect();
            finish();
        }, 12000);
    };
    start();
    return true;
}
