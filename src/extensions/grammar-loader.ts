// TextMate 语法加载器
// 将 VSCode 扩展的 .tmLanguage.json 语法注册到 Monaco
// 使用 vscode-textmate 解析 TextMate 语法,vscode-oniguruma 提供 WASM 正则引擎
// 通过 monaco.languages.setMonarchTokensProvider 的替代方案:
//   注册 Tokenizer,将 TextMate 规则转换为 Monaco 可识别的 token
import * as monaco from "monaco-editor";
import {Registry, parseRawGrammar, INITIAL, StackElement} from "vscode-textmate";
import {loadWASM} from "vscode-oniguruma";
import {InstalledExtension, GrammarContribution, LanguageContribution} from "./types";

let wasmLoaded = false;
let registry: Registry | null = null;

// 加载 oniguruma WASM(只需一次)
// vscode-oniguruma 的 wasm 文件需要从 node_modules 复制或内联
// 这里使用 CDN 作为 fallback
async function ensureWasmLoaded(): Promise<void> {
    if (wasmLoaded) return;
    // 尝试从 vscode-oniguruma 包加载 wasm
    // 在 webpack 环境中,需要 file-loader 处理 .wasm 文件
    // 这里使用 fetch 从 CDN 加载作为可靠方案
    const wasmUrl = "https://cdn.jsdelivr.net/npm/vscode-oniguruma@2.0.1/release/onig.wasm";
    try {
        const resp = await fetch(wasmUrl);
        const wasmBuffer = await resp.arrayBuffer();
        await loadWASM(wasmBuffer);
        wasmLoaded = true;
    } catch (e) {
        console.error("[siyuan-file-editor] 加载 oniguruma WASM 失败:", e);
        throw e;
    }
}

// 确保语法注册表已初始化
async function ensureRegistry(): Promise<Registry> {
    await ensureWasmLoaded();
    if (!registry) {
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
    }
    return registry;
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
                registerMonacoTokenizer(grammar.language, grammar.scopeName, g, reg);
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
function registerMonacoTokenizer(
    languageId: string,
    scopeName: string,
    grammar: any,
    reg: Registry,
): void {
    monaco.languages.setTokensProvider(languageId, {
        getInitialState: () => new TokenizerState(INITIAL),
        tokenize: (line: string, state: TokenizerState) => {
            const result = reg.grammarForScopeName(scopeName)?.tokenizeLine(line, state.ruleStack);
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

// Tokenizer 状态(封装 TextMate 的 StackElement)
class TokenizerState implements monaco.languages.IState {
    constructor(public ruleStack: StackElement) {}
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
