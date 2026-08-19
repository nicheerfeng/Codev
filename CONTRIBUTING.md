# Contributing to Terax

Terax 采用小核心、低依赖的产品方向。贡献应围绕多项目工作区、文件树、代码/文档阅读器和集成终端展开。

## Quick start

```bash
pnpm install
pnpm tauri dev
```

依赖 Rust stable、Node.js 22+、pnpm 和当前平台的 [Tauri prerequisites](https://tauri.app/start/prerequisites/)。

## Before opening a change

先阅读 [ROADMAP.md](ROADMAP.md)、[TERAX.md](TERAX.md) 和 [docs/README.md](docs/README.md)。大型改动、架构调整和新依赖应先在 issue 中确认范围；小型 bug 修复、测试和文档修正可直接提交。

每个改动只解决一个问题。不要顺手重构相邻模块、恢复已删除功能或添加备用配置。

## Quality bar

提交前运行：

```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo fmt --check
cd src-tauri && cargo check
```

触及 PTY、Shell、工作区授权、文件写入、标签/分屏和 OSC 解析时，必须补充或更新对应测试。UI 样式、主题和语法高亮表通常不需要额外测试。

## Project layout

```text
src-tauri/
  src/lib.rs              Tauri command registration
  src/modules/fs/         File tree, read/write, watch and search
  src/modules/history/    Shell history persistence
  src/modules/pty/        PTY sessions and shell integration
  src/modules/workspace.rs  Workspace roots and WSL environments

src/
  app/                    Main window coordinator and workspace surface
  modules/editor/         CodeMirror editor and language highlighting
  modules/explorer/       File tree and file actions
  modules/markdown/       Raw/rendered Markdown reader
  modules/spaces/         Multi-project spaces
  modules/tabs/           Tab and split-pane state
  modules/terminal/       xterm sessions and renderer pool
  modules/settings/       Preferences and settings window
  modules/theme/          App and editor themes
```

## Scope rules

项目不接受扩展/插件系统、LSP、代码诊断、自动格式化、网页预览、常驻索引、图形化 Git、AI/Agent 或独立 CLI 控制平面。终端中已有的 Shell 工具可以完成这些工作，不需要在阅读器内复制一套运行时。

新增依赖必须说明它直接减少核心复杂度或解决当前平台问题；能用现有模块完成的功能不要新增抽象层。

## Style

遵循现有 TypeScript、Rust 和 Biome 格式。注释说明设计原因，不重复代码行为。提交信息使用 Conventional Commits，例如 `fix(terminal): keep cwd after cd`。
