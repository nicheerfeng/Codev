# 2026-09-18 渐进整理记录

本轮依据代码审查后的授权执行，保留既有未提交修改，不发布、不升版本。

| 批次 | 已完成 | 验证 |
| --- | --- | --- |
| 隔离 QA | 补齐 Tauri 窗口及模型 mock，移除过期 cwd 属性，增加真实时间线数据入口和 ui-regression.mjs | Chrome 隔离回归通过，不连接真实 Pi |
| 已确认遗留 | 删除无引用 InlineRename / NewTabMenu；删除废弃工具组统计；清理停止操作旧参数；缩小 plugins barrel 和内部函数导出 | 类型检查、544 项前端测试通过；Knip 无 unused files |
| 渲染 | 思考 Markdown、工具参数及结果只在对应记录展开时渲染；折叠状态继续保存在记录组件；摘要和动画共用一次记录选择 | 回归验证收起时无正文 DOM、展开恢复、搜索、动画与草稿保留 |
| 终端尺寸 | 六个 fit 入口共用 fitVisibleSlot，保留各入口原有时机与防抖 | Tauri 开发窗口切换插件无 resize；隐藏字距变更延后到可见时应用 |
| Rust 职责 | JSONL 摘要、分页、复制、追加、删除移至 history.rs；IPC、格式、行为保持原样 | cargo check；12 项 Pi 原生测试串行通过 |
| 检查噪音 | 普通函数 useAssetDocument 改名为 loadAssetDocument | Lint 警告 123 → 120，无错误 |

Rust pi_agent/mod.rs 从 1,555 行变为 1,021 行；新增 history.rs 631 行，包含原实现和必要模块导入、说明。
本轮不以总行数下降衡量职责拆分的收益。

## 仍保留的事项

- Knip 仍有 unused exports/types 报告，涉及跨入口、文件内部使用和测试使用，未批量删除。
- 前端会话协调层暂不进一步拆 hooks，避免仅为缩短文件而增加参数与状态同步。
- 流式数组扫描和时间线缓存等待真实长线程性能测量后再决定，不新增缓存或索引状态。
- 全仓 cargo fmt --check 仍报未改文件的既有格式差异；本轮两份 Rust 文件的独立 rustfmt 检查通过。
- 其余 120 条 Lint 警告未批量自动修复。

## 可重复执行

Pi 隔离 QA 的启动和测试命令见 [pi-agent-plugin/README.md](pi-agent-plugin/README.md)。
原生检查在 src-tauri 目录运行，以使用本机 .cargo/config.toml 中的仓库外增量缓存：

```text
cargo check
cargo test modules::pi_agent --lib -- --test-threads=1
```
