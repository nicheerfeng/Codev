# 05 — Agent 系统诊断与系统化优化升级方案

> 本文基于以下真实代码与设计基线对照审查生成（仅陈述已核实的代码事实与差异，不包含未执行的代码假设）：
> - 产品边界与重构文档：[CODEV.md](../../CODEV.md)、[01-底座重置与Rust-Agent-Host.md](./01-底座重置与Rust-Agent-Host.md)、[02-统一Agent-UI与Harness适配层.md](./02-统一Agent-UI与Harness适配层.md)、[03-手机远程与兼容迁移.md](./03-手机远程与兼容迁移.md)、[04-开发与核验记录.md](./04-开发与核验记录.md)
> - 参考实现仓库：`docs/references/picot-main`（Pi 原生 RPC / 宿主同步 / 扩展宿主标杆）、`docs/references/codeg-main`（ACP 诊断 / 工具语义化卡片 / 计划与权限 UX 标杆）
> - 原版保留插件基线（对应 `D:\software\CodexScope-dev111` 提交 `c1da03a` 同源实现）：`src/modules/plugins/pi-agent/`、`src/modules/plugins/codex-agent/`、`src/modules/plugins/workbench/`、`src-tauri/src/modules/pi_agent/`、`src-tauri/src/modules/codex_agent/`

---

## 一、现状总体结论：为什么当前使用体验很差、让人“完全看不懂”

当前版本完成了 `agent_host` 单一 Rust 宿主的底座搭建，但**底座契约未打通前端语义层，同时大量 `CodexScope-dev111` 阶段打磨成熟的交互在迁移中被绕过或丢弃**。用户的挫败感来自四层叠加问题：

1. **核心运行时链路存在阻断级 Bug，造成“假死 / 错乱 / 卡状态”**
   - **Pi 实时流式基本失效**：`native_pi.rs` 只处理 `frame.get("message")`，忽略 Pi RPC 增量帧 `assistantMessageEvent`（`text_delta` / `thinking_delta` / `contentIndex`），导致正文和思考往往要等到 `message_end` 才整段蹦出；若 `message_end` 只有 `toolCall`，还会遗留空 `streaming: true` 占位直到 `agent_end`。
   - **工具过程折叠状态互相打架**：`AgentTranscript.tsx` 中 `ProcessBlock` 用 `useEffect(() => setOpen(running), [running])`，一旦新回合开始运行，整条对话里所有历史工具过程会集体弹开，回合结束再集体收起。
   - **ACP 回放历史永久卡在流式态**：`acp.rs` 在 `session/load` 重放 `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` 时写死 `streaming: true, status: "streaming"`，加载完成后从不清零。
   - **分叉（Fork）、队列、取消与超时多处半成品**：`session.fork` 后端无视 `entryId` 一律整会话 `clone`；`native_pi.rs` 将空 `errorMessage` 视为错误阻塞队列排空；`session.cancel` 在 ACP 错误中断时会卡 `stopping` 或弹错；Pi 回合仍用 120s 超时；移动端首次配对因默认收起侧栏直接呈现空白屏。

2. **协议内部结构直接裸露给用户，界面变成“JSON 调试器”**
   - **工具调用/结果无语义化**：`AgentTranscript.tsx` 把所有工具入参、执行结果直接塞进 `<pre>` 吐出原始 JSON；历史 Pi 记录更把同一次工具拆成两条孤立的 `toolCall` 和 `toolResult` 消息。
   - **计划、审批与配置全是原始字段**：ACP `plan` 直接 `serde_json::to_string_pretty` 输出 JSON 数组；`RequestCard` 权限审批直接打印原始 `rawInput` JSON；输入框下方一排匿名 `<select>` 下拉框（且仅显示 `o.type === "select"`，其余类型静默丢失），缺乏可读标签、作用域说明和当前状态反馈。
   - **符号黑盒与上下文错位**：顶栏用 `↻`、`⑂`、`▦`、`⏻` 等无足够提示的符号按钮；新建代理选择器与当前正在对话的会话代理混在同一个视觉层级，用户分不清选的是“当前会话”还是“下次新建”。

