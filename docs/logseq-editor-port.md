# Logseq 编辑器移植策略(AGPL-3.0)

> 状态:2026-11-15 定稿。许可证已变更 MIT → AGPL-3.0-only(502e06a)。
> 本文档记录 Logseq 编辑器源码的评估结论与分阶段移植计划。

## 1. 源码位置

- 本地参考:`E:/HOME/Code/logseq/og`(Logseq OG fork,v1.0.0,含 CODEBASE_OVERVIEW.md)
- 上游:https://github.com/logseq/logseq(AGPL-3.0)

## 2. 编辑器模块地图

| 模块 | 行数 | 内容 | 依赖闭包 |
|---|---|---|---|
| components/editor.cljs | 673 | 编辑器组件(Rum 组件树) | frontend.db/state/handler/components — **全应用闭包** |
| handler/editor.cljs | 3892 | 编辑行为主体(缩进/列表续行/光标管理/标记插入) | 同上 |
| handler/editor/lifecycle.cljs | 49 | 生命周期(did-mount/remount/unmount) | editor-handler(已等价实现 ✓) |
| handler/editor/keyboards.cljs | 40 | Esc 分层处理 | editor-handler(已等价实现 ✓) |

**依赖评估结论**:editor 模块的传递闭包包含 frontend.db(DataScript 图数据库)、
frontend.state(应用状态原子)、frontend.handler.*/components.* —— 即整个 Logseq 前端。
**直接引入源码不可行**(等于内嵌整个 Logseq 应用运行时)。

## 3. 移植策略:行为移植(非代码引入)

AGPL-3.0 已生效,允许引用/派生 Logseq 代码,但技术上仍以「读源码 → 在现有 CM6
基座上重实现」为准(ClojureScript 无法直接进 webpack 插件构建)。

### 已确认等价(无需移植)

- 生命周期模式:outside-click 延迟监听、unmount 保存、Esc 分层(见上表 ✓)
- 按操作类型跳过保存(lifecycle will-unmount 的 undo/redo/paste 跳过逻辑,
  与本插件的单向同步语义一致)

### 移植目标(按优先级,均需 AGPL 署名)

1. **P1 编辑器键位**(keyboards + handler/editor 的键盘部分):
   Tab/Shift+Tab 块缩进、Enter 列表续行、标记快捷输入
2. **P2 光标管理**(handler/editor 的 cursor 部分):
   块进入/退出的光标恢复、滚动跟随(scroll-editor-cursor 同款)
3. **P3 块操作**(handler/editor 的块操作):
   块复制/移动/引用(按需)

## 4. AGPL 合规清单

- [x] LICENSE → AGPL-3.0-only
- [x] package.json license 字段
- [x] README 许可证章节
- [ ] 每个 Logseq 派生文件头标注派生来源(移植时逐文件加)
- [ ] README 补充 AGPL 义务说明(修改版分发需提供源码)

## 5. 里程碑

- M1(本轮):策略文档 + 许可证 ✓
- M2:键盘行为移植(P1)——预计触及 cm6-markdown/cm6-inline 的 keymap
- M3:光标管理移植(P2)
- M4:块操作(P3,按需)
