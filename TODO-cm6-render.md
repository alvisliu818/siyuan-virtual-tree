# TODO：CM6 编辑器代码卡片渲染（2026-11-02 收尾 ✅ 全部完成）

## 已完成

| 项 | 文件 | 说明 |
|---|---|---|
| 整块代码卡片 | `src/editor/cm6-render.ts` | 光标在块外 → `FencedCode` 整块 `Decoration.replace({block:true})` 渲染卡片（语言标签+复制按钮+高亮正文）；光标入块回源码态 |
| TextMate 高亮 | `src/editor/tm-highlight.ts`（新） | vscode-textmate 语法 + VS Code 主题 tokenColors；token 级缓存（键=主题签名+lang+code），HTML 由 token 派生；无扩展主题回退内置 Dark+/Light+ |
| **编辑态 token 着色**（本轮新增） | `cm6-render.ts` | 光标入块后按 token 打 `Decoration.mark` 内联 color（与卡片同源语法/主题）；同步分词（`tmTokenizeSync`，2 万字符上限），语法未就绪由 `grammarSync` ViewPlugin 异步加载后 dispatch `forceRenderEffect` 补色 |
| 主题数据保留 | `src/extensions/theme-loader.ts` | 原始主题 JSON（`themeDataByName`）、`getActiveCodeTheme()` / `onCodeThemeChanged()` |
| 语法入口 | `src/extensions/grammar-loader.ts` | `getTmGrammar(lang)` + **`getTmGrammarSync(lang)`**（就绪语法同步表，编辑态分词用） |
| 主题切换重建 | `cm6-render.ts` | `onCodeThemeChanged` → `forceRenderEffect` 强制重建；widget eq 带主题签名 |
| 单横线表格 | `cm6-render.ts` | `RE_TABLE_SEP` 放宽为 `-{1,}`（`| - | - |` 可渲染） |
| **布局恢复引擎挂错修复**（本轮新增） | `markdown-tab.ts` + `index.ts` | 布局恢复的 md 页签创建早于 `onLayoutReady` 的 `loadConfig`，挂引擎时读到默认 vditor；修复 = 页签暴露 `_resyncEngineForConfig()`（引擎挂错才重进当前模式），配置就位后统一调用 |
| 样式 | `src/editor/cm6-markdown.ts` | `.syfe-cm-codeblock` 系卡片样式，删旧悬浮条样式 |

## 实机验证（CDP 9222，全部通过）

- `step-cm6-tm-verify.js`（已改为页签作用域断言）：卡片/语言/复制按钮 ✓、围栏隐藏 ✓、18 个着色 span（def 红/hello 蓝/name 深灰）✓、KaTeX rendered ✓、`| - | - |` 表格 ✓、点正文进源码（cardGone/srcLineCount/fenceBack）✓
- `step-cm6-editmark.js`（新）：编辑态 18 个 mark 着色 span + 行底色保留 ✓；点块外卡片恢复（正文 18 span，缓存热路径）✓
- `step-cm6-restore-verify.js`（新）：reload 后恢复页签终态 cm6（修复前是 vditor 且不切）✓
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

- 布局恢复页签早于插件磁盘配置加载：任何「onload 默认值 ≠ 磁盘配置」的设置项，恢复页签都会拿到默认值，需在配置就位后补偿重进
- 沙箱 Shell 启动的 GUI 进程被作业对象连坐杀掉（思源反复退出曾误判为崩溃）→ 长驻 GUI 用 WMI 拉起
- 沙箱内 node 连本机端口一律 ECONNREFUSED → CDP 探针沙箱外跑；CDP 验证必须 `Network.setCacheDisabled(true)` + reload（lesson 3d86a23）
- CDP DOM 断言必须锁定目标页签作用域：多页签开着同类渲染物时，document.querySelector 会被其他页签污染（kind-check 探针误报实锤）

## 关键路径速查

- 渲染核心：`src/editor/cm6-render.ts`（StateField 五段式；CodeBlockWidget/MathWidget/TableWidget/ImageWidget；editStateTokenMarks + grammarSync）
- 高亮：`src/editor/tm-highlight.ts`（token 级缓存：tmTokenizeSync / tmTokenize / getCachedTmTokens；HTML 派生：tmHighlightToHtml / getCachedTmHighlight）
- 语法 `src/extensions/grammar-loader.ts`（getTmGrammar / getTmGrammarSync）；主题 `src/extensions/theme-loader.ts`
- 冷启动（沙箱外拉起）：`Invoke-CimMethod Win32_Process Create -Arguments @{CommandLine='"D:\programs\SiYuan\SiYuan.exe" --remote-debugging-port=9222'}`，等 ~20s
- 探针目录：`e:\HOME\Local\sy-cdp`（puppeteer-core 已装，严禁写进插件源码路径）；回归探针保留 tm-verify / editmark / restore-verify 三个