3. **与 `CodexScope-dev111`（旧版 Pi / Codex / Workbench）相比丢失了大量高频工程能力**
   - **Diff 与文件变更闭环断线**：`AgentPane.tsx` 声明了 `onOpenDiff` prop 却从未解构调用（`App.tsx` -> `ToolPanel` -> `AgentPane` 传参链是空桩）；丢失了 Turn Diff 汇总（`+adds -dels`）、`PiFileOperations` 修改/写入/删除分组与“在资源管理器中显示（`revealItemInDir`）”。
   - **编辑器与附件降级**：丢失 `SkillMentionInput`（顶边拖拽调高、按会话记住高度/光标、`$skill` 高亮与折叠）、`@` 文件联想、`composer-paste-offload` 大粘贴转附件、拖拽文件生成干净芯片而非往提示词里塞丑陋的 `@"D:\..."` 字符串、以及 `steer`/单条编辑/删除的精细队列控制。
   - **导航、多视口与配置管理缺失**：丢失 `Ctrl+F` 搜索（含思考/工具参数高亮与自动展开）、`ViewportCount` 布局切换与工作台双栏共存能力、侧栏拖拽排序与项目分组、右键导出 HTML/打开目录/删除会话、OS 桌面完成通知（`piNotify.ts`）、单条消息语音朗读按钮、Pi 模型管理/提示词/技能插件/版本面板、以及 Codex Provider 切换与 `AGENTS.md` 管理。

4. **环境可观测性为零，用户不知道工具怎么用、为何不能用**
   - `registry.rs` 仅用极简的二进制存在性推断 `installed`，既不检查 GUI 与终端 `PATH` 差异、Node/npm 运行时、登录状态，也没有一键准备、登录引导和 `stderr` 诊断；用户只看到灰掉或报错，不知道缺了什么、去哪配。
   - `acp:codex` 在 `registry.rs::launch()` 中甚至强行覆盖用户自定义的 `command/args` 为 `managed_codex()`，违背设置页给人可改的错觉。

---

## 二、方案对齐：我们从参考库和旧版各自继承什么（并严守 `CODEV.md` 边界）

### 必须守住的架构红线（不可推翻）
- **单一宿主权威**：保留 `src-tauri/src/modules/agent_host/` 作为唯一运行时管理器和状态投影中心；React 仅负责订阅 `snapshot + patch` 与发送 intent 命令。
- **Pi 原生与 ACP 边界严格隔离**：Pi 坚持原生 `pi --mode rpc`；Codex（`codex-acp`）、Antigravity（`agy acp --stdio`）和自定义 ACP 各自独立进程运行；**禁止**把 ACP 模型注入 Pi，也**不恢复**已退场的 Claude / Gemini 适配器。
- **SQLite 只存宿主元数据**：保持 `host_workspaces` / `host_sessions` / `host_preferences` / `host_devices`，不把 Pi/Codex 原生 JSONL 历史全量搬库。
- **WebView2 原生拖放禁令**：标签、侧栏排序、文件拖拽等继续全部使用 Pointer Capture，绝不使用 HTML5 `draggable` / `onDrop`。
- **手机端与独立服务保留**：保留 `mobile.html` 与 `dist-agent-host/`，升级只补安全与可用性，不推翻协议骨架。

### 三方精华融合映射表

