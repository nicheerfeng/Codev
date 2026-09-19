export const CODEX_COMMANDS = [
  { name: "compact", description: "压缩当前线程上下文" },
  { name: "fork", description: "分叉当前线程" },
  { name: "new", description: "在当前项目新建线程" },
  { name: "model", description: "打开模型选择" },
  { name: "stop", description: "停止当前运行轮次" },
] as const;

/** 只识别独立 slash 指令，参数是否支持由对应操作明确校验。 */
export function parseCommand(text: string) {
  const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match
    ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" }
    : null;
}
