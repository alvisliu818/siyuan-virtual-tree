// 代码片段加载器
// 将 VSCode 扩展的 snippets JSON 注册到 Monaco completion provider
// VSCode snippet JSON 结构:
//   {
//     "Snippet Name": {
//       "prefix": "log",
//       "body": ["console.log(${1:var})", "$2"],
//       "description": "Log to console"
//     }
//   }
import * as monaco from "monaco-editor";
import {InstalledExtension} from "./types";

// 已注册的 snippet 提供者 dispose 函数(按扩展 ID)
const registeredProviders = new Map<string, monaco.IDisposable[]>();

// 加载扩展的代码片段贡献
export function loadSnippets(extension: InstalledExtension): number {
    const contributes = extension.contributes;
    if (!contributes?.snippets || contributes.snippets.length === 0) return 0;

    const disposables: monaco.IDisposable[] = [];
    let count = 0;

    // 按语言分组 snippets
    const languageSnippets = new Map<string, Snippet[]>();

    for (const snippetContribution of contributes.snippets) {
        try {
            const content = extension.files[normalizePath(snippetContribution.path || "")];
            if (!content) {
                console.warn(`[siyuan-file-editor] snippet 文件未找到: ${snippetContribution.path}`);
                continue;
            }
            const snippetsData = JSON.parse(content);
            const language = snippetContribution.language || snippetContribution.languageId || "plaintext";

            const snippets: Snippet[] = [];
            for (const [name, value] of Object.entries(snippetsData)) {
                const s = value as any;
                if (s.prefix && s.body) {
                    snippets.push({
                        name,
                        prefix: Array.isArray(s.prefix) ? s.prefix[0] : s.prefix,
                        body: Array.isArray(s.body) ? s.body.join("\n") : s.body,
                        description: s.description || "",
                    });
                }
            }

            if (snippets.length > 0) {
                const existing = languageSnippets.get(language) || [];
                languageSnippets.set(language, [...existing, ...snippets]);
                count += snippets.length;
            }
        } catch (e) {
            console.error(`[siyuan-file-editor] 加载 snippet 失败 ${snippetContribution.path}:`, e);
        }
    }

    // 为每种语言注册 completion provider
    for (const [language, snippets] of languageSnippets) {
        const provider = monaco.languages.registerCompletionItemProvider(language, {
            provideCompletionItems: (model, position) => {
                const word = model.getWordUntilPosition(position);
                const range = {
                    startLineNumber: position.lineNumber,
                    endLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endColumn: word.endColumn,
                };
                return {
                    suggestions: snippets.map(s => ({
                        label: s.prefix,
                        kind: monaco.languages.CompletionItemKind.Snippet,
                        insertText: s.body,
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        detail: s.name,
                        documentation: s.description,
                        range,
                    })),
                };
            },
        });
        disposables.push(provider);
    }

    if (disposables.length > 0) {
        registeredProviders.set(extension.id, disposables);
    }

    return count;
}

interface Snippet {
    name: string;
    prefix: string;
    body: string;
    description: string;
}

function normalizePath(p: string): string {
    return p.replace(/^\.\//, "").replace(/^\//, "");
}

// 移除扩展的代码片段(卸载时调用)
export function removeExtensionSnippets(extensionId: string): void {
    const disposables = registeredProviders.get(extensionId);
    if (disposables) {
        disposables.forEach(d => d.dispose());
        registeredProviders.delete(extensionId);
    }
}

// 清理所有代码片段
export function clearAllSnippets(): void {
    registeredProviders.forEach(disposables => disposables.forEach(d => d.dispose()));
    registeredProviders.clear();
}