| 问题域 | 采纳 `picot-main` 的设计 | 采纳 `codeg-main` 的设计 | 找回 `CodexScope-dev111` 旧插件设计 |
| :--- | :--- | :--- | :--- |
| **流式与同步协议** | `assistantMessageEvent` 增量解码；`host.resync` 按序列号断点补丁；15 分钟交互超时 | `SessionSettingsPicker` 统一配置胶囊 + 过期配置 `"重连生效"` 提示 | 任务栏未读（修复 `taskbar-unread` 类型对齐）与 OS 桌面完成通知（`piNotify.ts`） |
| **工具与过程渲染** | `tool-card` 前置/后置状态收敛；`turn-trace` 真实父子回合追踪 | `normalizeToolName` + `Explore` 多步合并组 + `EditDiff` 结构化 diff + `CommandRow` 实时尾行与 grep exit-1 语义 + 失败恢复归因 | `PiFileOperations`（修改/写入/删除分组 + `revealItemInDir`）+ `turnDiff` + 接通 `onOpenDiff` 到编辑器 Diff 标签 |
| **计划、审批与权限** | `ExtensionUiHost` 前台队列 + 中断兜底 + 扩展状态条 `setStatus` | 结构化 `PlanCard` / `AgentPlanOverlay`；权限审批带命令/文件预览、作用域标签与安全默认 `defaultToNo`；按 harness 控制 `HostToolsPolicy` | 旧版 Pi inline prompt 体验与 Codex 清晰授权反馈 |
| **输入区与命令系统** | `@` 工作区文件补全（`at-file-mention`）；`/` 本地/扩展命令分类与仅终端提示；大文本粘贴转附件；模型记忆恢复 | `@` 多类别候选弹窗；清晰底部控制栏 | `SkillMentionInput`（顶边拖高、按会话记住高度/光标、`$skill` 高亮与折叠）；拖拽/粘贴生成文件+图片芯片；`steer` + 单条队列编辑/删除 |
| **会话树、搜索与导航** | `session-tree.js` 真分支读取与指定 `entryId` 分叉；`conv-nav.js` 对话导航轨；`context-viz.js` 上下文环与明细 | 两步式 `history.scan` 扫描预览再导入 | 侧栏项目分组与 Pointer 拖拽排序；多工作区展开；运行态计数角标；`ViewportCount` 格数切换；`Ctrl+F` 全文/思考/参数高亮搜索；单条消息 TTS 朗读 |
| **环境诊断与安全** | `deviceId` 绑定令牌校验 + 远端视图脱敏隔离 | `acp_env_diagnostics` + `compute_verdict`（PATH 差异/缺依赖/脱敏 stderr 诊断）；`AcpError` 分级路由；`WelcomeTip` 引导条；401 vs 离线探测 | `PiModelsHelp` 类内置说明引导 + `.pi/extensions` 项目信任控制 + Pi `models.json` / `APPEND_SYSTEM.md` / 资产与 Codex `AGENTS.md` 管理入口 |

---

## 三、分阶段系统优化升级方案（可执行路线图）

为避免大改引发回归，方案分为 **4 个渐进 Phase**。每个 Phase 都可直接独立编译、单测、并在 `pnpm tauri dev --config src-tauri/tauri.portable.conf.json` 审核窗验证。

---

### Phase 1：P0 主干 Bug 清零、契约纠偏与安全加固（先让现有功能“正确跑通”）

> **目标**：不先大改版面，集中修复导致“不流式、错展开、假死、误写文件、远端掉线、Diff 断线”的阻断性缺陷，同时建立 `agent_host` 与 `agent` 的第一批单元/契约测试。

#### 1.1 Rust `agent_host` 修复项
1. **修复 Pi 增量流式与结束态判定（`src-tauri/src/modules/agent_host/native_pi.rs`）**
   - 在 `handle_frame` 中完整解析 `message_start` / `message_update` / `message_end` 内的 `assistantMessageEvent`（参照旧版 `reducer.ts` 与 `picot-main/assistant-message-stream.js`）：支持 `text_start`/`text_delta`/`text_end`、`thinking_start`/`thinking_delta`/`thinking_end`、`toolcall_*`，按 `contentIndex` 实时增量拼接到当前流式消息。
   - 若 `message_end` 仅包含 `toolCall` 而无文本/思考，必须把当前占位流式状态正确收敛或转为工具调用项，防止残留空白 `streaming: true` 卡片到 `agent_end`。
   - **修复空错误阻塞队列**：忽略 `errorMessage == Some("")`（仅非空字符串写入 `v.error`），保证正常回合结束后队列能自动续跑。
   - **修复用户消息去重脆弱性**：用客户端发送标记 / `clientMessageId` 或精确时间窗追踪待确认用户消息，替代仅比较 `.rev().take(6)` 纯文本（避免带图片或长工具回合重复出现两条用户消息）。
   - **保留结构化工具差异 & 合并历史工具对**：`tool_execution_update`/`tool_execution_end` 除 `content_text` 外，提取结构化 `details.diff`（若存在）与 `isError`；读取 Pi JSONL 历史（`history.rs`）时按 `toolCallId` 将 `toolCall` + `toolResult` 配对合并为同一张工具卡片，与实时视图结构一致。
   - **修正上下文用量统计与首次刷新覆盖**：`context` 计入完整 token 明细（`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`）；历史读取或 `session.open` 时回填最后已知 `usage`；`refresh_pi` 仅在消息尚未加载时初始化窗口，避免覆盖用户翻页加载的历史；取消每次 `turn_finished` 全文件重扫（改为增量游标读取新追加行）。
   - **接通被丢弃的 Pi 扩展事件**：至少处理 `setStatus`（状态条）、`setWidget`、`setTitle`、`set_editor_text`、`extension_error`、`stderr` 尾、`auto_retry_*`；为 `extension_ui_request` 的未知/中止路径补齐超时和取消清理。

