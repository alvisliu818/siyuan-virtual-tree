// pyright(LSP) 与 Monaco 的桥接层
//
// 职责:把 Monaco 的 provider 接口对接到 PythonLanguageServer,并把
// LSP 的返回结果翻译成 Monaco 认识的形状。
//
// 为什么要自己写而不用 monaco-languageclient:
//   见 ./lsp-client.ts 顶部 —— 它硬依赖 vscode API 垫片,在思源渲染进程跑不起来。
//
// 三条设计原则:
//   1. **永不阻塞 UI**:所有 provider 都有短超时(server 没起好就返回 null),
//      Monaco 对 null 的处理是"不显示任何补全",不会卡住编辑器。
//   2. **有 LSP 用 LSP,没 LSP 用内核兜底**:用户没装 pyright 时,退到
//      PythonKernel 的静态补全,基本编辑体验不丢。
//   3. **可整体摘除**:`disposePythonLsp()` 之后 provider 全注销,
//      编辑器立刻退回纯语法高亮,不会留僵尸引用。

import * as monaco from "monaco-editor";
import {
    getPythonLanguageServer, isPyrightAvailable, toLspPosition, fromLspRange,
    PythonLanguageServer,
} from "./python-lsp";
import {getPythonKernel} from "./python-kernel";

/** 已注册的 provider(用于整体注销) */
let disposables: monaco.IDisposable[] = [];
let registered = false;

/** 诊断的 owner 标识(monaco 用 (owner, model) 二元组管理 marker) */
const MARKER_OWNER = "python-lsp";

/** LSP 状态订阅(设置面板/状态栏显示用) */
export type LspStatusListener = (status: string, detail?: string) => void;
const statusListeners = new Set<LspStatusListener>();

export function onLspStatus(cb: LspStatusListener): () => void {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
}

function emitStatus(status: string, detail?: string): void {
    statusListeners.forEach((cb) => {
        try {
            cb(status, detail);
        } catch {
            // ignore
        }
    });
}

/** 诊断严重度:pyright 用 1..4,Monaco 用 MarkerSeverity(8..11) */
function toMarkerSeverity(sev: number | undefined): monaco.MarkerSeverity {
    switch (sev) {
        case 1: return monaco.MarkerSeverity.Error;
        case 2: return monaco.MarkerSeverity.Warning;
        case 3: return monaco.MarkerSeverity.Info;
        default: return monaco.MarkerSeverity.Hint;
    }
}

/** LSP CompletionItemKind(1..25) → Monaco CompletionItemKind(1..24) */
function toCompletionItemKind(kind: number | undefined): monaco.languages.CompletionItemKind {
    // 两者取值基本一致,只需处理越界(避免 undefined 落到 0)
    if (!kind || kind < 1) return monaco.languages.CompletionItemKind.Property;
    const k = kind as monaco.languages.CompletionItemKind;
    return k;
}

/** LSP 的 documentation 可能是 string 或 {kind, value} 或数组,统一成 markdown 字符串 */
function toMarkdown(
    doc: string | {kind: string; value: string} | Array<string | {kind: string; value: string}> | undefined,
): string | undefined {
    if (!doc) return undefined;
    if (typeof doc === "string") return doc;
    if (Array.isArray(doc)) {
        const parts = doc.map((d) => (typeof d === "string" ? d : d?.value || "")).filter(Boolean);
        return parts.length ? parts.join("\n\n---\n\n") : undefined;
    }
    return doc.value || undefined;
}

/** 编辑器实例 → 路径。createEditor 的调用点都知道 path,这里登记以便排查。 */
const editorPathMap = new WeakMap<monaco.editor.IStandaloneCodeEditor, string>();

/** 当前打开的 Python 编辑器登记表
 *  (只登记 Python 文件;monaco 的 provider 是按语言全局注册的,
 *  靠这张表把「某个 model」对应到「磁盘上的哪个 .py」,
 *  因为 monaco 模型的 URI 是 inmemory://model/1 这种,反查不出真实路径) */
const currentEditors: Array<{editor: monaco.editor.IStandaloneCodeEditor; path: string; languageId: string}> = [];

