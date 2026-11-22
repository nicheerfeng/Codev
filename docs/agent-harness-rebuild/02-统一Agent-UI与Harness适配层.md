# Codev Agent Harness 重构方案二：统一 Agent UI 与 Harness 适配层

## 文档定位

本文件是第二段方案。第一段完成后，Codev 已经有 Picot 式 Rust Agent Host，但旧的 Pi、Codex、Antigravity 和 Workbench React 插件已被清理。本段负责重新建立桌面端体验：用当前 Codev 右侧统一风格和 Pi 插件的成熟交互作为视觉与交互基准，打造一个统一 Agent UI。

这里的“统一”指界面、会话协议和能力描述统一，不指把所有 harness 伪装成同一个 CLI，也不指把 ACP 模型注册进 Pi。

## 一、设计原则

### 1. Pi 的 UI 作为交互基准，不作为底层架构基准

当前 Pi 插件已经积累了 Codev 最成熟的 Agent 交互：

- 右侧 Agent 面板。
- 项目和会话侧栏。
- 单行标题栏。
- 对话流式输出。
- 思考块、工具调用、工具结果和错误状态。
- 模型选择、思考等级和运行状态。
- 图片输入、文件拖入和路径引用。
- 发送中停止、消息排队和历史恢复。
- 多视口标题拖换内容。

这些行为需要保留，但代码不再属于 Pi 专属组件。新组件按统一 Agent 数据模型重写。

### 2. 每个 harness 只声明能力

界面不能通过 `if (provider === "pi")` 到处判断。每个 harness 在注册时声明能力，UI 根据能力显示控件：

```text
HarnessCapabilities {
  supportsResume
  supportsFork
  supportsThinking
  thinkingLevels
  supportsPermission
  permissionModes
  supportsImages
  supportsFileMentions
  supportsQueue
  supportsCompaction
  supportsModelSelection
  supportsSkills
  supportsExtensionUi
  supportsContextUsage
}
```

能力没有提供时，控件隐藏，而不是显示一个点击后失败的按钮。

### 3. 一个会话固定一个 harness

会话创建时记录 `harnessId`。会话中切换模型只能在该 harness 的模型目录内完成。切换到另一个 harness 时，新建会话或显式派生新会话，不继承不兼容的原生上下文。

这样可以同时实现统一界面和原生语义保真。

## 二、目标组件结构

旧的 `PiAgentPane`、`CodexPane`、`AntigravityPane` 和 `WorkbenchPane` 不再作为长期组件。新结构建议：

```text
src/modules/agent/
├── AgentPane.tsx
├── AgentSidebar.tsx
├── AgentTranscript.tsx
├── AgentComposer.tsx
├── AgentHeader.tsx
├── AgentViewportGrid.tsx
├── AgentPermissionCard.tsx
├── AgentToolCall.tsx
├── AgentThinkingBlock.tsx
├── AgentMessage.tsx
├── AgentModelPicker.tsx
├── AgentCapabilityControls.tsx
├── AgentHostClient.ts
├── agentStore.ts
├── agentTypes.ts
├── agentEvents.ts
├── agentLayout.ts
└── agent.css
```

### 1. `AgentHostClient`

只负责连接 Rust Host：

- 建立本地 WebSocket。
- 发送带 `requestId` 的命令。
- 接收快照和有序事件。
- 断线重连。
- 向 store 投递标准化事件。
- 不解析具体 Pi 或 ACP 原始消息。

桌面端也要走 Host 协议，不再为桌面单独保留另一套 Tauri 调用路径。窗口控制、目录选择和系统通知仍可使用 Tauri 原生命令。

### 2. `agentStore`

建议使用一个统一 store，状态分为四层：

