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
- [~] 每个 Logseq 派生文件头标注派生来源:`src/editor/cm6-block-editor.ts` 已标
     两处(事件隔离 ← `extensions/code.cljs`;选项注入 ← `:editor/extra-codemirror-options`),
     `src/editor/cm6-calc.ts` 已标三处来源(calc.cljc / grammar/calc.bnf / code.cljs);
     其余早期移植/派生文件待补,做 M3/M4 时逐文件加
- [x] README 补充 AGPL 义务说明(修改版分发需提供对应源码、§13 网络服务同样适用,`e0d3ea6`)

## 5. 里程碑

- M1(本轮):策略文档 + 许可证 ✓
- M2:键盘行为移植(P1)——预计触及 cm6-markdown/cm6-inline 的 keymap
- M3:光标管理移植(P2)
- M4:块操作(P3,按需)

### 5.1 代码块移植(出本计划主线,2026-11-15 单独推进,详见 project_memory.md)

> 结论:og 代码块为 CM5 单编辑态 + calc 块,闭包是整个 CS 应用,功能不比本插件
> 强,**不整体移植**;核心思路本插件已吸收,事件隔离已落地。

- 已交付(测试库验证,主库未动):
  - `e3860af` 参考 `extensions/code.cljs` 补强内嵌编辑器事件隔离(mousedown/
    touchstart stopPropagation、Cmd/Ctrl+[ ] 拦截),文件头已标 AGPL 来源
  - `b567f91` 修代码块编辑三处真 bug(写回越界/装饰崩溃/复制失效)
  - `dc42156` 修未闭合围栏吞文档导致输入错位
  - `e0d3ea6` 补齐两条低成本特性:
    - **`:editor/extra-codemirror-options` 配置注入** → `markdown.cm6CodeBlockExtraOptions`
      (JSON 字符串),按白名单映射成 CM6 facet(lineWrapping / lineNumbers /
      tabSize / indentUnit / highlightActiveLine / highlightActiveLineGutter /
      readOnly / allowMultipleSelections);非法 JSON 回落默认,未知键忽略
    - **Enter 自动补闭合围栏 + 光标进块内编辑器** → `markdown.cm6AutoCloseFence`
      (默认开,Obsidian 同款)。配对判据与 `fencedCodeInfos` 同源;卡片模式下
      原子范围会把块内光标挤到边界,故命中后直接 `beginCodeEdit` 进内嵌 CM6
    - 同笔提交补齐 README 的 AGPL 义务说明
  - `2537897` **calc 计算块**(`extensions/calc.cljc` 235 行 +
    `grammar/calc.bnf`)—— 最后一项 Logseq 代码块特性,至此「移植 logseq
    代码块」全部收尾:
    - instaparse 不能进 webpack,改用**递归下降解析器**重写 calc.bnf;
      bignumber.js 9.3.1 作为新运行依赖引入(与 Logseq 同款,保证十进制精度)
    - 支持四则 / 幂 / 阶乘 / 百分数 / 带分数 / 0x 0o 0b / 科学计数、
      变量赋值、PI/E/last、11 个数学函数、`#` 注释、
      `:format fix|sci|normal|frac|imp` 与 `:hex/:oct/:bin/:dec` 指令
    - 卡片 = 源码 + 右对齐逐行结果;编辑态结果常驻并逐键刷新
      (Logseq 的 CM5 change → eval-lines 等价);失败行显示 `?`
    - 同笔提交补内嵌 CM6 编辑手感:Tab/Shift-Tab 缩进、括号引号自动闭合、
      配对高亮、输入自动缩进、4 空格缩进单元
- 后续修(用户截图反馈「进出编辑主题渲染不一样 / 编辑时行号重叠」):
  - **配色**:阅读态是 Monaco TextMate 分词、编辑态原是 Lezer 分词 + 自建
    scope→tag 映射,同一 token 分类不同(python `print`:TextMate 蓝
    `#005cc5` / Lezer 红 `#d73a49`)。移除内嵌 CM6 的 `syntaxHighlighting`,
    改由 `colorizeField` 把**同一份 colorize HTML** 解析成带内联色的 mark
    装饰;子级 CM6 class 色会盖掉父级内联色,所以必须单一真源。
  - **行号**:补画列原按 `height:100%` flex 均分,编辑态卡片被压矮后行号
    仍按宿主行高撑出卡片、压到后续行号上。现钉成 `行数 ×
    view.defaultLineHeight` 并给卡片同值 `minHeight`;内嵌行号槽左内边距
    归零与阅读态对齐;`toDOM` 早于宿主 `.cm-gutters` 时改为 rAF 重试挂载,
    修掉阅读态补画行号偶发整段消失。
- **未做(刻意,非遗漏)**:blur 自动退出编辑态 —— 本 Electron 下极易误退出
  (点结果列/复制按钮都会触发),按前期调研结论保持 Esc / 点击卡外退出。
- 广义移植主线 M2(键盘)/M3(光标管理)/M4(块操作)本轮未动;按用户此前
  排序,**M3 优先级高于代码块**,代码块收尾后应先与用户确认再排期
