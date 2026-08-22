# Security model

Codev 的安全重点是文件、Shell、PTY 和前端 IPC 边界。项目没有网络代理、密钥服务或 AI 工具运行时，安全模型保持在本地工作区范围内。

## Boundaries

1. **IPC boundary**：前端只能调用 `src-tauri/src/lib.rs` 注册的命令，插件 API 由 `src-tauri/capabilities/default.json` 控制。
2. **Workspace boundary**：Rust 的 `WorkspaceRegistry` 记录已授权的工作区根目录；PTY 和文件命令在边界校验路径。
3. **PTY boundary**：Shell 由 Rust 创建，输出以字节流传回前端；Windows 子进程归入 Job Object，避免窗口退出后遗留进程。
4. **Terminal escape boundary**：OSC 7/133 只更新 cwd、提示符和命令状态，不执行终端输出中的文本。

## File operations

文件读写、创建、重命名、删除和搜索都从 `src-tauri/src/modules/fs/` 进入。新增文件命令必须复用工作区授权和现有路径规范化逻辑，不在前端直接调用 Node、Shell 或文件系统 API。

## Workspace authorization

- `workspace_authorize` 注册用户明确选择的根目录。
- PTY 创建前检查 cwd 是否属于已授权根目录。
- WSL 工作区使用同一工作区模型，不绕过前端选择流程。

## Terminal safety

终端会解析 OSC 7/133 来跟踪 cwd 和命令状态。解析器必须限制输入长度、过滤控制字符并区分 Shell 自己发出的标记和普通输出；不能因为“看起来像路径”就执行命令或扩大授权范围。

## Invariants

- 新增文件系统或进程命令必须经过 Rust 边界和 workspace registry。
- capability 只授予当前功能需要的最小权限。
- 关闭标签、窗口和应用时释放 PTY；隐藏终端只能按 renderer pool 规则保留。
- 不引入隐式网络请求、后台扫描、插件加载或凭据存储。

## See also

- [`TERAX.md`](../../TERAX.md)
- [`docs/README.md`](../README.md)
- [Two-process model](two-process-model.md)
- [PTY shell integration](pty-shell-integration.md)
