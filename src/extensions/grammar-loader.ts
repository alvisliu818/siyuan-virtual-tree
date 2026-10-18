// TextMate 语法加载器
// 将 VSCode 扩展的 .tmLanguage.json 语法注册到 Monaco
// 使用 vscode-textmate 解析 TextMate 语法,vscode-oniguruma 提供 WASM 正则引擎
// 通过 monaco.languages.setMonarchTokensProvider 的替代方案:
//   注册 Tokenizer,将 TextMate 规则转换为 Monaco 可识别的 token
import * as monaco from "monaco-editor";
import {Registry, parseRawGrammar, INITIAL, StateStack, IGrammar} from "vscode-textmate";
import {loadWASM} from "vscode-oniguruma";
import {InstalledExtension, GrammarContribution, LanguageContribution} from "./types";

declare const __SYFE_PLUGIN_NAME__: string;

let wasmLoaded = false;
let registry: Registry | null = null;
// ensureRegistry 的单例 promise:loadBuiltinGrammars 与扩展 loadGrammars 可能并发,
// 各自 await ensureWasmLoaded 后同时看到 registry==null 会建两个 Registry,
// 语法注册到不同实例上互相查不到(嵌入语法如 html 内嵌 js 全部失效)
let registryPromise: Promise<Registry> | null = null;

// 内置语法清单:VS Code 官方仓库 1.142.0 的语法文件,构建时原样复制到
// dist/grammars/。file 必须与 src/grammars/ 下的文件名一致,scopeName 必须与
// 文件内的 scopeName 字段一致(不一致时 addGrammar 会按文件里的注册,映射错乱)
interface BuiltinGrammarEntry {
    file: string;
    scopeName: string;
    // 要接管着色的 Monaco language id;空数组 = 仅注册语法不接管
    // (供其他语法的嵌入引用,如 markdown 围栏内嵌 source.ts)
    tokenLanguages: string[];
}

const BUILTIN_GRAMMARS: BuiltinGrammarEntry[] = [
    {file: "python.tmLanguage.json", scopeName: "source.python", tokenLanguages: ["python"]},
    // source.js 自带 JSX 规则,.js/.jsx 共用这一个 language id 恰好都对
    {file: "javascript.tmLanguage.json", scopeName: "source.js", tokenLanguages: ["javascript"]},
    // "typescript" id 由 source.tsx 接管而非 source.ts:.tsx 也映射到该 id,
    // TSX 语法 = TS 语法 + JSX 规则,对纯 .ts 几乎无差异、对 .tsx 是刚需。
    // source.ts 仍注册进 grammarMap —— markdown 的 ```ts 围栏内嵌引用它
    {file: "typescript.tmLanguage.json", scopeName: "source.ts", tokenLanguages: []},
    {file: "typescriptreact.tmLanguage.json", scopeName: "source.tsx", tokenLanguages: ["typescript"]},
    {file: "json.tmLanguage.json", scopeName: "source.json", tokenLanguages: ["json"]},
    {file: "html.tmLanguage.json", scopeName: "text.html.basic", tokenLanguages: ["html"]},
    {file: "css.tmLanguage.json", scopeName: "source.css", tokenLanguages: ["css"]},
    {file: "markdown.tmLanguage.json", scopeName: "text.html.markdown", tokenLanguages: ["markdown"]},
    {file: "yaml.tmLanguage.json", scopeName: "source.yaml", tokenLanguages: ["yaml"]},
    {file: "xml.tmLanguage.json", scopeName: "text.xml", tokenLanguages: ["xml"]},
    {file: "shell-unix-bash.tmLanguage.json", scopeName: "source.shell", tokenLanguages: ["shell"]},
    // cpp 语法(source.cpp)同文件覆盖 C(LANG_MAP 里 .c/.h → c):C 代码用
    // cpp 语法分词完全正确,scope 前缀差异不影响主题着色(主题按子 scope 匹配)
    {file: "cpp.tmLanguage.json", scopeName: "source.cpp", tokenLanguages: ["cpp", "c"]},
    {file: "java.tmLanguage.json", scopeName: "source.java", tokenLanguages: ["java"]},
    {file: "go.tmLanguage.json", scopeName: "source.go", tokenLanguages: ["go"]},
];

let builtinLoaded = false;

