# Testing

测试文档服务于当前核心：文件树、编辑器、Markdown、PTY、Shell 集成、工作区和标签/分屏。

## Running checks locally

```bash
pnpm lint
pnpm check-types
pnpm test

cd src-tauri
cargo fmt --check
cargo check
cargo test
```

CI 还会在 Linux、Windows 和 macOS 上执行 Rust 检查；本地没有 `cargo-nextest` 时使用 `cargo test` 即可。

## What must have a test

- Shell 分类、PTY 启动参数、cwd 和跨平台 Shell 初始化
- WorkspaceRegistry 的允许路径、越界路径和规范化行为
- 文件写入、重命名、删除、符号链接和搜索边界
- OSC 7/133 解析、终端历史、标签/分屏树和 renderer pool
- 任何影响多个模块的纯逻辑变更

测试应锁定真实不变量，优先覆盖边界和拒绝路径，不为 UI 样式、主题表或类型系统重复增加测试。

## Cross-platform PTY tests

平台差异使用 `#[cfg(unix)]`、`#[cfg(windows)]` 隔离。ConPTY/Job Object 测试只在 Windows 执行，Unix 进程生命周期测试只在 Unix 执行；不要把单个平台的 Shell 假设写成通用断言。

## Invariants

- PTY 改动必须验证首个终端启动和快速开关标签。
- 文件系统改动必须验证授权根目录外路径不会被访问。
- OSC 改动必须验证普通输出不会误改变 cwd 或命令状态。
- 渐进删减后先全文搜索残余入口，再运行完整回归命令。

## See also

- [`TERAX.md`](../../TERAX.md)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- [`docs/README.md`](../README.md)
