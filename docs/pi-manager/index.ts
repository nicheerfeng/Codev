import { getAgentDir, getPackageDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectManager } from './src/ipc.mjs';
import { tools } from './src/tools.mjs';

/** 将宿主公开 Extension API 接到包内管理协议，不依赖其他扩展。 */
export default function piManager(pi: ExtensionAPI) {
  const root = process.env.PI_MANAGER_ROOT ?? join(getAgentDir(), 'pi-manager');
  let ctx: ExtensionContext | undefined;
  let channel: Awaited<ReturnType<typeof connectManager>> | undefined;
  let connecting: Promise<void> | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let instance = randomUUID();
  let registeredId: string | undefined;
  const received = new Set<string>();

  /** 消息写为具名通信记录；普通通知不触发额外模型回合。 */
  async function receive(method: string, args: any) {
    if (!ctx) throw new Error('Pi session 尚未初始化');
    if (method === 'rename') { pi.setSessionName(args.name); return { name: pi.getSessionName() }; }
    if (method === 'leaf') return { entryId: ctx.sessionManager.getLeafId() };
    if (method === 'abort') { ctx.abort(); return { accepted: true }; }
    if (method !== 'deliver') throw new Error(`未知投递操作 ${method}`);
    const duplicate = received.has(args.id);
    if (duplicate) return { duplicate: true };
    pi.sendMessage({
      customType: 'pi-manager-message',
      content: JSON.stringify({ fromSessionId: args.from, messageId: args.id, mode: args.mode, replyTo: args.replyTo, text: args.text }),
      display: true, details: args,
    }, { triggerTurn: args.wake === true, deliverAs: args.wake || !ctx.isIdle() ? args.behavior : 'nextTurn' });
    received.add(args.id);
    return { accepted: true };
  }

  /** 并发调用共享一个连接；断线不会自动重发业务请求。 */
  async function ensure() {
    if (channel) return;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!ctx || stopped) throw new Error('session 已关闭');
      const active = ctx;
      const activeId = active.sessionManager.getSessionId();
      let registered = false;
      const candidate = await connectManager(root, receive, { onClose: () => {
        channel = undefined;
        if (!stopped && registered && registeredId === activeId) retry = setTimeout(() => { void ensure().catch(error => active.ui.notify(String(error), 'error')); }, 1000);
      } });
      const manager = active.sessionManager;
      const metadata = manager.getEntries().find(entry => entry.type === 'custom' && entry.customType === 'pi-manager');
      try {
        await candidate.call('register', {
          sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), cwd: active.cwd,
          title: manager.getSessionName(), model: active.model ? { provider: active.model.provider, id: active.model.id } : null,
          thinking: active.thinkingLevel, busy: !active.isIdle(), pid: process.pid, instance,
          agentDir: getAgentDir(), metadata: metadata?.type === 'custom' ? metadata.data : null,
          workerToken: process.env.PI_MANAGER_WORKER_TOKEN,
          launch: { executable: process.execPath, args: [join(getPackageDir(), 'dist', 'bundle', 'cli.js')], extension: fileURLToPath(import.meta.url) },
        });
        if (stopped || ctx?.sessionManager.getSessionId() !== activeId) { candidate.close(); return; }
        registered = true;
        registeredId = activeId;
        channel = candidate;
      } catch (error) { candidate.close(); throw error; }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }

  /** 随 session 启动和切换重新绑定身份，避免旧 parent 错收通知。 */
  pi.on('session_start', async (_event, context) => {
    stopped = true;
    clearTimeout(retry);
    channel?.close();
    channel = undefined;
    ctx = context;
    registeredId = undefined;
    received.clear();
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type === 'custom_message' && entry.customType === 'pi-manager-message' && (entry.details as any)?.id) received.add((entry.details as any).id);
    }
    stopped = false;
    instance = randomUUID();
    try { await ensure(); } catch (error) { context.ui.notify(`pi-manager: ${String(error)}`, 'error'); }
  });

  for (const definition of tools) {
    pi.registerTool({
      ...definition,
      executionMode: 'sequential',
      // 普通 JSON Schema 与宿主 TypeBox 协议结构一致，无额外运行依赖。
      parameters: definition.parameters as any,
      /** 将工具调用者的真实 session 身份交给内置协议，不通过模型参数猜测。 */
      execute: async (_id, args, signal, _update, context) => {
        ctx = context;
        await ensure();
        const input = args as any;
        const data = await channel!.call(definition.name, input, { signal, timeout: (input.timeoutMs ?? 60_000) + 120_000 });
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
      },
    });
  }

  /** 外部宿主报告原生生命周期；受管 worker 由 broker 的 RPC 事件负责。 */
  async function report(value: { type: string }, context: ExtensionContext) {
      ctx = context;
      try { await ensure(); await channel!.call('event', value); }
      catch (error) { context.ui.notify(`pi-manager 状态同步失败: ${String(error)}`, 'error'); }
  }
  pi.on('agent_start', report);
  pi.on('agent_settled', report);
  pi.on('message_end', report);
  pi.on('session_info_changed', report);
  pi.on('model_select', report);
  pi.on('thinking_level_select', report);

  /** 宿主关闭只注销当前会话，后台子 session 由独立服务持有。 */
  pi.on('session_shutdown', async () => {
    stopped = true;
    clearTimeout(retry);
    if (channel) {
      try { await channel.call('unregister', {}, { timeout: 2000 }); }
      catch { /* 断线时服务保留 stale 状态，由重新注册校准。 */ }
    }
    channel?.close();
    channel = undefined;
    ctx = undefined;
  });
}
