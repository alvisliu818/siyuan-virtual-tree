/**
 * 把 mysql 注册为 hljs 的 sql 别名，让思源原生 highlightRender 给 mysql 代码块上 sql 着色。
 *
 * 为什么这么做：思源对「hljs 语言表里有」的语言（如 sql）是边输入边高亮的
 * （input.ts 每次 input 都 removeAttribute("data-render") + highlightRender，用 <wbr>+
 * focusByOffset 保光标）。但 mysql 不在 hljs 语言表里，原生渲染成 plaintext。注册成 sql
 * 别名后，mysql 代码块就和原生 sql 块一样：输入时实时高亮、光标由内核 focusByOffset 处理，
 * 插件不需要在输入时改写 DOM，从根上避免了「插件改写 DOM 与内核光标恢复打架」导致的
 * 光标乱跳/卡顿。
 *
 * hljs 是思源懒加载的（highlightRender 里 addScript），插件启动时 window.hljs 可能还没就绪，
 * 故 ensureMysqlAlias 设计成幂等 + 可重复调用：hljs 没就绪时返回 false，等下一次 scan 再试。
 */
import { CODE_BLOCK_SELECTOR, getBlockLang, getHljsHost } from "./dom";

interface HljsApi {
    getLanguage?: (lang: string) => unknown;
    registerAliases?: (aliases: string | string[], opts: { languageName: string }) => void;
}

let aliasEnsured = false;

/** 注册 mysql→sql 别名。幂等；hljs 未就绪时返回 false（调用方下次再试）。 */
export function ensureMysqlAlias(): boolean {
    if (aliasEnsured) return true;
    const hljs = (window as unknown as { hljs?: HljsApi }).hljs;
    if (!hljs?.registerAliases) return false;
    try {
        if (!hljs.getLanguage?.("mysql")) {
            hljs.registerAliases("mysql", { languageName: "sql" });
        }
        aliasEnsured = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * 把「注册别名之前被渲染成 plaintext」的 mysql 块重渲染一次，拿原生 sql 着色。
 * 每个 protyle 容器只刷一次（WeakSet 记账）。之后新打开/输入的块由内核自动用别名着色。
 */
const refreshed = new WeakSet<Element>();

export function refreshMysqlNative(root: ParentNode | null | undefined): void {
    if (!aliasEnsured || !root?.querySelectorAll) return;
    if (refreshed.has(root)) return;
    refreshed.add(root);
    const protyleHighlight = (window as unknown as {
        Protyle?: { highlightRender?: (el: Element) => void };
    }).Protyle?.highlightRender;
    if (!protyleHighlight) return;
    root.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR).forEach((block) => {
        if (getBlockLang(block) !== "mysql") return;
        const host = getHljsHost(block);
        if (!host) return;
        // 强制重渲染：去掉 data-render 让 highlightRender 重新跑（这次能命中已注册的别名）
        host.removeAttribute("data-render");
        try {
            protyleHighlight(block);
        } catch {
            /* ignore */
        }
    });
}