2. **修复 ACP 会话恢复、权限边界、工具定位与 Diff 保真（`src-tauri/src/modules/agent_host/acp.rs`、`commands.rs`）**
   - **终止 `session/load` 卡流式态**：`session/load` 返回后统一收尾当前回合内所有未封口消息为 `streaming: false, status: "done"`；遇到 `recoverable_missing_session` 回退 `session/new` 前，先清空此前 `session/load` 半途重放的脏消息。
   - **修复工具定位与字段丢失**：`tool_call_update` 查找 `toolCallId` 改用 `.rposition(...)` 命中最近回合；`rawInput` 为 `{}` 或 `null` 时保留既有 `arguments` 不覆盖；保留 ACP 原生 `kind`（`read`/`edit`/`execute`/`search`/`think` 等）和 `locations`（文件+行号）；保留 ACP 结构化 `diff`（`{ path, oldText, newText }`）为结构化字段，不再压扁成纯文本拼接。
   - **不再无条件放开静默写文件**：`acp.rs` 初始化的 `fs.writeTextFile` 不再写死 `true` 无审批执行；改为受 `HostToolsPolicy` 策略控制，并在执行写入前走宿主审批请求或记录明确变更 Diff（默认安全策略：读取可按策略放行，写入需显式开启自动写入模式或经用户确认）。
   - **配置更新与取消态修复**：`config_option_update` 合并而不是擦除服务端合成的 `$mode`；`session.thinking` 映射到 `config_options` 时同时识别 `id == "thought_level"`；ACP `session.cancel` 在 `session/prompt` 返回取消态后立即清除 `"stopping"` 并按用户取消（`canceled`）收口，不再弹红字错误横幅；`session.prompt`（Pi）改用 15 分钟交互式超时；`session.fork` 真正传递 `entryId` 执行分支切出（对不支持的 harness 提前校验不创建空绑定），并在分支失败时回滚新建绑定。

3. **修复历史读取、注册表覆盖、桥接鲁棒性与远端安全（`history.rs`、`registry.rs`、`bridge.rs`、`coordinator.rs`、`server.rs`）**
   - **`history.rs`**：`read_pi` 按父指针回溯当前分支叶子节点而不是盲读文件最后一行；`read_codex` 解析 Codex 原生事件（`function_call`、`function_call_output`、`reasoning`、时间戳 `updated_at`），告别“Codex 历史工具全空 + 时间全是 0”；同时若当前未开启任何只读伪装，明确在消息数据结构中标记原生来源。
   - **`registry.rs`**：尊重用户对 `acp:codex` 自定义的 `command/args`（仅在未显式覆盖时走 `managed_codex()`）；修正 `defaults()` 初始能力位（不再全 `false` 导致未启动前能力展示失真）。
   - **`bridge.rs`**：正确区分 JSON-RPC `id: null` 通知错误与 `error: null` 正常响应；输出队列改用有界背压等待代替 `try_send` 丢消息；Unix 进程关闭增加进程组/PID 兜底防止孤儿进程。
   - **`coordinator.rs`**：60ms `flush()` 只推送实际变更的视图字段（不重复序列化大列表 `models`/`commands`）；`import_history` 批量完成后统一 emit 一次 `global_dirty`，消除 ~1600 次刷屏刷新。
   - **`server.rs`（高优先级安全修正）**：
     - 移动端初始 WS 建连调用 `host.snapshot_for(principal.desktop)`，杜绝向远端泄漏本地 `command/args`；
     - 解决独立 `codev-server`（`host.remote == None`）15 秒心跳把配对手机踢掉的 bug，同时收紧 `desktop_token` 权限与局域网鉴权边界（参照 `picot-main` `deviceId` 绑定 + 非桌面端明确独立角色）。

