// 扩展市场 UI 组件
// 在思源设置面板中嵌入的扩展管理界面
// 功能: 搜索 Open VSX 扩展、安装/卸载、启用/禁用、查看已安装
import {Dialog, showMessage} from "siyuan";
import {
    search,
    installExtension,
    uninstallExtension,
    reinstallExtension,
    toggleExtension,
    getInstalledExtensions,
} from "./extension-manager";
import {getIconThemesWithMissingIcons} from "./icon-theme-loader";
import {InstalledExtension, SearchEntry, ExtensionSource} from "./types";
import {refreshAllExpanded} from "../components/file-tree";
import type {Plugin} from "siyuan";

// 按用户偏好重新应用主题并刷新设置面板(插件实例上若无这些方法则忽略)
function syncThemesWithPreference(plugin: Plugin): void {
    const p = plugin as any;
    if (typeof p?.applyConfiguredThemes === "function") {
        p.applyConfiguredThemes();
    }
    if (typeof p?.refreshThemeSettingUI === "function") {
        p.refreshThemeSettingUI();
    }
}
import type {Plugin} from "siyuan";

function escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 刷新所有已打开的文件树,更新图标
function refreshFileTrees(): void {
    document.querySelectorAll<HTMLElement>(".syfe-tree__root").forEach(el => refreshAllExpanded(el));
}

// 打开扩展市场对话框
export async function openExtensionMarket(plugin: Plugin): Promise<void> {
    const dialog = new Dialog({
        title: "扩展市场 - VSCode 扩展",
        content: `<div class="syfe-ext-market">
            <div class="syfe-ext-market__search">
                <select class="b3-select" id="syfe-ext-source-select">
                    <option value="openvsx">Open VSX Registry</option>
                    <option value="vscode-marketplace">VSCode Marketplace</option>
                </select>
                <input type="text" class="b3-text-field fn__flex-1" id="syfe-ext-search-input" placeholder="搜索扩展(如: python, themes, snippets)..." />
                <button class="b3-button b3-button--outline" id="syfe-ext-search-btn">搜索</button>
            </div>
            <div class="syfe-ext-market__tabs">
                <button class="b3-button b3-button--text syfe-ext-market__tab syfe-ext-market__tab--active" data-tab="search">搜索结果</button>
                <button class="b3-button b3-button--text syfe-ext-market__tab" data-tab="installed">已安装</button>
            </div>
            <div class="syfe-ext-market__list" id="syfe-ext-list">
                <div class="syfe-ext-market__empty">输入关键词搜索扩展</div>
            </div>
        </div>`,
        width: "80%",
        height: "70%",
    });

    const listEl = dialog.element.querySelector("#syfe-ext-list") as HTMLElement;
    const searchInput = dialog.element.querySelector("#syfe-ext-search-input") as HTMLInputElement;
    const searchBtn = dialog.element.querySelector("#syfe-ext-search-btn") as HTMLElement;
    const sourceSelect = dialog.element.querySelector("#syfe-ext-source-select") as HTMLSelectElement;
    const tabs = dialog.element.querySelectorAll(".syfe-ext-market__tab");

    let currentTab = "search";
    let currentSource: ExtensionSource = "openvsx";

    // 搜索
    const doSearch = async () => {
        const query = searchInput.value.trim();
        if (!query) return;
        currentSource = sourceSelect.value as ExtensionSource;
        listEl.innerHTML = `<div class="syfe-ext-market__loading">搜索中...</div>`;
        try {
            const result = await search(query, 30, currentSource);
            renderSearchResults(listEl, result.extensions, plugin);
        } catch (e) {
            listEl.innerHTML = `<div class="syfe-ext-market__error">搜索失败: ${escapeHTML(String(e))}</div>`;
        }
    };

    searchBtn.addEventListener("click", doSearch);
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearch();
    });

    // Tab 切换
    tabs.forEach(tab => {
        tab.addEventListener("click", async () => {
            tabs.forEach(t => t.classList.remove("syfe-ext-market__tab--active"));
            tab.classList.add("syfe-ext-market__tab--active");
            currentTab = (tab as HTMLElement).dataset.tab!;
            if (currentTab === "installed") {
                listEl.innerHTML = `<div class="syfe-ext-market__loading">加载中...</div>`;
                const installed = await getInstalledExtensions(plugin);
                renderInstalledList(listEl, installed, plugin);
            } else {
                listEl.innerHTML = `<div class="syfe-ext-market__empty">输入关键词搜索扩展</div>`;
            }
        });
    });
}

