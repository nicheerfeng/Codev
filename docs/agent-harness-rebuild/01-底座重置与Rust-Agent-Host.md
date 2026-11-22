# Codev Agent Harness 重构方案一：底座重置与 Rust Agent Host

## 文档定位

本文件是 Codev 全量 Agent Harness 重构的第一段方案。目标不是在现有 Pi、Codex、Antigravity 插件上继续叠加适配，而是清理旧的代理运行边界，建立一个以 Picot 为主要参考的 Rust Agent Host。

本段只定义和实现底座，不恢复完整的桌面代理界面，也不实现手机端。完成后，桌面界面暂时可以只有一个最小调试客户端，但所有代理进程、运行状态、事件顺序和会话绑定必须已经由 Rust 主机负责。

参考版本：

- Codev 当前基线：`c1da03a`
- Picot 参考版本：`82691e8a283f0389945aa9d8e21c29ad8d480231`
- Codeg 参考版本：`4991406e6045b7903ae2c5bc78db0d3b7dfd1f77`

这三份代码只作为设计和实现参考，不直接把 Codeg 或 Picot 整个仓库复制进 Codev。

## 一、重构目标

### 1. 统一运行时归属

现在 Codev 的 Pi、Codex、Antigravity 分别有各自的前端状态机和 Rust 进程桥。前端会判断线程是否运行、负责发请求、解释事件、维护消息状态，Rust 主要负责创建子进程和转发输出。这种结构不适合手机接入，也无法保证桌面窗口关闭后代理仍然按照统一规则运行。

新结构中，Rust Agent Host 是唯一的运行时拥有者：

```text
Codev React 界面
        │ 统一主机协议
        ▼
Rust Agent Host
  ├─ RuntimeCoordinator
  ├─ AgentHarnessRegistry
  ├─ NativePiHarness
  ├─ AcpHarness
  ├─ SessionIndex
  └─ EventBus
        │
        ├─ pi --mode rpc
        ├─ ACP agent --stdio
        └─ 后续其他本地 CLI
```

React 只负责显示快照、发送用户意图和呈现事件，不再拥有代理进程的事实状态。

### 2. 保留 Pi 原生语义

Pi 不再通过 Antigravity ACP provider，也不把其他 ACP 模型注册进 Pi。Pi 是独立的一等 harness，直接使用：

```text
pi --mode rpc [--session <session-path>] [--extension <path>]
```

模型、思考等级、分叉、压缩、扩展请求、原生会话 JSONL 和 Pi 自己的认证全部由 Pi 管理。Agent Host 只负责生命周期、协议转发、事件归一化和客户端订阅。

### 3. 统一其他 CLI 的接入边界

非 Pi harness 统一通过 ACP 管理器接入。ACP 是接入协议，不是模型协议。每个 ACP agent 保持自己的登录、模型和会话语义，不能把它们注入 Pi。

最终只保留三个 harness：

- Pi 原生 RPC
- Codex ACP
- Antigravity ACP

Claude Code 与 Gemini CLI 已明确移出产品范围，不再保留预设、认证提示或独立适配。

本段只要求 Rust 中把 ACP 管理器和 Pi 管理器的公共生命周期接上，不要求所有 agent 在本段完成。

## 二、清理范围

这是一次完整重构，旧插件不与新底座长期并存。执行时按以下顺序清理：

### 1. 前端清理

暂时移除下列旧入口、状态和模块：

- 旧 Pi Agent 插件及其独立客户端状态机
- 旧 Codex Agent 插件及其独立客户端状态机
- 旧 Antigravity 插件及其独立状态、登录提示和 ACP 界面
- 旧 Workbench 插件及其独立的 agent 视口编排
- `App.tsx`、`ToolPanel.tsx`、插件注册表、工作区入口中的旧分支
- 旧 Pi、Codex、Antigravity 的项目菜单、模型设置、会话顺序和运行态存储
- 旧插件对应的 CSS、测试、native.ts 和 React 组件

