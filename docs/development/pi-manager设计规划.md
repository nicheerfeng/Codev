# pi-manager 设计与交付规划

更新：2026-09-24。设计已确认，独立实现位于仓库根目录 `pi-manager/`。Codev 只是当前文档与源码的存放位置，不参与插件运行，也未修改 Codev 的 Pi 界面或接入逻辑。

## 已确认边界

- 唯一会话实体是 Pi session。subagent 是带父子归属的 session，没有额外 Task 实体、任务数据库或内置业务工作流。
- 主 session 与 subagent 均可自我重命名；稳定 session ID、agentName 不随显示标题改变。
- 子 session JSONL 严格写在父 session JSONL 的同一目录；cwd 默认继承父会话。
- 会话创建、分支、读取、索引、归档、运行控制、IPC、消息和命名均为包内实现，禁止运行时引用其他项目/扩展私有文件。
- Pi 官方 Extension API 是宿主边界：用于注册工具、读取当前上下文、发送消息、更新运行中的标题。Pi 引擎自身不作为另一套私有扩展复制；插件不依赖其他管理扩展。
- 归档使用插件自有索引 `archived` 字段，恢复设为 false。Pi 没有标准 archive API；不伪造原生归档 entry，不删除 transcript，也不改变运行状态。
- fork 从明确 entry ID 或当前分支末端提取父链到新 session，源 session 不变。
- 通信协议与实现内置。以后若实际拷贝第三方代码，必须一并内置原许可证和版本记录。
- 默认返回子 agent 终轮原文与 session 引用；完整历史通过 read 获取，不额外调用模型生成摘要。
- 活动 worker 最大值默认按 CPU 和可用内存计算，允许用户覆盖；递归默认允许，最大层级可配置，同层累计数量无硬编码上限。

## 命令接口

共 17 个独立 `pv_` 工具，未合并为大型 action 参数。新增 followup 专门表达 v2 的“向同一子会话续派并唤醒”；send 保留纯通知语义。

| 命令 | 核心语义 |
|---|---|
| pv_session_create | 创建独立 session，可选首条消息、cwd、model、thinking。 |
| pv_session_list | 分页列出已登记 session，按 cwd/status 筛选。 |
| pv_session_read | 最近一页及 cursor 增量历史，sessionId 缺省为自己。 |
| pv_session_rename | 管理式修改指定 session 的显示名。 |
| pv_session_archive | archived=true 归档，false 恢复；仅写内部索引。 |
| pv_session_fork | 指定 entry ID 或当前分支点 fork，不改源 session。 |
| pv_dynamic_rename | 主 agent/subagent 动态自我改名。 |
| pv_message_send | to/text 定向通知；默认不唤醒空闲接收者，wake=true 显式唤醒。 |
| pv_message_ask | 发问并等待匹配回复；接收者须在线，超时保留消息 ID。 |
| pv_message_reply | 按 replyTo 精确回复，直接唤醒对方的等待工具。 |
| pv_message_inbox | 读取自身持久邮箱和回执，支持分页。 |
| pv_subagent_spawn | 异步创建 fresh-context 子 session，返回稳定 sessionId。 |
| pv_subagent_list | 默认直接子会话，descendants=true 查看本树后代。 |
| pv_subagent_read | 读取子会话终轮原文和原生历史。 |
| pv_subagent_wait | 等待任一指定子会话的新终轮或问题/消息，支持 cursor 与取消。 |
| pv_subagent_stop | 停止当前回合，保留原 session；取消未投递消息。 |
| pv_subagent_followup | 空闲时唤醒同一子 session；运行中使用 followUp 或 steer。 |

工具 schema 和详细参数随插件 `src/tools.mjs` 交付。普通分页默认 50 项、上限 200；wait 单次支持 1..200 个目标，可分批管理，不限制累计 session 数。

## 参考机制的取舍

| 来源 | 采纳 | 边界 |
|---|---|---|
| 本机 session-manager | 持久 session 身份、按需 RPC worker、标题与目录归属。 | 不引用其 worker/索引源文件。 |
| epid-task-manager-v2 | 独立会话创建、读取、命名、投递、归档、分叉。 | 不引入 Codex thread 概念或流病数据库。 |
| epid-subagent-orch-v2 | 稳定 worker 身份、通知与续派分离、等待事件、复用执行/审核者。 | 文件中的 5 个主题/10 个 worker 是该技能的规则，插件不照搬。 |
| pi-codex-subagents 0.3.3 | 父 session 归属、最终结果回传、闲时回收进程、续作恢复。 | 不照搬大量配置/overlay。 |
| pi-subagents 0.43.0 | 后台运行、嵌套归属、观察和故障恢复。 | 不引入 mission、workflow DSL、定时调度或 fleet。 |
| pi-intercom 0.13.0 | 定向消息、ask/reply、回执、离线信箱与准确寻址。 | IPC 为包内实现，不跨项目引用 broker。 |
| pi-rename-session 1.0.0 | 运行中即时改名、单行名称和 60 字长度规范。 | 名称规范化为包内实现。 |

核对过的源文件：

- `C:/Users/79988/.pi/agent/extensions/session-manager/index.ts`
- `C:/Users/79988/.pi/agent/npm/node_modules/@ogulcancelik/pi-codex-subagents/core.ts` 与 `index.ts`
- `C:/Users/79988/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/`
- `C:/Users/79988/.pi/agent/npm/node_modules/pi-intercom/broker/` 与 `types.ts`
- `C:/Users/79988/.pi/agent/npm/node_modules/pi-rename-session/src/session-name.ts`
- `C:/asset/epid_query_v8_main/.codex/skills/epid-task-manager-v2/SKILL.md`
- `C:/asset/epid_query_v8_main/.codex/skills/epid-subagent-orch-v2/SKILL.md`

