## Pi 空思考


针对用户指定的本地线程，读取时的快照有 67 个 thinking content block，其中 44 个正文为空。仅记录计数，不将会话内容或签名复制到仓库。

原时间线只把 turn 最后一项为 assistant message 的情况提取为独立回复。正文后跟空 thinking 时，会让整轮（包括最终回复）进入过程折叠。

修复仅调整展示和输入类型防御：

- 过滤空白、仅不可见字符/替换字符、非字符串思考，以及空助手正文。
- 在判断最后回复之前过滤，保持最终回复独立显示。
- 原始 session 文件、items 数组和 contentIndex 均保留，避免打乱流式 ID。
- 真实思考、工具结果、用户图片、解析错误提示均保留。
- 仅有空流式块时沿用单一运行占位，正文到达后才显示思考步骤。

独立页面：`/docs/development/pi-agent-plugin/empty-thinking-qa.html`。
已自动核验最终回复位于折叠框外、空思考卡片消失、真实思考保留、运行占位和后续内容显示正常。

## 检查

`	ext
pnpm check-types
pnpm exec vitest run src/modules/plugins/pi-agent/transcriptVisibility.test.ts src/modules/plugins/pi-agent/timeline.test.ts src/modules/plugins/pi-agent/reducer.test.ts
`

独立页面：/docs/development/pi-agent-plugin/empty-thinking-qa.html。PDF 搜索实现及其隔离 QA 已移除。