#### 1.2 前端 `src/modules/agent/` P0 修复项
1. **`ProcessBlock` 展开态独立（`AgentTranscript.tsx`）**：移除导致历史块跟着全局 `running` 弹开的 `useEffect`，默认折叠历史过程，仅当前正在运行的新过程默认展开，且尊重用户手动点开/收起的选择。
2. **接通 `onOpenDiff`（`AgentPane.tsx` + `AgentTranscript.tsx`）**：解构并传入 `onOpenDiff`，让 FileChips / 编辑卡片可以直接在主编辑器旁打开专业 Diff 标签页。
3. **仅对真实支持分叉的会话与消息显示分叉按钮**：只读历史与不支持 `supports_fork` 的 ACP 会话隐藏“分叉”按钮，避免点了报错。
4. **修复 `AgentComposer.tsx` 已知 React key 重复问题 & 客户端断线重连体验**：`client.ts` 支持消费 `host.resync` 按序列号补偿同步而非粗暴断开；`MobileApp.tsx` 区分 401（凭证失效才清 token 并回配对页）与宿主临时离线（保留 token 并提示重连）；移动配对进入后默认打开会话列表抽屉或给出清晰的一键新建入口，彻底消灭空白屏。
5. **建立首批自动化测试**：`src-tauri/src/modules/agent_host/` 协议单测（Pi delta 流式、ACP load 收尾、空 error 队列、`entryId` fork 回滚、far-end `snapshot_for` 脱敏、Codex JSONL 解析）；`src/modules/agent/` Vitest 单测（store patch 合并、ProcessBlock 状态稳定性、client resync）。

---

### Phase 2：工具语义可视化、审批体验与信息架构重建（解决“看不懂工具与状态”）

> **目标**：让用户一眼看懂“代理现在在干什么、改了什么文件、命令跑成功没有、为什么停在审批、还剩多少上下文”，彻底消灭“原始 JSON 墙”和“匿名控件”。

#### 2.1 语义化工具调用与过程时间线（融合 `codeg-main` + 旧版）
- **新增工具规范化与描述器（`src/modules/agent/toolFormat.ts`）**：
  - 将各代理异构工具名（`read`/`read_file`/`cat`、`edit`/`replace_file_content`/`apply_patch`、`bash`/`execute`/`run_command`、`grep`/`find`/`glob`/`search`、`web_search` 等）统一归类为：`read`、`search`、`list`、`edit`、`write`、`command`、`web`、`subagent`、`other`。
  - 生成人话摘要（如 `读取 AgentComposer.tsx (L1-80)`、`编辑 native_pi.rs (+12 -4)`、`搜索 "session.fork" · 3 处匹配`、`执行 pnpm cargo test`）。
- **两级可阅读过程时间线（对齐旧版 `timeline.ts` + `codeg-main/activity-timeline.tsx`）**：
  - **外层聚合摘要**：例如 `已执行 5 步（读取 3 个文件 · 搜索 1 次 · 修改 2 处）· 耗时 4.2s`，运行中附带简洁实时动作（如 `正在运行 pnpm cargo test…`）。
  - **同类探索合并组（Explore Group）**：连续的只读探查（读文件/列目录/搜索）折叠成紧凑一组，避免 20 条工具卡把对话刷成屏霸。
  - **专用语义卡片（按需展开细节，仍保留“查看原始 JSON”折叠入口方便开发者排查）**：
    - **文件编辑卡（EditDiff）**：基于结构化 `diff` / `apply_patch` / `oldText -> newText` 渲染红绿增删行对比 + `+adds -dels` 统计 + 点击在主编辑器打开完整 Diff（`onOpenDiff`）+ 右键/按钮在系统资源管理器定位文件（`revealItemInDir`）。
    - **终端命令卡（CommandRow）**：展示可读命令（剥离冗余壳前缀）、工作目录、流式最后几行实时预览、退出码徽章；**针对 `grep`/`rg` 退出码 1（无匹配）规范化为“无匹配”中性态**，不误报成红色失败；若前后工具“先失败后由同类动作恢复”，标注温和“已恢复”提示。
    - **搜索与网页卡**：参考 `WebSearchDetails.tsx` 展示关键词与来源链接芯片。
- **回合文件变更总栏（`TurnFileOperations`）**：在包含文件改动的助手回合底部显示折叠清单（`新增 / 修改 / 删除` 分组、总 `+adds / -dels` 计数、一键打开 Diff、在目录中显示）。

