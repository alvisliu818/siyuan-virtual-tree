// 思源原生编辑器的斜杆命令扩展
// 通过 plugin.protyleSlash 注册(思源 hint 菜单会自动收集插件项)
// 命令:插入文件链接(搜索文件 → 插入 file:// 链接 → 刷新反向链接面板)
import {showMessage} from "siyuan";
import type {Plugin, Protyle} from "siyuan";
import {openFilePicker} from "../components/file-picker";
import {toFileLink, toMarkdownFileLink} from "../utils/system-path";
import {basename} from "../utils/path";

// 触发反向链接面板刷新(自定义事件,backlink-panel 监听后按路径匹配重扫)
const BACKLINK_REFRESH_EVENT = "syfe:backlink-refresh";

export function emitBacklinkRefresh(path: string): void {
    window.dispatchEvent(new CustomEvent(BACKLINK_REFRESH_EVENT, {detail: {path}}));
}

// 删除光标前残留的斜杆命令文本(如 "/file")
// 思源对插件项不会自动删除已输入的关键字(内置项才会 deleteContents),这里兜底清理
function removeSlashText(): void {
    try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (!node || node.nodeType !== 3) return;
        const text = node.textContent || "";
        const before = text.slice(0, range.startOffset);
        const m = before.match(/\/[^/\s]*$/);
        if (!m) return;
        const start = range.startOffset - m[0].length;
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, range.startOffset);
        r.deleteContents();
        // 删完后把光标放回该位置
        const after = document.createRange();
        after.setStart(node, start);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
    } catch {
        // 清理失败不阻断插入
    }
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 把文件链接插入到思源笔记当前光标处
// 用思源原生链接节点 <span data-type="a" data-href="..."> —— 与思源内置「插入文件链接」
// (app/src/asset/renderAssets.ts 的 genAssetHTML)一致。protyle.insert 经
// lute.SpinBlockDOM 会把它识别为 NodeLink,存成 [名称](file:///...) 的 markdown(kramdown),
// 渲染为可点击链接,且能被反向链接扫描解析到(见 utils/backlink 的 MD_LINK_RE)。
// 注意:不要用裸 <a href>,Lute 可能原样保留为 HTML 而非 markdown 链接。
function insertFileLink(protyle: Protyle, filePath: string): void {
    const link = toMarkdownFileLink(filePath);
    const url = link?.url || toFileLink(filePath) || "";
    if (!url) {
        showMessage("无法生成文件链接(缺少工作空间路径)", 4000, "error");
        return;
    }
    const label = link?.label || basename(filePath);
    removeSlashText();
    const html = `<span data-type="a" data-href="${escapeHTML(url)}">${escapeHTML(label)}</span>`;
    try {
        (protyle as any).insert(html, false, true);
    } catch (e) {
        showMessage(`插入失败: ${e}`, 4000, "error");
        return;
    }
    // 插入后刷新该文件已打开的反向链接面板,使新引用立即出现
    emitBacklinkRefresh(filePath);
}

// 注册斜杆命令
export function registerSlashCommands(plugin: Plugin, getRootPath: () => string): void {
    plugin.protyleSlash.push({
        filter: ["file", "文件", "wj", "插入文件"],
        html: `<div class="b3-list-item__first">
            <svg class="b3-list-item__graphic"><use xlink:href="#iconFile"></use></svg>
            <span class="b3-list-item__text">插入文件链接(搜索文件)</span>
        </div>`,
        id: "syfeInsertFileLink",
        callback: (protyle: Protyle) => {
            const root = getRootPath();
            openFilePicker({
                rootPath: root,
                title: "插入文件链接",
                allowDir: true,
                onPick: (path: string) => {
                    insertFileLink(protyle, path);
                },
            });
        },
    });
}
