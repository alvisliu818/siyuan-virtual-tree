import { Plugin } from "siyuan";
import "./styles.css";
import { initI18n } from "./i18n";
import { closeAll, rerenderAll, scan } from "./engine";
import { restoreAll, sweepInplace } from "./inplace";
import { registerRenderer } from "./registry";
import { mysqlRenderer } from "./renderers/mysql";
import { getSettings, mergeSettings, replaceSettings, SETTINGS_NAME } from "./settings";
import { setupSettings } from "./settings-panel";

const SETTINGS_FILE = SETTINGS_NAME;

export default class CodeRenderPlugin extends Plugin {
    private scanScheduled = false;

    async onload(): Promise<void> {
        initI18n();
        registerRenderer(mysqlRenderer);

        // 存储读出的是原始字符串；缺失/破损时 mergeSettings 会兜底成默认值
        let stored: unknown = null;
        try {
            const raw = await this.loadData(SETTINGS_FILE);
            stored = typeof raw === "string" && raw ? JSON.parse(raw) : raw;
        } catch {
            stored = null;
        }
        replaceSettings(mergeSettings(stored));

        setupSettings(this, () => {
            // 关掉就地渲染后必须还原，否则代码块会一直停留在本插件的着色里
            if (getSettings().renderTarget === "panel") restoreAll();
            rerenderAll();
            this.scanAll();
        });

        const scheduleScan = (root?: ParentNode) => {
            if (this.scanScheduled) return;
            this.scanScheduled = true;
            window.requestAnimationFrame(() => {
                this.scanScheduled = false;
                if (root) scan(root);
                else this.scanAll();
            });
        };

        this.eventBus.on("loaded-protyle-static", (e: any) => {
            const protyle = e?.detail?.protyle;
            if (protyle) scheduleScan(protyle.contentElement || protyle.element);
        });
        this.eventBus.on("loaded-protyle-dynamic", (e: any) => {
            const protyle = e?.detail?.protyle;
            if (protyle) scheduleScan(protyle.contentElement || protyle.element);
        });
        this.eventBus.on("switch-protyle", (e: any) => {
            const protyle = e?.detail?.protyle;
            scheduleScan(protyle?.contentElement || protyle?.element);
        });
        // 代码块语言被修改后重新匹配规则
        this.eventBus.on("code-language-change", () => scheduleScan());
        this.eventBus.on("code-language-update", () => scheduleScan());

        // 插件启用时文档可能早已打开，补扫一次
        window.setTimeout(() => this.scanAll(), 600);
        window.setTimeout(() => this.scanAll(), 2000);
    }

    onunload(): void {
        // 先把被接管的代码块还原成思源原生高亮，再停掉监听
        restoreAll();
        closeAll();
    }

    private scanAll(): void {
        document.querySelectorAll(".protyle-content").forEach((el) => {
            scan(el);
            sweepInplace(el);
        });
    }
}