#### 2.2 结构化计划卡片、审批卡片与内联思考
- **计划卡片（PlanCard + 悬浮进度条）**：解析 `kind === "plan"` 中的 `{ content, status, priority }` 列表渲染复选进度项（待办 / 进行中 / 已完成 + 进度计数），并在长对话顶部可选显示轻量化当前计划进度条。
- **结构化交互审批卡（`RequestCard` 重构）**：
  - 对文件写/删/命令执行请求提取结构化预览：命令内容 / 目标文件路径 / 变更 Diff 预览、工作区作用域徽章（`工作区内` / `工作区外`警告）、操作影响等级；危险外部操作或高影响请求安全默认焦点设为拒绝（`defaultToNo`），不再把原始 JSON `pretty` 直接打印给用户；
  - 支持 Pi `extension_ui_request` 的多题问答（含密码遮罩 `isSecret`）与 `setStatus` 状态条、`setWidget` 提示条集成到会话底/顶栏。
- **内联 `<think>` 分离 + Markdown 增强 + 单条交互**：
  - 移植 `inlineThinking.ts` 处理模型把 `<think>...</think>` 吐进正文的问题；
  - `Streamdown` 接回安全外链/项目相对路径点击打开（`MarkdownLink`）、表格导出/横向滚动包装（`MarkdownTable`）、图片点击放大灯箱（`ZoomableImage`）；
  - 每条消息补齐轻量操作栏：时间戳、复制、单条 TTS 朗读开关（`VoiceMessageButton`）、分叉（仅支持分支的会话）和“编辑上一条重发（若当前 harness 支持）”。

#### 2.3 顶栏心智模型重构、配置整合胶囊与状态透明度
- **彻底区分“当前会话信息”与“新建会话动作”**：
  - 顶栏左侧清晰显示当前激活视口会话的 **Harness 徽标 + 会话标题 + 工作目录简名 + 运行状态灯**；不再让“新建会话下拉框”伪装成当前会话代理。
  - 将原分散的 `↻`、`⑂`、`▦`、`⏻` 替换为直观图标 + 文本 tooltip / 清晰次级操作菜单（如：切换布局格数、全屏/还原、打开外部目录、搜索 `Ctrl+F`、新建分支、断开进程）。
- **统一会话设置胶囊（参考 `codeg-main/SessionSettingsPicker`）**：
  - 将输入区底部零散无标签的 Model Popover、Thinking `<select>`、ACP `configOptions` `<select>` 整合为紧凑且带**明确中文标签与说明**的胶囊控件组（支持所有 `configOption` 类型而不仅限于 `select`，遇到需要重启才生效的配置项时给出 `"新设置将在下次新开/重连会话生效"` + 一键重连按钮）。
- **上下文可视化（`ContextViz`）与连接/通知闭环**：
  - 上下文不再只有一个裸数字 `42%`：显示环形微图 + 点击弹出明细浮层（`Input` / `Output` / `Cache Read` / `Cache Write` 占比、模型上下文上限、压缩中计时器、`"已压缩 · 用量待更新"` 真实状态）。
  - 恢复 OS 桌面回合完成提示（`Notification` / 参照 `piNotify.ts`，支持仅窗口未聚焦时提醒及静音开关）。

---

### Phase 3：找回 `CodexScope-dev111` 高频生产力体验（输入、侧栏、多视口与导航）

> **目标**：把旧版 Pi / Codex / Workbench 中用户已经形成肌肉记忆的高效率操作，在统一 `agent_host` 架构上全部无损找回。

#### 3.1 升级专业输入区（移植并适配 `SkillMentionInput` + Picot 补全）
- **可控高输入区**：接入原版 `SkillMentionInput`（顶部边缘拖拽自由调整高度、按 `sessionId` 记忆输入高度、光标位置与文本草稿、多行自动贴合），支持 `$skill` / `[$name](SKILL.md)` 高亮与点击展开/折叠。
- **双触发智能补全（`/` 与 `@`）**：
  - 输入 `/` 自动在光标上方弹出实时前缀过滤菜单，支持 `↑`/`↓`/`Tab`/`Enter`/`Esc`，清晰标注命令来源标签（`本地快捷` / `代理命令` / `扩展命令`），并对终端交互类扩展命令标注兼容性提示（参照 `picot-main/extension-command-compatibility.js`）；支持本地快捷命令 `/compact`、`/fork`、`/new`、`/model`、`/stop`。
  - 输入 `@` 触发工作区文件与目录路径联想（防抖模糊匹配工作区文件树 + 选中插入文件引用标签）。
