// 思源原生标签的挂载面板:给虚拟文档树里的思源文档/块打标签。
// 复用思源自己的标签数据(blocks.type='t'),标签会出现在思源标签面板与标签页签里。
import {Dialog, showMessage} from "siyuan";
import {listDocTags, listAllTags, addDocTag, removeDocTag, normalizeTag} from "../utils/siyuan-tags";

function escapeHTML(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 打开标签面板:上方是该文档现有标签(点击移除),下方输入新标签 + 已有标签建议
export function openSiyuanTagDialog(docRootId: string, docTitle: string): void {
    const dialog = new Dialog({
        title: "文档标签",
        content: `
            <div class="b3-dialog__content syfe-sytag">
                <div class="syfe-sytag__doc">${escapeHTML(docTitle || docRootId)}</div>
                <div class="b3-form__label" style="display:block;margin-bottom:4px;">已有标签(点击移除)</div>
                <div class="syfe-sytag__current" id="syfe-sytag-current">加载中…</div>
                <div class="b3-form__label" style="display:block;margin:10px 0 4px;">添加标签</div>
                <input class="b3-text-field fn__block" id="syfe-sytag-input" placeholder="标签名(可含中文)" />
                <div class="syfe-sytag__suggest" id="syfe-sytag-suggest"></div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-sytag-cancel">关闭</button>
                <button class="b3-button b3-button--text" id="syfe-sytag-ok">添加</button>
            </div>`,
        width: "460px",
    });
    const currentEl = dialog.element.querySelector("#syfe-sytag-current") as HTMLElement;
    const suggestEl = dialog.element.querySelector("#syfe-sytag-suggest") as HTMLElement;
    const inputEl = dialog.element.querySelector("#syfe-sytag-input") as HTMLInputElement;
    const close = () => dialog.destroy();

    // 刷新"已有标签"区域
    const refreshCurrent = async () => {
        try {
            const tags = await listDocTags(docRootId);
            currentEl.innerHTML = tags.length
                ? tags.map(t => `<span class="syfe-sytag__chip" data-remove="${escapeHTML(t)}" title="点击移除">#${escapeHTML(t)} ×</span>`).join("")
                : `<span class="syfe-sytag__none">暂无标签</span>`;
        } catch (e) {
            currentEl.innerHTML = `<span class="syfe-sytag__none">读取失败:${escapeHTML(String(e))}</span>`;
        }
    };

    // 建议区:工作区已有标签,点一下填进输入框
    const renderSuggest = async (current: string[]) => {
        try {
            const all = await listAllTags();
            const rest = all.filter(t => !current.includes(t)).slice(0, 24);
            suggestEl.innerHTML = rest.length
                ? rest.map(t => `<span class="syfe-sytag__chip" data-fill="${escapeHTML(t)}">#${escapeHTML(t)}</span>`).join("")
                : "";
        } catch {
            suggestEl.innerHTML = "";
        }
    };

    const doAdd = async () => {
        const tag = normalizeTag(inputEl.value);
        if (!tag) {
            showMessage("请输入标签名", 2000, "error");
            return;
        }
        try {
            await addDocTag(docRootId, tag);
            inputEl.value = "";
            showMessage(`已添加标签 #${tag}`, 2000, "info");
            await refreshCurrent();
            void renderSuggest(await listDocTags(docRootId));
        } catch (e) {
            showMessage(`添加标签失败:${e}`, 3000, "error");
        }
    };

    dialog.element.addEventListener("click", (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        const fill = t.closest("[data-fill]") as HTMLElement | null;
        if (fill) {
            inputEl.value = fill.dataset.fill!;
            inputEl.focus();
            return;
        }
        const rm = t.closest("[data-remove]") as HTMLElement | null;
        if (rm) {
            const tag = rm.dataset.remove!;
            void (async () => {
                try {
                    await removeDocTag(docRootId, tag);
                    showMessage(`已移除标签 #${tag}`, 2000, "info");
                    await refreshCurrent();
                    void renderSuggest(await listDocTags(docRootId));
                } catch (err) {
                    showMessage(`移除标签失败:${err}`, 3000, "error");
                }
            })();
            return;
        }
        if (t.closest("#syfe-sytag-ok")) {
            void doAdd();
        } else if (t.closest("#syfe-sytag-cancel")) {
            close();
        }
    });
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void doAdd();
        }
    });
    inputEl.focus();

    void (async () => {
        await refreshCurrent();
        try {
            await renderSuggest(await listDocTags(docRootId));
        } catch {
            // 建议加载失败不影响主流程
        }
    })();
}
