# 依赖与工具链登记

关联 REQ-002/004/005/006/010/011/021/025/030、NFR-002–006/008。

以下为 package.json 和锁文件指定的版本。许可字段来自包元数据，完整传递依赖与 integrity 以 package-lock.json 为准；分发时保留相应 LICENSE/NOTICE。

## 工具链

- Node.js **24.21.0**：.nvmrc 与 engines 固定。
- npm **11.12.1**：packageManager 与 engines 固定。
- Electron **44.4.1**：应用运行时。开发 Node 与 Electron 内嵌 Node 分别管理。


## 应用依赖

| 包 | 精确版本 | 包声明许可 | 用途 |
| --- | --- | --- | --- |
| `@codemirror/commands` | 6.11.1 | MIT | 键位与撤销历史 |
| `@codemirror/lang-markdown` | 6.5.2 | MIT | 编辑语法支持 |
| `@codemirror/search` | 6.7.2 | MIT | 字面 SearchCursor |
| `@codemirror/state` | 6.7.5 | MIT | 唯一可写编辑状态 |
| `@codemirror/view` | 6.43.12 | MIT | 编辑视图与 CSP nonce |
| `dompurify` | 3.4.15 | (MPL-2.0 OR Apache-2.0) | 预览净化 |
| `markdown-it` | 15.0.2 | MIT | Markdown 解析 |
| `highlight.js` | 11.12.0 | BSD-3-Clause | 预览代码高亮 |
| `katex` | 0.18.7 | MIT | 离线公式 MathML |
| `mermaid` | 12.0.0 | MIT | 离线图表 SVG |
| `markdown-it-deflist` | 4.0.0 | MIT | 定义列表 |
| `markdown-it-emoji` | 3.1.0 | MIT | Emoji 短码 |
| `markdown-it-footnote` | 4.0.0 | MIT | 脚注与返回 |
| `markdown-it-mark` | 4.0.0 | MIT | 标记 |
| `markdown-it-sub` | 2.0.0 | MIT | 下标 |
| `markdown-it-sup` | 2.0.0 | MIT | 上标 |
| `markdown-it-task-lists` | 2.1.1 | ISC | 只读任务列表 |
| `markdown-it-texmath` | 1.0.0 | MIT | 公式块分隔符解析 |
| `sharp` | 0.35.4 | Apache-2.0 | 图片元数据与目标平台原生库 |
| `vue` | 3.5.42 | MIT | 界面 |
| `write-file-atomic` | 8.0.0 | ISC | 同目录原子替换 |

## 开发与验证依赖

| 包 | 精确版本 | 包声明许可 | 用途 |
| --- | --- | --- | --- |
| `@electron/asar` | 3.4.1 | MIT | 包内容核对 |
| `@eslint/js` | 10.0.1 | MIT | JS 规则 |
| `@playwright/test` | 1.63.0 | Apache-2.0 | Electron E2E |
| `@types/node` | 24.13.5 | MIT | Node 类型 |
| `@types/write-file-atomic` | 4.0.3 | MIT | 写入库类型 |
| `@vitejs/plugin-vue` | 6.0.9 | MIT | Vue 编译 |
| `electron` | 44.4.1 | MIT | 桌面运行时 |
| `electron-builder` | 26.15.3 | MIT | DMG/NSIS 打包 |
| `electron-vite` | 5.0.0 | MIT | 三入口构建 |
| `eslint` | 10.10.0 | MIT | 静态规则 |
| `eslint-plugin-vue` | 10.11.0 | MIT | Vue 规则 |
| `globals` | 17.12.0 | MIT | 运行环境全局名称 |
| `typescript` | 6.0.3 | Apache-2.0 | strict 类型检查 |
| `typescript-eslint` | 8.70.0 | MIT | TS 规则 |
| `vite` | 7.3.6 | MIT | 构建底层 |
| `vitest` | 5.0.1 | MIT | 单元/集成 |
| `vue-tsc` | 3.3.11 | MIT | Vue 类型检查 |

## 兼容性与打包约束

- write-file-atomic 8.0.0 的 Node 范围为 `^22.22.2 || ^24.15.0 || >=26.0.0`；使用 Node24.21.0。应用自己管理同目标队列、版本核对、tmpfileCreated 检查与写后确认，不依赖库内部排队代替业务保护。
- sharp 0.35.4 使用 Node-API 预编译包。Mac 为 darwin-arm64，Windows 为 win32-x64；锁文件包含目标平台不等于本机已经安装它。保留 optional 依赖，跨构建使用隔离生产依赖树。
- sharp 与 @img 原生文件通过 asarUnpack 解包；当前 npmRebuild:false 不改变目标架构检查要求。平台包中的 libvips/编解码库许可证应随分发保留，不能只列 sharp 的 Apache-2.0。
- electron-builder 26.15.3 的 NSIS 工具集固定 1.2.1，下载校验由工具配置保留。Mac 提取卸载器的图标补丁兼容问题通过 UninstallIcon 配置及最终双 CRC 验证处理；不修改依赖源码或关闭完整性检查。
- Windows 的最终卸载器校验使用完整 7-Zip 的 `7z.exe` / `7z.dll`，不能使用 electron-builder 自带的精简 `7za.exe`。macOS 使用 builder 工具集中包含 NSIS 解包能力的 `7zz`（入口名为 `7za`）；工具配置见[开发与构建](development.md)。
- CodeMirror 搜索只使用 SearchCursor，不挂载另一套编辑器或默认搜索面板。预览高亮独立使用 highlight.js common 语言集，不复用或重建编辑器。
- Mermaid、KaTeX、高亮均随包分发并按需加载；KaTeX 输出 MathML，不加载网络字体。Mermaid 生成样式需通过应用过滤并使用窗口 nonce，不放宽 CSP。升级时验证所有样本图型、失败降级、两主题、布局和恶意输入。

## 升级与许可

依赖升级时检查兼容性、安全公告、原生库和打包结果，并验证写入行为；不要使用无界 latest 替换锁文件。

项目自身为 UNLICENSED。NSIS 回归样本附带来源、SHA-256 和工具集许可，见[第三方声明](../THIRD_PARTY_NOTICES.md)。安装包还需保留实际分发的 Electron/Chromium、libvips 和编解码库的许可材料。

相关工具的官方文档见[技术参考](references.md)。
