// 系统文件/文件夹选择对话框
//
// 为什么自己封装:思源没有给插件暴露"选一个本地路径"的公开 API。
// 思源自己是走 Electron IPC 的:
//   ipcRenderer.invoke("siyuan-get", {cmd: "showOpenDialog", properties: ["openFile"]})
// (见 siyuan/app/src/menus/navigation.ts 的导入 Markdown 菜单)
// 渲染进程开了 nodeIntegration,所以插件能拿到原生 require 走同一条通道。
//
// 只在桌面端可用;内核/移动端拿不到 electron,调用方需自行兜底。
import {getNativeRequire} from "./native-require";

export interface OpenDialogOptions {
    /** "openFile" 选文件,"openDirectory" 选文件夹(可同时给,但语义会冲突,建议二选一) */
    properties: Array<"openFile" | "openDirectory">;
    /** 文件类型过滤,如 [{name: "Markdown", extensions: ["md", "markdown"]}] */
    filters?: Array<{name: string; extensions: string[]}>;
    title?: string;
    defaultPath?: string;
}

/** 弹出系统选择框,返回选中的路径;用户取消返回 null,不可用时也返回 null */
export async function showOpenDialog(opts: OpenDialogOptions): Promise<string | null> {
    const req = getNativeRequire();
    if (!req) return null;
    try {
        const {ipcRenderer} = req("electron");
        const res = await ipcRenderer.invoke("siyuan-get", {
            cmd: "showOpenDialog",
            properties: opts.properties,
            filters: opts.filters || [],
            title: opts.title || "",
            defaultPath: opts.defaultPath || "",
        });
        const paths = res && Array.isArray(res.filePaths) ? res.filePaths : [];
        return paths.length > 0 ? String(paths[0]) : null;
    } catch {
        return null;
    }
}