清理的是 Codev 的代码入口，不是用户磁盘上的 Pi、Codex 或其他 CLI 配置。`~/.pi/agent/sessions`、`models.json`、`auth.json` 以及其他原生会话文件不能删除或改写。

### 2. Rust 清理

旧 `pi_agent`、`codex_agent`、`antigravity_agent` 只保留迁移所需的纯历史解析和可复用协议代码，运行时命令不再继续暴露给前端。新的 Agent Host 统一接管进程创建和事件发送。

清理顺序：

1. 先移除旧 IPC 命令的前端调用。
2. 再把可复用的 Pi JSONL 历史解析和 Codex 协议解析迁入新目录。
3. 再移除旧 `lib.rs` 命令注册。
4. 最后删除孤立模块、旧类型和旧测试。

所有删除操作按仓库规范送入 Windows 回收站，不直接擦除。

### 3. 不清理的内容

以下内容不属于本段删除范围：

- 文件树、阅读器、Markdown、PDF、HTML、终端、Git 只读能力
- Codev 主题、窗口、工作区根目录、标签和多视口底层工具
- 用户原生 CLI 的认证与历史文件
- Codev 的基础设置和非代理插件

## 三、Rust 模块结构

建议新建：

```text
src-tauri/src/modules/agent_host/
├── mod.rs
├── protocol.rs
├── target.rs
├── coordinator.rs
├── events.rs
├── registry.rs
├── native_pi.rs
├── acp.rs
├── bridge.rs
├── session_index.rs
├── permissions.rs
├── server.rs
└── error.rs
```

### 1. `protocol.rs`

定义桌面和后续手机端共同使用的消息协议。协议不要暴露具体 Pi 或 ACP 的原始结构，最小版本包括：

```text
client.hello
host.snapshot
workspace.list
session.list
session.open
session.create
session.prompt
session.cancel
session.restart
session.close
permission.respond
extension.respond
runtime.subscribe
runtime.unsubscribe
```

服务端事件包括：

```text
runtime.started
runtime.ready
runtime.state_changed
message.user
message.assistant_delta
message.assistant_end
thinking.delta
tool.started
tool.update
tool.finished
permission.requested
extension.requested
context.updated
turn.completed
turn.failed
runtime.crashed
runtime.snapshot
```

每个事件都必须带：

```text
protocolVersion
workspaceId
sessionId
instanceId
sequence
kind
payload
```

`sequence` 由 Rust 分配，不允许前端自行推断事件顺序。

### 2. `target.rs`

采用 Picot 的运行目标模型：

```rust
RuntimeTarget {
    workspace_id: String,
    session_id: String,
    instance_id: String,
}
```

`workspace_id` 表示工作目录，`session_id` 表示用户可见会话，`instance_id` 表示一次具体运行实例。重启同一会话时可以更换 `instance_id`，但不能混淆旧事件。

### 3. `coordinator.rs`

`RuntimeCoordinator` 负责：

- 注册和注销运行目标。
- 保证同一会话的变更串行化。
- 为事件分配单调递增序号。
- 为客户端重连生成快照。
- 拒绝旧实例、旧序列号和重复请求。
- 跟踪 `starting`、`ready`、`working`、`idle`、`suspended`、`crashed`、`stopped`。
- 给每个变更分配 `requestId`，保证停止、审批和发送消息不会被重复执行。

不能把这个状态机放在 React 中。React 可以显示状态，但不能决定状态。

### 4. `bridge.rs`

抽取 Picot `PiRpcBridge` 的核心模式：

- 独立读线程读取 stdout。
- 独立写线程向 stdin 写入 JSONL。
- pending 请求表用 `oneshot` 或等价机制关联响应。
- stderr 只进入诊断尾部，不污染协议 stdout。
- 限制单帧大小。
- 进程退出时收尾所有 pending 请求。
- Windows 使用 Job Object 保护子进程树。

Pi 的 JSONL RPC 与 ACP 的 JSON-RPC 2.0 framing 要在桥层分别标记，不能用“看到 id 就认为两者完全相同”的隐式行为。

