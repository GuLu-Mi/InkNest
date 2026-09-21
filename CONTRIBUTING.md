# 开发协作

需求、实现、测试和技术文档在同一仓库维护。修改前阅读 [AGENTS.md](AGENTS.md) 和相关[技术文档](docs/README.md)。

## 提交变更

1. 从最新 `main` 开始本地开发；需要临时分支时仅在本地使用。
2. 明确问题、预期行为及涉及的 REQ/NFR，完成代码、文档和必要测试。
3. 检查差异和暂存内容；提交标题与正文使用中文，描述具体变化与验证方法。
4. 本地验证后将改动合入 `main`，GitHub 只推送 `main`，不推送临时分支。

准备发布时运行 `npm run version:set -- 0.1.1`（替换为新版本），验证并推送 `main`，再手动运行 **Actions → Release**。工作流自动完成双平台打包、标签和 Release；具体行为见[开发与构建](docs/development.md)。

## 本地检查

使用 `.nvmrc` 指定的 Node.js 和 `package.json` 指定的 npm：

```sh
nvm use
npm ci --include=optional --no-audit
npm run build
npm run lint
npm run test:unit
npm run test:integration
```

Electron E2E 使用构建后的应用，需要正常桌面会话。命令与测试边界见[测试说明](docs/testing.md)，打包方式见[开发指南](docs/development.md)。

保存、恢复、冲突、编码、权限和关闭行为的修改应包含失败与时序测试。纯文案变更检查内容、链接和一致性即可。

## 文档与提交范围

提交源码、测试、固定样本、构建配置、锁文件和项目文档。版本说明面向使用者，技术文档解释当前行为、约束和设计理由。

开发日志、执行计划、进度表、测试运行报告及原始截图存放在被忽略的 `docs/local/` 或 `.tooling/`。不要从正式文档链接这些本地资料；影响使用的已知问题记录在[已知限制](docs/known-issues.md)。

不提交用户文档、恢复正文、凭据、签名材料、依赖或生成的安装包。`build/installer.nsh` 与 `tests/fixtures/nsis/*.exe` 是必要的构建源码和测试样本。

```sh
git status --short
git diff --check
git diff --cached
```

## 问题反馈

描述系统与应用版本、复现步骤、预期和实际行为。使用可公开的最小样本，移除正文隐私、绝对路径和凭据；界面问题可附脱敏截图。

## 许可

项目保持 `UNLICENSED`，尚未选择开源许可证。第三方材料见[声明](THIRD_PARTY_NOTICES.md)。