// 加载内置 TextMate 语法并接管对应 Monaco 语言的着色。
// 幂等;失败按文件跳过,不抛出 —— 语法加载失败只应退回 Monarch,不该打断启动。
// setTokensProvider 是覆盖语义,同一 language id 以最后注册者为准;
// 扩展语法后于内置加载,自带语法时自然覆盖内置(与 VS Code 行为一致)。
export async function loadBuiltinGrammars(): Promise<number> {
    if (builtinLoaded) return 0;
    builtinLoaded = true;
    const reg = await ensureRegistry();
    const base = `/plugins/${__SYFE_PLUGIN_NAME__}/grammars`;
    let loadedCount = 0;
    for (const item of BUILTIN_GRAMMARS) {
        try {
            const resp = await fetch(`${base}/${item.file}`);
            if (!resp.ok) {
                console.warn(`[siyuan-file-editor] 内置语法加载失败(HTTP ${resp.status}): ${item.file}`);
                continue;
            }
            const content = await resp.text();
            const rawGrammar = parseRawGrammar(content, item.file);
            grammarMap.set(item.scopeName, rawGrammar);
            const g = await reg.addGrammar(rawGrammar);
            for (const lang of item.tokenLanguages) {
                // setTokensProvider 对未注册语言直接抛错。Monaco 的 basic-languages
                // 贡献是惰性 chunk,首个 .py 模型创建前 "python" 可能尚未注册,这里兜底。
                // 重复注册 ModesRegistry 只是追加条目,无副作用;贡献 chunk 稍后照常
                // 加载,补上语言配置(括号/注释规则)与 Monarch factory(不会覆盖
                // 我们直接注册的 TextMate tokenizer —— TokenizationRegistry.getOrCreate
                // 永远先查直接注册表)
                if (!monaco.languages.getLanguages().some(l => l.id === lang)) {
                    monaco.languages.register({id: lang});
                }
                languageToScope.set(lang, item.scopeName);
                registerMonacoTokenizer(lang, g);
            }
            loadedCount++;
        } catch (e) {
            console.error(`[siyuan-file-editor] 内置语法注册失败 ${item.file}:`, e);
        }
    }
    if (loadedCount > 0) {
        console.info(`[siyuan-file-editor] 已加载 ${loadedCount} 个内置 TextMate 语法`);
        // 对注册前已创建的模型强制重分词:布局恢复先于本函数执行时,模型在
        // tokenizer 注册前创建,会一直停留在创建时的空分词结果上(表现为整文件
        // 默认色)。plaintext→原语言翻转强制 GrammarTokens 重新 resolve,
        // 着色立即生效;语言切换不影响光标/撤销栈。
        const covered = new Set<string>(BUILTIN_GRAMMARS.flatMap(g => g.tokenLanguages));
        for (const model of monaco.editor.getModels()) {
            const lang = model.getLanguageId();
            if (covered.has(lang)) {
                monaco.editor.setModelLanguage(model, "plaintext");
                monaco.editor.setModelLanguage(model, lang);
            }
        }
    }
    return loadedCount;
}

