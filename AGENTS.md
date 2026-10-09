# Codev 开发规范

产品边界见 [CODEV.md](CODEV.md)。本文件只记录开发、核验和发版必须遵守的工作方式。

## Rust 缓存硬性规则

所有 Rust / Tauri 命令统一经过 `scripts/with-cargo-cache.mjs`：`pnpm cargo test`、`pnpm cargo check`、`pnpm tauri dev`。缓存按当前机器自动解析，优先使用 `CODEV_CARGO_TARGET_DIR` / `CARGO_TARGET_DIR` 指定的仓库外目录，默认使用当前用户的平台缓存目录下的 `codev-cargo-target`（Windows 为 `%LOCALAPPDATA%\codev-cargo-target`）。不固定用户名、盘符或项目所在路径；目录不存在时自动创建，候选路径不可用时回退到当前用户默认缓存。禁止写入仓库内 `target`。执行前确认没有并发编译，执行后核对实际输出路径。

小修复、交互回归、拖拽和窗口行为，禁止先打便携包。便携构建只用于正式发版。

开发窗口必须使用独立 identifier，避免和已安装的 Codev 抢单实例锁：

```bash
pnpm tauri dev --config src-tauri/tauri.portable.conf.json
```

启动入口自动生成本机的 `src-tauri/.cargo/config.toml`（已 gitignore），同步到另一台电脑后会重新解析，不沿用旧用户名。这个生成文件中的绝对路径仅属于当前机器，不要手写或提交它。复用解析后的缓存，避免重复冷编译；只有全部候选目录不可写或出现编译锁冲突时才停止并报告。不要克隆完整构建树或创建临时缓存绕过编译锁。


这条命令使用 `app.teague.codev.portable`，与安装版 `app.teague.codev` 并存。Vite 热更新走 `http://localhost:1420`，安装版不占用该端口。界面改完后由 agent 直接启动这个审核窗口，并写明要看的点和反馈方式；不要只把命令丢给用户自己跑。

核验入口按改动类型选择：

1. Dock、窗口、原生拖放、WebView 行为：必须用上面的 Tauri 开发窗口。
2. 可 mock 的 Pi 界面：用隔离 QA 页，不启动真实模型。
3. 纯逻辑：跑对应 Vitest / Rust 测试。
4. 便携包和安装包：只在用户明确要求发版时构建。

## 进程边界

- 禁止结束用户正在使用的安装版、便携版或其他 Codev 窗口。
- Windows 安装版通常位于 `%LOCALAPPDATA%\Codev\codev.exe`，以进程实际路径为准。
- 开发版位于启动入口打印的 `CARGO_TARGET_DIR` 下的 `debug/codev.exe`，禁止回落到仓库缓存。
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
