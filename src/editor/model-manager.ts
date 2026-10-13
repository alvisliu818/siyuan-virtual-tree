import * as monaco from "monaco-editor";
import {readTextFile, writeFile} from "../api/file";
import {nativeStat} from "../api/native-fs";
import {getLanguageByPath} from "./monaco";
import {isSiyuanPath} from "../utils/path";

// path → Monaco 文本模型(同一文件多 Tab 共享)
const models = new Map<string, monaco.editor.ITextModel>();
// path → 是否有未保存修改
const dirtyMap = new Map<string, boolean>();
// path → 待跳转行号(搜索结果点击后,编辑器创建时消费)
const pendingReveals = new Map<string, number>();
// path → 上次落盘内容(相同则跳过写盘:data 下文件每次写入都会触发思源自动同步)
const lastSavedMap = new Map<string, string>();
// path → 文件在"我们认知里"的状态(首次加载/保存/重载时的 mtime+size)。
// 用来判断文件是否被思源之外的程序改过 —— 见 isChangedExternally。
const statMap = new Map<string, {mtimeMs: number; size: number}>();

function uriForPath(path: string): monaco.Uri {
    // 思源虚拟路径走专用 scheme;工作空间外的系统绝对路径(如 E:\HOME\BaiduSyncdisk)
    // 必须用 file:// 才能让 Monaco 正确解析盘符与反斜杠路径
    if (isSiyuanPath(path)) {
        return monaco.Uri.parse("siyuan://file" + path);
    }
    return monaco.Uri.file(path.replace(/\\/g, "/"));
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
    lastSavedMap.set(path, content);
    recordStat(path);
    return model;
}

// 记下当前文件的 mtime+size 作为"已同步"基线
function recordStat(path: string): void {
    const st = nativeStat(path);
    if (st) statMap.set(path, st);
}

// 文件是否被思源之外的程序改过(外部编辑器、git 切换分支、脚本生成…)。
// 拿不到 stat(环境不支持/文件已删)时返回 false —— 宁可不刷新,也不能凭空覆盖用户内容。
export function isChangedExternally(path: string): boolean {
    const base = statMap.get(path);
    if (!base) return false;
    const now = nativeStat(path);
    if (!now) return false;
    return now.mtimeMs !== base.mtimeMs || now.size !== base.size;
}

export function isDirty(path: string): boolean {
    return dirtyMap.get(path) ?? false;
}

export function markDirty(path: string, dirty: boolean): void {
    dirtyMap.set(path, dirty);
}

// 保存模型内容到文件(内容与上次落盘相同则跳过,避免无谓触发思源同步)
export async function saveModel(path: string): Promise<void> {
    const model = models.get(path);
    if (!model) return;
    const value = model.getValue();
    if (lastSavedMap.get(path) === value) {
        markDirty(path, false);
        return;
    }
    await writeFile(path, value);
    lastSavedMap.set(path, value);
    markDirty(path, false);
    recordStat(path);
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
    lastSavedMap.set(path, content);
    recordStat(path);
}

export function disposeModel(path: string): void {
    const model = models.get(path);
    if (model) {
        model.dispose();
        models.delete(path);
        dirtyMap.delete(path);
        lastSavedMap.delete(path);
        statMap.delete(path);
    }
}

export function disposeAll(): void {
    models.forEach(m => m.dispose());
    models.clear();
    dirtyMap.clear();
    pendingReveals.clear();
    lastSavedMap.clear();
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
