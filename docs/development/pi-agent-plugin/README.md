# Codev Pi Agent 插件专项

本目录是 Pi Agent 插件的长期开发记忆。功能实现、测试和交付必须以这里记录的边界、状态模型和验收标准为准，避免长程迭代中重新发明协议或扩张产品范围。

## 文档索引

- [执行规划](./执行规划.md)：架构、阶段、数据流、测试矩阵、验收标准和失败恢复。
- [参考快照](./参考快照.md)：已下载上游材料、固定提交及可复用范围。
- [2026-09-10 重构进度](./重构进度.md)：当前有效的 mcode/Zeno 适配范围、备份点和验收进度，覆盖旧 UI 决策。

## 已确认结论

1. Pi Agent 作为 Codev 内置插件，默认关闭，在设置页独立启用。
2. 入口位于右侧 Dock，与终端、JSON 格式化和文本对照平级。
3. 后端使用 Pi 官方 `--mode rpc` 严格 JSONL 协议，不解析或模拟 TUI。
4. 不嵌入完整 Next.js、Fastify、Electron 或 Expo 应用，不新增常驻 Node Web 服务。
5. 复用 Pi 原生模型配置、凭据、扩展、技能和 `~/.pi/agent/sessions` 会话文件。
6. UI 按 mcode 组/项目/归档和输入布局改用 Codev 控件；Zeno 提供逐 turn 聚合和滚动交互参考。原 pi-web 方案已被本轮替代。

## 当前状态

Pi Agent 已进入 `main`。0.9.2 收敛运行时简约感知态、队列消息和 Dock 标签任意顺序拖拽。界面核验使用 `pnpm tauri dev --config src-tauri/tauri.portable.conf.json`。本机参考源码仍可存在 `docs/ref-piagent/`，但不进仓库、不参与产品构建。

## 隔离界面回归

先运行 `pnpm exec vite --config docs/development/pi-agent-plugin/qa.vite.config.ts`。
浏览器访问 `http://127.0.0.1:1422/docs/development/pi-agent-plugin/qa.html`，全部 Pi IPC 使用内存 mock，不启动真实模型。

自动回归使用本机已有 Chrome 和 Codex runtime 内的 Playwright，无需安装包：

```powershell
node docs/development/pi-agent-plugin/ui-regression.mjs C:/Users/79988/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright
```

脚本参数为现有 Playwright 模块路径。覆盖停止后原位编辑及重发、草稿保留、真实内容预览、折叠正文按需渲染、展开状态保持、搜索定位、状态动画及减少动态效果偏好。
`qa.html?transcript` 是同一入口的时间线固定数据模式，测试通过 `window.piQA.setTranscript` 驱动真实组件。
