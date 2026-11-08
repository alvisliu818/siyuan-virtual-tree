import * as monaco from "monaco-editor";
import {Menu, showMessage} from "siyuan";
import {extname, basename} from "../utils/path";
import {EditorConfig} from "../types";
import {getActiveThemeName} from "../extensions/theme-loader";
import {setGlobalCodeTheme} from "./monaco-block";
import {buildEditorOptions} from "../settings/user-settings";
// 带行号的文件链接(Markdown 源码态与代码文件的「复制当前行链接」共用)
import {buildFileRefMd} from "../utils/file-ref";
// 双链:行内链接检测(Ctrl+click)与 [[ 补全数据源
import {findLinkInLine, openLinkFromEditor, getLinkIndex} from "../utils/wikilink";
import {searchBlocksForRef} from "../utils/backlink";

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
    // 全局主题切换统一走 monaco-block 的入口(记账主题名 + colorize 缓存失效 + 通知)
    setGlobalCodeTheme(themeName);
}

// 创建编辑器实例
// 注:config 保留在签名里(调用方统一传 plugin.config),但编辑器选项已全部改由
// 设置注册表提供 —— 见下方 buildEditorOptions。
// plugin(可选):双链 Ctrl+click 打开链接用;不传时点击链接退化为系统打开
export function createEditor(
    container: HTMLElement,
    model: monaco.editor.ITextModel,
    path: string,
    config: EditorConfig,
    onSave: () => void,
    plugin?: {app: any; name: string},
): monaco.editor.IStandaloneCodeEditor {
    // 编辑器选项全部来自设置注册表(settings.json 的 editor.* 键,缺省用注册表默认值),
    // 不再在这里写死 —— 否则"设置里加了项但新开的编辑器没反应",是最难排查的一类问题
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
        model,
        // 优先使用当前激活的扩展主题;此处不能硬编码思源主题,
        // 因为创建实例时的 theme 参数会全局覆盖 setTheme,导致扩展代码主题失效
        theme: getActiveThemeName() ?? (getCurrentMode() === 1 ? "siyuan-dark" : "siyuan-light"),
        automaticLayout: true,
        // 语义 token 着色(basedpyright semanticTokens → 参数名/函数调用等 VS Code 同款颜色)。
        // monaco standalone 默认关闭:主题没有 semanticHighlighting 标志入口,
        // 这里靠编辑器选项经 updateConfigurationService 写入全局配置激活
        // (isSemanticColoringEnabled 会查 configurationService 的该键)。
        "semanticHighlighting.enabled": true,
        ...(buildEditorOptions() as monaco.editor.IStandaloneEditorConstructionOptions),
    };
    const editor = monaco.editor.create(container, options);
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

    // ===== 行号右键:复制「当前行」的 Markdown 链接 =====
    // Markdown 源码态与代码文件共用 createEditor,这里做一次两边都生效。
    // 行号取值优先级:右键按下时 Monaco 报告的 gutter 行(精确,任何行号显示模式都对)
    // > 行号 DOM 里的数字(on/interval 模式可解析)> 光标所在行。
    let lastGutterLine: number | null = null;
    const GUTTER_TYPES = [
        monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
        monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
        monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
    ];
    editor.onMouseDown((e) => {
        if (!(e.event as any).rightButton) return;
        if (GUTTER_TYPES.indexOf(e.target.type) >= 0) {
            lastGutterLine = e.target.position?.lineNumber ?? null;
        }
    });
    const gutterEl = editor.getDomNode()?.querySelector(".margin-view-overlays") as HTMLElement | null;
    if (gutterEl) {
        // 必须在 capture 阶段拦:Monaco 自己的 contextmenu 处理器会把编辑器右键菜单弹出来。
        // 行号取值:右键按下时 Monaco 报告的 gutter 行(精确)> 命中的 .line-numbers 数字
        // (relative/interval 模式下数字不是绝对行号,仅作兜底)> 光标所在行
        gutterEl.addEventListener("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            let line = lastGutterLine ?? 0;
            if (!line) {
                // 按纵坐标命中行号元素(不依赖行号的文本内容,任何显示模式都准)
                for (const el of Array.from(gutterEl.querySelectorAll(".line-numbers")) as HTMLElement[]) {
                    const r = el.getBoundingClientRect();
                    if (e.clientY >= r.top && e.clientY <= r.bottom) {
                        const parsed = parseInt(el.textContent || "", 10);
                        if (isFinite(parsed) && parsed > 0) line = parsed;
                        break;
                    }
                }
            }
            if (!line) line = editor.getPosition()?.lineNumber ?? 1;
            const menu = new Menu();
            menu.addItem({
                icon: "iconLink",
                label: `复制第 ${line} 行链接`,
                click: () => {
                    const md = buildFileRefMd({path, line, label: `${basename(path)}:${line}`});
                    if (!md) {
                        showMessage("无法生成链接(取不到文件的绝对路径)", 3000, "error");
                        return;
                    }
                    void copyToClipboard(md).then(ok => showMessage(
                        ok ? "行链接已复制,粘贴到思源文档点击可定位" : "复制失败",
                        2500, ok ? "info" : "error",
                    ));
                },
            });
            menu.open({x: e.clientX, y: e.clientY});
        }, true);
    }

    // ===== Ctrl/Cmd+点击链接:解析并打开(双链)=====
    // Markdown 源码态与代码文件共用 createEditor,一次注册两边生效。
    // 检测用 findLinkInLine(与 CM6 live 同一套):md 链接 / [[wikilink]] / src-href。
    // 未命中链接时不拦默认行为(Python 等语言的 Ctrl+click 仍走「转到定义」)。
    if (plugin) {
        editor.onMouseDown((e) => {
            const ev = e.event as any;
            if (!(ev.ctrlKey || ev.metaKey) || ev.rightButton || ev.middleButton) return;
            const pos = e.target.position;
            if (!pos) return; // 行号槽等非正文区域不处理
            const lineText = model.getLineContent(pos.lineNumber);
            const hit = findLinkInLine(lineText, pos.column - 1);
            if (!hit) return;
            e.event.preventDefault();
            void openLinkFromEditor(plugin, path, hit.raw);
        });
    }

    // 编辑器销毁时移除监听器,避免内存泄漏
    editor.onDidDispose(() => {
        window.removeEventListener('keydown', keydownHandler, true);
    });

    // [[ 双链补全:Monaco provider 是全局单例注册,所有编辑器实例共享(只注册一次)。
    // plaintext 一并注册:txt 等不在 LANG_MAP 里的文本文件也能补全。
    registerWikilinkCompletionOnce();

    return editor;
}

