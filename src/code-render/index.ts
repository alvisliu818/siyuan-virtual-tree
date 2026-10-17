// 代码块渲染:并入宿主(siyuan-virtual-tree)后的适配层。
//
// 原独立插件(siyuan-plugin-code-render)的 onload/onunload 拆成 init/destroy:
//  - 事件挂宿主 plugin.eventBus(loaded-protyle-static/dynamic、switch-protyle、code-language-*)
//  - 设置持久化走宿主 saveData("code-render-settings.json")
//  - 设置 UI 挂进宿主已有的 Setting 实例(见 settings-panel.setupCodeRenderSettings,
//    不自建 Setting —— 那会覆盖宿主的 plugin.setting,宿主设置面板直接消失)
// 引擎/inplace/渲染器等其余文件与独立插件版本保持一致,便于跟随上游。
import "./styles.css";
import type {Setting} from "siyuan";
import {closeAll, rerenderAll, scan} from "./engine";
import {restoreAll, stopWatching, sweepInplace} from "./inplace";
import {initI18n} from "./i18n";
import {registerRenderer} from "./registry";
import {mysqlRenderer} from "./renderers/mysql";
import {getSettings, mergeSettings, replaceSettings, LEGACY_SETTINGS_NAME, SETTINGS_NAME} from "./settings";
import {setupCodeRenderSettings} from "./settings-panel";

let scanScheduled = false;

export function scanAllCodeRender(): void {
    if (!getSettings().enabled) return;
    document.querySelectorAll(".protyle-content").forEach((el) => {
        scan(el);
        sweepInplace(el);
    });
}

function scheduleScan(root?: ParentNode): void {
    if (scanScheduled) return;
    scanScheduled = true;
    window.requestAnimationFrame(() => {
        scanScheduled = false;
        if (root) scan(root);
        else scanAllCodeRender();
    });
}

/** 宿主 onload 调用:注册渲染器、读设置、挂事件总线、补扫已打开文档 */
export function initCodeRender(host: any): void {
    initI18n();
    registerRenderer(mysqlRenderer);

    void (async () => {
        // 存对象(思源会自行 JSON.stringify);loadData 返回原始字符串时再 parse。
        // 新名字读不到时回退到旧的 settings.json(该文件名已让给宿主的用户设置),
        // 读到就把内容迁到新名字下,避免用户重配一遍。
        let stored: unknown = null;
        let migrated = false;
        try {
            const raw = await host.loadData(SETTINGS_NAME);
            stored = typeof raw === "string" && raw ? JSON.parse(raw) : raw;
        } catch {
            stored = null;
        }
        if (!stored || (typeof stored === "object" && !Object.keys(stored as object).length)) {
            try {
                const legacy = await host.loadData(LEGACY_SETTINGS_NAME);
                const parsed = typeof legacy === "string" && legacy ? JSON.parse(legacy) : legacy;
                // 只认本模块的形状(rules + dataSources),宿主用户设置不会长这样
                if (parsed && Array.isArray(parsed.rules) && Array.isArray(parsed.dataSources)) {
                    stored = parsed;
                    migrated = true;
                }
            } catch {
                // 旧文件不存在或已变成别的东西:忽略
            }
        }
        replaceSettings(mergeSettings(stored));
        if (migrated) {
            try {
                await host.saveData(SETTINGS_NAME, getSettings());
            } catch {
                // 迁移写失败不致命:下次还能从旧文件读
            }
        }
        scanAllCodeRender();
    })();

    const onLoaded = (e: any) => {
        const protyle = e?.detail?.protyle;
        scheduleScan(protyle?.contentElement || protyle?.element);
    };
    host.eventBus.on("loaded-protyle-static", onLoaded);
    host.eventBus.on("loaded-protyle-dynamic", onLoaded);
    host.eventBus.on("switch-protyle", onLoaded);
    // 代码块语言被修改后重新匹配规则
    host.eventBus.on("code-language-change", () => scheduleScan());
    host.eventBus.on("code-language-update", () => scheduleScan());

    // 插件启用时文档可能早已打开,补扫一次
    window.setTimeout(() => scanAllCodeRender(), 600);
    window.setTimeout(() => scanAllCodeRender(), 2000);
}

/** 宿主设置面板调用:把外观/规则/数据源三组挂进宿主 Setting 实例 */
export function setupCodeRenderSettingItems(setting: Setting, host: any): void {
    setupCodeRenderSettings(setting, {
        saveData: (file, data) => host.saveData(file, data),
        rescan: () => {
            // 关掉就地渲染后必须还原,否则代码块会停留在本模块的着色里
            if (getSettings().renderTarget === "panel") restoreAll();
            rerenderAll();
            scanAllCodeRender();
        },
    });
}

/** 宿主 onunload 调用:先还原被接管的代码块,再停掉监听 */
export function destroyCodeRender(): void {
    restoreAll();
    closeAll();
    stopWatching();
}
