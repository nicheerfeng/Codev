import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** 在隔离 Pi 中暴露测试命令，直接运行真实注册工具而无需付费模型决策。 */
export default async function harness(pi: ExtensionAPI) {
  const manager = (await import(process.env.PI_MANAGER_TEST_ENTRY ?? new URL('../index.ts', import.meta.url).href)).default;
  const registered = new Map<string, ToolDefinition<any, any>>();
  manager({ ...pi, registerTool(tool: ToolDefinition<any, any>) { registered.set(tool.name, tool); pi.registerTool(tool); } } as ExtensionAPI);
  pi.registerCommand('pm-test', {
    description: 'Isolated pi-manager verification only',
    /** 接收测试请求并将实际工具结果回传为原生 entry 事件。 */
    handler: async (input, ctx) => {
      const { id, name, args } = JSON.parse(input);
      try {
        const tool = registered.get(name);
        if (!tool) throw new Error('missing tool');
        const result = await tool.execute(id, args, undefined, undefined, ctx);
        pi.appendEntry('pi-manager-test', { id, result: result.details });
      } catch (error) { pi.appendEntry('pi-manager-test', { id, error: String(error) }); }
    },
  });
}