- **干净的文件/图片附件芯片 & 大粘贴转附件**：
  - 资源管理器拖拽、系统原生文件拖放、剪贴板粘贴图片/文件全部走 `fs_stat` + MIME 判别：图片生成可预览缩略图芯片（支持放大查看与单张移除），普通文件/目录生成简洁 `+ 文件芯片`随消息结构化发送（彻底告别往文本框强插 `@"D:\...\file.ts"`）；
  - 参照 `composer-paste-offload.js`，超大文本（如超长报错日志 > 8KB）粘贴时自动提供转为临时文件附件芯片，避免拖垮输入框渲染。
- **精细化消息队列（Queue & Steer）**：
  - 队列列表完整展示每条排队内容的摘要与图片缩略图；每条支持：**立即插队（Steer，对应 Ctrl+Enter/按钮）**、**回填编辑（Edit）**、**上移/下移**、**单条删除**、**失败重试**。

#### 3.2 找回多视口工作台、会话侧栏秩序与全文搜索
- **多视口可控性恢复**：
  - 接回 `ViewportCount` 控件（`1 / 2 / 3 / 4 / 6` 格或 `-` / `+` 步进）与布局持久化；每格顶部标题栏支持 **双击 / `F2` 原地重命名**、**正在运行动画指示**、**清空视口归位（仅关闭界面视图不杀后台）** 与 **Pointer 拖放侧栏会话直达目标视口**。
  - 在 `App.tsx` 停靠区评估提供快捷键或清晰切换提示，恢复旧版 Terminal + Agent 的快速配合动线，并在 `Welcome` 文案及 `PluginsSection` 中更新准确的 Agent 描述。
- **侧栏秩序重建（`AgentSidebar.tsx`）**：
  - 支持多工作区自由保持展开（不再切会话就自动合拢其他项目）；
  - 恢复 **项目自定义分组与 Pointer 拖拽排序**（项目内会话与分组均可用指针拖拽调序，遵循 WebView2 规范）；
  - 每个工作区标题展示当前 **运行中会话数量角标** 与右键菜单（`在资源管理器中打开`、`复制项目路径`、`移除项目`、`导入历史扫描`）；
  - 会话右键菜单补齐：`打开文件所在目录 / 复制会话文件`、`导出为 Markdown / HTML`、`删除会话（区分仅从 Codev 移除或同时清理归档，带二次确认）`、`临时对话`快捷开关；
  - 将“全量盲导 ~1600 条历史”替换为 **两步式导入向导**：先执行只读 `history.scan` 展示发现的 Pi / Codex / Antigravity 会话条数与时间范围，由用户勾选项目批量导入，避免卡顿与侧栏污染；
  - `AgentProjectMenuItems`（资源管理器右键“添加到 Agent 工作区”）打通加载就绪自动入列、清空搜索过滤、滚动高亮到新增项目并弹出轻量提示。
- **高可用对话内搜索与导航轨**：
  - 为当前激活视口绑定 `Ctrl+F`（避免冲突），支持在**用户消息、助手正文、思考块、工具命令与参数**中全维度检索，高亮命中文本并自动展开所属折叠 `<details>`，支持 `Enter` / `Shift+Enter` 上下跳转与当前命中计数（`3 / 12`）。
  - 在长对话右侧边缘提供轻量 **对话锚点导航轨（`conv-nav`）**：快速一键跳转到任意用户提问回合或跳到底部，显示当前阅读锚点。
- **对比度与视觉层次修复**：继承旧版 `pi-agent.css` 的细腻层次令牌，拉大工具卡片、代码块、用户气泡、思考块与背景底板之间的边缘对比度和间距呼吸感，消除当前“灰蒙蒙糊成一片”的扁平感。

---

### Phase 4：环境自检诊断引擎、内置配置管理与全面回归门禁

> **目标**：让用户能自助看懂“为什么连不上 / 为什么不能用”，不用翻命令行也能搞定 Pi / Codex / Antigravity 准备与配置。

#### 4.1 `harness.diagnose` 环境诊断引擎（参照 `codeg-main/acp_env_diagnostics`）
- 新增后端命令 `harness.diagnose`，对三个内置代理与自定义 ACP 分别返回结构化诊断结果，并在设置页顶部展示 `VerdictBanner`：
  1. **可执行程序探测**：对比 **GUI 进程 PATH** 与 **交互式登录终端 PATH**（例如定位到终端里能跑 `codex` / `pi` / `agy` 但 GUI 找不到 Node/npm 全局路径的问题，给出可复制修复方案或直接使用探测到的绝对路径）；
  2. **托管运行时与登录态**：检查 `dist-agent-host` / `codev-agent-tools` 内置适配器、Node 版本、以及可安全探测的认证状态提示（例如 Codex 登录指引、Antigravity `agy` 命令行可用性）；
  3. **一键修复与脱敏失败日志**：为 `codex-acp` 等提供图形化检查/重拉与说明入口；启动失败时展示**脱敏后最近 15 行 `stderr` 尾** + 明确的排查建议，而非冷冰冰的 `"process exited"`。
