---
title: Markdown 兼容样本
tags: [阅读, 图表]
---

# Markdown 兼容样本 :sparkles:

## 基础语法

**加粗**、*斜体*、~~删除~~、==标记==、H~2~O、x^2^、`行内代码`。

网址 https://example.com/inknest 与邮箱 reader@example.com。

| 左侧 | 居中 | 右侧 |
| :--- | :---: | ---: |
| 中文 | 内容 | 123 |

- [ ] 未完成
- [x] 已完成

> [!NOTE]
> 这是一条说明。

> [!WARNING]
> 这是一条警告。

术语
: 术语的解释。

<details>
<summary>展开补充说明</summary>

折叠正文中的关键词：折叠测试。

按 <kbd>Command</kbd> 保存。<br>这里换行。

</details>

脚注第一次[^explain]，再次引用[^explain]。

[^explain]: 这是脚注正文，包含 **强调**。

## 代码

```typescript
const greeting: string = '你好，InkNest'
console.log(greeting)
```

```unknown-language
<script>literal code</script>
```

## 公式

行内公式 $E = mc^2$，以及 \(a^2 + b^2 = c^2\)。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]

货币 $5 和 $10 不应被合并为公式。

## 图表

```mermaid
flowchart TD
    A[欢迎页或当前文档] -->|新建| B[未命名空白 / 编辑]
    B -->|输入| C[未命名有内容]
    C -->|保存| E[原生保存位置选择器]
    E -->|取消或失败| F[保留未命名会话]
    E -->|写入及校验成功| G[已命名 / 原会话继续]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as 应用
    U->>A: 保存文档
    A-->>U: 保存成功
```

```mermaid
classDiagram
    Document <|-- Markdown
    Document : +save()
```

```mermaid
stateDiagram-v2
    [*] --> Editing
    Editing --> Saved: save
    Saved --> [*]
```

```mermaid
erDiagram
    DOCUMENT ||--o{ REVISION : contains
```

```mermaid
pie title 内容分布
    "正文" : 70
    "图表" : 30
```

```mermaid
gantt
    title 实施计划
    dateFormat YYYY-MM-DD
    section 开发
    设计 :a1, 2026-09-21, 2d
    验证 :after a1, 1d
```

```mermaid
mindmap
  root((文档))
    正文
    图表
    公式
```

```mermaid
timeline
    title 文档流程
    新建 : 编辑
    保存 : 历史
```

```mermaid
gitGraph
    commit id: "initial"
    branch develop
    commit id: "feature"
    checkout main
    merge develop id: "merged"
```

```mermaid
quadrantChart
    title 优先级
    x-axis 成本低 --> 成本高
    y-axis 收益低 --> 收益高
    quadrant-1 推进
    样例: [0.3, 0.7]
```

```mermaid
xychart-beta
    title "数量变化"
    x-axis [Jan, Feb, Mar]
    y-axis "数量" 0 --> 10
    bar [2, 5, 8]
```

```mermaid
journey
    title 阅读体验
    section 开始
      打开文档: 5: 用户
      阅读图表: 4: 用户
```

## 错误隔离

```mermaid
this is not a diagram
```

错误公式 $\notARealCommand{x}$ 后面的正文必须仍然显示。

原始脚本保持文字：<script>window.pwned = true</script>。