```text
hostConnection
  ├─ status
  ├─ endpoint
  ├─ protocolVersion
  └─ reconnecting

workspaces
  ├─ id
  ├─ cwd
  ├─ title
  └─ sessions

sessions
  ├─ identity
  ├─ harness
  ├─ model
  ├─ runtime
  ├─ messages
  ├─ pendingPermissions
  └─ context

layout
  ├─ sidebarOpen
  ├─ sidebarWidth
  ├─ viewportSlots
  └─ selectedViewport
```

运行状态只能由 Host 快照和事件更新。布局状态属于 Codev UI，不写入 Agent Host 的运行态。

## 三、桌面 UI 详细设计

### 1. AgentPane

`AgentPane` 是新的右侧统一 Agent 入口，取代旧插件分别占据 Dock 的方式。顶部只显示当前 harness、会话标题和运行状态，不显示过多协议细节。

头部包含：

- 新建会话。
- 当前工作区和会话标题。
- 当前 harness 标识。
- 运行状态。
- 侧栏开关。
- 多视口入口。
- 当前会话的更多操作。

所有按钮必须根据能力和状态决定是否显示。没有原生支持的能力不能通过视觉上可点击的假按钮占位。

### 2. AgentSidebar

侧栏按项目和会话组织，保留当前 Pi 侧栏的密度与扫描体验：

```text
项目
  当前项目
    会话 A   ● 运行中   Pi
    会话 B             Codex
    会话 C             Claude
其他项目
  项目二
```

每个会话列表项显示：

- 标题和最近消息摘要。
- harness 图标或短标签。
- 运行状态。
- 最近更新时间。
- 未读状态。
- 是否可恢复。

会话排序、置顶、归档、删除和搜索都操作统一 `sessionId`，不再有 Pi 专属的 session order。

### 3. AgentTranscript

消息结构统一为：

```text
UserMessage
AssistantMessage
ThinkingBlock
ToolCallBlock
ToolResultBlock
PermissionRequestBlock
QuestionBlock
PlanBlock
ErrorBlock
TurnBoundary
```

Pi 原生事件、ACP 事件和后续其他协议都翻译为这些结构。必须保留 `harnessRawKind` 和 `sourceEventId`，用于诊断和历史恢复，但不让 UI 依赖它们。

视觉上继续使用当前 Codev Pi 对话的层次：

- 用户消息右侧气泡。
- 助手消息居中、宽度受限。
- 思考内容弱化显示，可折叠。
- 工具调用使用清晰边界和状态颜色。
- 工具结果保持可读，不把大段终端输出挤成一行。
- 错误显示在对应 turn，而不是只写入全局通知。
- 流式更新不改变外层布局尺寸。

### 4. AgentComposer

输入区是统一组件，具体控件由能力决定：

- 文本输入。
- 文件路径提及。
- 图片粘贴和拖入。
- 模型选择。
- 思考等级。
- 权限模式。
- 发送、停止和队列。
- 压缩上下文。
- 斜杠命令或 skills。

Pi 的输入区交互作为默认样式基线，但模型列表来源改成当前 harness 的 `modelCatalog`。禁止在输入框里读取另一个 harness 的 `models.json` 或运行时模型。

### 5. 多视口

旧 Workbench 插件删除后，多视口能力重新归入 Agent UI 的布局层，名称改为 `AgentViewportGrid`。它不是一个 agent harness，也不拥有会话进程。

每个 slot 只记录：

```text
viewportIndex
sessionId | null
```

拖拽标题只交换 slot 内容，不能重启运行时。运行时属于 session，视口只是显示容器。这样保留 Codev 当前“拖标题换内容、会话保持挂载”的体验，同时避免 Workbench 成为第二个状态中心。

## 四、Harness 注册模型

Rust Host 与 React UI 使用一致的描述：

```text
HarnessDescriptor {
  id
  displayName
  kind: nativePi | acp | custom
  version
  installed
  authState
  capabilities
  models
  configOptions
  sessionPolicy
}
```

### 1. Pi Native

```text
id: pi
kind: nativePi
transport: piRpc
sessionPolicy: nativeFile
```

特征：

