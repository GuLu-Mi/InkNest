# 墨栖 InkNest

安静阅读，自在书写。

InkNest 是本地 Markdown 阅读与源码编辑器。文档保留在用户选择的位置，不需要账号或服务器，原始 Markdown 始终是保存来源。

## 功能

- 新建 Markdown 文档、多标签阅读与源码编辑，每个文档独立保留选区、撤销和阅读位置。
- 标题目录、正文与源码查找、编辑模式下的查找替换。
- Mermaid 图表、数学公式、代码高亮与复制、脚注、提示块及折叠内容，详见[Markdown 兼容性](docs/markdown.md)。
- 自动保存、外部修改冲突处理、恢复草稿、本地历史和可撤销的历史还原。
- 浅色与深色主题、全屏阅读演示、本地图片缩放与旋转、链接打开。
- UTF-8 BOM、LF/CRLF 和末尾换行保留；HTML 预览不参与文件保存。

项目仍处于开发中，最新版本及安装包见 [Releases](https://github.com/GuLu-Mi/InkNest/releases/latest)。目标平台为 Windows 11 x64 和 macOS 14 及以上 Apple Silicon Mac；兼容性、功能限制和已知问题见[已知限制](docs/known-issues.md)。

## Markdown 展示

[InkNest Markdown 完整展示](docs/examples/markdown-showcase.md) 包含基础排版、表格、任务列表、链接、四种本地图片、代码高亮、Mermaid 图表、数学公式及扩展语法。

可在 GitHub 浏览示例源码与页面。GitHub 使用自身的渲染规则，配色、部分扩展语法和交互与应用不同。查看 InkNest 的实际效果时，下载或克隆仓库，用应用打开 `docs/examples/markdown-showcase.md`；保留同目录中的辅助文档与 `assets` 图片目录。

## 从源码运行

需要 Node.js **24.21.0** 和 npm **11.12.1**。版本由 `.nvmrc`、`package.json` 和锁文件固定；首次安装需要下载 Electron 和平台原生依赖。

```sh
nvm use
npm ci --include=optional --no-audit
npm run dev
```

## 基本操作

1. 点击“打开文档”选择 `.md` 或 `.markdown` 文件，文件默认以阅读模式打开；点击首页“新建文档”或 `Cmd/Ctrl+N` 开始空白编辑。标签栏“+”返回首页，可选择打开或新建，已有文档继续保留。
2. 点击“编辑”修改 Markdown 源码，点击“预览”返回阅读。自动保存默认开启，也可使用 `Cmd/Ctrl+S` 手动保存。
3. 使用 `Cmd/Ctrl+F` 查找；编辑模式下可切换到“替换”页签。
4. 通过“历史版本”查看、导出或还原历史；通过文件菜单中的“本地备份…”管理恢复草稿。

普通文字链接使用 `Command/Ctrl+单击` 打开，本地图片可直接单击查看。单窗口最多打开 20 个文档；≤2MiB 的支持编码文件可编辑，>2–10MiB 文件只读，>10MiB 文件拒绝打开。

图片查看器支持双指捏合连续缩放，也可使用 macOS `Command` / Windows `Ctrl` + 滚轮缩放；普通滚轮保持滚动。点击旋转按钮可顺时针旋转 90°，不修改原始图片；切图或关闭后重开恢复初始方向。

首页左侧“新建文档”、右侧“打开文档”。未命名文档只备份恢复草稿；编辑模式点击当前文档工具栏的“保存…”或使用 `Cmd/Ctrl+S` 选择文件位置后开始正式自动保存，也可保存空文件。保存按钮及另存为/关闭下拉仅在编辑时显示，阅读和预览仍可使用文件菜单、快捷键和标签关闭按钮。状态在底部显示。关闭非空未命名稿可保存、确认不保存或取消。

自动保存、恢复草稿和本地历史是三种独立机制。历史会合并自动保存记录并受容量限制，不能找回每一个中间输入状态。

## 开发与文档

- [开发与构建](docs/development.md)：环境、检查命令、本地打包和 GitHub Actions 打包。
- [开发协作](CONTRIBUTING.md)：分支、提交和变更要求。
- [文档索引](docs/README.md)：产品需求、交互、架构、接口、安全和测试。
- [版本变化](CHANGELOG.md)：面向使用者的版本说明。
- [已知限制](docs/known-issues.md)：功能、兼容性和可靠性边界。

## 许可

项目目前为 `UNLICENSED`，未选择开源许可证。第三方组件及随仓库保留的材料见[第三方声明](THIRD_PARTY_NOTICES.md)。
