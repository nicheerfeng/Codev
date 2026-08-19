# Terax contributor documentation

这些文档服务于当前最小产品：多项目工作区、文件树、代码/文档阅读器和集成终端。

## Getting started

- [项目架构](../TERAX.md) - 当前模块边界与开发约定
- [贡献指南](../CONTRIBUTING.md) - 质量要求、目录结构和检查命令
- [测试指南](contributing/testing.md) - 前端与 Rust 回归测试

## Architecture

- [双进程模型与 IPC](architecture/two-process-model.md) - Rust 后端、前端调用边界和命令目录
- [PTY Shell 集成](architecture/pty-shell-integration.md) - PTY、Shell 初始化、OSC 7/133、ConPTY、WSL
- [安全模型](architecture/security-model.md) - IPC、路径、文件和终端转义序列边界
- [终端渲染器池](architecture/terminal-renderer-pool.md) - 槽位复用、DormantRing 和隐藏终端保活

开发过程中的裁剪记录见 [二开规划](二开规划.md)。
