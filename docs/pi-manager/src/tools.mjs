const text = { type: 'string', minLength: 1 };
const boolean = { type: 'boolean' };
const number = { type: 'integer', minimum: 0 };
const page = { cursor: text, limit: { type: 'integer', minimum: 1, maximum: 200 } };
const model = { type: 'object', properties: { provider: text, id: text }, required: ['provider', 'id'], additionalProperties: false };

/** 生成独立工具协议，参数结构随插件发布而非依赖外部 schema 包。 */
function tool(name, description, properties, required = []) {
  return { name, label: name, description, promptSnippet: description, executionMode: 'sequential', parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const tools = [
  tool('pv_session_create', '创建独立持久 Pi session；可附首条 message，模型默认继承当前 session。', { title: text, cwd: text, message: text, model, thinking: text }),
  tool('pv_session_list', '分页查看默认可见 session；global=true 显式查询全部索引，可按 cwd/status/父树筛选。', { ...page, cwd: text, archived: boolean, status: text, parent: text, descendants: boolean, global: boolean }),
  tool('pv_session_read', '读取默认可见或 global=true 显式授权的 session 最近一页。', { sessionId: text, global: boolean, ...page }),
  tool('pv_session_rename', '修改默认可见或 global=true 显式授权的 session 名称。', { sessionId: text, name: text, global: boolean }, ['name']),
  tool('pv_session_archive', '归档或恢复默认可见或 global=true 显式授权的 session。', { sessionId: text, archived: boolean, global: boolean }),
  tool('pv_session_fork', '从默认可见或 global=true 显式授权的 session 创建分支。', { sessionId: text, entryId: text, name: text, global: boolean }),
  tool('pv_dynamic_rename', '主 agent 和 subagent 动态重命名自身 session。', { name: text }, ['name']),
  tool('pv_message_send', '发送定向消息；默认只收信不启动空闲 agent，wake=true 才唤醒。运行中按 steer/followUp 投递。id 可用于幂等重试。', { to: text, text, id: text, wake: boolean, behavior: { enum: ['steer', 'followUp'], type: 'string' } }, ['to', 'text']),
  tool('pv_message_ask', '向在线 session 询问并等待精确回复；超时保留 requestId 可查 inbox，避免重复发送。', { to: text, text, id: text, timeoutMs: number }, ['to', 'text']),
  tool('pv_message_reply', '回复收到的 ask。必须传其 replyTo 消息 ID，回复直接唤醒对方等待工具。', { replyTo: text, text }, ['replyTo', 'text']),
  tool('pv_message_inbox', '分页查看自身消息、最终答复与投递回执。unknown 表示不能确认是否执行，禁止盲目重发。', { ...page, delivery: text }),
  tool('pv_subagent_spawn', '异步创建 fresh-context 子 session；name 在当前 parent 内唯一，可选 profile/provider/model/thinking。', { name: text, role: text, profile: text, provider: text, message: text, model, thinking: text }, ['name', 'message']),
  tool('pv_agent_profiles', '列出当前 cwd 的公共与项目 agent profile；项目同名定义覆盖公共定义。', { cwd: text }),
  tool('pv_subagent_list', '分页读取自身直接子 session；descendants=true 包含当前树后代，不混入其他树。', { ...page, descendants: boolean, status: text, role: text, archived: boolean }),
  tool('pv_subagent_read', '读取子 session 的终轮返回与增量历史。', { sessionId: text, ...page }, ['sessionId']),
  tool('pv_subagent_wait', '事件驱动等待任一所选子 session 的终轮或发来的问题/消息；支持 cursor 去重、取消和超时。', { sessionIds: { type: 'array', items: text, minItems: 1, maxItems: 200 }, cursor: { type: 'object', additionalProperties: number }, timeoutMs: number }, ['sessionIds']),
  tool('pv_subagent_stop', '中断子 session 当前回合并取消尚未投递消息，保留 session 供 followup 续作。', { sessionId: text }, ['sessionId']),
  tool('pv_subagent_followup', '向既有子 session 续派：空闲时唤醒同一 session，运行中默认 followUp，也可 steer。', { sessionId: text, message: text, behavior: { type: 'string', enum: ['steer', 'followUp'] } }, ['sessionId', 'message']),
];
