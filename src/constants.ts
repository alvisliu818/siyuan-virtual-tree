/** Dock 类型标识 */
export const DOCK_TYPE = "virtual-tree-dock";

/** 持久化存储名 */
export const STORAGE_NAME = "virtual-tree-data";

/** 命令 langKey（同时作为 i18n 字段名） */
export const COMMAND_ADD_CURRENT_AS_ROOT = "addCurrentAsRoot";
export const COMMAND_LOCATE_CURRENT_DOC = "locateCurrentDoc";

/** ws 事件触发 rebuild 的防抖时间（ms） */
export const WS_REBUILD_DEBOUNCE_MS = 1000;

/** rebuild 调度延迟（ms），用于合并短时间内多次调用 */
export const REBUILD_SCHED_MS = 50;

/** 定位高亮动画时长（ms） */
export const LOCATE_FLASH_MS = 2000;
