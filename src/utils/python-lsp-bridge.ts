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
    PythonLanguageServer, maybeRestartForInterpreterChange,
} from "./python-lsp";
import {getNativeRequire} from "./native-require";
import {getPythonKernel} from "./python-kernel";
import {registerSettingsChangedHandler, getBoolSetting} from "../settings/user-settings";
// CM6 代码块语义接线(见文件尾「块内代码块」段):注入钩子 + colorize 语义覆盖。
// 方向:本模块 → monaco-block / theme-loader 单向;monaco-block 不反向 import 本模块。
import {
    getMonacoThemeName, invalidateColorizeCache, setBlockLspHooks, setSemanticOverlayHook,
} from "../editor/monaco-block";
import {resolveSemanticTokenStyle} from "../extensions/theme-loader";

/** 已注册的 provider(用于整体注销) */
let disposables: monaco.IDisposable[] = [];
let registered = false;

/** 诊断的 owner 标识(monaco 用 (owner, model) 二元组管理 marker) */
const MARKER_OWNER = "python-lsp";

/** LSP 状态订阅(设置面板/状态栏显示用) */
export type LspStatusListener = (status: string, detail?: string) => void;
const statusListeners = new Set<LspStatusListener>();

/** 语义 token 失效信号(registerPythonLsp 就绪后创建;fire = monaco 重拉全部文档) */
let semanticChanged: monaco.Emitter<void> | null = null;

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
        // workspaceRoot 保持为空(用户定案):不指向任何磁盘目录,pyright 对
        // 打开文件的语义分析(openFilesOnly)不受影响,只是没有 workspace 枚举。
        // root 为空时 pyright 会打 <default workspace root> 占位符日志,属预期。
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

// ===== 块内代码块的虚拟文档(CM6 md 编辑器的围栏代码块)=====
// 围栏代码块没有磁盘文件:pyright 的文档身份 = 临时目录下的虚拟 .py 路径 +
// 实时内容(路径按内容哈希命名,同一份代码在任何文档里都是同一个 LSP 文档)。
// 语义 provider 反查、诊断挂载与文件编辑器共用管线:
// currentEditors(文件 Tab)↔ blockDocs(块内 model)互为补充。
interface BlockDocEntry {
    path: string;
    languageId: string;
    contentSub: monaco.IDisposable;
}
const blockDocs = new Map<monaco.editor.ITextModel, BlockDocEntry>();

// 编辑态会话登记的路径集合(LRU 淘汰阅读态文档时跳过,不掐断正在编辑的块)
const sessionBlockPaths = new Set<string>();

/** 块内 model 登记:didOpen + 内容变化 didChange(与 registerPythonEditor 同构) */
export function registerPythonBlockDoc(
    model: monaco.editor.ITextModel,
    fsPath: string,
    languageId: string,
): void {
    if (!fsPath || !isPyrightAvailable() || blockDocs.has(model)) return;
    sessionBlockPaths.add(fsPath.toLowerCase());
    const server = getPythonLanguageServer();
    void server.start().then((ok) => {
        if (ok && !model.isDisposed() && blockDocs.has(model)) {
            void server.didOpen(fsPath, languageId, model.getValue());
        }
    });
    const contentSub = model.onDidChangeContent(() => {
        const s = getPythonLanguageServer();
        if (!s.isReady) return;
        s.didChange(fsPath, model.getValue());
    });
    blockDocs.set(model, {path: fsPath, languageId, contentSub});
}

/** 块内 model 注销:didClose + 摘 marker(卸载/换 model 时调用) */
export function unregisterPythonBlockDoc(model: monaco.editor.ITextModel): void {
    const entry = blockDocs.get(model);
    if (!entry) return;
    blockDocs.delete(model);
    entry.contentSub.dispose();
    sessionBlockPaths.delete(entry.path.toLowerCase());
    try {
        if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    } catch {
        // ignore
    }
    try {
        getPythonLanguageServer().didClose(entry.path);
    } catch {
        // ignore
    }
}

