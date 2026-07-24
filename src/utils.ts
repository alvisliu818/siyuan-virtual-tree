import { getAllEditor, showMessage } from "siyuan";
import type { subMenu } from "siyuan";
import { StateManager } from "./stateManager";
import { t } from "./i18n";

/**
 * 获取当前激活文档的 rootID。
 * 多标签页下优先返回激活 tab 中的编辑器，避免聚焦到错误文档。
 *
 * 策略（按可靠性排序）：
 * 1. getAllEditor() 中 element 在激活 tab（layout-tab__item--focus）内的编辑器
 * 2. DOM 方式：激活 tab 内的 protyle 元素通过 data-doc-id 获取文档 ID
 * 3. 可见编辑器（元素有非零尺寸，即用户当前可见的文档）
 * 4. 只有一个编辑器时直接使用
 * 5. 任意有 rootID 的编辑器
 */
export function getCurrentDocRootId(): string | null {
  try {
    const editors = getAllEditor();

    // 1. 优先：getAllEditor() 中 element 在激活 tab 内的编辑器
    for (const editor of editors) {
      const el = editor?.protyle?.element;
      const rootId = editor?.protyle?.block?.rootID;
      if (!el || !rootId) continue;
      if (el.closest(".layout-tab__item--focus")) {
        return rootId;
      }
    }

    // 2. DOM 回退：激活 tab 内的 protyle 通过 data-doc-id 获取
    const activeProtyle = document.querySelector(
      ".layout-tab__item--focus .protyle"
    ) as HTMLElement | null;
    if (activeProtyle) {
      const docIdEl = activeProtyle.hasAttribute("data-doc-id")
        ? activeProtyle
        : activeProtyle.querySelector<HTMLElement>("[data-doc-id]");
      const docId = docIdEl?.dataset.docId;
      if (docId) return docId;
    }

    // 3. 可见编辑器：元素有非零尺寸即为用户当前可见的文档
    for (const editor of editors) {
      const el = editor?.protyle?.element;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const rootId = editor?.protyle?.block?.rootID;
        if (rootId) return rootId;
      }
    }

    // 4. 回退：只有一个编辑器时直接用
    if (editors.length === 1) {
      const rootId = editors[0]?.protyle?.block?.rootID;
      if (rootId) return rootId;
    }

    // 5. 最终回退：任意一个有 rootID 的编辑器
    for (const editor of editors) {
      const rootId = editor?.protyle?.block?.rootID;
      if (rootId) return rootId;
    }

    return null;
  } catch (e) {
    console.error("[VirtualTree] Failed to get current doc root ID:", e);
    return null;
  }
}

/**
 * 在右键菜单中追加"加入/移出虚拟树"管理项。
 * 供 doc tree、editor title、panel 三处复用。
 *
 * @param menu          siyuan subMenu
 * @param docId         目标文档 rootID
 * @param stateManager  状态管理器
 * @param onChanged     成功添加/移除后的回调（通常用于 rebuild）
 */
export function addRootManagementItems(
  menu: subMenu,
  docId: string,
  stateManager: StateManager,
  onChanged: () => void
): void {
  menu.addItem({
    icon: "iconList",
    label: t("addToVirtualTree", "添加到虚拟文档树"),
    click: async () => {
      const success = await stateManager.addRootDoc(docId);
      showMessage(
        success
          ? t("addRootSuccess", "已添加为根节点")
          : t("addRootDuplicate", "该文档已是根节点")
      );
      if (success) onChanged();
    },
  });

  if (stateManager.isRootDoc(docId)) {
    menu.addItem({
      icon: "iconTrashcan",
      label: t("removeRoot", "从虚拟树移除"),
      click: async () => {
        await stateManager.removeRootDoc(docId);
        showMessage(t("removeRootSuccess", "已从虚拟树移除"));
        onChanged();
      },
    });
  }
}

/**
 * 简单的防抖工具。返回的函数带一个 `.cancel()` 方法用于清理。
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
