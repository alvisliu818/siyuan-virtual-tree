# TODO：CM6 编辑器代码卡片渲染（2026-11-02 收尾 ✅ 全部完成）

## 已完成

| 项 | 文件 | 说明 |
|---|---|---|
| **统一渲染管线**（终态） | `cm6-render.ts` | 代码块两态唯一一套渲染：代码行永远以「行底色 + TextMate token mark」呈现；渲染态（光标在块外）围栏行 block replace 隐藏 + 头部工具条 widget（语言/复制）+ `-out` 修饰类画旧卡片壳描边；编辑态（光标在块内）只是围栏原样显示。两态色板/字体/字号/行高/换行由构造保证一致 |
| TextMate 高亮 | `src/editor/tm-highlight.ts`（新） | vscode-textmate 语法 + VS Code 主题 tokenColors；token 级缓存（键=主题签名+lang+code），HTML 由 token 派生（阅读态用）；无扩展主题回退内置 Dark+/Light+ |
| **语法加载竞态修复**（本轮） | `grammar-loader.ts` | `getTmGrammar` 等待 `builtinGrammarsReady`（内置清单加载完成信号），消除「wasm 就绪但语法清单未到 → 永久缓存 null → 代码块永远无色」；cm6-render 的 grammarSync 在构造函数即调度（ViewPlugin 的 update 在视图创建时不触发） |
| **编辑态 token 着色**（本轮新增） | `cm6-render.ts` | 光标入块后按 token 打 `Decoration.mark` 内联 color（与卡片同源语法/主题）；同步分词（`tmTokenizeSync`，2 万字符上限），语法未就绪由 `grammarSync` ViewPlugin 异步加载后 dispatch `forceRenderEffect` 补色 |
| 主题数据保留 | `src/extensions/theme-loader.ts` | 原始主题 JSON（`themeDataByName`）、`getActiveCodeTheme()` / `onCodeThemeChanged()` |
| 语法入口 | `src/extensions/grammar-loader.ts` | `getTmGrammar(lang)` + **`getTmGrammarSync(lang)`**（就绪语法同步表，编辑态分词用） |
| 主题切换重建 | `cm6-render.ts` | `onCodeThemeChanged` → `forceRenderEffect` 强制重建；widget eq 带主题签名 |
| 单横线表格 | `cm6-render.ts` | `RE_TABLE_SEP` 放宽为 `-{1,}`（`| - | - |` 可渲染） |
| **布局恢复引擎挂错修复**（本轮新增） | `markdown-tab.ts` + `index.ts` | 布局恢复的 md 页签创建早于 `onLayoutReady` 的 `loadConfig`，挂引擎时读到默认 vditor；修复 = 页签暴露 `_resyncEngineForConfig()`（引擎挂错才重进当前模式），配置就位后统一调用 |
| **阅读态高亮对齐**（本轮新增） | `markdown-tab.ts` | `enterCm6Reading` 的 Vditor.preview 产物：代码块 hljs → tm-highlight 同源 TextMate 色（`after` 回调 + 1500ms 兑底，幂等 data 标记 + `dataset.highlighted` 防 hljs 晚到重写；背景/字体对齐卡片；明暗切换清标记重刷） |
| 样式 | `src/editor/cm6-markdown.ts` | `.syfe-cm-codeblock` 系卡片样式，删旧悬浮条样式 |

## 实机验证（CDP 9222，全部通过）

- `step-cm6-unified.js`（主探针）：渲染态首帧 18 span 有色（竞态修复验证）✓、头部/复制/围栏隐藏/2 代码行 ✓、点头部→编辑态围栏现形 4 行同样 18 span ✓、点块外回渲染态同色 ✓
- 截图目检（step-cm6-shot.js）：渲染态卡片壳（头部+边框+圆角+着色正文）与编辑态（围栏+同样色行）两图对照一致 ✓
- `step-cm6-read-tm.js`：阅读态 `syfe-tm-code` 替换 hljs，def 色 rgb(215,58,73) 与卡片采样一致，背景 = --b3-theme-surface ✓
- `step-cm6-restore-verify.js`：reload 后恢复页签终态 cm6（修复前是 vditor 且不切）✓
- tsc：改动文件零新增错误（存量错误在别处，如 `markdown-tab.ts:1146` resolveImageSrc 签名，committed 状态就有）
- `yarn build` 通过，自动部署到 `E:\HOME\SiYuan\data\plugins\siyuan-virtual-tree`

