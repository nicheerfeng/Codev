import { itemText, type Item, type Turn } from "./protocol";

/** 判断上下文压缩事件，压缩只由输入区状态呈现。 */
export function isCompaction(item: Item): boolean {
  return ["contextCompaction", "context_compaction"].includes(item.type);
}

/** 仅统计原生工具条目，思考和沟通文字不计为工具调用。 */
export function isTool(item: Item): boolean {
  return (
    !["userMessage", "agentMessage", "reasoning", "plan"].includes(item.type) &&
    !isCompaction(item)
  );
}

/** 清除可确认的 shell 启动包装，无法识别时原样返回。 */
export function displayCommand(command: string): string {
  const value = command.trim();
  const match = value.match(
    /^(?:"([^"]+\.exe)"|'([^']+\.exe)'|(\S+\.exe))\s+([\s\S]+)$/i,
  );
  if (!match) return command;
  const executable = (match[1] ?? match[2] ?? match[3] ?? "")
    .split(/[\\/]/)
    .pop()!
    .toLowerCase();
  const args = match[4].trim();
  let script: string | undefined;
  if (["powershell.exe", "pwsh.exe"].includes(executable)) {
    script = args.match(
      /^(?:(?:-[\w-]+)\s+)*(?:-command|-c)\s+([\s\S]+)$/i,
    )?.[1];
  } else if (
    ["bash.exe", "bash", "sh.exe", "sh", "zsh.exe", "zsh"].includes(executable)
  ) {
    script = args.match(/^(?:(?:-[\w-]+)\s+)*-lc\s+([\s\S]+)$/i)?.[1];
  } else if (["cmd.exe", "cmd"].includes(executable)) {
    script = args.match(/^(?:(?:\/[\w]+)\s+)*\/c\s+([\s\S]+)$/i)?.[1];
  }
  if (!script) return command;
  const trimmed = script.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed[trimmed.length - 1] === quote)
    return trimmed.slice(1, -1).trim() || command;
  return trimmed || command;
}

/** 构造经过命令前缀清理的调用详情，不修改协议缓存。 */
export function displayItemDetails(item: Item): string {
  return JSON.stringify(
    item.command ? { ...item, command: displayCommand(item.command) } : item,
    null,
    2,
  );
}

/** 将真实思考或工具预览归一为从开头截断的一行文本。 */
export function activityLabel(item: Item): string {
  if (item.type === "subAgentActivity")
    return `${({ started: "子代理启动", interacted: "子代理交互", completed: "子代理完成", interrupted: "子代理停止" } as Record<string, string>)[String(item.kind)] ?? "子代理"} · ${String(item.agentPath ?? item.agentThreadId ?? "")}`;
  const text = (
    item.type === "commandExecution" && item.command
      ? displayCommand(item.command)
      : itemText(item)
  )
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (item.type === "reasoning")
    return `${item.status === "inProgress" ? "思考中" : "已思考"} · ${text}`;
  const status =
    item.status === "inProgress"
      ? "正在运行"
      : item.status === "failed"
        ? "执行失败"
        : "已完成";
  const name = item.tool ?? item.type;
  return `${status} · ${name}${text && text !== name ? ` · ${text}` : ""}`;
}

/** 只使用原生或实际收到的轮次时间，不用线程更新时间伪造消息时间。 */
export function elapsedText(turn: Turn, running: boolean, now: number): string {
  const duration =
    running && turn.startedAt != null
      ? now - turn.startedAt * 1000
      : (turn.durationMs ??
        (turn.completedAt != null && turn.startedAt != null
          ? (turn.completedAt - turn.startedAt) * 1000
          : null));
  if (duration == null) return "";
  const seconds = Math.max(0, Math.floor(duration / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
    : `${seconds}秒`;
}

/** 构建与 Pi 对齐的外层状态统计，真实内容保留在内层步骤。 */
export function processLabel(turn: Turn, running: boolean): string {
  if (running) return "进行中";
  return turn.status === "interrupted"
    ? "已停止"
    : turn.status === "failed"
      ? "执行失败"
      : "已完成";
}

export type TurnBlock = {
  id: string;
  process: boolean;
  items: Item[];
};

/** 把一轮拆成用户/最终答复与过程条；运行中的空状态条插在用户消息后面。 */
export function turnBlocks(turn: Turn, running: boolean): TurnBlock[] {
  const last = [...turn.items]
    .reverse()
    .find((item) => item.type === "agentMessage");
  const blocks: TurnBlock[] = [];
  for (const item of turn.items) {
    if (isCompaction(item)) continue;
    const message =
      item.type === "userMessage" ||
      (item.type === "agentMessage" &&
        (item.phase === "final_answer" ||
          (!running && item.phase == null && item.id === last?.id)));
    const previous = blocks[blocks.length - 1];
    if (!message && previous?.process) previous.items.push(item);
    else blocks.push({ id: item.id, process: !message, items: [item] });
  }
  if (!blocks.some((block) => block.process) && running) {
    let insertAt = -1;
    for (let index = 0; index < blocks.length; index++) {
      if (blocks[index].items[0]?.type === "userMessage") insertAt = index + 1;
    }
    const placeholder: TurnBlock = {
      id: `process-${turn.id}`,
      process: true,
      items: [],
    };
    if (insertAt < 0) blocks.unshift(placeholder);
    else blocks.splice(insertAt, 0, placeholder);
  }
  return blocks;
}

/** 工具内容按字段展示，原始协议仅留在用户主动打开的详情中。 */
export function toolOutput(item: Item): string {
  if (item.aggregatedOutput != null) return item.aggregatedOutput;
  const result = item.result as
    | { content?: Array<{ text?: string }> }
    | null
    | undefined;
  if (result?.content)
    return result.content
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
  if (typeof item.output === "string") return item.output;
  return item.status === "inProgress" ? "正在执行…" : "";
}
