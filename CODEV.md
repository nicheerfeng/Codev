# Codev project memory

Codev 基于 Tauri 2、Rust 和 React。桌面工作方式保留多项目、多根目录、文件阅读与编辑、终端、主题和右侧工具区；代理接入已按用户批准的三段方案重构为共享 Rust 主机。

开发窗口、缓存、进程边界和发版规范见 [AGENTS.md](AGENTS.md)。本轮实现与人工审核边界见 [重构实施记录](docs/agent-harness-rebuild/04-开发与核验记录.md)。

## 产品边界

- 保留 CodeMirror 阅读与编辑、Markdown/PDF/HTML/图片预览、文件搜索、工作区、终端分屏、Shell 历史、玻璃感主题和 Windows 原生交互。
- 内置工具包括 JSON 格式化、文本对照和统一 Agent 工作区；插件仍由用户开启。
- Agent 工作区采用一个 Rust 主机、多个独立代理运行时、桌面与手机共用连接协议的方式。
- Pi 直接运行原生 `pi --mode rpc`，其他代理作为独立 ACP 进程；不能把外部代理的模型注册进 Pi。
- 此次没有实现第三方界面插件市场、语言服务器或代码诊断产品功能。

## 运行模型

- `src-tauri/src/modules/agent_host/` 拥有运行实例、原生协议、请求去重、审批、消息投影、历史绑定和设备授权。
- `src/modules/agent/` 是共享的 React 客户端界面。界面只能通过主机快照与增量事件更新运行状态，不能重新实现 Pi 或 ACP 状态机。
- 桌面通过唯一的 `agent_host_bootstrap` 原生命令取得本机连接地址和临时令牌，随后使用 WebSocket。手机使用设备配对令牌访问同一服务。
- `src-tauri/src/bin/codev-server.rs` 是独立服务入口，不启动桌面窗口，复用同一套主机实现。
- 文件、目录、普通终端、WSL、原生窗口和通知仍保留 Codev 原有系统服务边界。远程客户端不能调用任意 Tauri 命令。

## 数据归属

- 原生 Pi JSONL、Codex 历史和各命令行程序的认证保持原样。
- 主机 SQLite 保存工作区、会话绑定、偏好和设备令牌哈希，不复制原生会话作为另一份消息真相。
- 内存中的消息是可限制大小、可重新读取的展示投影。实时连接推送增量消息及有序元数据，不反复广播整段历史。
- 没有原生恢复能力的历史明确标为只读。ACP 代理是否回放历史由真实能力决定，不能伪造恢复成功。
- 运行实例标识每次重启更换；请求和审批不得写入过期实例。

## 模块地图

- `modules/agent`：统一 Agent 右侧界面、项目会话栏、多视口、消息、输入区、主机设置、手机配对页面。
- `modules/voice`：从原插件分离的桌面公共语音能力，沿用既有默认语音存储以保持配置兼容。
- `modules/plugins`：轻量工具开关与右侧工具容器，不再承载各代理的独立运行时。
- `modules/explorer`、`modules/editor`、`modules/markdown`、`modules/reader`：文件工作区和阅读编辑能力。
- `modules/terminal`：普通终端、多视口、Shell 集成和搜索；已解除旧混合工作台耦合。
- `modules/settings`、`modules/theme`、`modules/spaces`、`modules/tabs`：基础桌面体验。

## 旧代码隔离

用户要求尽量避免删除。旧 `pi-agent`、`codex-agent`、`antigravity-agent`、`workbench` 和依赖它的旧浏览器插件已退出入口和依赖图。当前文件权限同时阻止目录重命名，因此这些原文件暂时原位保留，并从 TypeScript、代码检查和测试入口中排除，供用户后续处理。

Rust 旧 `pi_agent`、`codex_agent`、`antigravity_agent` 不再由模块表、状态管理或原生命令注册引用。不要为了通过旧测试重新暴露这些入口。

## 构建与审核

新前端产物输出到 `dist-agent-host/`，避免清空旧 `dist`。其中 `mobile.html` 是手机浏览器入口；桌面包携带同目录资源，独立服务也可通过 `CODEV_WEB_DIR` 指定资源路径。

所有 Rust/Tauri 命令必须经过 `scripts/with-cargo-cache.mjs`，不能写仓库内 `target`，不能并行编译。

本轮只运行类型检查、编译和静态诊断，不主动运行业务测试或发送真实模型提示词。后续业务测试按用户具体指令执行。

审核窗口统一通过 `scripts/start-review.ps1` 启动，使用独立 identifier，不能结束安装版进程。未经用户明确指令，不升版本、不打包发版、不提交或推送。
