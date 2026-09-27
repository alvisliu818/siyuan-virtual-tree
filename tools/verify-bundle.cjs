const fs = require("fs");
let s = fs.readFileSync(process.argv[2], "utf8");
// esbuild 把非 ASCII 转义为 \uXXXX(大写),还原后再匹配
s = s.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const checks = [
  "复制链接", "链接已复制", "复制路径", "空目录", "重命名",
  "复制 Markdown 链接", "Markdown 链接已复制",
  // 标签功能
  "标签", "新建标签", "标签管理", "全部已打标签", "没有符合标签的条目", "重要",
  "file:///", "execCommand", "%3A", "图标缺失", "BaiduSyncdisk",
  // 斜杆命令:插入文件链接
  "插入文件链接", "syfeInsertFileLink", "syfe:backlink-refresh", "搜索文件",
  // 原生链接节点(思源 genAssetHTML 同款 <span data-type="a" data-href>),保证存为 markdown [label](url)
  "data-href",
  // 多 tab 分栏打开
  "分栏打开", "在右侧分栏打开", "在下方分栏打开",
  // 最近打开的文件(函数名被 esbuild 混淆,用 JS 中的字符串字面量校验)
  "最近打开", "syfe-picker__recent-item", "syfe-picker__recent-head",
  // 侧边栏「最近使用」面板(文件 + 思源文档)
  "最近使用", "syfe-recent-dock", "syfe:recents-changed", "从最近使用中移除", "暂无最近使用记录",
  // 思源文档最近使用:switch-protyle 监听 + 文档菜单项
  "switch-protyle", "打开文档", "复制思源链接", "siyuan://blocks/",
  // fileUrlToPath 是函数名会被 esbuild 混淆,改用菜单文案与事件名字符串
  "在文件夹树中定位", "open-menu-link", "在文件资源管理器中显示",
  // 音视频播放器
  "syfe-media", "siyuan-file-editor-media", "音视频播放器", "iconVideo", "iconRecord",
  "加载中...(大文件可能需要几秒)", "无法播放该文件,浏览器不支持此编码格式",
  "用系统默认应用打开", "画中画", "已复制文件链接", "循环播放", "播放倍速",
  // 新标签页(接管思源顶部「+」)
  "siyuan-file-editor-start", "syfe:start-page-changed", "syfe-start__body",
  "新标签页", "固定到新标签页", "新建思源文档", "正在建立文件索引",
  "所有分区都已隐藏", "接管顶部", "收藏", "从最近使用中移除",
  // 侧边栏「标签」面板(按标签聚合,文件夹就地逐级展开)
  "siyuan-file-editor-tag-dock", "syfe:tags-changed", "syfe-tagdock__row",
  "从此标签中移除", "该标签下暂无条目", "syfe-tagdock__crumb-back", "(空文件夹)",
  // 标签树形展开 + 「聚焦」按钮(点聚焦才进入条目列表)
  "syfe-tagdock__focus", "syfe-tagdock__row--selected", "聚焦:整页列出该标签下的条目", "__any__",
  // 点标签行就地展开其条目(箭头才是展开子标签)
  "syfe-tagdock__toggle--arrow", "syfe-tagdock__row--open", "点击展开/收起该标签的文件与文件夹",
  // Markdown 三态编辑器(对齐 Obsidian:实时预览 / 源码 / 阅读)
  "syfe-md__content--reading", "实时预览", "阅读", "syfe-md__modebtn",
];
let ok = 0;
for (const c of checks) {
  const found = s.includes(c);
  if (found) ok++;
  console.log((found ? "FOUND  " : "MISSING") + "  " + c);
}
console.log("\n" + ok + "/" + checks.length);
