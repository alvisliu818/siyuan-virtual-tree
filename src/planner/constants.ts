// 插件内的类型标识与常量。
//
// 历史注:并入宿主(siyuan-virtual-tree)前本模块是独立插件,为避免与宿主 dock/tab 同名
// 冲突,type 用了 siyuan-planner- 前缀。并入后沿用原名 —— 独立版插件可能还装着,
// 改名会让它的旧 dock 记录漂移成宿主的僵尸槽位(宿主 pruneStalePluginDocks 按
// "当前代码还注不注册这个 type" 判定,legacyNames 已含 siyuan-planner)。
export const PLANNER_TAB_TYPE = "siyuan-planner-tab";
export const PLANNER_DOCK_TYPE = "siyuan-planner-dock";

/** 数据存储文件名(落在 data/storage/petal/<插件名>/) */
export const STORAGE_KEY = "planner.json";

/**
 * 旧存档来源:独立插件 siyuan-planner 的 petal 目录。
 * 迁移链:虚拟文档树(最早) → siyuan-planner(独立期) → 虚拟文档树(并入后)。
 * 并入后的存储 = 宿主 petal 目录下的 planner.json;独立版的目录才是"旧数据",
 * 首次启动(宿主侧还是空档)时读一次迁过来。
 */
export const LEGACY_PLUGIN_NAME = "siyuan-planner";
