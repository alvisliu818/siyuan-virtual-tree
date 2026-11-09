// Vditor 本地资源路径与样式注入(独立模块,避免 editor/* 与 tabs/markdown-tab 循环依赖)。
// 插件名由 webpack DefinePlugin 注入(见 webpack.config.js),**不要写死**:
// 写死的话插件改名后这个目录 404,Vditor 的 CSS/JS 加载不到,编辑器会退化成
// 无样式裸 textarea 且不报错。
declare const __SYFE_PLUGIN_NAME__: string;
export const VDITOR_CDN = `/plugins/${__SYFE_PLUGIN_NAME__}/vditor`;

/** 注入 Vditor 主样式(幂等);图表渲染(SVG/echarts/abc 等)也依赖它 */
export function ensureVditorCSS(): void {
    if (document.querySelector(`link[data-syfe-vditor]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${VDITOR_CDN}/dist/index.css`;
    link.setAttribute("data-syfe-vditor", "1");
    document.head.appendChild(link);
}