- 设置页新增 **自定义 ACP 删除 / 重置为默认**、同步修好 `HarnessEditor` 选中不同 harness 时的表单双向状态重置；新增新手引导条（`WelcomeTip`，可关闭），首屏简明提示三类代理差异与快捷键。

#### 4.2 安全策略、Pi 生态配置与 Codex 配置整理
- **Per-Harness 宿主工具策略（`HostToolsPolicy`）**：允许用户在设置页或会话级开关每个 ACP 代理的本地文件读/写自主权，默认遵循“可读，写需经宿主 Diff 审批 / 显式开启自动授权”。
- **Pi 高级管理入口（保留原有深度控制力，不污染主界面）**：
  - `.pi/extensions` 项目级扩展信任提示与开关（防止打开未知仓库自动执行不信任项目内脚本）；
  - 为 Pi 用户在 `AgentSettings` 的 `Pi 高级配置` 子页中恢复核心实用能力：`APPEND_SYSTEM.md` 全局指令编辑、`models.json` 入口或安全查看/验证（严格只作用于 Pi 原生，绝不把 ACP 模型混入）、已装技能/扩展列表查看与版本检查（`PiAssetsPanel` / `PiVersionPanel` 精简收敛版）。
- **Codex 辅助配置入口**：提供 `~/.codex/AGENTS.md` 只读/编辑入口及明确标注当前 `codex-acp` 桥接支持边界（例如历史外置日志为何为只读展示与如何新建交互会话）。

#### 4.3 全链路测试矩阵
- **Rust 端 (`pnpm cargo test`)**：覆盖 `native_pi.rs`（delta、tool_execution、queue、errorMessage）、`acp.rs`（`session/load` 收尾、`.rposition`、diff 保留、`config_option_update` 合并）、`commands.rs`（`entryId` fork 与失败回滚、cancel 收口、超时边界）、`history.rs`（Pi 分支回溯、Codex `function_call`/`reasoning` 解析）、`server.rs`（far-end 脱敏与独立服务保活）。
- **前端 (`pnpm test` / Vitest)**：覆盖 `toolFormat.ts` 归一化与 Diff 提取、ProcessBlock 展开稳定性、`SkillMentionInput` 语法高亮与草稿恢复、`/` 与 `@` 补全过滤、`client.ts` `host.resync` 恢复与 401/离线路由。
- **审核热窗人工验收清单**：桌面多视口拖拽、资源管理器拖放图片/文件生成芯片、Pi 真流式+思考+Edit Diff 打开到主编辑器、Codex/Antigravity 工具卡片+权限审批+计划卡片、移动端扫码配对后直接出现可用引导视图。

---

## 四、实施优先级与依赖顺序建议

1. **先做 Phase 1**：消除所有“会误导用户判断功能好坏”的假死与流式丢失 Bug，同时把后端安全与测试用例铺平；
2. **紧接 Phase 2**：统一工具卡片、Plan、RequestCard、顶栏与配置胶囊，让界面语言变成“人类能直接读懂的操作台”；
3. **推进 Phase 3**：集中回收 `CodexScope-dev111` 的输入、拖拽芯片、队列、搜索、侧栏与视口高阶交互；
4. **收官 Phase 4**：补齐环境自检诊断、Pi/Codex 配置入口、安全信任门与全量回归。

---

## 五、核心验证点与验收口径（执行时须遵守）

- 每次涉及 Rust 代码均经 `scripts/with-cargo-cache.mjs`（`pnpm cargo check` / `pnpm cargo test`），确保产物在仓库外 `CARGO_TARGET_DIR`；
- 每次涉及 UI / 原生拖放 / 窗口交互时，以 `pnpm tauri dev --config src-tauri/tauri.portable.conf.json` 在独立 identifier 下拉起审核窗口按清单逐项验收；
- 所有改动过程中严格维持 `06-Agent使用与交互说明书.md` 与界面真实交互文案同步更新。
