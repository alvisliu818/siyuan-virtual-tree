/**
 * 就地渲染的 DOM 集成测试（jsdom）。
 *
 * 这个文件存在的唯一理由：**曾经把思源整个卡死过**。
 * 当时的写法是给每个 .hljs 挂 MutationObserver，我们写入 → observer 触发 → 再写入 → 死循环。
 * 纯算法测试完全覆盖不到这种回环，必须在真实 MutationObserver 下跑。
 *
 * 覆盖点：
 *  1. 正常接管一次，且 textContent 逐字不变（保存安全）
 *  2. 稳定后不再产生 DOM 写入（无回环）—— 核心回归
 *  3. 思源重新高亮抹掉我们的节点后，只补一次，然后重新稳定
 *  4. 思源整块重建 DOM（输入时的真实行为）后能接管新块
 *  5. 编辑态不接管（交给内核原生高亮），失焦后才接管
 *  6. 渲染器返回的文本与原文不符时，回退纯文本并停用该块（绝不污染笔记）
 *  7. restoreAll 能干净还原
 */
import { JSDOM } from "jsdom";

let failed = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
        console.log(`✓ ${name}`);
    } else {
        failed++;
        console.log(`✗ ${name}\n  实际: ${a}\n  期望: ${e}`);
    }
}

function checkTrue(name: string, cond: boolean): void {
    check(name, cond, true);
}

const CODE = "select id, name from t_user where id > 1 and name like '%a%'";

