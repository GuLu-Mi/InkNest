# 技术参考

以下为相关工具和库的官方文档。API 使用需结合项目锁定版本；应用默认值与交互规则见[产品需求](requirements.md)。

| 来源 | 本项目采纳的依据 |
| --- | --- |
| [Electron安全](https://www.electronjs.org/docs/latest/tutorial/security) | 上下文隔离、沙盒、IPC来源验证、限制导航、使用受控协议 |
| [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) | preload暴露固定业务方法，不暴露完整IPC能力 |
| [Electron沙盒](https://www.electronjs.org/docs/latest/tutorial/sandbox) | 沙盒渲染进程通过主进程执行特权任务 |
| [electron-vite入门](https://electron-vite.org/guide/) | Vue与TypeScript模板、main/preload/renderer构建 |
| [electron-vite开发](https://electron-vite.org/guide/dev) | preload运行限制及开发构建注意事项 |
| [CodeMirror系统指南](https://codemirror.net/docs/guide/) | 编辑状态与事务、选区、扩展和历史模型 |
| [CodeMirror参考](https://codemirror.net/docs/ref/) | EditorState/EditorView接口，执行时按锁定版本核查 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | Markdown解析与扩展机制，兼容范围需应用定义 |
| [Mermaid](https://mermaid.js.org/config/usage.html) | strict 模式、应用管理配置、异步 SVG 绘制 |
| [KaTeX](https://katex.org/docs/options.html) | trust、宏展开限制与 MathML 输出 |
| [highlight.js](https://highlightjs.readthedocs.io/en/latest/api.html) | 显式语言高亮与 common 语言集 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML过滤能力及过滤后修改输出的风险 |
| [Node文件系统](https://nodejs.org/api/fs.html) | 并发writeFile限制、文件监测差异和文件替换相关行为 |
| [write-file-atomic](https://www.npmjs.com/package/write-file-atomic) | 临时写入、替换及同文件排队的基础能力 |
| [Tauri WebView](https://v2.tauri.app/reference/webview-versions/) | 备选技术栈跨平台WebView差异 |
| [Electron签名](https://www.electronjs.org/docs/latest/tutorial/code-signing) | macOS签名/公证与Windows分发签名准备 |
| [Node发布周期](https://github.com/nodejs/Release) | 开发运行时支持周期 |
| [Playwright Electron](https://playwright.dev/docs/api/class-electron) | Electron自动化为实验性能力，需固定版本并补原生验收 |

不要从文档中的“latest”链接推导项目应在CI每次安装最新版。实际版本以锁文件及依赖登记为准。发布政策、支持系统和签名服务可能变化，发布前再次查官方资料。

产品定位与行为以本项目[需求](requirements.md)及[设计取舍](decisions.md)为准。
