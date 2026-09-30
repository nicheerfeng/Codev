# pi-manager

独立 Pi 扩展。session 是唯一会话实体，支持持久会话、递归 subagent、运行态自我重命名和双向通信。没有 task 数据库，不依赖 Codev。

## 安装

要求 Node.js >= 22.19，Pi 0.85.x。使用已安装的 Pi 宿主：

```sh
pi install /absolute/path/to/pi-manager
```

也可临时加载，不改全局扩展配置：

```sh
pi -e /absolute/path/to/pi-manager/index.ts
```

安装后重启 Pi 或执行 `/reload`。核心命令为独立的 `pv_` 工具，模型可直接调用，不需要运行终端脚本。

所有调度、存储、JSONL、IPC 和命名逻辑均在包内；只通过 Pi 官方公开 Extension API 对接宿主。没有其他 Pi 扩展或 Codev 的路径引用，未复制或内置整个 Pi 引擎。

## 命令

| 工具 | 必填参数 | 作用 |
|---|---|---|
| `pv_session_create` | 无 | 创建独立 session；可选 title/cwd/message/model/thinking，默认继承当前模型。 |
| `pv_session_list` | 无 | 查看已登记 session，按 cwd/status 筛选，支持 cursor/limit。 |
| `pv_session_read` | 无 | 指定 sessionId，省略则读自己；返回最近一页，cursor 增量追读。 |
| `pv_session_rename` | name | 改指定 sessionId 的显示名，省略目标则改自己。 |
| `pv_session_archive` | 无 | archived=true 归档，false 恢复；默认目标为自己。 |
| `pv_session_fork` | 无 | 指定 sessionId/entryId 或当前分支末端，新 session 不改源记录。 |
| `pv_dynamic_rename` | name | 主 agent 或 subagent 动态自我改名。 |
| `pv_message_send` | to, text | 发信，默认不唤醒空闲 session；wake=true 可唤醒。 |
| `pv_message_ask` | to, text | 向在线 session 提问，等待 replyTo 精确匹配的回复。 |
| `pv_message_reply` | replyTo, text | 回复收到的 ask，不需要猜发送方。 |
| `pv_message_inbox` | 无 | 查看自己的收件箱和投递状态。 |
| `pv_subagent_spawn` | name, message | 异步启动 fresh-context 子 session；可选 profile/role/provider/model/thinking。 |
| `pv_agent_profiles` | 无 | 读取公共与项目级 profile 列表，项目同名覆盖公共定义。 |
| `pv_subagent_list` | 无 | 查自身直接子 session，descendants=true 查整个后代树。 |
| `pv_subagent_read` | sessionId | 读取子 session 的终轮返回和原生历史。 |
| `pv_subagent_wait` | sessionIds | 任一所选子 session 有新终轮或问题即返回，支持 timeoutMs/cursor。 |
| `pv_subagent_stop` | sessionId | 中断当前回合，保留 session 供续作。 |
| `pv_subagent_followup` | sessionId, message | 复用同一子 session；空闲时唤醒，运行中默认 followUp。 |

所有命令都返回结构化 details。分页默认 50 项，最多 200 项；管理总量没有同层数量上限。wait 单次可指定 1..200 个目标，可分批等待；默认超时 60 秒，最多 10 分钟。

`send`/`followup` 返回 queued 或 accepted 表示已保存/接受，业务完成只认 `agent_settled` 后的终轮。`agent_end` 不作为完成依据，Pi 的压缩和重试保持原生运行。

## 调度示例

```text
pv_subagent_spawn({name: "executor_01", role: "executor", message: "完整执行要求"})
pv_subagent_wait({sessionIds: ["返回的 sessionId"], timeoutMs: 60000})
pv_subagent_spawn({name: "reviewer_01", role: "reviewer", message: "完整审核要求与交付路径"})
pv_subagent_followup({sessionId: "executor 的 sessionId", message: "审核原文与修正要求"})
```

`name` 在同一个 parent 内唯一并保持稳定；`pv_dynamic_rename` 修改显示标题，不改变 ID 或稳定 name。role 是语义标签，不隐式选择模型或注入工作流。model 显式传 `{provider, id}`，否则继承父模型；子 session 无父 transcript。

## Agent profiles

