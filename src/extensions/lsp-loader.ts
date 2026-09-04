// LSP 加载器(最小方案)
// 完整的 LSP 扩展需要模拟整个 vscode API,这里实现一个最小方案:
//   1. 对于纯前端的语言扩展(如格式化器),尝试加载其 main 入口
//   2. 提供 Monaco API 作为 vscode API 的代理
//   3. 大部分依赖 Node.js 的扩展无法运行
//
// 限制说明:
//   - 无法运行需要 Node.js fs/child_process 的扩展
//   - 无法运行 Language Server Protocol(需要独立进程)
//   - 仅支持通过 monaco.languages API 注册的简单功能
//
// 可行的扩展类型:
//   - 简单的格式化器(基于正则)
//   - 静态诊断(基于正则的 linter)
//   - 自定义 completion provider
import * as monaco from "monaco-editor";
import {InstalledExtension} from "./types";

// 已加载的 LSP 扩展 dispose 函数
const loadedLspExtensions = new Map<string, monaco.IDisposable[]>();

// 加载扩展的 LSP 功能(尝试加载 main 入口)
// 注意:这是一个实验性功能,大部分扩展无法成功加载
export async function loadLsp(extension: InstalledExtension): Promise<number> {
    const pkgJson = extension.files["package.json"];
    if (!pkgJson) return 0;

    let pkg: any;
    try {
        pkg = JSON.parse(pkgJson);
    } catch {
        return 0;
    }

    // 检查是否有 main 入口
    if (!pkg.main) return 0;

    // 检查激活事件
    const activationEvents = pkg.activationEvents || [];
    const hasLanguageActivation = activationEvents.some(
        (e: string) => e.startsWith("onLanguage:") || e === "*",
    );
    if (!hasLanguageActivation) return 0;

    // 尝试加载扩展代码
    // 注意:在浏览器环境中,无法直接 require 扩展代码
    // 这里仅记录支持信息,实际加载需要更复杂的模块系统
    console.info(
        `[siyuan-file-editor] 扩展 ${extension.id} 包含 LSP 功能(main: ${pkg.main}),` +
        `当前 LSP 加载为实验性功能,仅支持部分纯前端扩展`,
    );

    // 模拟 vscode API 命名空间
    const vscodeApi = createVscodeApiStub(extension);
    // 存储供未来使用(当前不实际执行扩展代码)
    loadedLspExtensions.set(extension.id, []);

    return 0;
}

// 创建 vscode API 桩(模拟 vscode 命名空间)
function createVscodeApiStub(extension: InstalledExtension): any {
    return {
        // 语言 API → 代理到 monaco.languages
        languages: {
            registerCompletionItemProvider: (language: string, provider: any) =>
                monaco.languages.registerCompletionItemProvider(language, provider),
            registerHoverProvider: (language: string, provider: any) =>
                monaco.languages.registerHoverProvider(language, provider),
            registerDocumentFormattingEditProvider: (language: string, provider: any) =>
                monaco.languages.registerDocumentFormattingEditProvider(language, provider),
            registerDocumentRangeFormattingEditProvider: (language: string, provider: any) =>
                monaco.languages.registerDocumentRangeFormattingEditProvider(language, provider),
            registerCodeActionProvider: (language: string, provider: any) =>
                monaco.languages.registerCodeActionProvider(language, provider),
            registerDefinitionProvider: (language: string, provider: any) =>
                monaco.languages.registerDefinitionProvider(language, provider),
            registerReferenceProvider: (language: string, provider: any) =>
                monaco.languages.registerReferenceProvider(language, provider),
            registerRenameProvider: (language: string, provider: any) =>
                monaco.languages.registerRenameProvider(language, provider),
            registerSignatureHelpProvider: (language: string, provider: any) =>
                monaco.languages.registerSignatureHelpProvider(language, provider),
            registerDocumentSymbolProvider: (language: string, provider: any) =>
                monaco.languages.registerDocumentSymbolProvider(language, provider),
            registerTypeDefinitionProvider: (language: string, provider: any) =>
                monaco.languages.registerTypeDefinitionProvider(language, provider),
            createDiagnosticCollection: (_name: string) => ({
                set: () => {},
                clear: () => {},
                dispose: () => {},
            }),
        },
        // 窗口 API → 代理到 monaco.editor
        window: {
            activeTextEditor: null,
            showInformationMessage: (msg: string) => console.info(`[${extension.id}] ${msg}`),
            showWarningMessage: (msg: string) => console.warn(`[${extension.id}] ${msg}`),
            showErrorMessage: (msg: string) => console.error(`[${extension.id}] ${msg}`),
        },
        // 工作区 API → 桩实现
        workspace: {
            getConfiguration: () => ({
                get: (key: string, defaultValue?: any) => defaultValue,
                update: () => Promise.resolve(),
            }),
            onDidChangeTextDocument: () => ({dispose: () => {}}),
            onDidSaveTextDocument: () => ({dispose: () => {}}),
        },
        // 命令 API
        commands: {
            registerCommand: () => ({dispose: () => {}}),
            executeCommand: () => Promise.resolve(),
        },
        // 上下文 API
        context: {
            subscriptions: [],
            asAbsolutePath: (p: string) => p,
        },
        // 版本信息
        version: "1.0.0",
    };
}

// 移除扩展的 LSP 功能
export function removeExtensionLsp(extensionId: string): void {
    const disposables = loadedLspExtensions.get(extensionId);
    if (disposables) {
        disposables.forEach(d => d.dispose());
        loadedLspExtensions.delete(extensionId);
    }
}

// 清理所有 LSP
export function clearAllLsp(): void {
    loadedLspExtensions.forEach(disposables => disposables.forEach(d => d.dispose()));
    loadedLspExtensions.clear();
}