// 渲染搜索结果
function renderSearchResults(
    container: HTMLElement,
    entries: SearchEntry[],
    plugin: Plugin,
): void {
    if (entries.length === 0) {
        container.innerHTML = `<div class="syfe-ext-market__empty">未找到匹配的扩展</div>`;
        return;
    }
    container.innerHTML = entries.map(e => `
        <div class="syfe-ext-card" data-id="${escapeHTML(e.namespace)}.${escapeHTML(e.name)}">
            <div class="syfe-ext-card__icon">
                ${e.iconLink ? `<img src="${escapeHTML(e.iconLink)}" alt="" />` : `<svg class="syfe-ext-card__icon-default"><use xlink:href="#iconPackage"></use></svg>`}
            </div>
            <div class="syfe-ext-card__info">
                <div class="syfe-ext-card__title">${escapeHTML(e.displayName || e.name)}</div>
                <div class="syfe-ext-card__meta">${escapeHTML(e.namespace)}.${escapeHTML(e.name)} · v${escapeHTML(e.version)} · ${e.source === "vscode-marketplace" ? "Marketplace" : "Open VSX"}</div>
                <div class="syfe-ext-card__desc">${escapeHTML(e.description || "")}</div>
            </div>
            <div class="syfe-ext-card__action">
                <button class="b3-button b3-button--text syfe-ext-install-btn" data-namespace="${escapeHTML(e.namespace)}" data-name="${escapeHTML(e.name)}" data-source="${escapeHTML(e.source || "openvsx")}" data-version="${escapeHTML(e.version)}">
                    安装
                </button>
            </div>
        </div>
    `).join("");

    // 绑定安装按钮
    container.querySelectorAll(".syfe-ext-install-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            const target = ev.currentTarget as HTMLElement;
            const ns = target.dataset.namespace!;
            const name = target.dataset.name!;
            const source = (target.dataset.source || "openvsx") as ExtensionSource;
            const version = target.dataset.version;
            target.textContent = "安装中...";
            (target as HTMLButtonElement).disabled = true;
            try {
                await installExtension(plugin, ns, name, source, version);
                target.textContent = "已安装";
                showMessage(`扩展 ${ns}.${name} 安装成功`, 3000, "info");
                // 安装后按用户偏好应用主题并刷新文件树图标
                syncThemesWithPreference(plugin);
                refreshFileTrees();
            } catch (e) {
                target.textContent = "安装";
                (target as HTMLButtonElement).disabled = false;
                showMessage(`安装失败: ${e}`, 5000, "error");
            }
        });
    });
}