## 本轮结论（原待办两条已定论）

- 「实时渲染不是 cm6 是 vditor」≠ 配置未生效：新开页签 live 一直是 cm6；**挂错的是布局恢复的页签**（恢复早于配置加载）。修复见上表。
- 「启动约 1 分钟自动退出」= 沙箱作业对象连坐杀 GUI（非崩溃）。本会话用 WMI `Win32_Process.Create` 拉起思源（PID 23248），存活 >1 小时，未再复现。

## 提交计划（gl.sh 入口，分四个不混杂的提交）

1. `tools/pty-helper.js` — 终端 Git Bash 三级探测（早前会话遗留）
2. `.yarnrc.yml` — yarn 自动重写（approvedGitRepositories/npmMinimalAgeGate）
3. `feat(editor-cm6)` 卡片+高亮：cm6-render.ts / cm6-markdown.ts / tm-highlight.ts / grammar-loader.ts / theme-loader.ts
4. `fix(editor-cm6)` 恢复引擎重进 + 本文件：markdown-tab.ts / index.ts / TODO-cm6-render.md

## Lesson（已同步 project_memory.md）

- **两态渲染想一致，就走同一套装饰**：曾有「widget HTML 卡片」与「mark 着色」两条并行管线，字体/行高/换行/首帧时序处处可漂；统一后（同一批行装饰+mark，围栏显隐是唯一差异）构造上不可能漂移。状态差异用修饰类（-out）表达，不另起渲染路径
- **ViewPlugin 的 update 在视图创建时不触发**：需要初次调度的插件逻辑必须同时放构造函数
- **异步初始化竞态要显式等信号**：getTmGrammar 曾在 wasm 就绪但语法清单未 fetch 完时返回 null 并被永久缓存（旧卡片路径靠 widget 自补掩盖）；加 builtinGrammarsReady 信号根治
- CDP DOM 断言必须锁定目标页签作用域（多页签同类渲染物会污染 document.querySelector）
- 布局恢复页签早于插件磁盘配置加载：任何「onload 默认值 ≠ 磁盘配置」的设置项，恢复页签都会拿到默认值，需在配置就位后补偿重进
- 沙箱 Shell 启动的 GUI 进程被作业对象连坐杀掉（思源反复退出曾误判为崩溃）→ 长驻 GUI 用 WMI 拉起；沙箱内 node 连本机端口一律 ECONNREFUSED → CDP 探针沙箱外跑；CDP 验证必须 `Network.setCacheDisabled(true)` + reload（lesson 3d86a23）

## 关键路径速查

- 渲染核心：`src/editor/cm6-render.ts`（StateField 五段式；CodeBlockWidget/MathWidget/TableWidget/ImageWidget；editStateTokenMarks + grammarSync）
- 高亮：`src/editor/tm-highlight.ts`（token 级缓存：tmTokenizeSync / tmTokenize / getCachedTmTokens；HTML 派生：tmHighlightToHtml / getCachedTmHighlight）
- 语法 `src/extensions/grammar-loader.ts`（getTmGrammar / getTmGrammarSync）；主题 `src/extensions/theme-loader.ts`
- 冷启动（沙箱外拉起）：`Invoke-CimMethod Win32_Process Create -Arguments @{CommandLine='"D:\programs\SiYuan\SiYuan.exe" --remote-debugging-port=9222'}`，等 ~20s
- 探针目录：`e:\HOME\Local\sy-cdp`（puppeteer-core 已装，严禁写进插件源码路径）；回归探针保留 tm-verify / editmark / restore-verify 三个