// ===== 语义 token 就绪信号 =====
// server 就绪/重启/注销都 fire:订阅方(monaco-block 的 colorize 缓存)清缓存重渲,
// 否则「LSP 未就绪时渲染的纯 TextMate 结果」会一直留在缓存里永不补语义色。
let semanticReady = false;
const semanticReadyListeners = new Set<() => void>();

function fireSemanticReady(): void {
    for (const cb of [...semanticReadyListeners]) {
        try {
            cb();
        } catch {
            // ignore
        }
    }
}

export function onSemanticTokensReady(cb: () => void): () => void {
    semanticReadyListeners.add(cb);
    if (semanticReady) {
        // 晚到订阅:已就绪立即对齐一次
        try {
            cb();
        } catch {
            // ignore
        }
    }
    return () => semanticReadyListeners.delete(cb);
}

// ===== 块虚拟文档路径与阅读态供给 =====
function fnv1a32(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

const BLOCK_DOC_EXT: Record<string, string> = {python: "py"};

/** 块代码 → 虚拟文档路径(tmp 目录 + 内容哈希;同内容同身份,偏移漂移不换文档) */
export function makeBlockDocPath(lang: string, code: string): string {
    const ext = BLOCK_DOC_EXT[lang];
    if (!ext) return "";
    const req = getNativeRequire();
    if (!req) return "";
    try {
        const os = req("os");
        const pathMod = req("path");
        const fsMod = req("fs");
        const hash = fnv1a32(`${lang}\u0000${code}`).toString(16).padStart(8, "0");
        const dir = pathMod.join(os.tmpdir(), "syfe-blocks");
        // 目录建出来:虽然是"虚拟文档"(文件内容走 LSP didOpen,不落盘),
        // 但 cwd/rootUri 指向的目录最好真实存在,免得 pyright 侧 stat 出幺蛾子
        try {
            fsMod.mkdirSync(dir, {recursive: true});
        } catch {
            // 已存在或其他失败都不影响文档打开
        }
        return pathMod.join(dir, `block-${hash}.${ext}`);
    } catch {
        return "";
    }
}

// 阅读态覆盖用过的虚拟文档 LRU 上限:pyright 对每个 open 文档做语义分析,
// 无上限会随浏览的代码块数线性涨(进程内存 + 分析耗时)。
const BLOCK_DOC_LRU_LIMIT = 32;
const blockDocLru: string[] = [];

function evictBlockDocs(): void {
    while (blockDocLru.length > BLOCK_DOC_LRU_LIMIT) {
        const victim = blockDocLru.shift()!;
        if (sessionBlockPaths.has(victim.toLowerCase())) continue;  // 编辑会话中,不掐
        try {
            getPythonLanguageServer().didClose(victim);
        } catch {
            // ignore
        }
    }
}

/** 确保某块代码的虚拟文档已打开且内容最新(didOpen 幂等:已打开转 didChange) */
async function ensureBlockSemanticDoc(fsPath: string, languageId: string, text: string): Promise<boolean> {
    if (!isPyrightAvailable()) return false;
    const server = getPythonLanguageServer();
    const ok = await server.start();
    if (!ok) return false;
    await server.didOpen(fsPath, languageId, text);
    const lower = fsPath.toLowerCase();
    if (!blockDocLru.some(p => p.toLowerCase() === lower)) blockDocLru.push(fsPath);
    evictBlockDocs();
    return true;
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
    // 设置里的「显示报错」关闭时不上报诊断(补全/悬停/跳转不受影响)
    if (!getBoolSetting("editor.diagnostics.enabled", true)) return;
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
        if (sameFsPath(e.path, fsPath)) return e.editor.getModel();
    }
    // 块内代码块的虚拟文档(诊断 marker 也要能挂到块 model 上)
    for (const [model, entry] of blockDocs) {
        if (sameFsPath(entry.path, fsPath)) return model;
    }
    return null;
}

