// 思源块只读数据访问(get/export 类 API,绝不写回)。
//
// 背景:.sy 是 JSON 化的 Lute AST 块树,不是 Markdown 文本。整篇覆盖 Markdown
// 会重新分配块 id、断块引用/反链/IAL、绕过 blocktree 索引同步 —— 所以这里
// 一律只读:块 DOM 用于原生样式预览,kramdown 作兜底,exportMdContent 用于
// 文档只读视图。
//
// 缓存/并发去重挂 window 注册表:webpack 分块会把模块求值两份,模块级变量
// 各自为政(见 monaco-block.ts 的实测铁律)。

import {postJSON} from "./file";

export interface DocMd {
    hPath: string;
    content: string;
}

interface BlockIoCache {
    dom: Map<string, string>;
    domInflight: Map<string, Promise<string>>;
    kramdown: Map<string, string>;
    kramdownInflight: Map<string, Promise<string>>;
    docs: Map<string, DocMd>;
    docsInflight: Map<string, Promise<DocMd>>;
}

const CACHE_KEY = "__syfeBlockIoCache";

function cache(): BlockIoCache {
    const w = window as any;
    let c = w[CACHE_KEY] as BlockIoCache | undefined;
    if (!c) {
        c = {
            dom: new Map<string, string>(),
            domInflight: new Map<string, Promise<string>>(),
            kramdown: new Map<string, string>(),
            kramdownInflight: new Map<string, Promise<string>>(),
            docs: new Map<string, DocMd>(),
            docsInflight: new Map<string, Promise<DocMd>>(),
        };
        w[CACHE_KEY] = c;
    }
    return c;
}

/** POST /api/block/getBlockDOMWithEmbed {id} → {id, dom}。
 *  内核渲染好的 protyle 块 DOM(含 IAL/块引用文本/嵌入块展开),配 .protyle >
 *  .protyle-wysiwyg 容器即可完整吃思源原生样式。优先于 kramdown 转换。 */
export function getBlockDOM(id: string): Promise<string> {
    const c = cache();
    const hit = c.dom.get(id);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = c.domInflight.get(id);
    if (pending) return pending;
    const p = postJSON<{id?: string; dom?: string}>(
        "/api/block/getBlockDOMWithEmbed", {id},
    ).then((d) => {
        const dom = String(d?.dom ?? "");
        c.dom.set(id, dom);
        return dom;
    }).catch(() => "").finally(() => c.domInflight.delete(id));
    c.domInflight.set(id, p);
    return p;
}

/** POST /api/block/getBlockKramdown {id} → {id, kramdown}(md 模式,保留 IAL)。
 *  仅在内核块 DOM 接口不可用/返回空时,交给 Lute.Md2BlockDOM 兜底转换。 */
export function getBlockKramdown(id: string): Promise<string> {
    const c = cache();
    const hit = c.kramdown.get(id);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = c.kramdownInflight.get(id);
    if (pending) return pending;
    const p = postJSON<{id?: string; kramdown?: string}>(
        "/api/block/getBlockKramdown", {id},
    ).then((d) => {
        const md = String(d?.kramdown ?? "");
        c.kramdown.set(id, md);
        return md;
    }).catch(() => "").finally(() => c.kramdownInflight.delete(id));
    c.kramdownInflight.set(id, p);
    return p;
}

/** POST /api/export/exportMdContent {id} → {hPath, content}(只读导出副本) */
export function exportDocMarkdown(id: string): Promise<DocMd> {
    const c = cache();
    const hit = c.docs.get(id);
    if (hit) return Promise.resolve(hit);
    const pending = c.docsInflight.get(id);
    if (pending) return pending;
    const p = postJSON<{hPath?: string; content?: string}>(
        "/api/export/exportMdContent", {id},
    ).then((d) => {
        const out: DocMd = {hPath: String(d?.hPath ?? ""), content: String(d?.content ?? "")};
        c.docs.set(id, out);
        return out;
    }).catch(() => ({hPath: "", content: ""} as DocMd))
      .finally(() => c.docsInflight.delete(id));
    c.docsInflight.set(id, p);
    return p;
}

/** POST /api/filetree/getDoc {id,size} → {content}:内核渲染好的整篇 protyle
 *  blockDOM(带 data-node-id / data-type),配 .protyle > .protyle-wysiwyg 容器
 *  即完整吃思源原生样式。用于 sydoc:// 文档只读视图,不经过三引擎。 */
export async function getDocBlockDOM(id: string): Promise<string> {
    const d = await postJSON<{content?: string}>("/api/filetree/getDoc", {id, size: 102400});
    return String(d?.content ?? "");
}

/** 把内核返回的 protyle 块 DOM 转成「只读预览」形态:
 *  去掉编辑态块标(.protyle-attr)、关闭所有 contenteditable/spellcheck。
 *  思源原生 DOM 内层是 contenteditable="true",外层 widget 的 false 压不住它,
 *  不处理的话只读卡片里的文字看起来/实际上都能改(虽然不会写回 .sy)。 */
export function sanitizeProtyleDOM(html: string): string {
    const host = document.createElement("div");
    host.innerHTML = html;
    host.querySelectorAll(".protyle-attr").forEach(el => el.remove());
    host.querySelectorAll("[contenteditable]").forEach(el => el.setAttribute("contenteditable", "false"));
    host.querySelectorAll("[spellcheck]").forEach(el => el.setAttribute("spellcheck", "false"));
    return host.innerHTML;
}

/** 外部改动后清缓存(缺省 id 则全清) */
export function invalidateBlockIo(id?: string): void {
    const c = cache();
    if (id) {
        c.dom.delete(id);
        c.kramdown.delete(id);
        c.docs.delete(id);
    } else {
        c.dom.clear();
        c.kramdown.clear();
        c.docs.clear();
    }
}
