# 工程与构建

本文介绍本地环境、测试和打包命令。平台与分发限制见[已知限制](known-issues.md)。

## 1. 工具链与安装

项目固定 Node.js 24.21.0、npm 11.12.1、Electron 44.4.1。版本来源分别为 `.nvmrc`、`package.json` 和锁文件；开发 Node 与 Electron 内嵌 Node 分开核对。顶层依赖及许可见[依赖登记](dependencies.md)。

```sh
node --version
npm --version
npm ci --include=optional --no-audit
npm run dev
```

安装包含 Electron 二进制及目标平台可选原生依赖。不能省略 optional：sharp 依赖平台原生包。首次安装需要访问公共制品下载地址。TypeScript strict、ESLint 及受限 preload 在开发和生产中均保留。

## 2. 验证命令

| 命令 | 范围 |
| --- | --- |
| `npm run typecheck` | main/preload/shared 与 Vue renderer 类型检查 |
| `npm run lint` | 当前源码、配置和测试规则 |
| `npm run test:unit` | 单元测试 |
| `npm run test:integration` | 临时目录真实文件、时序与失败注入 |
| `npm run build` | 类型检查后构建 main/preload/renderer 到 out |
| `npm run test:e2e` | 启动已构建的 Electron，需桌面环境和进程/文件权限 |

Electron E2E 前执行 build，避免误测旧 out。完整回归可以显式使用 `INKNEST_PRESENTATION_TEST_DRIVER=controlled npm run test:e2e`；此时全屏原生边界是替身，不能据此宣称系统全屏进出通过。测试始终启用 Chromium sandbox，使用独立临时文档和 userData。

保存、恢复、编码、授权、冲突、关闭及历史还原变更需要失败/时序测试。文案和纯文档只检查内容、链接和一致性，不新增镜像实现的测试。提交说明中注明实际运行的检查。

## 3. 本地打包

| 命令 | 当前行为 |
| --- | --- |
| `npm run dist:mac` | 构建后生成 arm64 DMG |
| `npm run dist:win` | 构建后生成 x64 NSIS；目标生产依赖安装到隔离目录 |
| `npm run dist:all` | 构建一次 out，再生成上述两端安装包 |
| `npm run smoke:fixtures` | 生成隔离的固定样本，拒绝覆盖既有样本包 |
| `npm run inspect:packages` | 检查版本、架构、ASAR、固定接口、安全选项与原生库 |
| `npm run verify:packaged:mac` | 针对实际 Mac 应用包执行 smoke；系统 picker/确认是受控边界 |

当前分发目录为 `release/0.0.15-search-panel/`；Mac 可运行副本位于 `.tooling/mac-builds/0.0.15/mac-arm64/InkNest.app`。这两个目录均为本地生成物。新版本同步 package/lock、builder 输出和脚本预期版本。

Windows 脚本创建 `.tooling/windows-<version>-*`，用完整锁文件和 win32/x64 参数安装生产依赖，再复制同一 out。不能打入 macOS 的 sharp 二进制。两端需分别检查 .node/动态库架构及 ASAR 外解包位置，跨构建不等于 Windows 原生加载通过。

Mac 使用 ad-hoc 签名，未完成 Developer ID、公证与正式加固。Windows 不签名，采用可选目录的引导式 NSIS；正常卸载保留 AppData 偏好、恢复和历史。`build/installer.nsh` 是源码：保持安装/卸载图标一致，并在最终产物中校验安装器和嵌入卸载器 CRC，不以关闭 CRC 规避问题。所有打包入口禁止自动 publish。

Mac 测试副本可能进入 LaunchServices；实际包测试后的注销仅针对已确认测试路径，不重置全局数据库、不改变默认关联。隐藏构建目录减少普通扫描，不保证主动运行旧包后仍只有一个系统候选。

## 4. 发布配置

打包入口显式禁用自动发布，只生成本地产物。仓库没有 CI 工作流；上述命令需在本地运行，跨平台构建不能替代目标系统运行测试。

正式分发需要配置项目许可、第三方声明、签名及 macOS 公证，并核对安装包版本与架构。签名密钥不写入仓库或日志。项目没有自动更新服务。

分支、提交与文档约定见[开发协作](../CONTRIBUTING.md)。
