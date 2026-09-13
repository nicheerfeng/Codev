# Codev 0.9.4

本次更新继续优化 Pi Agent 的会话交互，并加入技能与插件只读展示。

## Pi Agent

- 优化压缩前后的阅读适配，压缩状态、队列输入和进度感知更加连贯。
- 新增独立 Pi `session_manager` 插件及 Codev 适配，支持 session 的跨线程管理和对话，以便支持 agentic 任务级别开发。
- 新增技能和插件展示系统，支持 Pi 技能目录、共享技能目录及 Pi extensions 的卡片化只读浏览，并提供刷新检查。
- 长会话默认加载最近 150 条消息，上翻继续加载更早记录，并保持阅读位置。

## 下载

- Codev-0.9.4-Windows-x64-Setup.exe
- Codev-0.9.4-Windows-x64-Portable.exe

Pi 功能需要本机安装 Pi Coding Agent 并配置可用模型。
