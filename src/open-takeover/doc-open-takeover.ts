// 接管思源文档内打开文件
//
// 思源里文档内链接(assets/xxx、file:/// 本地路径、裸本地路径)的点击统一走
// app/src/editor/openLink.ts,在真正打开前会发**可取消的插件事件**:
//   - "open-asset":assets/ 相对路径与 file:// 本地路径(detail.path = 原始链接文本)
//   - "open-link" :其余本地路径(detail.href/originalHref)
// handler 返回 false 即取消思源默认打开 —— 我们借这个口子把文件改交本插件的
// openFileTab(自动按扩展名分派 markdown/图片/媒体/notebook/office/文本页签)。
//
// 为什么不走 DOM 拦截:思源已经把拦截点做成了官方插件事件,DOM capture 会漏掉
// 键盘回车、右键菜单"打开"等入口,还会和思源的点击委托抢时序。
//
// 配置热生效:handler 每次触发时都读 getConfig(),改设置不用重新注册。
//
// ⚠️ 取消语义:思源 EventBus 基于 EventTarget,emit 返回 dispatchEvent 的结果,
// 即"是否被 preventDefault"。所以**必须调 event.preventDefault() 来取消默认打开**,
// listener 的 return false 无效(实测踩过:只 return false 时思源照样打开)。
import {openFileTab} from "../tabs/editor-tab";
import {fileUrlToPath, getWorkspacePath} from "../utils/system-path";

export interface DocOpenTakeoverConfig {
    mode: "off" | "exts" | "all";
    exts: string;
}

/** 解析白名单:"md, .txt; TXT" → {"md","txt"} */
function parseExts(raw: string): Set<string> {
    const out = new Set<string>();
    for (const piece of (raw || "").split(/[,;\s]+/)) {
        const ext = piece.trim().replace(/^\.+/, "").toLowerCase();
        if (ext) out.add(ext);
    }
    return out;
}

/** 取路径扩展名(剥掉 URL query/hash;无扩展名返回 "") */
function extname(p: string): string {
    const clean = (p || "").split(/[?#]/)[0];
    const base = clean.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return ""; // ".md" 这种隐藏文件不算扩展名
    return base.slice(dot + 1).toLowerCase();
}

/** 判断这条打开请求是否应被接管 */
function shouldTakeOver(cfg: DocOpenTakeoverConfig, rawPath: string): boolean {
    if (!rawPath || cfg.mode === "off") return false;
    if (cfg.mode === "all") return true;
    return parseExts(cfg.exts).has(extname(rawPath));
}

/**
 * 把思源的链接文本还原为系统绝对路径。
 * 支持:assets/ 相对路径(= 工作空间 data 目录下)、file:// 链接、
 * Windows 盘符/UNC 路径、POSIX 绝对路径。其余(http/https/siyuan:// 等)返回 null。
 */
function toAbsolutePath(raw: string): string | null {
    const p = (raw || "").trim();
    if (!p) return null;
    let out: string | null = null;
    if (/^assets\//i.test(p)) {
        const ws = getWorkspacePath();
        if (!ws) return null;
        out = ws.replace(/[\\/]+$/, "") + "/data/" + p;
    } else {
        out = fileUrlToPath(p);
        if (!out) {
            // 裸本地路径:Windows 盘符 / UNC / POSIX 绝对路径
            if (/^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\/(?!\/)/.test(p)) out = p;
        }
    }
    if (!out) return null;
    // 统一成正斜杠:workspaceDir 是反斜杠形式,直接拼接会得到混合分隔符路径,
    // 下游 isMarkdownFile/isDirectory 等判定会因分隔符不一致而失败(实测踩过)
    return out.replace(/\\/g, "/");
}

/**
 * 注册接管。返回注销函数(插件卸载时调用)。
 * getConfig 每次事件触发时调用 —— 设置保存后立即生效,无需重新注册。
 */
export function registerDocOpenTakeover(
    plugin: {eventBus: {on: Function; off: Function}},
    getConfig: () => DocOpenTakeoverConfig,
): () => void {
    // 返回 true = 已接管(取消思源默认);false = 放行
    const takeOver = (rawPath: string, ev: Event | undefined): boolean => {
        const cfg = getConfig();
        if (!shouldTakeOver(cfg, rawPath)) return false; // 放行,走思源默认
        const abs = toAbsolutePath(rawPath);
        if (!abs) return false; // 解析不了本地路径就别拦,交给思源
        try {
            openFileTab(plugin as any, abs);
        } catch (e) {
            console.warn("[doc-open-takeover] 打开失败,回退思源默认:", rawPath, e);
            return false;
        }
        // 取消思源默认打开:必须 preventDefault(EventTarget 语义),return false 无效
        ev?.preventDefault?.();
        return true;
    };

    // assets/ 相对路径与 file:// 链接(思源把它们都算 asset)
    const onOpenAsset = (e: {detail?: {path?: string}} & Event) =>
        takeOver(e?.detail?.path || "", e as Event);
    // 其余本地路径(open-link 只对本地址发,https 等外链 detail.href 带 https:// 前缀,
    // toAbsolutePath 不认识会自动放行)
    const onOpenLink = (e: {detail?: {href?: string; originalHref?: string}} & Event) =>
        takeOver(e?.detail?.originalHref || e?.detail?.href || "", e as Event);

    plugin.eventBus.on("open-asset", onOpenAsset);
    plugin.eventBus.on("open-link", onOpenLink);
    return () => {
        try {
            plugin.eventBus.off("open-asset", onOpenAsset);
            plugin.eventBus.off("open-link", onOpenLink);
        } catch {
            // 插件卸载流程里 eventBus 可能已销毁,忽略
        }
    };
}
