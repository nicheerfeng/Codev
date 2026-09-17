export type RecommendedPiPlugin = {
  name: string;
  package: string;
  summary: string;
  repoUrl: string;
};

/** 可从 npm 安装的公开插件；不含本机 extensions 里的自研扩展。 */
export const RECOMMENDED_PI_PLUGINS: RecommendedPiPlugin[] = [
  {
    name: "MCP Adapter",
    package: "pi-mcp-adapter",
    summary: "给 Pi 接 MCP 服务，把外部工具接到对话里。",
    repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
  },
  {
    name: "Pi Lens",
    package: "pi-lens",
    summary: "代码反馈：LSP、lint、结构检查和实时诊断。",
    repoUrl: "https://github.com/apmantza/pi-lens",
  },
  {
    name: "Pi Subagents",
    package: "pi-subagents",
    summary: "单代理委派和脚本化多代理工作流。",
    repoUrl: "https://github.com/nicobailon/pi-subagents",
  },
  {
    name: "Pi Flow",
    package: "@kky42/pi-flow",
    summary: "多后端子代理和动态工作流编排。",
    repoUrl: "https://github.com/kky42/pi-flow",
  },
  {
    name: "Codex Subagents",
    package: "@ogulcancelik/pi-codex-subagents",
    summary: "Codex 风格的会话级子代理、模板和实时 overlay。",
    repoUrl: "https://github.com/ogulcancelik/pi-extensions",
  },
  {
    name: "Pi Intercom",
    package: "pi-intercom",
    summary: "本机多个 Pi 会话之间传话和协同。",
    repoUrl: "https://www.npmjs.com/package/pi-intercom",
  },
  {
    name: "Feishu / Lark",
    package: "pi-feishu-lark",
    summary: "从飞书或 Lark 继续和 Pi 对话。",
    repoUrl: "https://github.com/AX1202/pi-feishu-lark",
  },
  {
    name: "Hide Providers",
    package: "pi-hide-providers",
    summary: "从模型列表里隐藏不需要的服务商和模型。",
    repoUrl: "https://github.com/monotykamary/pi-hide-providers",
  },
  {
    name: "Rename Session",
    package: "pi-rename-session",
    summary: "给当前会话改名的小工具。",
    repoUrl: "https://github.com/bradennss/pi-rename-session",
  },
];

export function recommendedInstallSpec(packageName: string): string {
  return `npm:${packageName}`;
}

/** 已装清单或 settings.packages 是否覆盖该推荐包。 */
export function isRecommendedPluginInstalled(
  packageName: string,
  installed: { name?: string; spec?: string }[],
): boolean {
  const spec = recommendedInstallSpec(packageName).toLowerCase();
  const name = packageName.toLowerCase();
  return installed.some((item) => {
    const itemName = item.name?.replace(/\\/g, "/").toLowerCase();
    const itemSpec = item.spec?.trim().toLowerCase();
    return (
      itemName === name ||
      itemSpec === spec ||
      itemSpec === name ||
      itemSpec?.replace(/^npm:/, "") === name
    );
  });
}
