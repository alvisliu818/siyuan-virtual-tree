import * as monaco from "monaco-editor";
import {extname} from "../utils/path";
import {EditorConfig} from "../types";
import {getActiveThemeName} from "../extensions/theme-loader";

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
    // .pyi 是 PEP 484 的类型存根,语法与 .py 一致,交给同一个 language id
    // 才能拿到 pyright 的补全/跳转(否则退化成纯文本,存根里的类型全看不见)
    ".pyi": "python",
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
    configureTypeScriptWorker();
    applyTheme(getCurrentMode());
}

// 配置 TypeScript/JavaScript worker
// 禁用语义和语法诊断,避免分析深度嵌套表达式时栈溢出(minified 代码等)
// 语法高亮由 Monaco 的 Monarch tokenizer 提供,不依赖 worker 诊断
function configureTypeScriptWorker(): void {
    const ts = (monaco.languages.typescript as any);
    if (ts?.typescriptDefaults) {
        ts.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: true,
        });
        ts.typescriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget.ESNext,
            allowNonTsExtensions: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            module: ts.ModuleKind.ESNext,
            noEmit: true,
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
            allowJs: true,
            typeRoots: [],
        });
    }
    if (ts?.javascriptDefaults) {
        ts.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: true,
        });
        ts.javascriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget.ESNext,
            allowNonTsExtensions: true,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            module: ts.ModuleKind.ESNext,
            noEmit: true,
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
            allowJs: true,
            typeRoots: [],
        });
    }
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
        // 优先使用当前激活的扩展主题;此处不能硬编码思源主题,
        // 因为创建实例时的 theme 参数会全局覆盖 setTheme,导致扩展代码主题失效
        theme: getActiveThemeName() ?? (getCurrentMode() === 1 ? "siyuan-dark" : "siyuan-light"),
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

    // 修复:思源拦截了 paste 事件,导致 Monaco 编辑器无法粘贴
    // 方案:在 window capture 阶段拦截 Ctrl+V/Ctrl+C/Ctrl+X keydown 事件,
    // 阻止思源处理,然后用 navigator.clipboard API 读写剪贴板
    const isEditorFocused = (): boolean => {
        if (editor.hasTextFocus()) return true;
        const active = document.activeElement;
        if (active && container.contains(active)) return true;
        return false;
    };

    // 从剪贴板读取文本并插入编辑器
    const doPaste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                const selection = editor.getSelection();
                if (selection) {
                    editor.executeEdits('paste', [{
                        range: selection,
                        text: text,
                        forceMoveMarkers: true,
                    }]);
                    editor.pushUndoStop();
                }
            }
        } catch (e) {
            // readText 可能因权限失败,回退到 document.execCommand
            console.warn("[siyuan-file-editor] clipboard.readText 失败,尝试 execCommand:", e);
            try {
                document.execCommand('paste');
            } catch {
                // 忽略
            }
        }
    };

    // 复制选中文本到剪贴板
    const doCopy = async () => {
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const text = editor.getModel()?.getValueInRange(selection) || '';
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            console.warn("[siyuan-file-editor] clipboard.writeText 失败:", e);
        }
    };

    // 剪切:复制后删除选中文本
    const doCut = async () => {
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const text = editor.getModel()?.getValueInRange(selection) || '';
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            console.warn("[siyuan-file-editor] clipboard.writeText 失败:", e);
        }
        editor.executeEdits('cut', [{
            range: selection,
            text: '',
            forceMoveMarkers: true,
        }]);
        editor.pushUndoStop();
    };

    // keydown capture:拦截 Ctrl+V/C/X,当编辑器有焦点时阻止思源处理
    const keydownHandler = (e: KeyboardEvent) => {
        if (!isEditorFocused()) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) return;
        const key = e.key.toLowerCase();
        if (key === 'v') {
            e.preventDefault();
            e.stopImmediatePropagation();
            doPaste();
        } else if (key === 'c') {
            e.preventDefault();
            e.stopImmediatePropagation();
            doCopy();
        } else if (key === 'x') {
            e.preventDefault();
            e.stopImmediatePropagation();
            doCut();
        }
    };
    window.addEventListener('keydown', keydownHandler, true);

    // 编辑器销毁时移除监听器,避免内存泄漏
    editor.onDidDispose(() => {
        window.removeEventListener('keydown', keydownHandler, true);
    });

    return editor;
}

// 全局清理(onunload 时调用)
export function disposeMonaco(): void {
    // monaco 无全局 dispose,模型清理在 model-manager 中处理
    initialized = false;
}