这些绝对路径是调研出处，不进入插件运行配置或编译路径。

## 包内模块与职责

| 文件 | 职责 |
|---|---|
| index.ts | Pi 官方扩展入口；生命周期登记、工具注册、实时命名和原生消息投递。 |
| src/tools.mjs | 独立工具 schema 与模型可读描述。 |
| src/service.mjs | session 操作、父子范围、共享配额、状态、等待、续作和结果回传。 |
| src/sessions.mjs | 包内 Pi v3 JSONL 创建、同目录子会话、父链分支与流式读取。 |
| src/store.mjs | 原子保存元数据、归档标记、持久邮箱和分页索引。 |
| src/worker.mjs | 独立 Pi RPC 子进程；接受响应与最终完成分离。 |
| src/ipc.mjs、src/broker.mjs | 包内双向 IPC、连接认证、自动启动、单例与关闭。 |
| src/common.mjs | 名称、ID、自动配额与 UTF-8 JSONL 分帧。 |

## 关系与落盘

原生 JSONL 是唯一对话历史。child 的 `pi-manager` custom entry 保存 `version=1`、`sessionId`、`parentSessionId`、`rootSessionId`、稳定 `agentName`、role、depth。此 entry 不进入模型上下文。

fork 来源单独记录为 `sourceSessionId` 与原生 header 的 parentSession 路径，不据此推断 subagent 父子关系；提取历史时移除源 pi-manager 归属记录并写新身份。显示名称使用 Pi `session_info`。

`~/.pi/agent/pi-manager/sessions/<sessionId>.json` 保存索引与运行态；`messages/<messageId>.json` 保存唯一消息正文及回执；`mailboxes/<sessionId>/inbox.jsonl`、`outbox.jsonl` 和按发送方的 `senders/<senderId>.jsonl` 只保存消息 ID 索引；`config.json` 保存并发/递归配置。`PI_MANAGER_ROOT` 可隔离目录。归档标记只存在索引，不能声称删掉索引后还能自动恢复此标记。

不在启动时扫描全部历史。只登记实际加载插件的 session 和本插件新建的 session；列表只读元数据。历史正文按需流式读取，默认最近一页，后续按字节游标追读。手动删除整个管理目录、全量迁移旧插件数据均不纳入自动恢复。

## 生命周期与并发

状态采用 queued/starting/running/waiting/idle/stale；最后一轮结果另记 completed/failed/interrupted，避免把“运行中”和“交付已验收”混在一个字段。

只有 `agent_settled` 才生成正常终轮通知；`agent_end` 后可能仍有压缩、重试或排队输入。异常 EOF 明确记录失败并释放配额。正常结束闲置 worker 回收，后续 followup 恢复同一个 JSONL。

独立 broker 持有受管进程，parent 窗口关闭后已启动的 child 可继续完成。服务没有连接或活动 worker 后自动退出；不会终止用户自行启动的外部 Pi。

所有 parent 共享活动配额，默认按可用 CPU 和内存计算，可用 maxWorkers 覆盖。wait/ask 中的 parent 让出生成配额；等待进程仍占内存，配额不承诺操作系统级内存硬隔离，也不阻止用户在外部 TUI 手动生成。maxDepth 默认 4，可配置；每层直接子会话总量不设硬上限。

稳定 session ID 为控制目标，agentName 是创建时同 parent 内唯一别名；显示标题可自由改。管理者可读取自身后代，列表不会混入别的 parent 树。

## 通信与故障语义

消息信封包含 id/from/to/mode/text/replyTo/wake/behavior/delivery；ID 可由调用者提供以实现幂等重试。源码不依赖外部扩展、静态本机 npm 路径或 Codev IPC。

- queued 表示持久保存但未投递；accepted 表示目标 Pi 接受了注入请求，业务完成另由原生生命周期报告。
- delivering 过程中断线且无法确认的消息变成 unknown，不自动重放。任意进程崩溃场景不承诺严格 exactly-once 模型执行。
- 离线消息保留；wake=true 且 session 无其他运行时持有时，可按需启动。有效 owner 断线期间拒绝双写。
- ask 必须精确 replyTo。父 wait 可被子 ask 唤醒，父回复直接完成子的等待工具，避免双方卡住。
- wait 按目标 session 的专属事件订阅和发送方邮箱游标增量读取；标题或无关连接状态不会触发共享目录扫描，也不会误报旧结果。
- 终轮通知回传最终原文和 session 引用。极大正文按技术限制标明截断、保留完整 JSONL 路径，不自动总结；wait 已接收的结果不会额外唤醒父模型。
- 进程重连校准状态。已经退出的 owner 留下 stale，重新续作不回放旧 prompt。消息数据损坏会报告错误，不作为空结果悄悄忽略。

## 实施与验收

1. 独立包与工具协议：恢复独立命令，移除本机绝对编译路径和外部扩展依赖。
2. session 与关系：验证原生 JSONL 可被 Pi 读取、父子同目录、fork 不污染源会话、标题和归档正确。
3. 通信与运行：验证 ask/reply、离线邮箱、去重、EOF、取消、停止后续作和多层低并发等待。
4. 真实 Pi 验收：隔离 agent 目录和本地模拟提供方，实际执行冷启动、动态改名、子会话续作及递归。
5. 发布包核验：只包含插件自身实现及文档许可证，不打包用户配置、测试数据、node_modules 或其他项目文件。

当前执行结果与命令以插件内 `VERIFICATION.md` 为准。持续日常使用的长期稳定性仍需真实使用反馈；测试通过不等于已证明所有模型渠道、操作系统和非协作外部进程的行为。
