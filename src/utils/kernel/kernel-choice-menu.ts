// 内核选择菜单(笔记本工具栏徽章 / 文档代码块共用)
//
// 抽出来的原因:两处的需求完全一样 —— 让用户挑「内置内核」还是某个 Jupyter kernelspec,
// 顺便能重启。差别只在"能不能现在切换"(正在执行时要拦一下)和"切完干什么",
// 所以做成回调,两边各自填。
import {Menu, showMessage} from "siyuan";
import {
    getKernelChoice,
    setKernelChoice,
    disposeKernel,
    listAvailableKernels,
    loadKernelChoices,
    KernelChoice,
} from "./registry";

export interface KernelChoiceMenuOpts {
    x: number;
    y: number;
    docId: string;
    /** 返回非空文案 = 拒绝切换(如"正在执行,请先中断"),菜单里直接提示 */
    beforeSwitch?: () => string | null;
    /** 切换或重启后的回调(重新连内核、刷新 UI) */
    onAfter?: () => void;
}

// 当前内核的显示名(按钮/徽章文案用)
export function kernelChoiceLabel(docId: string): string {
    const cur = getKernelChoice(docId);
    if (!cur || cur.kind === "syfe") return "内置";
    if (cur.kind === "jupyter") return cur.specName || "jupyter";
    return String(cur.kind);
}

/**
 * 弹出内核选择菜单。
 * 菜单项:内置 Python 内核(带 ✓)/ 检测到的每个 Jupyter kernelspec / 重启当前内核。
 */
export async function openKernelChoiceMenu(opts: KernelChoiceMenuOpts): Promise<void> {
    const {docId, beforeSwitch, onAfter} = opts;
    await loadKernelChoices();
    const cur = getKernelChoice(docId);
    const menu = new Menu("syfe-kernel-choice");

    const pick = (choice: KernelChoice, okMsg: string) => {
        const blocked = beforeSwitch?.();
        if (blocked) {
            showMessage(blocked, 3000, "info");
            return;
        }
        setKernelChoice(docId, choice);
        showMessage(okMsg, 2500, "info");
        onAfter?.();
    };

    const builtinOn = !cur || cur.kind === "syfe";
    menu.addItem({
        iconHTML: "",
        label: (builtinOn ? "✓ " : "") + "内置 Python 内核",
        click: () => pick({kind: "syfe"}, "已切换到内置 Python 内核"),
    });
    menu.addSeparator();

    let specs: Awaited<ReturnType<typeof listAvailableKernels>> = [];
    try {
        specs = await listAvailableKernels();
    } catch {
        specs = [];
    }
    if (specs.length === 0) {
        menu.addItem({iconHTML: "", label: "(未检测到 Jupyter kernelspec)", click: () => {}});
    } else {
        for (const spec of specs) {
            const isCur = cur?.kind === "jupyter" && cur.specName === spec.name;
            // conda 环境自带的 spec,displayName 形如 "conda:ai · Python 3 (ipykernel)",
            // 自带来源标识,不再叠加 "Jupyter · " 前缀
            const display = spec.displayName || spec.name;
            const label = display.startsWith("conda:") ? display : `Jupyter · ${display}`;
            menu.addItem({
                iconHTML: "",
                label: (isCur ? "✓ " : "") + label,
                click: () => pick(
                    {kind: "jupyter", specName: spec.name, specResourceDir: spec.resourceDir},
                    `已切换到内核 ${spec.displayName || spec.name}`,
                ),
            });
        }
    }

    menu.addSeparator();
    menu.addItem({
        iconHTML: "",
        icon: "iconRefresh",
        label: "重启当前内核",
        click: () => {
            const blocked = beforeSwitch?.();
            if (blocked) {
                showMessage(blocked, 3000, "info");
                return;
            }
            void disposeKernel(docId).then(() => {
                showMessage("内核已重启,变量已清空", 2500, "info");
                onAfter?.();
            });
        },
    });

    menu.open({x: opts.x, y: opts.y});
}