// 渲染已安装列表
function renderInstalledList(
    container: HTMLElement,
    extensions: InstalledExtension[],
    plugin: Plugin,
): void {
    if (extensions.length === 0) {
        container.innerHTML = `<div class="syfe-ext-market__empty">尚未安装任何扩展</div>`;
        return;
    }
    // 图标主题声明了图标但 SVG 全部缺失(历史安装数据不完整)的扩展 id
    const brokenIconExts = new Set(getIconThemesWithMissingIcons().map(t => t.extensionId));

    container.innerHTML = extensions.map(e => `
        <div class="syfe-ext-card" data-id="${escapeHTML(e.id)}">
            <div class="syfe-ext-card__icon">
                ${e.icon ? `<img src="${escapeHTML(e.icon)}" alt="" />` : `<svg class="syfe-ext-card__icon-default"><use xlink:href="#iconPackage"></use></svg>`}
            </div>
            <div class="syfe-ext-card__info">
                <div class="syfe-ext-card__title">${escapeHTML(e.displayName)}</div>
                <div class="syfe-ext-card__meta">${escapeHTML(e.namespace)}.${escapeHTML(e.name)} · v${escapeHTML(e.version)} · ${e.enabled ? "已启用" : "已禁用"}</div>
                <div class="syfe-ext-card__desc">${escapeHTML(e.description)}</div>
                <div class="syfe-ext-card__contrib">
                    ${e.contributes.grammars?.length ? `<span class="syfe-tag">语法 ×${e.contributes.grammars.length}</span>` : ""}
                    ${e.contributes.themes?.length ? `<span class="syfe-tag">主题 ×${e.contributes.themes.length}</span>` : ""}
                    ${e.contributes.iconThemes?.length ? `<span class="syfe-tag">图标 ×${e.contributes.iconThemes.length}</span>` : ""}
                    ${e.contributes.snippets?.length ? `<span class="syfe-tag">片段 ×${e.contributes.snippets.length}</span>` : ""}
                    ${brokenIconExts.has(e.id) ? `<span class="syfe-tag syfe-tag--warn" title="图标文件缺失,请点「重装」重新下载">图标缺失</span>` : ""}
                </div>
            </div>
            <div class="syfe-ext-card__action">
                <button class="b3-button b3-button--text syfe-ext-toggle-btn" data-id="${escapeHTML(e.id)}">
                    ${e.enabled ? "禁用" : "启用"}
                </button>
                <button class="b3-button b3-button--text syfe-ext-reinstall-btn" data-id="${escapeHTML(e.id)}" title="重新下载并解包,用于修复文件缺失">
                    重装
                </button>
                <button class="b3-button b3-button--text syfe-ext-uninstall-btn" data-id="${escapeHTML(e.id)}">
                    卸载
                </button>
            </div>
        </div>
    `).join("");

    // 绑定启用/禁用按钮
    container.querySelectorAll(".syfe-ext-toggle-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            const target = ev.currentTarget as HTMLElement;
            const id = target.dataset.id!;
            await toggleExtension(plugin, id);
            const installed = await getInstalledExtensions(plugin);
            renderInstalledList(container, installed, plugin);
            showMessage("已切换,重新加载插件后生效", 3000, "info");
        });
    });

    // 绑定重装按钮(重新下载解包,修复历史安装导致的文件缺失)
    container.querySelectorAll(".syfe-ext-reinstall-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            const target = ev.currentTarget as HTMLButtonElement;
            const id = target.dataset.id!;
            target.textContent = "重装中...";
            target.disabled = true;
            try {
                await reinstallExtension(plugin, id);
                const installed = await getInstalledExtensions(plugin);
                renderInstalledList(container, installed, plugin);
                showMessage("重装完成,图标已刷新", 3000, "info");
                syncThemesWithPreference(plugin);
                refreshFileTrees();
            } catch (e) {
                target.textContent = "重装";
                target.disabled = false;
                showMessage(`重装失败: ${e}`, 5000, "error");
            }
        });
    });

    // 绑定卸载按钮
    container.querySelectorAll(".syfe-ext-uninstall-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
            const target = ev.currentTarget as HTMLElement;
            const id = target.dataset.id!;
            try {
                await uninstallExtension(plugin, id);
                const installed = await getInstalledExtensions(plugin);
                renderInstalledList(container, installed, plugin);
                // 被卸载扩展的主题可能被移除,按偏好回退并刷新设置选项
                syncThemesWithPreference(plugin);
                refreshFileTrees();
                showMessage("已卸载,重新加载插件后完全清理", 3000, "info");
            } catch (e) {
                showMessage(`卸载失败: ${e}`, 5000, "error");
            }
        });
    });
}
