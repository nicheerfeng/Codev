import { itemText, type Item, type Turn } from "./protocol";

/** 仅统计原生工具条目，思考和沟通文字不计为工具调用。 */
export function isTool(item: Item): boolean {
  return !["userMessage", "agentMessage", "reasoning", "plan"].includes(
    item.type,
  );
}

/** 将真实思考或工具预览归一为从开头截断的一行文本。 */
export function activityLabel(item: Item): string {
  const prefix =
    item.type === "reasoning"
      ? item.status === "inProgress"
        ? "思考中 · "
        : "已思考 · "
      : "";
  return (
    prefix + itemText(item).replace(/\*\*/g, "").replace(/\s+/g, " ").trim()
  );
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
