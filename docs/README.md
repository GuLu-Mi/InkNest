# 文档

产品操作入口见[项目首页](../README.md)，功能与兼容性边界见[已知限制](known-issues.md)。

## 产品与行为

| 文档 | 内容 |
| --- | --- |
| [产品需求](requirements.md) | 产品范围、功能要求、默认值与容量约束 |
| [交互规格](interaction.md) | 标签、阅读、编辑、搜索、保存与异常处理 |
| [Markdown 兼容性](markdown.md) | 支持的语法、图表公式、交互与降级规则 |
| [已知限制](known-issues.md) | 不支持的功能、可靠性风险与平台限制 |

## 技术与开发

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | 模块职责、状态所有权与数据流 |
| [接口契约](contracts.md) | preload API、数据类型、结果与事件 |
| [保存与恢复](persistence.md) | 正式文件、恢复草稿、历史及关闭保护 |
| [安全与隐私](security.md) | 文档输入、路径权限、资源、IPC 与网络边界 |
| [设计取舍](decisions.md) | 技术选择的理由与代价 |
| [开发与构建](development.md) | 工具链、检查命令与本地打包 |
| [依赖](dependencies.md) | 固定版本、用途、许可与平台约束 |
| [测试](testing.md) | 测试方法、固定样本与需求用例 |
| [技术参考](references.md) | 相关工具和库的官方文档 |

代码变更时同步维护对应主题；需求编号和接口契约用于保持产品行为、实现与测试一致。协作约定见[CONTRIBUTING.md](../CONTRIBUTING.md)。
