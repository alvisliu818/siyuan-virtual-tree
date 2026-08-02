import * as monaco from "monaco-editor";
import {extname} from "../utils/path";
import {EditorConfig} from "../types";

let initialized = false;

// 扩展名 → Monaco language id(需与 webpack.config.js 中 MonacoWebpackPlugin.languages 对齐)
const LANG_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".json": "json",
    ".json5": "json",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".html": "html",
    ".htm": "html",
    ".xml": "xml",
    ".svg": "xml",
    ".md": "markdown",
    ".markdown": "markdown",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".php": "php",
    ".rb": "ruby",
};

export function getLanguageByPath(path: string): string {
    return LANG_MAP[extname(path)] || "plaintext";
}

// 读取思源 CSS 变量
function readCSSVar(name: string): string {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
}

// 规范化颜色为 Monaco 可接受的 6 位 hex 格式(#222 → #222222)
// Monaco 的 tokenTheme 不接受 3 位 hex 缩写,会抛 "Illegal value for token color"
function normalizeColor(color: string, fallback: string): string {
    if (!color) return fallback;
    const c = color.trim().toLowerCase();
    // 6 位 hex #rrggbb
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    // 3 位 hex #rgb → #rrggbb
    if (/^#[0-9a-f]{3}$/.test(c)) {
        return "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    // 8 位 hex #rrggbbaa(带 alpha) → 截取前 6 位
    if (/^#[0-9a-f]{8}$/.test(c)) return c.slice(0, 7);
    // rgb()/rgba() → 转 hex
    const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
        const r = parseInt(m[1], 10);
        const g = parseInt(m[2], 10);
        const b = parseInt(m[3], 10);
        return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
    }
    return fallback;
}

// 获取思源当前外观模式(0=亮, 1=暗)
export function getCurrentMode(): 0 | 1 {
    const w = window as any;
    return (w?.siyuan?.config?.appearance?.mode ?? 0) as 0 | 1;
}

// 初始化 Monaco:定义主题
// worker 路径由 webpack publicPath + monaco-editor-webpack-plugin 自动处理
export function setupMonaco(pluginName: string): void {
    if (initialized) return;
    initialized = true;
    applyTheme(getCurrentMode());
}

// 根据思源配色定义并切换 Monaco 主题
export function applyTheme(mode: 0 | 1): void {
    const bgFallback = mode === 1 ? "#1e1e1e" : "#ffffff";
    const fgFallback = mode === 1 ? "#d4d4d4" : "#222222";
    const bg = normalizeColor(readCSSVar("--b3-theme-background"), bgFallback);
    const fg = normalizeColor(readCSSVar("--b3-theme-on-background"), fgFallback);
    const themeName = mode === 1 ? "siyuan-dark" : "siyuan-light";
    monaco.editor.defineTheme(themeName, {
        base: mode === 1 ? "vs-dark" : "vs",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": bg,
            "editor.foreground": fg,
        },
    });
    monaco.editor.setTheme(themeName);
}

// 创建编辑器实例
export function createEditor(
    container: HTMLElement,
    model: monaco.editor.ITextModel,
    path: string,
    config: EditorConfig,
    onSave: () => void,
): monaco.editor.IStandaloneCodeEditor {
    const editor = monaco.editor.create(container, {
        model,
        theme: getCurrentMode() === 1 ? "siyuan-dark" : "siyuan-light",
        fontSize: config.fontSize,
        tabSize: config.tabSize,
        wordWrap: config.wordWrap,
        automaticLayout: true,
        minimap: {enabled: true},
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        renderWhitespace: "selection",
        bracketPairColorization: {enabled: true},
        padding: {top: 8, bottom: 8},
    });
    // Ctrl/Cmd + S 保存
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    return editor;
}

// 全局清理(onunload 时调用)
export function disposeMonaco(): void {
    // monaco 无全局 dispose,模型清理在 model-manager 中处理
    initialized = false;
}
