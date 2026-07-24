import { Setting } from "siyuan";
import { StateManager } from "./stateManager";
import { VirtualTreeSettings, DEFAULT_SETTINGS } from "./types";
import { t } from "./i18n";

export class VirtualTreeSettingsPanel {
  private stateManager: StateManager;
  private rebuildCallback: () => void;

  constructor(stateManager: StateManager, rebuildCallback: () => void) {
    this.stateManager = stateManager;
    this.rebuildCallback = rebuildCallback;
  }

  create(): Setting {
    const setting = new Setting({
      confirmCallback: () => {
        this.rebuildCallback();
      },
    });

    const settings = this.stateManager.getSettings();

    setting.addItem({
      title: t("weightAttrName", "权重属性名"),
      description: t("weightAttrNameDesc", "文档自定义属性中用于排序的权重字段名，缺失则权重视为 0"),
      direction: "row",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.placeholder = "weight";
        input.value = settings.weightAttrName;
        input.addEventListener("change", async () => {
          await this.stateManager.updateSettings({ weightAttrName: input.value || "weight" });
        });
        return input;
      },
    });

    setting.addItem({
      title: t("defaultExpandLevel", "默认展开层级"),
      description: t("defaultExpandLevelDesc", "0 = 全部折叠，-1 = 全部展开，N = 展开前 N 层"),
      direction: "row",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.type = "number";
        input.placeholder = "-1";
        input.value = String(settings.defaultExpandLevel);
        input.addEventListener("change", async () => {
          const num = parseInt(input.value, 10);
          if (!isNaN(num)) {
            await this.stateManager.updateSettings({ defaultExpandLevel: num });
          }
        });
        return input;
      },
    });

    setting.addItem({
      title: t("sortMethod", "排序方式"),
      description: t("sortMethodDesc", "子节点的排序方式"),
      direction: "row",
      createActionElement: () => {
        const select = document.createElement("select");
        select.className = "b3-select fn__block";
        const options = [
          { value: "name", label: t("sortByName", "按名称排序") },
          { value: "weight", label: t("sortByWeight", "按权重排序") },
          { value: "custom", label: t("sortByCustom", "自定义排序（拖拽）") },
        ];
        for (const opt of options) {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          if (opt.value === settings.sortMethod) option.selected = true;
          select.appendChild(option);
        }
        select.addEventListener("change", async () => {
          await this.stateManager.updateSettings({
            sortMethod: select.value as "name" | "weight" | "custom",
          });
        });
        return select;
      },
    });

    setting.addItem({
      title: t("maxDepth", "最大递归深度"),
      description: t("maxDepthDesc", "构建子树时的最大递归层数，防止无限递归"),
      direction: "row",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.type = "number";
        input.min = "1";
        input.max = "50";
        input.placeholder = "10";
        input.value = String(settings.maxDepth);
        input.addEventListener("change", async () => {
          const num = parseInt(input.value, 10);
          if (!isNaN(num) && num > 0) {
            await this.stateManager.updateSettings({ maxDepth: num });
          }
        });
        return input;
      },
    });

    setting.addItem({
      title: t("maxNodes", "最大节点数"),
      description: t("maxNodesDesc", "虚拟树的最大节点总数，超出则停止构建"),
      direction: "row",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.type = "number";
        input.min = "10";
        input.placeholder = "500";
        input.value = String(settings.maxNodes);
        input.addEventListener("change", async () => {
          const num = parseInt(input.value, 10);
          if (!isNaN(num) && num > 0) {
            await this.stateManager.updateSettings({ maxNodes: num });
          }
        });
        return input;
      },
    });

    setting.addItem({
      title: t("placeholderText", "占位文字"),
      description: t("placeholderTextDesc", "树为空时显示的文字"),
      direction: "row",
      createActionElement: () => {
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.placeholder = DEFAULT_SETTINGS.placeholderText;
        input.value = settings.placeholderText;
        input.addEventListener("change", async () => {
          await this.stateManager.updateSettings({
            placeholderText: input.value || DEFAULT_SETTINGS.placeholderText,
          });
        });
        return input;
      },
    });

    setting.addItem({
      title: t("caseSensitive", "区分大小写"),
      description: t("caseSensitiveDesc", "排序时是否区分大小写"),
      direction: "row",
      createActionElement: () => {
        const label = document.createElement("label");
        label.className = "fn__flex-center";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "b3-switch fn__flex-center";
        input.checked = settings.caseSensitive;
        input.addEventListener("change", async () => {
          await this.stateManager.updateSettings({ caseSensitive: input.checked });
        });
        label.appendChild(input);
        return label;
      },
    });

    setting.addItem({
      title: t("includePhysicalSubtree", "包含物理子树"),
      description: t("includePhysicalSubtreeDesc", "开启后，文档在思源原生层级的物理子文档也会作为虚拟子节点显示"),
      direction: "row",
      createActionElement: () => {
        const label = document.createElement("label");
        label.className = "fn__flex-center";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "b3-switch fn__flex-center";
        input.checked = settings.includePhysicalSubtree;
        input.addEventListener("change", async () => {
          await this.stateManager.updateSettings({ includePhysicalSubtree: input.checked });
        });
        label.appendChild(input);
        return label;
      },
    });

    return setting;
  }
}