/** 编辑器打开/关闭时的登记与注销 */
export function registerPythonEditor(
    editor: monaco.editor.IStandaloneCodeEditor,
    fsPath: string,
): void {
    const model = editor.getModel();
    if (!model) return;
    editorPathMap.set(editor, fsPath);

    if (isPyrightAvailable()) {
        const server = getPythonLanguageServer();
        // 后台启动,不阻塞编辑器可用性;ready 之前 provider 会走内核兜底
        void server.start().then((ok) => {
            if (ok) {
                void server.didOpen(fsPath, "python", model.getValue());
            }
        });
    }

    let disposed = false;
    const contentSub = model.onDidChangeContent(() => {
        if (disposed) return;
        const server = getPythonLanguageServer();
        if (!server.isReady) return;
        server.didChange(fsPath, model.getValue());
    });

    const entry = {editor, path: fsPath, languageId: "python"};
    currentEditors.push(entry);

    (editor as any).__syfeLspCleanup = () => {
        disposed = true;
        contentSub.dispose();
        const idx = currentEditors.indexOf(entry);
        if (idx >= 0) currentEditors.splice(idx, 1);
        try {
            const model2 = editor.getModel();
            // 关掉之前把该模型的 marker 清掉,否则诊断会残留在标签页上
            if (model2) monaco.editor.setModelMarkers(model2, MARKER_OWNER, []);
            const server = getPythonLanguageServer();
            server.didClose(fsPath);
        } catch {
            // ignore
        }
    };
}

export function unregisterPythonEditor(editor: monaco.editor.IStandaloneCodeEditor): void {
    const cleanup = (editor as any).__syfeLspCleanup;
    if (typeof cleanup === "function") cleanup();
}

// ===== 诊断 =====

/**
 * 把 LSP 诊断写到对应模型的 marker 上。
 *
 * monaco 0.50 **没有** createModelMarkers,只有 setModelMarkers(model, owner, markers)
 * —— marker 绑在 model 上,清空也要给同一个 model 传空数组。
 * (这个 API 在 monaco 0.52+ 才换成 createModelMarkers 返回 collection 的形式。)
 */
function setMarkers(
    fsPath: string,
    items: Array<{range: LspRangeLike; severity?: number; message: string; code?: string | number; source?: string}>,
): void {
    const model = findModelForPath(fsPath);
    if (!model) return;  // 文件没打开(或不是 python)→ 没有 model 可挂 marker
    if (getLanguageForPath(fsPath) === "plaintext") return;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, items.map((d) => {
        // end 必须 > start,否则 monaco 抛 "Invalid range"
        const startLine = d.range.start.line + 1;
        const startCol = d.range.start.character + 1;
        const endLine = d.range.end.line + 1;
        const endCol = d.range.end.character + 1;
        return {
            severity: toMarkerSeverity(d.severity),
            message: (d.source ? `[${d.source}] ` : "") + d.message +
                (d.code !== undefined ? ` (${d.code})` : ""),
            startLineNumber: startLine,
            startColumn: startCol,
            endLineNumber: Math.max(endLine, startLine),
            // 同位置零宽区间 → 强制至少 1 列宽,否则 monaco 认为 range 无效
            endColumn: endLine === startLine ? Math.max(endCol, startCol + 1) : endCol,
        };
    }));
}

/** LSP range 的最小结构(避免为一处类型断言引入整个 lsp-client 类型) */
interface LspRangeLike {
    start: {line: number; character: number};
    end: {line: number; character: number};
}

function findModelForPath(fsPath: string): monaco.editor.ITextModel | null {
    for (const e of currentEditors) {
        if (e.path === fsPath) return e.editor.getModel();
    }
    return null;
}

/** 扩展名 → monaco language id(与 editor/monaco.ts 的 LANG_MAP 保持一致) */
function getLanguageForPath(p: string): string {
    const lower = p.toLowerCase();
    if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
    return "plaintext";
}

// ===== 注册 =====

/**
 * 为 Python 注册全部 LSP provider。
 * 幂等:重复调用直接返回,不会叠加注册(monaco 叠加注册会让补全出现重复项)。
 */
