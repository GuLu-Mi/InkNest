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

分发目录为 `release/<版本>/`；Mac 可运行副本位于 `.tooling/mac-builds/<版本>/mac-arm64/InkNest.app`。版本取自 `package.json` 并与锁文件核对，打包、样本和检查脚本自动使用同一版本。检查单个平台可执行 `npm run inspect:packages -- mac` 或 `npm run inspect:packages -- win`。这些目录均为本地生成物。

Windows 脚本创建 `.tooling/windows-<version>-*`，用完整锁文件和 win32/x64 参数安装生产依赖，再复制同一 out。不能打入 macOS 的 sharp 二进制。两端需分别检查 .node/动态库架构及 ASAR 外解包位置，跨构建不等于 Windows 原生加载通过。

Windows 本地打包还需安装完整 [7-Zip](https://www.7-zip.org/)：卸载器校验默认使用 `%ProgramFiles%\7-Zip\7z.exe`，同目录需保留 `7z.dll`。自定义安装位置可通过环境变量 `INKNEST_NSIS_7ZIP_PATH` 指定。GitHub Windows runner 已预装完整版本。electron-builder 自带的 Windows `7za.exe` 不支持 NSIS；校验脚本强制按 NSIS 格式提取，防止误读安装包内的应用压缩包。

Mac 使用 ad-hoc 签名，未完成 Developer ID、公证与正式加固。Windows 不签名，采用可选目录的引导式 NSIS；正常卸载保留 AppData 偏好、恢复和历史。`build/installer.nsh` 是源码：保持安装/卸载图标一致，并在最终产物中校验安装器和嵌入卸载器 CRC，不以关闭 CRC 规避问题。所有打包入口禁止自动 publish。

Mac 测试副本可能进入 LaunchServices；实际包测试后的注销仅针对已确认测试路径，不重置全局数据库、不改变默认关联。隐藏构建目录减少普通扫描，不保证主动运行旧包后仍只有一个系统候选。

## 4. 升级版本并发布

本地完成开发和验证后，使用一条命令升级版本，例如：

```sh
npm run version:set -- 0.1.1
```

将示例替换为新版本。命令同步修改 `package.json` 和 `package-lock.json`，不创建提交或标签；其他输出目录、安装包名和验收样本名自动跟随。当前发布支持 `主版本.次版本.修订号` 格式。可在 `CHANGELOG.md` 新增对应版本的功能、修复和限制说明，保留旧版本记录；没有对应条目时，Release 提供项目说明和与上一版本的代码比较链接。

1. 本地验证并提交改动，推送到 `main`。
2. 打开 **Actions → Release → Run workflow**，分支选择 `main`，保留“构建成功后发布到 Releases”勾选并运行。
3. 等待整个工作流成功，到仓库右侧 **Releases** 下载新版本。

无需手动创建标签、Release 草稿或填写运行编号。工作流固定使用点击运行时的 `main` 提交，依次核对版本、构建 Windows x64 和 macOS arm64 安装包、检查产物、创建对应 `v<版本>` 标签、上传两个安装包及 `SHA256SUMS.txt`，核对上传大小和摘要后发布为最新版本。构建期间 `main` 的后续提交不会混入该版本。

普通推送和创建标签不会触发发布。已发布版本不能覆盖；标签若指向其他提交会停止。上传中断时保留未发布草稿，重跑同一提交可复用已校验的附件；草稿或附件与本次构建不一致时停止，不覆盖既有内容。

只需要打包或验证流程时，取消“构建成功后发布到 Releases”勾选。两端仍完整构建、检查并生成发布预览，但不创建或修改标签和 Release；安装包、校验文件和预览在该次运行的 **Artifacts** 下载，保留 14 天。

工作流见 [Release](../.github/workflows/build-installers.yml)。它使用锁定的 Node/npm 与锁文件，执行 lint、发布工具测试、类型检查、构建和产物版本/架构检查；Windows 保留安装器及嵌入卸载器双 CRC 校验。CI 不运行图形 E2E，也不替代目标系统的安装、输入法和保存恢复验证。

看不到 Run workflow 按钮时，确认工作流在默认分支、仓库已启用 Actions、当前账号有写入权限。GitHub 操作说明见[手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。

## 5. 分发配置

本地打包只生成安装包，正式上传由手动 Release 工作流处理。版本与路径的共同入口是 `scripts/release-config.mjs`；builder 的输出目录使用版本宏，不需要随版本修改配置。

正式分发需要配置项目许可、第三方声明、签名及 macOS 公证，并核对安装包版本与架构。签名密钥不写入仓库或日志。项目没有自动更新服务。

分支、提交与文档约定见[开发协作](../CONTRIBUTING.md)。
