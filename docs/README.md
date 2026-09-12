# Codev contributor documentation

这些文档服务于当前产品：多项目工作区、文件树、代码/文档阅读器、集成终端，以及默认关闭的内置插件。

## Getting started

- [项目架构](../CODEV.md) - 当前模块边界与开发约定
- [开发规范](../AGENT.md) - 开发窗口、核验入口和发版文案
- [贡献指南](../CONTRIBUTING.md) - 质量要求、目录结构和检查命令
- [测试指南](contributing/testing.md) - 前端与 Rust 回归测试

## Architecture

- [双进程模型与 IPC](architecture/two-process-model.md) - Rust 后端、前端调用边界和命令目录
- [PTY Shell 集成](architecture/pty-shell-integration.md) - PTY、Shell 初始化、OSC 7/133、ConPTY、WSL
- [安全模型](architecture/security-model.md) - IPC、路径、文件和终端转义序列边界
- [终端渲染器池](architecture/terminal-renderer-pool.md) - 槽位复用、DormantRing 和隐藏终端保活

## Product notes

- [发布记录](发布记录.md) - 正式版本、验证结果与交付文件
- [Codev 0.9.2 发布说明](Codev-0.9.2-发布说明.md) - 当前版本说明
- [Pi Agent 插件专项](development/pi-agent-plugin/README.md) - 插件边界、RPC 模型与重构记录