profile 是 provider、model、thinking 和预制提示词的可复用配置，不是新的 session 类型。公共 profile 放在 `~/.pi/agent/pi-manager/agents/*.json`；项目 profile 放在任意项目目录的 `<project>/.agent/agents/*.json`。解析时从 cwd 的项目根向上继承，越靠近当前 cwd 的定义优先，项目同名 alias 覆盖公共定义。

```json
{
  "name": "reviewer",
  "description": "只读审核者",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "thinking": "high",
  "tools": ["read", "grep", "find"],
  "prompt": "你是项目审核者。只检查当前项目，不修改文件。输出带路径的事实依据。"
}
```

`pv_subagent_spawn({ profile: "reviewer", name: "review-01", message: "检查这次改动" })` 会合并预制提示词与 message，并把 provider/model/thinking 快照写入子 session。修改 profile 不影响已创建 session；显式传入与 profile 冲突的资源会被拒绝。`pv_agent_profiles` 只返回 alias、描述、来源 scope 和资源配置。

通信中的 `send` 不会唤醒空闲 agent；运行中的接收者在 Pi 的安全消息边界接收。需要明确续作使用 `pv_subagent_followup` 或 `wake=true`。`ask` 超时返回 requestId，迟到回复仍保存在 inbox。子向父提问会唤醒正在 wait 的父 agent；父 agent 的 reply 直接解除子 agent 的工具等待。

最终通知包含终轮原文、结果状态和 session 引用，不让模型另写摘要。过大的终轮正文会标明截断并附 JSONL 路径；完整历史用 read 获取。parent 已在 wait 时，结果通过 wait 返回，后台通知保留为不触发新回合的通信记录。

## 配置与并发

配置文件：`~/.pi/agent/pi-manager/config.json`。使用 `PI_MANAGER_ROOT` 可隔离数据目录。

```json
{
  "maxWorkers": 6,
  "maxDepth": 4
}
```

省略 maxWorkers 时，按可用 CPU 数与可用内存计算默认值：每个活动 worker 预留约 768 MiB 的估算空间，最小 1。显式设置可以提高或降低最大值；这是启动配额，不是内存硬隔离。默认允许递归，最大深度 4，可配置。

配额由本用户的内置 broker 统一管理，所有 parent 共享。wait/ask 中的 parent 让出生成配额，允许低并发下递归完成；等待中的进程仍占用少量内存。用户在外部 TUI 手动发起的生成不受插件进程调度器阻止。配置在 broker 下次启动时读取；所有连接和受管 worker 离开后服务会自动退出。

## 落盘与恢复

- 普通 session 使用 Pi 原生 cwd 分组目录。子 session 严格写入父 JSONL 所在目录，包括使用自定义 session 目录的父会话。
- 每个子 session 的 `pi-manager` custom entry 记录 version、parentSessionId、rootSessionId、agentName、role、depth；不参与模型上下文。外部可视化只需识别这些字段。
- `sessions/<sessionId>.json` 保存插件索引。归档只改变索引 archived 标记，恢复不改 transcript，不停止运行中的 session。此状态不声称为 Pi 内建 archive。
- `messages/<messageId>.json` 保存唯一消息正文及回执；`mailboxes/<sessionId>/inbox.jsonl`、`outbox.jsonl` 和按发送方索引只保存消息 ID。查询 inbox 或 wait 不枚举共享消息目录。运行中会话只由 owner 写 transcript。
- 正常完成会回收受管 Pi 子进程；followup 通过原 JSONL 按需恢复。parent 窗口关闭不会删除子 session；后台服务继续管理已启动 worker。
- 意外断线后重连重新登记；旧 running 无有效 owner 时标记 stale。已经尝试投递但未得到回执的消息为 unknown，不自动重发，避免重复执行。
- session 列表只读取本插件已登记的索引，不自动扫描整机所有历史会话。加载本插件的外部 Pi session 会自行登记；已有扩展创建的历史会话不做隐式迁移。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run verify
npm pack
```

测试使用临时目录、真实本机 IPC、实际 Pi RPC 与本地模拟模型。不会读取用户认证文件、访问真实模型服务或修改全局 Pi 配置。测试包含冷启动、续作、递归、ask/reply、并发、EOF、停止、归档和分支。开发依赖由包内 package-lock.json 固定，发布包不包含测试缓存和 node_modules。
