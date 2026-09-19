# Codex 插件

## 边界

独立插件默认关闭：设置 → 插件 → Codex。要求本机已经安装并配置官方 Codex CLI。使用原生配置和认证，不复制密钥，不调用 Pi 的 RPC 或 reducer。

调用链：Codex React 界面 → Tauri IPC → Rust 子进程 → `codex app-server --listen stdio://`。首次打开才启动；切换 Dock 保活；禁用插件或退出 Codev 回收自身进程。Windows 使用现有 Job Object 管理该子进程树。

## 实现

- `src-tauri/src/modules/codex_agent.rs`：CLI 定位、stdio JSONL、连接编号隔离、退出回收。
- `src/modules/plugins/codex-agent/client.ts`：initialize 握手、请求关联、线程缓存、开始/追加/停止、重命名、分叉、归档和审批。
- `protocol.ts`：Codex 原生条目的增量合并。原生协议不转换为 Pi 格式。
- `CodexPane.tsx`：与 Pi 对齐的顶部工具栏和最多六视口；切换已有线程复用历史，关闭视口保留运行。
- `CodexSidebar.tsx`：组 → 项目 → 线程、搜索、分页、pointer 排序/拖入视口、重命名、归档和宽度调整。
- `CodexTranscript.tsx`：运行中显示沟通进展，思考/工具为嵌套 details；最终答复独立显示；实际摘要尾部截断与轻量过渡、文件变更、复制及滚动记忆。
- `CodexComposer.tsx`：Pi 样式输入卡片、模型搜索、思考等级、图片粘贴、路径附件及沙箱选择。
- `sandbox.ts`：原生只读/工作区写入/完全访问映射。默认明确使用完全访问，菜单只保留三个等级；新建与分叉直接传入默认等级，恢复与发送传入所选等级；同等级保留服务端返回的网络和可写目录配置；运行中不修改等级。审批仍单独处理。

布局、项目组织、分组、排序、折叠及视口位置使用 `codev-ui-state.json` 的 `codev.codex.*` 键；会话历史仍由 Codex 持有。

## 协议与参考

本次按本机 `codex-cli 0.153.4` 生成的类型核对，生成文件放在忽略目录 `.reference-cache/codex-protocol`。CLI 升级后先重新生成并核对协议。

官方文档：https://developers.openai.com/codex/app-server

参考仓库已克隆到 `docs/ref-codexmonitor`（本地忽略，不打包、不扫描其测试）。来源 https://github.com/Dimillian/CodexMonitor，参考提交 `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`，上游 MIT LICENSE 保留在仓库内。仅参考进程桥接与事件分发思路，没有引入其远程守护进程、Git 管理或其他产品模块。

## 核验

```powershell
pnpm check-types
pnpm test
# 在 src-tauri 目录执行：
cargo check
cargo test codex_agent::tests::installed_cli_stdio_handshake --lib -- --ignored --nocapture
```

开发审核窗口：`pnpm tauri dev --config src-tauri/tauri.portable.conf.json`。

隔离 UI 页：`http://localhost:1420/docs/development/codex-agent/qa.html`。
`node docs/development/codex-agent/ui-regression.mjs` 使用本机 Chrome 与 Codex bundled Playwright，覆盖历史复用、折叠、模型弹层、重命名、六视口、pointer 拖放、并发发送、追加、审批、独立停止、沙箱参数、插件显隐和窄窗口。

真实 CLI 已验证握手与历史列表；流式、审批及发送交互采用隔离协议数据核验，未向真实模型发送任务。命令/文件修改/权限审批和用户提问有专用响应；其他服务端请求明确返回不支持，不能把这些方法视为已集成。当前未提供 ChatGPT OAuth 登录流程和自定义模型配置编辑器。

## 服务商存储与资源切换

顶部登录资源选择器始终显示，Codex 设置中提供“服务商存储”Tab。顶部提示：**多视口或仍有任务运行时不可切换资源，请退出多视口并等待任务结束。**

`$CODEX_HOME/codev.json` 保存别名、baseURL、DPAPI 加密 key、当前资源以及按 provider/资源分别保存的最近模型。原生资源沿用原有认证，不自动复制 auth.json 中的 key。自定义档案只在对应子进程中覆盖同名 provider 的地址和认证；不修改原生 config.toml/auth.json。Windows 用户或机器改变后需重新输入密钥。使用额外 command auth 或自定义认证头的 provider 当前明确拒绝仅 baseURL/key 的替换。

编辑档案只保存，不会改变运行中的进程；“重新应用当前资源”执行同样的空闲检查。目录探测只 GET `/models`，不调用模型；404/405 不能判定生成能力不可用。

前端事件汇总所有活动线程、请求和审批，包含隐藏会话；切换时暂停发送，Rust 在进程锁内检查 pending、原生 `thread/loaded/list`、`thread/read.status` 和 `thread/backgroundTerminals/list`。后台终端检查使用本机 0.153.4 的 experimental 接口，因此握手启用 experimentalApi；查询失败或未知状态会明确阻止切换。平时不对所有历史线程轮询。

核验成功后关闭 stdin，等待旧 app-server 正常退出落盘，再启动新资源并重新握手。保留界面草稿、历史和视口，下一次发送冷恢复原线程，不删除写锁、不改归档、不引入 Codex 二开。此版本是受限切换的单 runtime 实现，不是并存的资源进程池。

新增核验：`node docs/development/codex-agent/resources-regression.mjs`；Rust `cargo test installed_cli_resource_switch_checks --lib -- --ignored --nocapture` 使用临时 Codex 目录、DPAPI 假 key 验证真实 CLI 配置覆盖、后台核验和正常退出，无真实模型调用。