const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div class="protyle-content"><div class="protyle-wysiwyg"></div></div></body></html>`,
    { pretendToBeVisual: true },
);

// inplace.ts 在调用时才读全局，因此这里先注入再 import 业务模块
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.MutationObserver = dom.window.MutationObserver;
g.Node = dom.window.Node;
g.NodeFilter = dom.window.NodeFilter;
g.HTMLElement = dom.window.HTMLElement;

/* eslint-disable @typescript-eslint/no-var-requires */
const { applyInplace, restoreAll, sweepInplace, watchContainer, stopWatching } = require("../src/inplace") as typeof import("../src/inplace");
const { registerRenderer } = require("../src/registry") as typeof import("../src/registry");
const { mysqlRenderer } = require("../src/renderers/mysql") as typeof import("../src/renderers/mysql");
const { mergeSettings, replaceSettings } = require("../src/settings") as typeof import("../src/settings");

registerRenderer(mysqlRenderer);
replaceSettings(mergeSettings({}));

const doc = dom.window.document;
const wysiwyg = doc.querySelector(".protyle-wysiwyg") as HTMLElement;

/** 按思源真实结构造一个 mysql 代码块 */
function makeBlock(code: string, id = "20260908110000-abcdefg"): HTMLElement {
    const block = doc.createElement("div");
    block.setAttribute("data-node-id", id);
    block.setAttribute("data-type", "NodeCodeBlock");
    block.className = "code-block";
    block.innerHTML =
        '<div class="protyle-action">' +
        '<span class="protyle-action--first protyle-action__language">mysql</span>' +
        "</div>" +
        '<div class="hljs" data-render="true">' +
        '<div class="protyle-linenumber__rows" contenteditable="false"></div>' +
        '<div contenteditable="true" spellcheck="false"></div>' +
        "</div>" +
        '<div class="protyle-attr" contenteditable="false"></div>';
    const codeEl = block.querySelector(".hljs")!.lastElementChild as HTMLElement;
    codeEl.textContent = code;
    return block;
}

function codeElOf(block: HTMLElement): HTMLElement {
    return block.querySelector(".hljs")!.lastElementChild as HTMLElement;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 独立的旁观 observer：统计代码块内容区被写了多少次，用于检测回环 */
function spyOn(el: HTMLElement): () => number {
    let n = 0;
    const mo = new dom.window.MutationObserver(() => {
        n++;
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => n;
}

async function main(): Promise<void> {
    /* --- 1&2. 接管一次 + 稳定后无回环 --- */
    const block = makeBlock(CODE);
    wysiwyg.appendChild(block);
    let codeEl = codeElOf(block);

    watchContainer(wysiwyg);
    sweepInplace(wysiwyg);
    await tick(200);

    checkTrue("接管后插入包裹节点", !!codeEl.querySelector(".cr-hl"));
    checkTrue("接管后使用 hljs 类名", !!codeEl.querySelector(".hljs-keyword"));
    check("接管后文本逐字不变（末尾补换行同思源）", codeEl.textContent, CODE + "\n");

    // 稳定期观测：若存在回环，这里会持续产生写入
    const countAfterSettle = spyOn(codeEl);
    await tick(500);
    check("稳定后不再写 DOM（无回环）", countAfterSettle(), 0);

    /* --- 3. 思源重新高亮抹掉我们的节点后，只补一次 --- */
    const countAfterRehighlight = spyOn(codeEl);
    // 模拟内核 highlightRender：直接覆盖内容区
    codeEl.innerHTML = CODE.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "\n";
    await tick(400);
    checkTrue("被覆盖后重新接管", !!codeEl.querySelector(".cr-hl"));
    check("被覆盖后文本仍逐字不变", codeEl.textContent, CODE + "\n");
    // 1 次是我们模拟的覆盖，1 次是插件补写；再多就说明有回环
    checkTrue(`补写次数收敛（实际 ${countAfterRehighlight()} 次）`, countAfterRehighlight() <= 3);

    /* --- 4. 思源整块重建 DOM（输入时的真实行为） --- */
    const fresh = makeBlock(CODE, "20260908110000-abcdefg");
    block.insertAdjacentElement("afterend", fresh);
    block.remove();
    await tick(300);
    codeEl = codeElOf(fresh);
    checkTrue("整块重建后接管新块", !!codeEl.querySelector(".cr-hl"));
    check("整块重建后文本不变", codeEl.textContent, CODE + "\n");

    /* --- 5. 编辑态不接管（交给内核原生高亮），失焦后才接管 --- */
    // mysql 已注册为 hljs 的 sql 别名，输入时由思源原生 highlightRender 着色（内核 focusByOffset 保光标）。
    // 插件在编辑态绝不改写 DOM，否则会和内核光标恢复打架 → 光标乱跳。失焦后再接管。
    codeEl.textContent = CODE + "\n";
    const selEdit = dom.window.getSelection()!;
    const rangeEdit = doc.createRange();
    rangeEdit.selectNodeContents(codeEl);
    rangeEdit.collapse(true); // 光标折叠到块内开头 → 编辑态
    selEdit.removeAllRanges();
    selEdit.addRange(rangeEdit);
    check("编辑态不接管（返回 false）", applyInplace(fresh), false);
    checkTrue("编辑态不写 DOM", !codeEl.querySelector(".cr-hl"));
    // 失焦（光标离开代码块）→ 触发 focusout → 接管
    selEdit.removeAllRanges();
    codeEl.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
    await tick(120);
    checkTrue("失焦后接管", !!codeEl.querySelector(".cr-hl"));
    check("失焦后文本逐字不变", codeEl.textContent, CODE + "\n");

    /* --- 6. 渲染器改了文本 → 回退纯文本并停用 --- */
    const badBlock = makeBlock("select 1", "20260908110001-badbadb");
    wysiwyg.appendChild(badBlock);
    const badCodeEl = codeElOf(badBlock);
    // 临时把 mysql 渲染器的 inplace 换成「会吞字符」的坏实现
    const prettyMode = mysqlRenderer.modes.find((m) => m.id === "pretty")!;
    const goodInplace = prettyMode.inplace;
    prettyMode.inplace = () => "<span>select</span>";
    const ok = applyInplace(badBlock);
    prettyMode.inplace = goodInplace;

    check("文本被改时应用失败", ok, false);
    check("文本被改时回退为原文纯文本", badCodeEl.textContent, "select 1\n");
    checkTrue("文本被改时不留包裹节点", !badCodeEl.querySelector(".cr-hl"));
    // 停用后即使换回正常实现也不再接管该块，避免反复写坏
    check("坏块已被停用", applyInplace(badBlock), false);

    /* --- 7. restoreAll + stopWatching 干净还原（即插件 onunload 的真实序列） --- */
    // 注意：restoreAll 改写内容会触发仍连着的 observer，若不再 stopWatching 会重新接管。
    // 真实卸载路径是 restoreAll() → closeAll() → stopWatching()，后者取消待处理 flush 并断开 observer。
    // 卸载必然先离开编辑器，故先清掉选区（否则 restoreInplace 会因 isEditing 而跳过还原）。
    dom.window.getSelection()!.removeAllRanges();
    restoreAll();
    stopWatching();
    await tick(150);
    checkTrue("还原后无包裹节点", doc.querySelectorAll(".cr-hl").length === 0);
    check("还原后文本完整", codeElOf(fresh).textContent, CODE + "\n");

    console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
    if (failed) process.exit(1);
}

void main();
