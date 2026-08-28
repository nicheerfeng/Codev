# Two-process model and IPC command reference

Codev 由 Rust 后端和前端 WebView 组成。Rust 负责文件、目录、PTY、Shell 和工作区状态；前端负责界面、编辑器、文件树、Markdown 视图和终端渲染。

前端不直接访问文件系统或创建进程，所有主机操作都通过 `invoke()` 调用 `src-tauri/src/lib.rs` 注册的命令。

## Adding an IPC command

1. 在 `src-tauri/src/modules/<area>/` 添加 Rust 命令。
2. 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册。
3. 在对应的 `src/modules/<area>/lib/` 添加轻量前端调用。
4. 为路径、工作区和平台边界补充测试；避免引入常驻服务或额外运行时。

## Command groups

### PTY

`pty_open`、`pty_write`、`pty_resize`、`pty_close`、`pty_close_all`、`pty_has_foreground_process`、`pty_has_foreground_job`、`pty_shell_name`、`pty_list_shells`。

### Files and search

目录树：`list_subdirs`、`fs_read_dir`、`fs_list_drives`、`fs_list_files`；文件：`fs_read_file`、`fs_write_file`、`fs_stat`、`fs_canonicalize`；变更：`fs_create_file`、`fs_create_dir`、`fs_rename`、`fs_delete`、`fs_copy`；监听：`fs_watch_add`、`fs_watch_remove`；搜索：`fs_search`、`fs_grep`、`fs_grep_interactive`、`fs_glob`。

### Workspace and history

工作区：`wsl_list_distros`、`wsl_default_distro`、`wsl_home`、`workspace_authorize`、`workspace_current_dir`。历史：`history_suggest`、`history_commands`、`history_record`、`history_list`。

### Window and launch

`get_launch_dir`、`get_launch_files`、`open_settings_window`。启动参数中的目录作为工作区，文件作为待打开标签；macOS 的“打开方式”事件走同一套入口。

## Invariants

- 文件和进程操作只能从 Rust 边界进入。
- 新命令必须注册并覆盖路径、工作区和平台约束。
- 终端输出按字节流处理，不能把终端内容当作可执行代码。
- 新功能必须服务于文件树、阅读器、终端或多项目工作区，避免恢复插件、后台索引和重复抽象。

## See also

- [`CODEV.md`](../../CODEV.md) - 当前架构边界
- [`docs/README.md`](../README.md) - 文档索引
- [PTY shell integration](pty-shell-integration.md) - PTY 与 Shell 集成
- [Security model](security-model.md) - IPC、路径和终端安全边界
