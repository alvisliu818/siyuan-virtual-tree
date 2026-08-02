# 文件编辑器 / File Editor

> 类 VSCode 文件编辑器 + 类 Obsidian 文件管理器,为思源笔记打造,基于 Monaco Editor。

## 功能 / Features

- **文件树侧栏**(Obsidian 式):浏览思源工作空间 `data/` 目录,懒加载展开
- **多标签编辑器**(VSCode 式):Monaco Editor 提供语法高亮、代码折叠、智能提示
- **文件管理**:右键新建文件/文件夹、重命名(F2)、删除、复制路径
- **全局搜索**:`Ctrl+Shift+F` 跨文件内容搜索,点击结果跳转定位
- **保存**:`Ctrl+S` 保存,未保存修改时关闭 Tab 会提示确认
- **主题同步**:Monaco 主题跟随思源明暗模式
- **设置面板**:字体大小、Tab 宽度、自动换行等可配置

## 快捷键 / Shortcuts

| 快捷键 | 功能 |
|--------|------|
| `Ctrl/Cmd + S` | 保存当前文件 |
| `Ctrl/Cmd + Shift + F` | 全局搜索 |
| `F2` | 重命名(文件树中) |

## 安装 / Install

1. 下载 `package.zip`
2. 思源 → 设置 → 集市 → 下载 → 从本地安装,选择解压后的目录
3. 启用插件

## 开发 / Development

```bash
pnpm install
pnpm dev   # 监听构建,输出到项目根目录
```

在思源中通过「本地插件」加载本项目目录即可调试。

```bash
pnpm build  # 生产构建,输出 dist/ 与 package.zip
```

## 说明 / Notes

- 仅支持桌面端
- 文件浏览范围限定在工作空间 `data/` 目录
- 二进制文件(图片等)不在编辑器中打开
- 同一文件在多 Tab 间共享同一编辑模型
