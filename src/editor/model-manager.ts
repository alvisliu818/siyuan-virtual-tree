import * as monaco from "monaco-editor";
import {readTextFile, writeFile} from "../api/file";
import {getLanguageByPath} from "./monaco";

// path → Monaco 文本模型(同一文件多 Tab 共享)
const models = new Map<string, monaco.editor.ITextModel>();
// path → 是否有未保存修改
const dirtyMap = new Map<string, boolean>();
// path → 待跳转行号(搜索结果点击后,编辑器创建时消费)
const pendingReveals = new Map<string, number>();

function uriForPath(path: string): monaco.Uri {
    return monaco.Uri.parse("siyuan://file" + path);
}

// 获取或创建模型;不存在则从文件加载内容
export async function getModel(path: string): Promise<monaco.editor.ITextModel> {
    const existing = models.get(path);
    if (existing) return existing;
    let content = "";
    try {
        content = await readTextFile(path);
    } catch {
        // 读取失败(文件不存在等),使用空内容,允许新建后保存
        content = "";
    }
    const model = monaco.editor.createModel(content, getLanguageByPath(path), uriForPath(path));
    models.set(path, model);
    dirtyMap.set(path, false);
    return model;
}

export function isDirty(path: string): boolean {
    return dirtyMap.get(path) ?? false;
}

export function markDirty(path: string, dirty: boolean): void {
    dirtyMap.set(path, dirty);
}

// 保存模型内容到文件
export async function saveModel(path: string): Promise<void> {
    const model = models.get(path);
    if (!model) return;
    await writeFile(path, model.getValue());
    markDirty(path, false);
}

// 重新加载文件内容到已有模型(外部修改后刷新)
export async function reloadModel(path: string): Promise<void> {
    const model = models.get(path);
    if (!model) return;
    let content = "";
    try {
        content = await readTextFile(path);
    } catch {
        return;
    }
    const position = model.getFullModelRange();
    model.applyEdits([{
        range: position,
        text: content,
    }]);
    markDirty(path, false);
}

export function disposeModel(path: string): void {
    const model = models.get(path);
    if (model) {
        model.dispose();
        models.delete(path);
        dirtyMap.delete(path);
    }
}

export function disposeAll(): void {
    models.forEach(m => m.dispose());
    models.clear();
    dirtyMap.clear();
    pendingReveals.clear();
}

// 搜索结果跳转:设置待跳转行号
export function setPendingReveal(path: string, lineNo: number): void {
    pendingReveals.set(path, lineNo);
}

// 编辑器创建时消费待跳转行号
export function consumePendingReveal(path: string): number | null {
    const line = pendingReveals.get(path);
    if (line !== undefined) {
        pendingReveals.delete(path);
        return line;
    }
    return null;
}
