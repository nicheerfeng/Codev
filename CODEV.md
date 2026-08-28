# Codev project memory

Codev 是一个基于 Tauri 2 + Rust + React 的极简代码和文档阅读器。产品核心只有四层：多项目工作区、文件树、代码/Markdown 阅读器、集成终端。

## Product boundary

保留多项目 spaces、多个 workspace roots、文件树和文件搜索、CodeMirror 语法高亮、Markdown 原文/渲染视图、xterm PTY、多标签/分屏、Shell 历史、主题和基础设置。

明确不实现扩展/插件系统、LSP、代码诊断、自动格式化、网页预览、常驻索引、AI/Agent、图形化 Git、自动启动、窗口状态插件或独立 CLI 控制平面。语法高亮用于阅读，不承担检查职责。

## Runtime model

- `src-tauri/src/lib.rs` 注册 IPC 命令并初始化 Tauri plugins、PTY、文件监听、历史和 workspace registry。
- `src/` 只负责界面状态和渲染；文件、目录、Shell、WSL 和历史操作通过 `invoke()` 调用 Rust。
- `src/app/App.tsx` 负责窗口级协调，业务逻辑放进 `src/modules/<area>/`，保持模块 barrel 精简。
- 工作区路径在 Rust 注册后才能用于 PTY 和文件操作；前端路径统一使用 `/`，Windows 边界再转换。

## Module map

- `modules/explorer`：多根文件树、搜索、文件操作和拖拽。
- `modules/editor`：CodeMirror 文本编辑、保存、语言解析和语法高亮。
- `modules/markdown`：Markdown 文件的原文/渲染阅读。
- `modules/terminal`：xterm、PTY bridge、OSC 7/133、终端搜索、分屏和 renderer pool。
- `modules/spaces`：项目空间、环境和标签持久化。
- `modules/tabs`：terminal/editor/markdown 标签联合类型和 pane tree。
- `modules/settings`、`modules/theme`：基础偏好、快捷键、主题和背景。

## Native boundary

Rust backend modules are limited to `fs`, `history`, `proc`, `pty` and `workspace`。新增 IPC 命令必须在 `lib.rs` 注册，并在对应模块中补测试。不要为了潜在未来需求预留协议、插件接口或后台服务。

PTY shell integration emits OSC 7 for cwd and OSC 133 A/B/C/D for prompt/command state。Shell 初始化脚本只负责跨平台 Shell 启动、用户配置加载和这些终端标记；不得恢复已删除的命令块、CLI 控制或 Agent 注入。

## Development checks

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo fmt --check && cargo check
```

修改顺序优先采用渐进删减：先移除入口、状态、持久化和测试，再删除孤立模块，最后用全文搜索和回归命令确认无残留。任何相邻问题只记录，不在当前范围内顺手修复。