### 5. `native_pi.rs`

实现 `NativePiHarness`：

- 解析 Pi 可执行文件路径。
- 获取 Pi 版本。
- 根据工作区决定是否加载项目扩展。
- 按会话路径启动或恢复 Pi。
- 转发 `get_state`、`get_available_models`、`set_model`、`set_thinking_level`、`prompt`、`abort`、`compact`、`get_entries` 等原生 RPC。
- 把原始 Pi 事件翻译为统一事件，同时保留 `rawKind` 供诊断。
- 不保存或读取其他 harness 的模型配置。

Pi 的原生会话路径仍是重要身份信息，`SessionIndex` 只保存路径和映射，不复制整份 JSONL。

### 6. `acp.rs`

实现通用 `AcpHarness`：

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/request_permission`
- `session/set_config_option`
- `session/close`

ACP agent 通过描述文件注册，不在 React 里硬编码。每个 harness 需要声明：

```text
id
label
command
args
workingDirectoryPolicy
supportsResume
supportsImages
supportsPermission
supportsThinking
supportsModelSelection
configOptions
```

Antigravity 以后作为 ACP harness 接入，不再作为“Pi 模型 provider”。这条边界必须写入代码和文档。

## 四、存储策略

第一段采用 Picot 的取舍：

### 1. 原生历史仍是事实来源

- Pi 消息和会话继续在 Pi JSONL。
- Codex、Claude、其他 CLI 的原生历史继续由各自 harness 管理。
- Agent Host 不把整份消息复制到数据库作为第二份真相。

### 2. 新增轻量 SQLite 元数据

只存：

```text
workspaces
session_bindings
runtime_instances
preferences
```

`session_bindings` 至少包含：

```text
session_id
workspace_id
harness_id
native_session_id
native_session_path
title
created_at
updated_at
last_known_state
```

后续手机配对信息也放在同一个元数据库，但不在本段实现手机服务。

### 3. 历史迁移

启动时扫描现有 Pi 会话目录，把历史 JSONL 注册到 `session_bindings`。扫描只建立索引，不改写原文件。旧会话显示为“可恢复”或“只读历史”，只有原生 harness 能够成功加载时才允许继续发送。

## 五、第一段交付顺序

1. 新建协议和运行目标类型。
2. 移植并测试桥接层。
3. 接入 `NativePiHarness`。
4. 接入运行协调器和统一事件总线。
5. 接入最小 Tauri 命令：启动 host、取得 host 地址、停止 host、获取快照。
6. 清理旧代理插件入口。
7. 用最小调试页面确认 Pi 的创建、恢复、发送、取消、审批和退出。

调试页面不需要成为最终界面，完成后会在第二段被统一 Agent UI 替换。

## 六、第一段完成标准

- Codev 中不存在旧 Pi、旧 Codex、旧 Antigravity、旧 Workbench 的运行入口。
- Pi 进程只由 Rust Agent Host 创建和回收。
- React 不再直接调用旧 Pi 或 Codex IPC。
- 同一会话重复发送不会产生两个活动 turn。
- 进程崩溃后，客户端能收到 `runtime.crashed` 并重新获取快照。
- 客户端断开后 Pi 进程状态不丢失。
- 重连后可以通过快照恢复当前状态。
- Pi 原生 JSONL 没有被迁移、覆盖或转换。
- 不通过 ACP provider 把其他模型注入 Pi。
- 只进行类型检查、Rust 编译和协议级诊断；不发送真实模型提示词，除非另行确认。

## 七、明确不做的事情

本段不做：

- 不实现最终 Agent UI。
- 不实现手机页面。
- 不实现 Codeg 全部二十多个 agent。
- 不迁移完整消息到 SQLite。
- 不复活旧插件作为兼容模式。
- 不把 Codeg 六十万行代码整体合并进 Codev。

第一段的判断标准只有一个：**Codev 是否已经拥有一个可被多个客户端使用、由 Rust 负责真实状态的 Pi 一等运行时。**