- 直接运行 Pi RPC。
- 模型来源是 Pi 运行时自身。
- 会话恢复使用 Pi JSONL 路径。
- 思考等级使用 Pi 实际返回值。
- Pi 扩展请求转换为统一 extension request。

### 2. ACP Harness

```text
id: acp:<agent-id>
kind: acp
transport: jsonRpcStdio
sessionPolicy: providerDefined
```

特征：

- 独立进程。
- 独立登录和配置。
- 独立模型列表。
- 能力由 initialize 和 agent preset 共同决定。
- 不向 Pi 共享模型，不读取 Pi 的 provider 配置。

### 3. 特殊能力处理

- Pi 的 extension UI 映射为统一表单请求。
- ACP 的 `session/request_permission` 映射为统一审批卡片。
- 不支持审批的 harness 不显示审批按钮。
- 不支持图片的 harness 不显示图片输入入口。
- 不支持 fork 的 harness 不显示分叉命令。
- 不支持上下文百分比的 harness 不显示伪造的百分比。

## 五、Codev 特色功能的保留方式

| 现有特色 | 新归属 | 处理方式 |
|---|---|---|
| 多项目工作区 | Codev Workspace | 保留现有工作区模型，session 绑定 workspace id |
| 多根目录 | Workspace | 保留，Agent Host 收到明确 cwd 和 roots |
| 文件树和阅读器 | Codev UI | 不与 harness 绑定 |
| 终端和分屏 | Codev UI / Host | 继续保留，后续可由 Host 提供远程终端能力 |
| Pi 右侧对话布局 | Agent UI | 作为所有 harness 的默认视觉基准 |
| 多视口 | AgentViewportGrid | 从 Workbench 提升为 Agent UI 布局能力 |
| 文件拖入 | AgentComposer | 转为统一 host prompt attachment |
| 主题和窗口行为 | Codev Shell | 不迁入 harness 层 |
| 任务栏通知 | Agent events | 监听统一 turn completed / failed 事件 |
| 原生 session 历史 | Harness adapter | 通过 session binding 展示，不复制真相 |

## 六、第二段实施顺序

1. 固定统一事件到 UI 类型的映射。
2. 建立 `AgentHostClient` 和 agent store。
3. 实现 `AgentPane`、`AgentSidebar`、`AgentTranscript`、`AgentComposer` 的静态骨架。
4. 接入 Pi Native，完成 Pi 的完整桌面链路。
5. 接入多视口和标题拖换。
6. 接入通用能力控件。
7. 接入第一个 ACP harness，确认 UI 不需要写 provider 分支。
8. 删除旧的 Pi、Codex、Antigravity、Workbench React 组件和状态。

## 七、第二段完成标准

- 桌面只有一个统一 Agent 入口。
- Pi、至少一个 ACP harness 共用同一套侧栏、对话流、输入区和权限卡片。
- 当前 Pi 的右侧视觉密度、消息层级、模型控件和多视口体验得到保留。
- 不存在把 ACP 模型注入 Pi 的路径。
- harness 不支持的能力不会显示为可点击假控件。
- 同一会话切换视口不重启进程。
- Agent Host 断线重连后 UI 能恢复快照和消息位置。
- 旧插件入口、旧 workbench 状态中心和旧 agent 客户端已经移除。
- 只进行类型检查、Rust 编译、静态协议诊断和界面可用性核验；真实模型交互由后续人工审核窗口决定。

## 八、明确不做的事情

本段不做：

- 不让所有 harness 共享一个模型目录。
- 不把 ACP 变成 Pi 的模型 provider。
- 不把每个 harness 的特殊功能全部强行塞进统一 UI。
- 不把文件树、终端和阅读器改成 Agent 专属组件。
- 不直接照搬 Codeg 的 Next.js UI。
- 不恢复旧 Workbench 插件作为独立 agent 插件。

第二段的判断标准是：**用户面对的是一个统一的 Codev Agent UI，但每个 harness 仍然保持自己的真实运行语义。**
