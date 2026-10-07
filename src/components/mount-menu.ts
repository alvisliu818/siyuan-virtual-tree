// 挂载到虚拟文档树:菜单项 + 面板内"添加挂载"所需的公共逻辑。
// 选项 = 顶层 + 现有所有挂载节点(带面包屑),供文件树右键、思源文档/块右键、虚拟文档树面板右键共用,
// 实现"支持嵌套挂载":同一个条目可以挂到顶层,也可以挂到任意已挂载节点下面。
//
// 注意:本文件**不要 import ./file-tree**(它 import 了本文件,会成环);
// 需要「挂载思源文档…」选择器的地方(mount-tree-dock)直接引 file-tree 的 pickMountTargetDialog。
import {Menu, Dialog, showMessage} from "siyuan";
import {addMountItem, listMountTargets, hasMounted, MountKind} from "../mount-tree";
import {readDir} from "../api/file";
import {basename, dirname} from "../utils/path";

export interface MountPayload {
    kind: MountKind;
    name: string;
    path?: string;      // kind=file
    targetId?: string;  // kind=doc / notebook / block
    isDir?: boolean;    // kind=file:是否文件夹
}

// 执行挂载并提示结果
export async function mountPayload(plugin: any, payload: MountPayload, parentUid: string | null): Promise<boolean> {
    try {
        const item = await addMountItem(plugin, payload, parentUid);
        if (!item) {
            showMessage("挂载失败:目标节点已不存在", 3000, "error");
            return false;
        }
        showMessage(`${parentUid ? "已嵌套挂载" : "已挂载到虚拟文档树"}:${payload.name}`, 2500, "info");
        return true;
    } catch (e) {
        showMessage(`挂载失败: ${e}`, 3000, "error");
        return false;
    }
}

// 可选挂载位置的菜单项(已挂过的打勾)
function targetItems(plugin: any, payload: MountPayload) {
    return listMountTargets().map(t => ({
        label: t.label + (hasMounted(t.uid, payload.kind, payload.path, payload.targetId) ? " ✓" : ""),
        click: () => {
            void mountPayload(plugin, payload, t.uid);
        },
    }));
}

// 作为一项追加到调用方的 Menu 上(文件树 / 思源右键菜单复用其 Menu 实例)
export function addMountMenuItem(menu: Menu, plugin: any, payload: MountPayload): void {
    menu.addItem({
        icon: "iconList",
        label: "挂载到虚拟文档树",
        submenu: targetItems(plugin, payload),
    });
}

// 独立弹出挂载位置选择菜单
export function showMountTargetMenu(x: number, y: number, plugin: any, payload: MountPayload): void {
    const menu = new Menu();
    for (const it of targetItems(plugin, payload)) {
        menu.addItem(it);
    }
    menu.open({x, y});
}

// 判断路径是文件还是文件夹。
// 注意:不能直接 readDir(目标)——思源内核对**文件**也返回空数组,与"空文件夹"无法区分;
// 必须读父目录再按名字回查 DirEntry.isDir(与标签面板同一套做法)。
export async function detectIsDir(path: string): Promise<boolean> {
    try {
        const list = await readDir(dirname(path));
        const ent = (Array.isArray(list) ? list : []).find(e => e.name === basename(path));
        return ent ? !!ent.isDir : false;
    } catch {
        return false;
    }
}

// 输入路径挂载文件/文件夹(虚拟文档树面板右键「挂载文件/文件夹…」用)
export function promptMountPathDialog(
    title: string,
    onPicked: (p: string, isDir: boolean, name: string) => void,
): void {
    const dialog = new Dialog({
        title,
        content: `
            <div class="b3-dialog__content">
                <div style="margin-bottom:6px;">文件或文件夹路径</div>
                <input class="b3-text-field fn__block" id="syfe-mtree-path" placeholder="E:\\notes 或 /data/子目录/笔记.md" />
                <div style="margin-top:6px;font-size:12px;opacity:.7;">支持工作空间内路径(/data/...)与系统绝对路径</div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="syfe-mtree-cancel">取消</button>
                <button class="b3-button b3-button--text" id="syfe-mtree-ok">挂载</button>
            </div>`,
        width: "520px",
    });
    const inputEl = dialog.element.querySelector("#syfe-mtree-path") as HTMLInputElement;
    const close = () => dialog.destroy();
    const submit = async () => {
        const p = inputEl.value.trim();
        if (!p) {
            showMessage("请填写路径", 2000, "error");
            return;
        }
        const isDir = await detectIsDir(p);
        close();
        onPicked(p, isDir, basename(p));
    };
    inputEl.focus();
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void submit();
        }
    });
    dialog.element.querySelector("#syfe-mtree-ok")!.addEventListener("click", () => void submit());
    dialog.element.querySelector("#syfe-mtree-cancel")!.addEventListener("click", close);
}
