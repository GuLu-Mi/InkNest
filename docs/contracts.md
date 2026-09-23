# 数据与接口契约

关联 REQ-001/006–017/019–024/026–030、NFR-001/002/008。本页描述当前公开业务接口；产品目标见[需求](requirements.md)，未来能力不预先开放。

精确 TypeScript 声明位于 [shared/contracts.ts](../src/shared/contracts.ts)，暴露实现位于 [preload/index.ts](../src/preload/index.ts)。当前 **25 个 invoke 方法 + 1 个事件订阅方法**，没有通用 IPC、Node、shell、任意路径读写或执行命令入口。

Mermaid、公式、代码高亮、脚注与折叠是 renderer 的只读展示能力，复用已有来源和资源契约，不新增 preload 方法。生成的 SVG/MathML/HTML、图表查看方式和折叠状态不属于 ContentSnapshot，不送入保存、恢复或历史正文。

## 身份与状态

| 类型 / 字段 | 约束 |
| --- | --- |
| `SessionRef` | `docId` + `epoch`，均 UUID；main 再绑定 owner webContents，旧 epoch 不能使用 |
| `Mode` | 当前仅 `read` / `edit`；`split` 是后续需求，不是现有枚举值 |
| `ContentSnapshot` | ref + 非负安全整数 revision + LF 规范源码 text；格式与正式路径取自 main |
| `TextFormat` | UTF-8、bom:boolean、eol:lf/crlf；末尾换行由源码文本本身保留 |
| `diskToken` | main 生成的 64 位十六进制摘要，关联原始字节/文件身份/格式；不能靠 mtime/size 判定冲突 |
| `OpenDocument` | displayName/displayPath、源码、revision、format/diskToken、readOnlyReason、recovered、readingPosition；displayPath 仅展示，不是权限凭证 |
| `ReadOnlyReason` | encoding / mixed-eol / size / link / filesystem / permission；mixed-eol 含孤立 CR；filesystem 是保留分类，当前 reader 未进行专门识别 |
| `readingPosition` | 当前新打开返回 null；不保存跨启动阅读位置 |
| dirty / saving / diskStatus / recoveryStatus | 分别表达内容差异、请求进行、磁盘状态和草稿状态，不压成同一布尔量 |

容量同时检查 IPC 字符长度与按目标 BOM/EOL 序列化后的 UTF-8 字节数，拒绝孤立代理项和非规范 CR。空字节、未知字段、额外参数和类型错误均由业务校验拒绝。

## 当前 API

方法名是 `window.inknest` 的成员，通道名只在 preload/main 内使用。

| 方法 | 通道 | 业务含义 |
| --- | --- | --- |
| `createDocument()` | document:create | 零参数创建独立空白会话；main 生成 UUID、编号及默认格式，原子校验容量和关闭准入 |
| `openFile()` | document:open | 原生选择器选择一份 Markdown；无路径参数 |
| `rendererReady()` | document:renderer-ready | 零参数握手，安装订阅后放行系统打开队列 |
| `activateDocument(ref)` | document:activate | 激活已登记会话并补核对外部变化 |
| `closeDocument(ref)` | document:close | 单标签关闭保护，不直接销毁会话 |
| `completeClose(requestId,state)` | document:complete-close | 匹配 main 一次性挑战，交回冻结的当前状态 |
| `save(request)` | document:save | renderer 仅 manual/auto；close 由 main 协调器使用 |
| `saveAs(request)` | document:save-as | 仅 manual，由原生选择器授权目标，无任意 path/force |
| `reconcileExternal(state)` | document:reconcile | 用最新状态判定重载或冲突 |
| `resolveConflict(ref,action,snapshot)` | document:conflict | inspect / save-copy / use-disk / overwrite |
| `resolveResources(ref,refs)` | document:resources | 每批≤200 个引用；key 1–128 字符，目标 1–4096 字符；只返回能力 URL/受限原因 |
| `openDocumentLink(request)` | document:link | requestId + ref + rawTarget；重新校验来源与目标，返回 anchor/document/image/dispatched |
| `checkpoint(snapshot)` | backup:checkpoint | 独立恢复备份，成功返回 revision/savedAt |
| `listRecovery()` | backup:list-recovery | 恢复记录摘要 |
| `inspectRecovery(id)` | backup:inspect-recovery | 校验后只读源码字符串，不借用当前文档资源权限 |
| `restoreRecovery(id)` | backup:restore-recovery | 建立受保护的新会话；来源已打开时返回 TARGET_OPEN 并激活原标签 |
| `discardRecovery(id)` | backup:discard-recovery | 确认后写持久丢弃标记 |
| `listHistory(ref)` | backup:list-history | 返回 generation 和 entries，不带全部正文 |
| `inspectHistory(ref,id)` | backup:inspect-history | 校验后的单条 HistorySnapshot |
| `exportHistory(ref,id)` | backup:export-history | 导出原始字节，选择器授权目标，不迁移当前会话 |
| `restoreHistory(request)` | backup:restore-history | 显式受控还原；默认取消确认与强制保护 |
| `clearRecords(kind)` | backup:clear | 只允许 recovery/history，分别确认；无 recent 分支 |
| `setPresentation(request)` | window:presentation | requestId + ref + enabled；只请求所属窗口目标状态 |
| `getTheme()` | settings:theme | 返回 system/light/dark 与 warning |
| `setTheme(theme)` | settings:set-theme | 仅 light/dark，持久化结果与即时生效分别报告 |
| `onEvent(listener)` | document:event | 固定事件订阅，返回取消订阅函数 |