/**
 * Windows 盘符路径等价比较。
 *
 * 为什么不能用严格 ===(实测踩过,症状极具迷惑性):
 *   pyright 回传 publishDiagnostics 时会把 URI 的盘符**小写化**并转义冒号
 *   (发过去 file:///E:/... → 回来 file:///e%3A/...,探针实测),
 *   uriToPath 还原出 e:\HOME\... ,而编辑器登记的是原始大小写 E:\HOME\...
 *   → 严格相等永远失配 → setMarkers 直接 return → **诊断永远不显示**。
 *   而 hover/补全/跳转都是客户端主动发请求、响应不回显路径,所以全部正常。
 *
 * 规则:任一方形如盘符路径(X:\ 或 X:/)→ 大小写不敏感 + 统一斜杠比较;
 *      否则(POSIX)保持严格比较。
 */
function sameFsPath(a: string, b: string): boolean {
    if (a === b) return true;
    const isDrivePath = /^[a-zA-Z]:[\\/]/;
    if (!isDrivePath.test(a) && !isDrivePath.test(b)) return false;
    return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

/** 扩展名 → monaco language id(与 editor/monaco.ts 的 LANG_MAP 保持一致) */
function getLanguageForPath(p: string): string {
    const lower = p.toLowerCase();
    if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
    return "plaintext";
}

/** 清空当前所有打开模型的 pyright 诊断(「显示报错」关闭时调用) */
function clearAllPythonMarkers(): void {
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
    blockDocs.forEach((_entry, model) => {
        try {
            monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
        } catch {
            // ignore
        }
    });
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
    // server 引用必须先于任何使用获取:此前声明在函数末尾(诊断订阅处),
    // 而上面的 onRestarted 注册先执行 → TDZ "Cannot access 'server' before
    // initialization",整个注册流程被外层 try/catch 吞掉,
    // 补全/hover/诊断/语义 provider 全部静默失效。
    const server = getPythonLanguageServer();

    // ---- Python 解释器变更 → 重启语言服务器 ----
    // settings.json 被保存(含手改文件)时的广播;GUI 路径由 editor-settings-ui
    // 的 afterChange 直调 maybeRestartForInterpreterChange,两路最终都靠
    // "server 已应用值 vs 当前设置值" 的比对去重,重复触发零开销。
    let lastDiagEnabled = getBoolSetting("editor.diagnostics.enabled", true);
    registerSettingsChangedHandler(() => {
        void maybeRestartForInterpreterChange();
        // 「显示报错」开关:关闭 → 立即清掉已挂的 marker;打开 → didChange 让
        // pyright 重新 publishDiagnostics,波浪线马上回来(无需改动文件内容)
        const now = getBoolSetting("editor.diagnostics.enabled", true);
        if (now !== lastDiagEnabled) {
            lastDiagEnabled = now;
            if (!now) {
                clearAllPythonMarkers();
            } else {
                currentEditors.forEach((e) => {
                    const model = e.editor.getModel();
                    if (model) server.didChange(e.path, model.getValue());
                });
            }
        }
    });
    // server 重启完成(新进程已就绪、文档已重开)后让 monaco 重拉语义 token
    server.onRestarted(() => {
        semanticChanged?.fire();
        // colorize 缓存里的 plain 结果(重启窗口期渲染的)也一并失效重渲,
        // 否则重启后阅读态代码块停留在纯 TextMate 色,与编辑态/代码文件漂移
        invalidateColorizeCache();
    });

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
            // pyright/basedpyright 返回的 markdown **已自带 ```python 围栏**(探针实测:
            // contents.value = "```python\n(function) xxx: Unknown\n```"),
            // 再包一层会把内层围栏渲染成字面文本 —— 弹框顶部出现一行 ```python(实测踩过)。
            // 只有纯文本内容(不含围栏)才需要补围栏获得代码样式。
            const value = content.includes("```") ? content : "```python\n" + content + "\n```";
            const r = res.range ? fromLspRange(res.range) : null;
            return {
                contents: [{value}],
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
    disposables.push(monacoDisposable(server.onDiagnostics((fsPath, diagnostics) => {
        setMarkers(fsPath, diagnostics as any);
    })));
    disposables.push(monacoDisposable(server.onLog((text) => emitStatus("log", text))));

    // ---- 语义 token(basedpyright semanticTokens → Monaco 语义着色)----
    // 必须等 server 就绪(legend 已知)再注册:monaco 的
    // SemanticTokensStylingService.getStyling 会按 provider 缓存 getLegend()
    // 的返回值,拿空 legend 注册会让所有语义 token 因 "not-in-legend" 被丢弃。
    const registerSemanticProvider = (): void => {
        const legend = server.semanticTokensLegend;
        if (!legend) {
            console.info("[syfe-semantic] legend 为空,语义 provider 不注册");
            return;
        }
        // 模块级持有:server 重启(切换 Python 解释器)后 onRestarted 回调要 fire 它,
        // 让已打开文档重拉语义 token(旧进程的 token 已随连接失效)
        semanticChanged = new monaco.Emitter<void>();
        disposables.push(semanticChanged);
        disposables.push(monaco.languages.registerDocumentSemanticTokensProvider(language, {
            onDidChange: semanticChanged.event,
            getLegend() {
                return legend;
            },
            async provideDocumentSemanticTokens(model) {
                const entry = currentEditors.find((e) => e.editor.getModel() === model);
                let path: string | null = entry ? entry.path : null;
                if (!path) {
                    // 块内代码块:虚拟文档登记表反查(见文件头「块内代码块」段)
                    const block = blockDocs.get(model);
                    path = block ? block.path : null;
                }
                if (!path) return {data: new Uint32Array(0)};
                const data = await server.semanticTokensFull(path);
                // LSP 与 monaco 的五元组编码完全一致
                // (deltaLine, deltaStartChar, length, tokenType, tokenModifiers)
                return {data: new Uint32Array(data || [])};
            },
            releaseDocumentSemanticTokens() {
                // 无资源需要释放
            },
        }));
        console.info("[syfe-semantic] 语义 provider 已注册: language=python");
        // 就绪信号:让 colorize 缓存里「语义未就绪时渲染的纯 TextMate 结果」失效重渲
        semanticReady = true;
        fireSemanticReady();
    };

    emitStatus("starting");
    // start() 幂等:已就绪时立即 resolve,两个分支(新启动/已就绪)都只注册一次
    const onStarted = (ok: boolean): void => {
        console.info(`[syfe-semantic] registerPythonLsp start.then ok=${ok} legend=${!!server.semanticTokensLegend}`);
        emitStatus(ok ? "ready" : "error", ok ? server.version : "启动失败");
        if (!ok) return;
        registerSemanticProvider();
        // 重试成功路径:此前 start 失败时已登记编辑器的 didOpen 也被跳过了
        // (didOpen 在 start().then 里),这里补齐,否则文件编辑器语义/补全全无
        currentEditors.forEach((e) => {
            const m = e.editor.getModel();
            if (m) server.didOpen(e.path, e.languageId, m.getValue());
        });
    };
    void server.start().then((ok) => {
        // ⚠ 冷启动握手超时重试:思源进程刚拉起时多子进程并发启动,pyright 的
        //   initialize 偶发 40s 无响应(实测本机反复出现;手动同参 spawn 147ms
        //   响应、子进程全程存活)。start() 失败后不会自愈,这里延后重试一轮;
        //   仍失败则维持旧行为(补全退化,用户重载窗口恢复)。
        if (!ok && !server.isReady) {
            console.info("[syfe-semantic] 启动失败,8s 后重试一轮");
            setTimeout(() => {
                void server.start().then(onStarted);
            }, 8000);
            emitStatus("error", "启动失败(将重试)");
            return;
        }
        onStarted(ok);
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
    clearAllPythonMarkers();
    // 就绪信号翻转:订阅方清 colorize 缓存 → 已叠语义色的渲染回落纯 TextMate
    if (semanticReady) {
        semanticReady = false;
        fireSemanticReady();
    }
}

/** 当前是否已启用 LSP */
export function isPythonLspActive(): boolean {
    return registered;
}

// ===== CM6 代码块语义覆盖(阅读态 colorize 叠 LSP 语义色)=====
// 阅读态没有编辑器实例,Monaco 自身的语义渲染管线用不上;这里把
// semanticTokensFull 的五元组手工叠到 colorize 的 mtk span 上:
//   1) 五元组 → 每行 {col,len,css} 覆盖区间(resolveSemanticTokenStyle 取色,
//      与 defineTheme 的语义规则同一张表 → 文件编辑器什么色,块就什么色);
//   2) colorize HTML 按行(<br> 分隔)展开成叶子 span 段;
//   3) 在语义 token 边界切分段,整段落在覆盖内的切片内联覆盖色/字重。
// 切片保持原 mtk 类与原内联样式,覆盖色写在 style 尾部(同属性后者胜)。

interface SemanticOverlayOv {
    col: number;
    len: number;
    css: string;
}

async function overlayBlockSemanticTokens(lang: string, code: string, html: string): Promise<string> {
    if (!semanticReady || lang !== "python") return html;
    const server = getPythonLanguageServer();
    const legend = server.semanticTokensLegend;
    if (!legend) return html;
    const path = makeBlockDocPath(lang, code);
    if (!path) return html;
    if (!(await ensureBlockSemanticDoc(path, lang, code))) return html;
    // pyright 对刚 didOpen 的文档会**立即**返回空 token(分析还没跑完),
    // 空结果一旦缓存就永远是纯 TextMate 色 —— 带宽限重试等首轮分析落地
    // (冷启动竞态实测:首次恒空,几百 ms 后重试即有数据)。
    let data: number[] | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        data = await server.semanticTokensFull(path);
        if (data && data.length) break;
        await new Promise(r => setTimeout(r, 400));
    }
    if (!data || data.length === 0) return html;
    try {
        return applySemanticToColorizeHtml(html, data, legend);
    } catch (e) {
        console.warn("[syfe-semantic] colorize 语义覆盖失败,回落纯 TextMate:", e);
        return html;
    }
}

function applySemanticToColorizeHtml(
    html: string,
    data: number[],
    legend: {tokenTypes: string[]; tokenModifiers: string[]},
): string {
    const themeName = getMonacoThemeName();
    // 1) 五元组 → 每行覆盖区间
    const byLine = new Map<number, SemanticOverlayOv[]>();
    let line = 0;
    let col = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStart = data[i + 1];
        const len = data[i + 2];
        const typeIdx = data[i + 3];
        const modBits = data[i + 4];
        line += deltaLine;
        col = deltaLine > 0 ? deltaStart : col + deltaStart;
        const type = legend.tokenTypes[typeIdx];
        if (!type || !len) continue;
        const mods: string[] = [];
        for (let b = 0; b < legend.tokenModifiers.length; b++) {
            if (modBits & (1 << b)) mods.push(legend.tokenModifiers[b]);
        }
        const style = resolveSemanticTokenStyle(themeName, [type, ...mods].join("."));
        if (!style || !style.foreground) continue;
        let css = `color:${style.foreground};`;
        const fm = (style.fontStyle || "").split(/\s+/).filter(Boolean);
        if (fm.includes("bold")) css += "font-weight:bold;";
        if (fm.includes("italic")) css += "font-style:italic;";
        if (fm.includes("underline")) css += "text-decoration:underline;";
        const arr = byLine.get(line) || [];
        arr.push({col, len, css});
        byLine.set(line, arr);
    }
    if (!byLine.size) return html;

    // 2) 展开 colorize HTML:行 = 顶层节点序列,<br> 分隔
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const outHtml: string[] = [];
    let lineIdx = 0;
    let bucket: Node[] = [];
    const flushLine = () => {
        outHtml.push(renderLine(bucket, byLine.get(lineIdx)));
        bucket = [];
        lineIdx++;
    };
    for (const n of Array.from(holder.childNodes)) {
        if (n.nodeName === "BR") {
            flushLine();
            outHtml.push("<br>");
        } else {
            bucket.push(n);
        }
    }
    flushLine();
    return outHtml.join("");
}

interface ColorizeSeg {
    text: string;
    className: string;
    css: string;
    start: number;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 一行:叶子 span 段收集 → 语义边界切分 → 重建(覆盖段内联色) */
function renderLine(nodes: Node[], ovs: SemanticOverlayOv[] | undefined): string {
    // 收集叶子段(带样式的最近元素祖先 = mtk span;colorize 行包裹 span 无类无样式)
    const segs: ColorizeSeg[] = [];
    let lineLen = 0;
    const walk = (el: Element): void => {
        for (const child of Array.from(el.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                const t = child.textContent || "";
                const he = el as HTMLElement;
                segs.push({text: t, className: he.className || "", css: he.style ? he.style.cssText : "", start: lineLen});
                lineLen += t.length;
            } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).nodeName !== "BR") {
                walk(child as Element);
            }
        }
    };
    for (const n of nodes) {
        if (n.nodeType === Node.ELEMENT_NODE) {
            walk(n as Element);
        } else if (n.nodeType === Node.TEXT_NODE) {
            const t = n.textContent || "";
            segs.push({text: t, className: "", css: "", start: lineLen});
            lineLen += t.length;
        }
    }
    if (!segs.length) return "";
    if (!ovs || !ovs.length) {
        // 无覆盖:原样序列化(保持原 span 的类与内联样式)
        return segs.map(g => {
            const cls = g.className ? ` class="${g.className}"` : "";
            const css = g.css ? ` style="${g.css}"` : "";
            return `<span${cls}${css}>${escapeHtml(g.text)}</span>`;
        }).join("");
    }
    // 语义边界切分:**逐段推进**(先前的「按切点区间取首段文本」在区间跨段时
    // 会吞掉跨界文字 —— 实测 def 后的空格、字符串尾部被吞成 defhello/print()。
    // 每段独立用覆盖边界切分,天然不丢字;切片各自判定覆盖(语义 token 可能
    // 跨 TextMate 段边界,逐切片判定即可)。
    let built = "";
    for (const seg of segs) {
        const segStart = seg.start;
        const segEnd = seg.start + seg.text.length;
        const cuts = new Set<number>([segStart, segEnd]);
        for (const ov of ovs) {
            if (ov.col > segStart && ov.col < segEnd) cuts.add(ov.col);
            if (ov.col + ov.len > segStart && ov.col + ov.len < segEnd) cuts.add(ov.col + ov.len);
        }
        const pts = [...cuts].sort((a, b) => a - b);
        for (let i = 0; i < pts.length - 1; i++) {
            const s = pts[i];
            const e = pts[i + 1];
            if (e <= s) continue;
            const slice = seg.text.slice(s - segStart, e - segStart);
            if (!slice) continue;
            const ov = ovs.find(o => o.col <= s && e <= o.col + o.len);
            const cls = seg.className ? ` class="${seg.className}"` : "";
            // 覆盖 css 拼在原 css 之后(同属性后者胜);任一为空都不出前导分号
            const css = (seg.css || ov) ? ` style="${[seg.css, ov ? ov.css : ""].filter(Boolean).join(";")}"` : "";
            built += `<span${cls}${css}>${escapeHtml(slice)}</span>`;
        }
    }
    return built;
}

// ===== 块语义接线入口(onload 调一次)=====

/**
 * 把 CM6 代码块接进语义层:
 *   - 编辑态:mountBlockEditor/unmountBlockEditor → 块 model 登记虚拟文档
 *     (didOpen + 内容 didChange)→ 语义 provider 反查得到 token;
 *   - 阅读态:colorizeCached 的 TextMate HTML → 语义覆盖;
 *   - 就绪/注销信号 → colorize 缓存失效重渲。
 * 与 registerPythonLsp 并列调用;未启用 LSP 时全部钩子内部自短路,零开销。
 */
export function setupBlockSemanticBridge(): void {
    setSemanticOverlayHook(overlayBlockSemanticTokens);
    setBlockLspHooks({
        onBlockMounted: (lang, code, model) => {
            const path = makeBlockDocPath(lang, code);
            if (path) registerPythonBlockDoc(model, path, lang);
        },
        onBlockUnmounted: (model) => {
            unregisterPythonBlockDoc(model);
        },
    });
    onSemanticTokensReady(() => invalidateColorizeCache());
}