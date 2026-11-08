// 双链 dock(侧边功能栏):入链/出链面板常驻侧栏,自动跟随当前活动的文件页签。
// 与页签内嵌面板共用 createBacklinkPanel(数据层/渲染/点击跳转全同源),
// 这里只负责:注册 dock、跟随逻辑(可见页签路径识别)、生命周期清理。
// 跟随识别:可见的 .syfe-editor__path[data-path](代码文件页签)与
// .syfe-md__path[data-path](Markdown 页签)—— offsetParent 非 null 即活动页签。
// 思源文档页签不跟随(文档双链由思源原生反链面板与「查看引用」弹窗覆盖)。
import {BACKLINK_DOCK_TYPE} from "../constants";
import {createBacklinkPanel, BacklinkPanel} from "../components/backlink-panel";

export interface IPluginForBacklinkDock {
    app: any;
    name: string;
    getOpenedTab(): { [key: string]: any[] };
}

// 当前可见(活动)文件页签的路径;没有则 null
function visibleFilePath(): string | null {
    const paths = document.querySelectorAll<HTMLElement>(".syfe-editor__path[data-path], .syfe-md__path[data-path]");
    for (const el of Array.from(paths)) {
        // 隐藏页签的 offsetParent 为 null
        if (el.offsetParent !== null && el.dataset.path) return el.dataset.path;
    }
    return null;
}

export function createBacklinkDockConfig(plugin: IPluginForBacklinkDock) {
    let panel: BacklinkPanel | null = null;
    let timer: number | undefined;

    const follow = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            const p = visibleFilePath();
            if (p) panel?.setTarget(p);
        }, 150);
    };

    return {
        type: BACKLINK_DOCK_TYPE,
        config: {
            position: "RightBottom" as const,
            size: {width: 300, height: 0},
            icon: "iconLink",
            title: "双链",
            hotkey: "",
            show: false,
            index: 2,
        },
        data: {},
        init(this: { element: HTMLElement }) {
            this.element.classList.add("syfe-bldock", "fn__flex-column");
            this.element.innerHTML = `<div class="fn__flex-1 syfe-bldock__body"></div>`;
            const body = this.element.querySelector(".syfe-bldock__body") as HTMLElement;
            panel = createBacklinkPanel(plugin, visibleFilePath() || "", {expanded: true});
            body.appendChild(panel.el);
            // 跟随活动页签:编辑器聚焦/点击都视为切换信号(防抖合并)
            document.addEventListener("focusin", follow);
            document.addEventListener("click", follow);
        },
        destroy(this: { element: HTMLElement }) {
            document.removeEventListener("focusin", follow);
            document.removeEventListener("click", follow);
            window.clearTimeout(timer);
            panel?.dispose();
            panel = null;
        },
    };
}