// [[ 补全 provider 的全局注册标记(模块级;Monaco 语言服务全局共享)
let wikilinkCompletionRegistered = false;
// 空查询/未过滤时的候选上限(超大库不把下拉撑爆)
const WIKILINK_COMPLETE_LIMIT = 64;

function registerWikilinkCompletionOnce(): void {
    if (wikilinkCompletionRegistered) return;
    wikilinkCompletionRegistered = true;
    const langs = Array.from(new Set(Object.values(LANG_MAP)));
    langs.push("plaintext");
    monaco.languages.registerCompletionItemProvider(langs, {
        triggerCharacters: ["[", "("],
        async provideCompletionItems(model, position) {
            const lineText = model.getLineContent(position.lineNumber);
            const before = lineText.slice(0, position.column - 1);
            const range = (qlen: number) => new monaco.Range(
                position.lineNumber,
                position.column - qlen,
                position.lineNumber,
                position.column,
            );
            // (( 思源块引用补全:仅 markdown(代码文件里的 (( 是括号,不触发)。
            // range 覆盖 ((query 整段,insertText 为完整引用链接 —— 选中后触发符整体替换
            const bm = /\(\(([^()]*)$/.exec(before);
            if (bm && model.getLanguageId() === "markdown") {
                const query = bm[1].trim();
                const briefs = await searchBlocksForRef(query);
                const suggestions: monaco.languages.CompletionItem[] = [];
                for (const b of briefs) {
                    const label = b.title.replace(/[\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || b.id;
                    suggestions.push({
                        label,
                        detail: b.hpath || "思源块",
                        kind: monaco.languages.CompletionItemKind.Reference,
                        insertText: `[${label}](siyuan://blocks/${b.id})`,
                        range: range(bm[0].length),
                    });
                }
                return {suggestions};
            }
            const m = /\[\[([^\[\]]*)$/.exec(before);
            if (!m) return {suggestions: []};
            const query = m[1].trim().toLowerCase();
            const index = await getLinkIndex();
            // 光标后若已是 "]]"(Monaco 自动闭合括号产生),插入时不补 "]]",避免叠成 ]]]]
            const after = lineText.slice(position.column - 1);
            const suffix = after.startsWith("]]") ? "" : "]]";
            const suggestions: monaco.languages.CompletionItem[] = [];
            const seen = new Set<string>();
            const collect = (map: Map<string, string[]>) => {
                for (const [key, paths] of map) {
                    if (query && !key.includes(query)) continue;
                    for (const p of paths) {
                        if (suggestions.length >= WIKILINK_COMPLETE_LIMIT) return;
                        if (seen.has(p)) continue;
                        seen.add(p);
                        const name = p.split("/").pop() || key;
                        suggestions.push({
                            label: name,
                            detail: p.slice(0, p.lastIndexOf("/")),
                            kind: monaco.languages.CompletionItemKind.File,
                            insertText: `${name}${suffix}`,
                            range: range(m[1].length),
                            sortText: key === query ? "0000" : undefined,
                        });
                    }
                    if (suggestions.length >= WIKILINK_COMPLETE_LIMIT) return;
                }
            };
            collect(index.byName);
            if (suggestions.length < WIKILINK_COMPLETE_LIMIT) collect(index.byStem);
            return {suggestions};
        },
    });
}

// 本模块专用的剪贴板写入(带 execCommand 降级)。
// 刻意不引 components/file-tree 的 copyText:那会形成 monaco → file-tree → editor-tab → monaco 的环,
// 环本身能跑,但没必要为 10 行工具代码背上初始化顺序风险。
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 继续走降级
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

// 全局清理(onunload 时调用)
export function disposeMonaco(): void {
    // monaco 无全局 dispose,模型清理在 model-manager 中处理
    initialized = false;
}

// 把导航窗格(minimap)开关即时应用到所有已打开的编辑器
// (兼容旧调用点;现已由 applyEditorOptions 统一处理所有编辑器设置)
// (设置保存后调用,无需重开 Tab;monaco.editor.getEditors() 枚举当前所有实例)
export function applyMinimapSetting(enabled: boolean): void {
    try {
        monaco.editor.getEditors().forEach(ed => {
            ed.updateOptions({minimap: {enabled}});
        });
    } catch (e) {
        console.warn("[siyuan-file-editor] 应用 minimap 设置失败:", e);
    }
}