export function registerPythonLsp(): void {
    if (registered) return;
    if (!isPyrightAvailable()) {
        console.info("[siyuan-file-editor] 未找到 pyright,Python 补全将退化为内置静态分析");
        return;
    }
    registered = true;

    const language = "python";

    // ---- 补全 ----
    disposables.push(monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", "_", '"', "'", "(", "[", ":", ",", " "],
        async provideCompletionItems(model, position) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return {suggestions: []};
            const server = getPythonLanguageServer();

            // 先把当前未保存的内容同步给 server —— 否则 server 看到的是旧版本,
            // 会出现"刚敲的名字补不出来"(模型变了但 didChange 还在路上)
            server.didChange(entry.path, model.getValue());

            if (server.isReady) {
                const items = await server.completion(entry.path, toLspPosition(position));
                if (items && items.length) {
                    const word = model.getWordUntilPosition(position);
                    const range: monaco.IRange = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn,
                    };
                    return {
                        incomplete: true,  // 让 monaco 继续追问后续字符
                        suggestions: items.map((it) => ({
                            label: it.label,
                            kind: toCompletionItemKind(it.kind),
                            // pyright 返回的 insertText 可能是 Snippet 格式,
                            // 我们没声明 snippetSupport,所以直接用 label,
                            // 避免 {} 占位符原样插进代码
                            insertText: it.textEdit?.newText || it.label,
                            detail: it.detail,
                            documentation: toMarkdown(it.documentation),
                            // sortText:pyright 已按重要性排好序("10.9999.xxx"),
                            // monaco 会用它排序;不给的话按字母排会丢掉 pyright 的排序意图
                            sortText: it.sortText,
                            filterText: it.filterText,
                            range,
                        })),
                    };
                }
            }

            // ---- 兜底:内核静态补全(pyright 没起来时)----
            const kernel = getPythonKernel();
            if (!kernel) return {suggestions: []};
            const code = model.getValue();
            const cursor = model.getOffsetAt(position);
            const res = await kernel.complete(code, cursor);
            if (!res || !res.matches.length) return {suggestions: []};
            // 内核返回的是「待替换区间」[cursorStart, cursorEnd](字符偏移)。
            // 内核静态分析只认识纯文本,不知道 monaco 的行列,所以这里用
            // model.getPositionAt 反算 —— 换行/中文都不会算错。
            const startPos = model.getPositionAt(Math.max(0, Math.min(res.cursorStart, code.length)));
            const endPos = model.getPositionAt(Math.max(0, Math.min(res.cursorEnd, code.length)));
            return {
                incomplete: true,
                suggestions: res.matches.map((m) => ({
                    label: m,
                    kind: monaco.languages.CompletionItemKind.Property,
                    insertText: m,
                    range: {
                        startLineNumber: startPos.lineNumber,
                        endLineNumber: endPos.lineNumber,
                        startColumn: startPos.column,
                        endColumn: endPos.column,
                    },
                })),
            };
        },
    }));

    // ---- Hover ----
    disposables.push(monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return null;
            const server = getPythonLanguageServer();
            if (!server.isReady) return null;
            server.didChange(entry.path, model.getValue());
            const res = await server.hover(entry.path, toLspPosition(position));
            if (!res) return null;
            const content = toMarkdown(res.contents as any);
            if (!content) return null;
            const r = res.range ? fromLspRange(res.range) : null;
            return {
                contents: [{value: "```python\n" + content + "\n```"}],
                ...(r ? {range: new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)} : {}),
            };
        },
    }));

    // ---- 跳转定义 ----
    disposables.push(monaco.languages.registerDefinitionProvider(language, {
        async provideDefinition(model, position) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return null;
            const server = getPythonLanguageServer();
            if (!server.isReady) return null;
            server.didChange(entry.path, model.getValue());
            const locs = await server.definition(entry.path, toLspPosition(position));
            if (!locs || !locs.length) return null;
            return locs.map((loc) => ({uri: monaco.Uri.parse(loc.uri), range: fromLspRange(loc.range)}));
        },
    }));

    // ---- 引用查找 ----
    disposables.push(monaco.languages.registerReferenceProvider(language, {
        async provideReferences(model, position) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return null;
            const server = getPythonLanguageServer();
            if (!server.isReady) return null;
            server.didChange(entry.path, model.getValue());
            const locs = await server.references(entry.path, toLspPosition(position));
            if (!locs || !locs.length) return null;
            return locs.map((loc) => ({
                uri: monaco.Uri.parse(loc.uri),
                range: fromLspRange(loc.range),
            }));
        },
    }));

    // ---- 签名帮助 ----
    disposables.push(monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ["(", ","],
        signatureHelpRetriggerCharacters: [")"],
        async provideSignatureHelp(model, position) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return null;
            const server = getPythonLanguageServer();
            if (!server.isReady) return null;
            server.didChange(entry.path, model.getValue());
            const res = await server.signatureHelp(entry.path, toLspPosition(position));
            if (!res || !res.signatures?.length) return null;
            return {
                value: {
                    signatures: res.signatures.map((s) => ({
                        label: s.label,
                        documentation: toMarkdown(s.documentation),
                        parameters: (s.parameters || []).map((p) => ({
                            // monaco 0.50 的 ParameterInformation.label 只接受
                            // string 或 [start, end] **tuple**,不接受
                            // {start, end} 对象(那是别的版本的形状)。
                            // LSP 给的也是 tuple,这里直接展开 +1:
                            // LSP 的 end 是闭区间,monaco 是半开区间。
                            label: Array.isArray(p.label)
                                ? ([p.label[0], p.label[1] + 1] as [number, number])
                                : p.label,
                            documentation: toMarkdown(p.documentation),
                        })),
                    })),
                    activeSignature: res.activeSignature ?? 0,
                    activeParameter: res.activeParameter ?? 0,
                },
                // monaco 0.50 的 SignatureHelpResult **要求** dispose(不是可选),
                // 且它会用返回值去释放富文本渲染。这里没有富文本资源,
                // 但必须给一个真的 IDisposable 对象,否则 TS 编译不过、
                // 运行时 monaco 也会抛 "dispose is not a function"。
                dispose: () => {},
            };
        },
    }));

    // ---- 文档符号(大纲/导航) ----
    disposables.push(monaco.languages.registerDocumentSymbolProvider(language, {
        async provideDocumentSymbols(model) {
            const entry = currentEditors.find((e) => e.editor.getModel() === model);
            if (!entry) return [];
            const server = getPythonLanguageServer();
            if (!server.isReady) return [];
            const syms = await server.documentSymbols(entry.path);
            if (!syms) return [];
            // 递归把 LSP 的 SymbolInformation 树转成 monaco 的 DocumentSymbol 树
            // monaco 0.50 的 DocumentSymbol.tags 是**必需**字段,且 SymbolTag
            // 只有 Deprecated=1 一个值(不是老 API 的 0=无标记)。
            // 空数组 = 无标记。
            const toDocSymbol = (s: any): monaco.languages.DocumentSymbol => ({
                name: s.name,
                detail: s.detail || "",
                kind: symbolKindTo(s.kind),
                tags: [],
                range: toRange(s.range),
                selectionRange: toRange(s.selectionRange || s.range),
                children: (s.children || []).map(toDocSymbol),
            });
            return syms.map(toDocSymbol);
        },
    }));

    // ---- 诊断订阅 ----
    const server = getPythonLanguageServer();
    disposables.push(monacoDisposable(server.onDiagnostics((fsPath, diagnostics) => {
        setMarkers(fsPath, diagnostics as any);
    })));
    disposables.push(monacoDisposable(server.onLog((text) => emitStatus("log", text))));

    emitStatus("starting");
    void server.start().then((ok) => {
        emitStatus(ok ? "ready" : "error", ok ? server.version : "启动失败");
    });
}

function toRange(r: {start: {line: number; character: number}; end: {line: number; character: number}}): monaco.IRange {
    return new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
}

/** 把"取消订阅函数"包装成 monaco 的 IDisposable */
function monacoDisposable(unsubscribe: () => void): monaco.IDisposable {
    return {dispose: unsubscribe};
}

/** LSP SymbolKind(1..26) → Monaco SymbolKind */
function symbolKindTo(kind: number): monaco.languages.SymbolKind {
    const k = kind as monaco.languages.SymbolKind;
    if (!kind || kind < 1) return monaco.languages.SymbolKind.Variable;
    return k;
}

/** 注销全部 provider(设置里关闭 LSP 时调用) */
export function disposePythonLsp(): void {
    disposables.forEach((d) => {
        try {
            d.dispose();
        } catch {
            // ignore
        }
    });
    disposables = [];
    registered = false;
    // 清掉所有 marker:monaco 0.50 按 (owner, model) 管理,
    // 所以要逐个打开着的模型传空数组
    currentEditors.forEach((e) => {
        const model = e.editor.getModel();
        if (model) {
            try {
                monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
            } catch {
                // ignore
            }
        }
    });
}

/** 当前是否已启用 LSP */
export function isPythonLspActive(): boolean {
    return registered;
}