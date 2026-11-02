# TODO：CM6 代码块 Monaco 化（2026-11-02 ✅ 全部完成并部署验证）

> 诉求：「代码块使用 Monaco 编辑和 Monaco 渲染，全局单一 Monaco 实例」。
> 参考 my-logseq 模块的代码块实现（colorize 静态渲染 + 单例按需挂载，两态同源）。
> 历史：曾用 tm-highlight（vscode-textmate 自分词）做统一管线，本轮整体退役——
> 高亮完全交给 Monaco（colorize + 单例编辑器），不再维护第二条分词路径。

## 终态架构

- **渲染态（阅读态同源）**：`monaco.editor.colorize()` 用当前全局主题产出 mtk* HTML；
  colorize 缓存键 = 主题名+lang+code，主题切换统一走 `setGlobalCodeTheme`（记账+清缓存+通知）。
- **编辑态**：全局唯一 Monaco 编辑器实例（window 注册表 `__syfeMonacoBlock`），
  点击卡片由 `editMounter`（ViewPlugin）安置进真实视图 DOM 的宿主容器；
  Esc / 点击块外退出 → 归还 stash → 卡片 colorize 重渲。
- **内容同步**：Monaco `onDidChangeModelContent` → 单事务写回 cm6 文档（块 key 定位）；
  保存前 `flushActiveBlock()` 落最终值；model 强制 LF（monaco 在 Windows 默认 CRLF 会污染行尾）。
- **主题切换**：`setGlobalCodeTheme` → `onMonacoThemeChanged` 订阅 → `forceRenderEffect` 重建卡片。

## monaco-block.ts 三条实测铁律（违反即翻车）

1. **全部状态挂 window 注册表**：webpack 分块会把模块求值两份，模块级变量各自为政
   会出现两个编辑器实例、主题记账错乱（totalMonaco=2 且焦点落在 stash 那份的实锤）。
2. **挂载/重绑绝不在 widget.toDOM 里做**：CM6 重建/测量会克隆销毁 widget DOM；
   编辑器只能由 ViewPlugin 在真实视图 DOM 上安置，toDOM 永远只渲染壳。
   同块重建后由 `remountBlockEditor` 搬 DOM + 重绑（测量克隆 `.cm-measurement` 已过滤）。
3. **monaco 0.50 运行时 `getDomNode()` 返回 undefined**（类型却声明存在）：
   创建时自己 `querySelector(":scope > .monaco-editor")` 抓根节点搬运 DOM。
   旧 widget 销毁还会把单例搬回 stash —— destroy 延迟一拍检查继任（同 key 已重挂则跳过）。

## 文件清单

| 文件 | 说明 |
|---|---|
| `src/editor/monaco-block.ts`（新） | 单例基础设施：stash/挂载/重绑/退出、setGlobalCodeTheme、colorizeCached（剥尾 `<br/>`，两态盒子高度一致） |
| `src/editor/cm6-render.ts` | CodeBlockWidget 纯壳渲染（头部工具条 + colorize 正文 + editorhost）；editMounter 声明式安置；主题/点击/同步/退出全链 |
| `src/editor/cm6-markdown.ts` | `.syfe-cm-codeblock` 卡片样式 + is-editing 显隐规则 |
| `src/editor/monaco.ts` | applyTheme 走统一入口 setGlobalCodeTheme |
| `src/extensions/theme-loader.ts` | safeSetTheme 走统一入口；notifyCodeThemeChanged 供思源配色回退路径 |
| `src/extensions/grammar-loader.ts` | 保留 TextMate→Monaco tokenizer 注册（代码文件与 colorize 共用）；`resolveFenceLanguageId`；删除 getTmGrammar(Sync) 及 readyGrammars/grammarInstanceCache/builtinGrammarsReady 死代码 |
| `src/tabs/markdown-tab.ts` | 阅读态代码块 colorize 替换 hljs（restyleReadingCodeBlocks）+ 保存 flush |
| `src/editor/tm-highlight.ts` | **已删除**（.trash 备份）：Markdown 侧自分词管线整体退役 |

## 实机验证（CDP 9222 全部通过）

- `step-cm6-m2v.js`（回归主探针）：挂载（activeBlock.key 命中、单例进卡）→ 模型 API
  编辑同步回 cm6 文档 ✓ → 点击外部退出卸载、卡片 colorize 重渲新内容（mtk 着色）✓ →
  保存落盘 ✓（monacoCount=2 为 cm6 测量克隆静态副本，无害）
- `step-cm6-m1.js`：卡片 colorize 渲染 + 运行时切主题 26→24 span 换色、还原逐字节一致 ✓
- bundle 证据：tmTokenizeSync/getTmGrammar(Sync)/registry-init 日志/死 CSS 全部消失；
  __syfeMonacoBlock 注册表、br 剥离、editorhost 钩子在
- tsc 27 个错误全部为基线存量，改动文件零新增

## 提交计划（gl.sh 入口）

1. `feat(editor-cm6)` 代码块 Monaco 单例：monaco-block.ts（新）/ cm6-render.ts / cm6-markdown.ts / monaco.ts / theme-loader.ts / grammar-loader.ts / markdown-tab.ts
2. `chore` 删 tm-highlight.ts（死代码）+ tools 临时文件清理
3. 本文件 + project_memory.md 记忆更新
