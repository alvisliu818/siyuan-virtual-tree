# TODO：移动端 UI 优化 + Git 挂载对话框增强（2026-11-12 晚 已收尾）

> 状态：**代码完成、验证通过、已提交并推送、测试库与主库产物均已同步**（哈希一致）。
> 三个提交：`8d7cf26`(#24 Git 挂载) → `c1ecfc1`(#25 编辑界面) → `2396a7e`(#26 设置界面)，
> 基线 `fdebbf1`，已 push 到 `origin/main`。
> 任务 #24 / #25 / #26 全部完成；主库**热重载未触发**（见第四节），需用户手动
> 禁用/启用插件、重启思源或让移动端刷新页面后生效。第六节清理项仍待用户确认。

## 一、提交与部署

| 提交 | 文件 | 内容 |
|---|---|---|
| `8d7cf26` | `src/api/git-repo.ts`、`src/components/git-repo-dialog.ts`、`src/dock/mount-tree-dock.ts`、`src/index.scss`(图标 hunk) | `gitListMyRepos`(GitHub `/user/repos`、Gitee `/v5/user/repos`)；目标列表列文件+目录、挂载位置下拉、我的仓库下拉；`onPicked` 回传 `{isDir, parentUid}`；文件行图标撑满 16px |
| `c1ecfc1` | `src/editor/mobile-editor.ts`、`src/tabs/mobile-open.ts`、`src/index.scss`(.syfe-mopen__* hunk) | 编辑器工具栏、字号/换行/撤销重做、路径单行、底部留白移到 `.cm-content` |
| `2396a7e` | `src/settings/plugin-settings-dialog.ts`、`src/index.scss`(.syfe-set hunk) | 窄屏单列钻取、重复 Dialog 幂等、横向溢出修复 |

- 构建：`env -u NODE_OPTIONS yarn tsc --noEmit` + `yarn webpack --mode production`（**不跑** `yarn build`，它会连带 deploy 到主库）。
- 产物哈希：`index.js` = `b6d9eb1d…d37`，`index.css` = `b8256c1a…ff6`。
- 测试库 `E:\HOME\Local\siyuan-test-ws\data\plugins\siyuan-virtual-tree` 与主库
  `E:\HOME\SiYuan\data\plugins\siyuan-virtual-tree` 的 `index.js`/`index.css` 均与 `dist/` 逐字节一致。
- 主库旧产物备份在 `E:\HOME\Local\sy-cdp\_mainbak\`（`*.fdebbf1`）。

## 二、#25 移动端编辑界面（已完成）

390×844 测试库实机（`E:/HOME/Local/sy-cdp/mob-editor-v2.png`）：

- 无重复标题；工具栏 = 脏态 + ↶ / ↷ / A− / 字号 / A+ / 换行 / 保存，工具靠左、保存靠右，44px tap 目标。
- 路径单行省略、点击展开；字号 14 实时生效、换行开关生效、当前行高亮连续。
- **本轮新增**：底部留白从 `.cm-scroller` 移到 `.cm-content`（`padding: 0 10px 12vh`），
  修掉短文档下半屏行号槽背景戛然而止的灰白分界。实测量得
  `.cm-gutters` / `.cm-scroller` / `.cm-content` 三者同高 691px，留白 101.28px 落在 content 上。

## 三、#26 移动端设置界面（缺陷 A / B 已修，另修新缺陷 C）

**缺陷 A（重复/空壳 Dialog）—— 根因确认并修复**：
不是 mount 异步落空，而是 `open()` 每次都 `new Dialog`，而 `mainEl` 是单例 DOM；
第二次 open 把它从旧 Dialog 搬走，留下空白「虚拟文档树 设置」框。
修复：按 `.syfe-set__mount` 从 `window.siyuan.dialogs` 认领并复用已有 Dialog，
多余空壳 `destroy()`；`destroyCallback` 只在 `self.element.contains(mainEl)` 时才把面板搬回缓存；
mount 落空直接销毁不留空壳；复用时按当前视口重设容器宽高。
实机：连续两次 `p.openSetting()` → 仅 1 个 Dialog、`mount.children=1`、`siyuanDialogs=1`。

**缺陷 B（列表页横向溢出）—— 根因确认并修复**：
思源无全局 `box-sizing:border-box`，`.syfe-set__nav { width:100% } + padding 8px`
在 390px 视口下实测宽 **405px**。
修复：窄屏对设置面板各层加 `box-sizing:border-box / min-width:0 / max-width:100%`。
实机：nav 布局宽 389px、`document.documentElement.scrollWidth=390`。

**缺陷 C（详情页横向滚动条，本轮新发现）**：
说明里的长不可断串（`.git/.svn/.hg`、`node_modules` 等）把 `.syfe-set__rowdesc`
撑到 428px（容器 357px），`.syfe-set__pages` scrollWidth 444 > clientWidth 389，底部出现横向滚动条。
修复：说明/标题加 `overflow-wrap:anywhere; word-break:break-word`，内容区 `overflow-x:hidden`。
实机：详情页溢出元素 **0**，说明文字约 29 字/行，返回条可见、可返回列表。

**目视截图**（本轮重截，均在 `E:/HOME/Local/sy-cdp/`）：
`mob-settings-list-v2.png`（全宽分类列表、无裁切/无空壳）、
`mob-settings-detail-v2.png`（横排说明、无横向滚动条、底部按钮完整）、
`mob-editor-v2.png`（工具栏与连贯行号槽）。

**桌面回归**（1280×800，同一测试库窗口）：
`containerW=900`、`navW=193`、右列 `display:flex`、设置行 `flex-direction:row`、
无 `syfe-set--detail` 类 → media query 只作用于 ≤640px，宽屏布局未变。

## 四、遗留：主库热重载未触发

主库文件已同步，但 `POST /api/petal/setPetalEnabled`（`Authorization: Token <conf.api.token>`）
连续两次返回 `401 Auth failed [header: Authorization]` —— 磁盘 `conf/conf.json` 的
`api.token` 与内核内存 `Conf.Api.Load().Token` 不一致（未探明原因，未反复重试）。
内核源码 `kernel/api/petal.go` 确认该接口 `enabled:true` 会 `PushReloadPlugin` 重载。

**生效方式**（任选一）：主库「设置 → 插件」禁用再启用；重启思源；移动端刷新页面
（插件 JS 由内核按磁盘提供，重载后即新代码）。没有改动任何用户数据，也没有在主库跑 CDP 探针。

## 五、刻意不做 / 范围外

- `github://` **挂载根**改绑分支：需要移除重挂，会丢嵌套挂载与排序，未实现。
  远端历史对话框已能浏览任意分支；插件库绑定已有真正的换分支（含基准重置）。
- 移动端不做所见即所得 Markdown：窄屏富渲染的点击进编辑交互更难用，保持源码态+围栏高亮。

## 六、调试环境备忘（复现必读）

- 测试实例：`SiYuan.exe --workspace="E:\HOME\Local\siyuan-test-ws" --remote-debugging-port=9222`，
  内核端口每次启动随机（本次 55262）；主库 6806 在跑，禁测。
- `tools/cdp-eval.js` 只认 desktop 路径且不能改视口；移动端验证用
  `E:/HOME/Local/sy-cdp/mobile-probe.js`：
  - `boot` 设 390×844 并切 `/stage/build/mobile/`；`editor` / `editor-tools` /
    `settings` / `settings-detail` / `eval "<js>"` / `evalFile <js文件>` / `shot <png>` /
    `reload`（`Page.reload ignoreCache`） / `desktop`（1280×800 回归）。
  - **视口 override 绑定 CDP 会话**：每个步骤开头都会重设，否则 media query 不生效。
  - 中文 JS 走 `evalFile`（本轮新增 `_verify-mobile-ui.js`），避免 CLI 参数编码破坏。
  - **Dialog 有打开动画**：`getBoundingClientRect()` 在动画期读到 0.8 缩放值
    （390→312、900→720），量测要看 `scrollWidth/clientWidth` 或等 700ms 后再取，别误判溢出。
  - `Page.captureScreenshot` 偶发挂起，重跑一次 `shot` 即可。
  - 打开挂载树 dock 后需等 ≥2s；也可直接 `plugin.openFile("<path>")` 打开移动端编辑器
    （本轮 dock 在 reload 后未自动打开，直接走 openFile 更稳）。

## 七、清理遗留（**待用户确认后执行**）

- [ ] 远端测试仓库 `alvisliu818/siyuan-virtual-tree-sync-test`（含 `alt` 分支、`.env` 假密钥）——用户授权创建，待确认删除或保留。
- [ ] 测试库挂载：`repo3`（`mgitrepo01`）、`sy-sync-test`；库条目 `proj`/`demo` 及其 junction。
- [ ] 本机 scratch：`E:/HOME/Local/gitlocal-test/`、`E:/HOME/Local/sy-lib-test/`、`E:/HOME/Local/sy-sync-test/`。
- [ ] 探针脚本 `E:/HOME/Local/sy-cdp/mobile-probe.js` 与 `mob-*.png`（本轮新增 `evalFile/reload/desktop` 步骤，有复用价值，暂留）。
- [ ] **令牌撤销重建仍未确认**：旧 `gho_` OAuth 令牌曾进代理 URL 并被打印；本机副本已清
      （插件配置置空 + `git credential reject` 删凭据），但 GitHub 侧
      Settings → Applications → Authorized OAuth Apps → Git Credential Manager → Revoke 需用户操作。

## 八、验收清单

- [x] 缺陷 A 定位并修复（重复 open 只剩 1 个 Dialog，无空壳）
- [x] 缺陷 B 复测通过（列表页 nav 389px ≤ 视口，页面无横向滚动）
- [x] 缺陷 C（详情页长串溢出）修复，溢出元素 0
- [x] 目视列表页 / 详情页 / 编辑器页（`-v2.png` 三张）
- [x] 桌面端回归：1280px 下宽屏布局不变
- [x] 类型检查 + production 构建 + 测试库部署 + 哈希比对
- [x] 7 文件按功能拆 3 个 commit 并 push
- [x] 主库产物部署 + 哈希比对（热重载见第四节，需手动触发）
- [x] 任务 #25 / #26 完成
- [ ] 第六节清理项与用户确认后执行

## 九、2026-11-12 晚：真机调试 + 移动端编辑器增强（提交 `083c8f0`）

**真机通道**：USB adb(V2171A / 思源 3.8.8 / Chrome 133 / 360×762)。正式包
`WebView.setWebContentsDebuggingEnabled` 只在 debug 包自动开启,但
`JSAndroid.setWebViewDebuggingEnabled(true)` 是 JS 桥方法 —— 往手机插件
`index.js` 末尾临时追加一行调用(122 字节,可还原),重启 App 后
`adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>` 即可接 CDP。
调试完毕已用干净 `dist/index.js` 覆盖还原。
探针 `mobile-probe.js` 增加 `SY_CDP_PORT` / `SY_TARGET_HINT=any` /
`SY_NO_VIEWPORT=1` / `touch` / `reload` / `evalFile` 等步骤,真机专用脚本
`_phone-*.js` 留在 `E:/HOME/Local/sy-cdp/`。

**"从挂载树点远端 md 第一次无法进入编辑"根因**：不是打开链路(真机 trace
touchstart/click 都到达、编辑器 Dialog 与 CM6 均正常),而是思源 Android 在
键盘收起时 `Utils.setWebViewFocusable(webView,false)` + `clearFocus`;其前端
`document touchstart` 只在 `canInput(target)` 命中时重新放行,而 `canInput`
只认 INPUT/TEXTAREA 和 `.protyle-wysiwyg` 内的 contenteditable —— CM6 的
`.cm-content` 永远不命中。于是 DOM 有焦点、系统输入法不弹。决定性实验:
冷启动触摸内容区后 `active=cm-content / cm-focused=true` 但
`mInputShown=false`;调用 `window.JSAndroid.setWebViewFocusable(true)` 再触摸
→ `mInputShown=true`。"第一次"是因为先点过思源自带输入框就会把 WebView 放开。

**本轮需求与实现**（`083c8f0`）：
- 工具栏 40×44 → 28×30,栏高 61 → 35;`.b3-dialog__content` 的
  `padding:16px 24px` 归零、`.cm-content` 左右 10px / 底部 12vh → 0 / 4vh、
  行号槽收紧;真机编辑区宽 310 → 358px。
- 保留 `⇤`(Shift+Tab 反缩进),新增 **Shift 粘滞键 + Tab 键**(Shift 亮起时
  Tab 走反缩进,用完复位)与「折行」按钮;8 个按钮 `scrollWidth=clientWidth=358`,
  360px 屏无横向滚动。
- 点击行号复制行链接(桌面 `buildFileRefMd` 同格式);虚拟路径绕开
  `toFileLink`,否则会生成 `file:///gitee://...` 坏链接。
- 焦点规则:点编辑区 → 放行 WebView + 聚焦 CM6;点其它区域(行号槽/工具栏/
  路径条)→ blur 退出编辑。工具按钮不再自动重新聚焦。

**真机验收**：点内容区 `active=cm-content` / 键盘弹;点行号槽复制
`[note.md:6](<gitee://alvisliu0/kb@main/note.md?line=6>)` 并收键盘、
`cmFocused=false`;点路径条失焦;Shift 点亮→Tab 反缩进→复位;折行切换生效。
`tsc` + production 构建通过;dist / 测试库 / 主库 / 手机四处产物一致
(`index.js` `28687ffa…`,`index.css` `9df67b36…`)。

## 十、2026-11-12 晚（续）：行号链接跳转 + 挂载文档打开（提交 `0975695`）

**问题 A：复制的远端文件行号链接无法点击跳转打开文件**
- 双重原因：①`registerDocOpenTakeover` 只在桌面 `onload()` 注册,
  移动端 `onloadMobile()` 没注册 → 文档内链接点击根本不发到插件;
  ②`takeOver` 的 `toAbsolutePath` 只认 `assets/`、file://、盘符/UNC、
  POSIX 绝对路径,`gitee://` 等虚拟路径返回 null 被放行给思源当外部协议。
- 修复：`onloadMobile()` 同样注册接管;虚拟路径(`isRemotePath`,即
  github:// / gitee:// / baidu://)**无条件接管**(不受 `docOpenTakeover=off`
  与扩展名白名单限制,思源对它们没有有意义的默认行为),直接用原路径
  `openFileTab` → 移动端 `openFileOnMobile`。
- 顺带补齐定位：`setPendingRef` 已投递 `line`,但移动端编辑器不消费;
  现在 `openEditorDialog` 创建 CM6 后 `consumePendingRef(path)` →
  `handle.revealLine(line)`(selection + `EditorView.scrollIntoView`)。
- 注：思源 `resolveOpenLinkEvent` 对任何非空、非 asset 的 href 都会生成
  `open-link` 事件(不限制 scheme),只要插件订阅了就能拿到。

**问题 B：移动端点击挂载树里的思源文档无反应**
- 根因：`openSiyuanDoc(id, app)` 走 `openTab({app,doc:{id}})`,而移动端
  `openTab` 是空实现且**正常 resolve 不 reject** → 既不打开、也触发不了
  `openDocByProtocol` 兜底,静默失败。
- 修复：`isMobileFrontend()` 时改调 `window.openFileByURL("siyuan://blocks/<id>")`
  (思源移动端官方入口,`parseSiYuanUriInfo` → `openMobileFileById`),
  失败才回退 `<a href="siyuan://blocks/...">`。

**真机验收**（重新注入调试片段 → 重启 → `adb forward tcp:9223`）：
- 模拟 `open-link` 事件 `gitee://alvisliu0/kb@main/note.md?line=6` →
  `emit=false`(被插件取消)、打开 note.md 编辑器、`.cm-activeLineGutter=6`。
- 点击挂载树「大模型 → 01-python」→ 调用
  `openFileByURL("siyuan://blocks/20260901123752-01h1d9w")`,
  `protyle-wysiwyg` 出现、标题变为「01-python」,文档真实打开。
- `tsc` + production 构建通过;产物 `index.js` `5341ba64…` /
  `index.css` `9df67b36…`,dist / 测试库 / 主库 / 手机四处一致;
  `0975695` 已 push,手机调试注入已还原。
