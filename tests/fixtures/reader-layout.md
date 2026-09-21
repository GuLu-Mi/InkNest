# 项目发布清单

这份文档用于检查阅读排版。阅读时应有清晰的层级、舒适的留白，以及完整显示的表格编号和英文名称。

## 1. 准备工作

1. 确认 **Windows** 与 **macOS** 的安装包名称。
2. 检查 `document_id`、`release_channel` 和 `last_saved_at` 等字段。
3. 保留中文、空格与长文件名：`团队 文档说明.md`。

> 文档的正文是主要内容。状态和操作应易于找到，也应尽量少占空间。

---

## 2. 验收用例

### A. 基础流程

| ID | 平台 | 步骤 | 预期 |
| --- | --- | --- | --- |
| A1 | Apple | 打开文档 → 阅读 | 标题层级清晰，中文自然换行，`file_name` 可读。 |
| A2 | Windows | 输入内容 → 切换预览 | 显示最新内容，状态由“待保存”变为“已保存”。 |
| A3 | macOS | 打开另一文档 → 切回 | 阅读位置、选区与撤销记录分别保留。 |

### B. 文字与表格

| ID | 名称 | 配置 | 结果 |
| --- | --- | --- | --- |
| B1 | Apple | `auto_save_enabled=true` | 短名称保持完整，普通中文句子在合适位置折行。 |
| B2 | Preview | `preview_generation_id=32` | 行内代码使用淡灰背景，不使整页横向滚动。 |
| B3 | Export | `very_long_configuration_identifier_without_spaces_0123456789_abcdefghijklmnopqrstuvwxyz` | 长内容在局部得到处理。 |
| B4 | Editor | `document_revision=128` | **关键结果**与普通正文保持清晰的对比。 |

### C. 较宽的比较表

| ID | 文件名称 | 第一个检查项目 | 第二个检查项目 | 第三个检查项目 | 第四个检查项目 | 第五个检查项目 | 最终结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 中文 文档说明.md | 完整内容显示 | UTF-8 格式保留 | 文件名可区分 | 保存状态正确 | 错误说明可操作 | 待核对 |
| C2 | architecture-reference.md | 标题结构完整 | 表格局部滚动 | 光标位置保留 | 无多余通知 | 操作仍可访问 | 待核对 |

## 3. 代码块

```ts
const document = { name: '团队 文档说明.md', mode: 'read', revision: 128 };
const longLine = 'abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789';
console.log(document.name, longLine);
```

段落包含 **粗体**、*斜体*、~~删除线~~ 和 [示例链接](https://example.invalid)。链接内容不参与测试数据的生成。

## 4. 阅读位置

### 第一节

切换标签前滚动到此处。切回后应仍显示相同阅读区域，编辑模式与预览模式也分别保留位置。

### 第二节

缩小窗口后，正文两边仍应保留适量空间。放大到 200% 时，标签、加号和文档操作仍可以访问。

### 第三节

切换深色主题时，应保持标题、正文、表格边框和代码背景之间的层级。