拖放路径入口、格式转换、额外资源目录、通用设置和最近文件没有 API。

图片查看器的缩放、顺时针旋转及滚动位置仅为 renderer 临时展示状态；沿用 `resolveResources` / `openDocumentLink` 返回的受控图片 URL，不新增 preload 方法、文件写入或方向持久化。切图和关闭重置查看状态，不修改文档 revision、dirty 或历史。

## 保存与请求结果

普通 `Result<T>` 为 ok/value、cancelled 或 error/AppError；取消不能伪装成功。错误代码包括 NOT_FOUND、ACCESS_DENIED、UNSUPPORTED_TYPE、TOO_LARGE、INVALID_REQUEST、STALE_SESSION、IO_ERROR、FILE_BUSY、STALE_REVISION、EXTERNAL_CHANGE、DISK_FULL、READ_ONLY、TAB_LIMIT、TARGET_OPEN、RECOVERY_FAILED、HISTORY_FAILED、CORRUPT_DATA。

`SaveRequest` 固定包含 requestId、snapshot、expectedDiskToken、trigger。相同 ID 相同规范 payload 重放结果；不同 payload/操作类型拒绝。完成缓存最多 256 条，不持有旧正文；未完成请求不被淘汰。过期 ID 不保证永久重放，旧 revision/token 仍拒绝。

`SaveReceipt` 包含 requestId、ref、savedRevision、diskToken、savedAt、displayName、displayPath、history。只确认固定快照，不能把新输入标为已保存。历史结果为 recorded/unchanged/failed/skipped，带 generation 与 error；后置历史失败不撤销已确认的正文保存。

文档工具栏保存、另存与关闭复用上述 API，不新增窗口级“全部保存”接口。工具栏整组保存操作仅在编辑时显示，不改变文件菜单、快捷键、标签关闭或失败救援入口的会话权限。动作绑定发起时的活动 SessionRef；手动保存在等待 IME 后检查该会话仍被选中且有效，来源变化时不派发保存。下拉关闭显式传原 ref，保存回执只更新对应会话；工具栏名称和底部状态始终由当前活动会话派生。

`CurrentState` 为 ref + snapshot/null；只读文档必须 null，可编辑文档提供相同 ref 的完整快照。main 在 5 秒关闭挑战内验证身份及内容，renderer 的布尔 dirty 无授权效力。

## 历史与还原

`HistoryEntry` 包含 id、savedAt、byteLength、source、sealed；source 为 baseline/auto/manual/close/save-as/restore/legacy。`HistoryListing` 增加 generation。sealed 表示不能继续自动合并，不是永久保留。

`HistorySnapshot` 额外包含 contentHash、text、format/null、restorable。restorable 仅表示历史来源具备基本格式/容量资格，main 仍核对当前文件权限、格式、磁盘状态和最新快照；预览正文不是保存来源。

`HistoryRestoreRequest` 固定包含 requestId、snapshot、expectedDiskToken、historyId、expectedContentHash。成功可为 unchanged，或 restored（previousRevision、preservedCurrent、restored 保存回执等）。失败另带 preservedCurrent 和 diskUncertain：当前 B 已保存则只推进其基准；目标 C 结果未明则保持编辑保护，不盲目回滚。

失联时保留原请求与目标 capture，同一 requestId/payload 核对已有回执，不伪造新 revision。已有精确回执可在关闭准入前重放；新的还原仍受关闭门控。renderer 成功接纳必须在原 CodeMirror 中完成一次可撤销事务，随后原子更新保存基准。

## 事件、权限与生命周期

AppEvent 覆盖新建/打开/激活/关闭、系统与链接打开、菜单命令、外部变化、保存回执、恢复状态、历史变化/维护、关闭冻结/解冻与错误，以及 presentation-state。所有按文档路由的事件核对完整 ref；历史变化同时核对 displayPath/generation，避免同 epoch 另存后接受旧列表。

菜单命令当前为 new/open/save/save-as/backups/close/presentation/find/find-next/find-previous。标签栏 + 只切换 renderer 到首页，不派发 new/open，不改变已登记文档的 ref 或生命周期；首页打开和新建分别调用原 openFile/createDocument。首页期间自动保存、checkpoint 和整窗关闭仍按原 ref 处理全部后台会话。新建和搜索由 main 单入口派发，before-input-event 防止同一快捷键被原生菜单与页面重复执行。

每个特权请求核验 sender、主 frame、精确生产来源 `inknest://app/`（或开发受信 origin）、owner、ref 和精确 schema。主进程原生对话框提供文件选择/覆盖/丢弃意图，页面不能绕过目标版本复核。导航、关闭、迁移、epoch 更新和窗口销毁撤销相应能力/监听。行为时序见[持久化](persistence.md)，图片和外链规则见[安全](security.md)。


`document-created` 事件与 `createDocument` 回执携带同一 `OpenDocument`，renderer 按 docId/epoch 幂等登记，迟到事件不重置模式和选区。无路径新建与恢复均进入编辑，已有文件默认阅读。无路径会话的 displayPath/diskToken 为 null，不登记路径或文件身份，不授权 cwd。未命名显示名为当前窗口递增的“未命名-N”；recovered 只标记恢复来源。

首次保存复用 saveAs，传输失败时保留原 requestId 和冻结快照核对回执，不盲目重新选择目标。main 普通 save 对无路径会话返回 INVALID_REQUEST，自动调度不会打开选择器。ResourceBlockedReason 新增 unsaved：尚未建立本地资源基准。无路径历史返回空列表，不扫描磁盘历史。