// 加载 oniguruma WASM(只需一次)
// 优先从插件目录取(随插件分发,离线可用),CDN 仅作兜底
async function ensureWasmLoaded(): Promise<void> {
    if (wasmLoaded) return;
    const candidates = [
        `/plugins/${__SYFE_PLUGIN_NAME__}/grammars/onig.wasm`,
        "https://cdn.jsdelivr.net/npm/vscode-oniguruma@2.0.1/release/onig.wasm",
    ];
    let lastErr: unknown = null;
    for (const wasmUrl of candidates) {
        try {
            const resp = await fetch(wasmUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const wasmBuffer = await resp.arrayBuffer();
            await loadWASM(wasmBuffer);
            wasmLoaded = true;
            return;
        } catch (e) {
            lastErr = e;
            console.warn(`[siyuan-file-editor] 加载 oniguruma WASM 失败(${wasmUrl}):`, e);
        }
    }
    throw lastErr ?? new Error("oniguruma WASM 加载失败");
}

// 确保语法注册表已初始化(单例 promise,防并发建双 Registry)
function ensureRegistry(): Promise<Registry> {
    if (!registryPromise) {
        registryPromise = (async () => {
            await ensureWasmLoaded();
            registry = new Registry({
                onigLib: Promise.resolve({
                    createOnigScanner: (sources: string[]) => new (require("vscode-oniguruma") as any).OnigScanner(sources),
                    createOnigString: (str: string) => new (require("vscode-oniguruma") as any).OnigString(str),
                }),
                loadGrammar: async (scopeName: string) => {
                    // 语法依赖的外部语法(如 source.js 内嵌在 html 中)
                    // 从已加载的语法映射中查找
                    const grammar = grammarMap.get(scopeName);
                    return grammar || null;
                },
            });
            return registry;
        })();
    }
    return registryPromise;
}

// scopeName → RawGrammar 的映射(用于处理嵌入式语法)
const grammarMap = new Map<string, any>();

// languageId → scopeName 的映射(用于 Monaco 注册)
const languageToScope = new Map<string, string>();

// 扩展名 → languageId 的映射(用于文件关联)
const extToLanguage = new Map<string, string>();

// 加载扩展的语法贡献
export async function loadGrammars(extension: InstalledExtension): Promise<number> {
    const contributes = extension.contributes;
    if (!contributes?.grammars || contributes.grammars.length === 0) return 0;

    const reg = await ensureRegistry();
    let loadedCount = 0;

    // 先注册语言(如果 contributes.languages 中有定义)
    if (contributes.languages) {
        for (const lang of contributes.languages) {
            registerLanguage(lang);
        }
    }

    // 加载并注册语法
    for (const grammar of contributes.grammars) {
        try {
            const content = extension.files[normalizePath(grammar.path)];
            if (!content) {
                console.warn(`[siyuan-file-editor] 语法文件未找到: ${grammar.path}`);
                continue;
            }

            // 解析语法
            const rawGrammar = parseRawGrammar(content, grammar.path);
            grammarMap.set(grammar.scopeName, rawGrammar);

            // 注册到 Registry
            const g = await reg.addGrammar(rawGrammar);

            // 如果语法关联了语言,注册到 Monaco
            if (grammar.language) {
                languageToScope.set(grammar.language, grammar.scopeName);
                registerMonacoTokenizer(grammar.language, g);
            }

            loadedCount++;
        } catch (e) {
            console.error(`[siyuan-file-editor] 加载语法失败 ${grammar.path}:`, e);
        }
    }

    return loadedCount;
}

// 注册语言到 Monaco(扩展名关联)
function registerLanguage(lang: LanguageContribution): void {
    if (lang.extensions) {
        for (const ext of lang.extensions) {
            extToLanguage.set(ext.toLowerCase(), lang.id);
        }
    }
    // 注册 Monaco 语言(如果不存在)
    const languages = monaco.languages.getLanguages();
    if (!languages.find(l => l.id === lang.id)) {
        monaco.languages.register({
            id: lang.id,
            extensions: lang.extensions,
            aliases: lang.aliases,
            filenames: lang.filenames,
        });
    }
}

// 将 TextMate 语法注册为 Monaco 的 Tokenizer
//
// grammar 直接用调用方传入的 IGrammar(loadGrammars 里 reg.addGrammar 的返回值):
// vscode-textmate v9 已经没有 grammarForScopeName 这个公开方法了(私有化),
// 而 addGrammar 的产物就是同一个语法对象,顺手传进来即可。
function registerMonacoTokenizer(
    languageId: string,
    grammar: IGrammar,
): void {
    monaco.languages.setTokensProvider(languageId, {
        getInitialState: () => new TokenizerState(INITIAL),
        tokenize: (line: string, state: TokenizerState) => {
            const result = grammar.tokenizeLine(line, state.ruleStack);
            if (!result) {
                return {tokens: [], endState: state};
            }
            const tokens: monaco.languages.IToken[] = [];
            for (let i = 0; i < result.tokens.length; i++) {
                const token = result.tokens[i];
                tokens.push({
                    startIndex: token.startIndex,
                    scopes: token.scopes[token.scopes.length - 1],
                });
            }
            return {
                tokens,
                endState: new TokenizerState(result.ruleStack),
            };
        },
    });
}

// Tokenizer 状态(封装 TextMate 的 StateStack —— v9 里 StackElement 已更名)
class TokenizerState implements monaco.languages.IState {
    constructor(public ruleStack: StateStack) {}
    clone(): monaco.languages.IState {
        return new TokenizerState(this.ruleStack);
    }
    equals(other: monaco.languages.IState): boolean {
        if (!(other instanceof TokenizerState)) return false;
        return this.ruleStack === other.ruleStack;
    }
}

// 规范化路径
function normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

// 根据文件扩展名获取 languageId(优先使用扩展注册的语言)
export function getLanguageIdByExtension(ext: string): string | null {
    return extToLanguage.get(ext.toLowerCase()) || null;
}

// 清理所有已注册的语法(卸载扩展时调用)
export function clearAllGrammars(): void {
    grammarMap.clear();
    languageToScope.clear();
    extToLanguage.clear();
    registry = null;
}
