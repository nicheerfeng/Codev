# pi-manager 0.1.0 验证记录

日期：2026-09-24。

## 环境

- Windows，Node.js 22.23.1。
- 独立包开发依赖安装的 Pi 0.85.1；插件声明兼容 Pi 0.85.x。
- IPC 使用真实 Windows named pipe；模型端使用本地 HTTP 模拟 OpenAI completions 流。
- Pi 测试配置、会话和邮箱全部位于临时目录，未安装到用户全局 Pi，未使用真实模型认证。

## 已通过

`npm run check`：Pi 官方扩展接口类型检查通过。纯 Node 核心模块由实际执行的协议/集成测试验证；不将该检查表述为全部 JavaScript 的严格类型检查。

`npm test`：20 项通过，0 失败。

- 独立 pv_ 工具 schema 与命令数量。
- 动态标题规范化、自适应默认并发和配置覆盖。
- LF 分帧、跨块中文与 Unicode 分隔符。
- 父子原生 JSONL 同目录、字节游标读取和指定分支 fork。
- 归档/恢复只改索引，不更改对话或运行状态。
- 后代隔离、分页和重复名称拒绝。
- 在线 ask/reply、幂等消息、离线邮箱恢复。
- 按接收 session/发送 session 的邮箱索引增量读取；查询不会枚举共享消息目录。
- 父 wait 被子 ask 唤醒、精确回复解除子等待。
- 超时、取消、等待 cursor 与监听清理。
- 排队取消、运行中停止以及同 session 续作。
- IPC 认证、断线拒绝 pending、broker 冷启动、复用及重新启动。
- 12 个同层 session 在并发上限下排队，不把接受回执当作完成。
- 异常 EOF 释放配额并反馈失败。
- 真实 Pi 冷创建子 session、模型调用 pv_dynamic_rename、终轮结果、同 session 再执行、归档与 fork。
- 真实 Pi 单配额下两层递归，子代理继续创建自己的子 session 并等待完成。

`npm run pack:verify`：打包文件清单及导入边界检查通过。将 tgz 解压到临时目录后，加载解压后的扩展再次跑完真实 Pi 集成流程；其管理源码无需项目外的扩展私有路径。

交付产物：`artifacts/pi-manager-0.1.0.tgz`。包内包含入口、核心源码、README、许可证及参考声明，未包含 node_modules、测试配置、用户资源或 Codev 文件。

验证结束后检查：没有命令行指向本轮测试临时目录的残留进程。

## 证据范围

本轮证明了 Windows + Pi 0.85.1 环境下的上述流程。尚未进行持续数天的运行观察、macOS/Linux 实机测试或所有第三方模型渠道测试。任意外部客户端绕过插件自行写同一 JSONL 不在插件锁的控制范围内。投递确认丢失时返回 unknown，不承诺崩溃场景下模型执行严格 exactly-once。

后续复验：在此独立包目录运行 `npm ci --ignore-scripts`、`npm run verify`、`npm run pack:verify`。
