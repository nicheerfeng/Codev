# Codev 开发规范

产品边界见 [CODEV.md](CODEV.md)。本文件只记录开发、核验和发版必须遵守的工作方式。

## 界面核验

小修复、交互回归、拖拽和窗口行为，禁止先打便携包。便携构建只用于正式发版。

开发窗口必须使用独立 identifier，避免和已安装的 Codev 抢单实例锁：

```bash
pnpm tauri dev --config src-tauri/tauri.portable.conf.json
```

这条命令使用 `app.teague.codev.portable`，与安装版 `app.teague.codev` 并存。Vite 热更新走 `http://localhost:1420`，安装版不占用该端口。

核验入口按改动类型选择：

1. Dock、窗口、原生拖放、WebView 行为：必须用上面的 Tauri 开发窗口。
2. 可 mock 的 Pi 界面：用隔离 QA 页，不启动真实模型。
3. 纯逻辑：跑对应 Vitest / Rust 测试。
4. 便携包和安装包：只在用户明确要求发版时构建。

## 进程边界

- 禁止结束用户正在使用的安装版、便携版或其他 Codev 窗口。
- 安装版路径通常是 `C:\Users\79988\AppData\Local\Codev\codev.exe`。
- 开发版路径是 `src-tauri/target/debug/codev.exe`。
- 发现单实例冲突时，改用便携 identifier 启动开发窗口，不要杀安装版。
- 关闭开发窗口时，只结束 debug 进程和对应 `tauri dev` / Vite，不动安装版。

## 拖拽与排序

窗口开启了 Tauri 原生文件拖放。HTML5 `draggable` 会在 WebView2 里变成系统禁止光标。文件标签、终端树、工作区根目录和右侧 Dock 标签一律用 pointer 捕获排序，不要再接 `dataTransfer` / `onDragOver` / `onDrop`。

## 发版规范

- 未得到用户明确指令，不升版本、不打 tag、不推 GitHub Release。
- 用户可见的更新说明只写功能变化，禁止写入文件大小、SHA-256 或其他校验编码。
- GitHub Release 正文、发布说明和对外更新提示都遵守上一条。
- 校验文件可以留在本地 `artifacts/`，不要贴进更新文案。

错误示例：

```text
Codev-0.9.2-Windows-x64-Portable.exe（7,809,536 bytes，SHA-256 F0B4...）
```

正确示例：

```text
修复 Pi Agent 运行状态显示，改为类似 Codex 的运行时简约感知态，支持队列消息等。
支持终端和标签的任意顺序拖拽。
```
