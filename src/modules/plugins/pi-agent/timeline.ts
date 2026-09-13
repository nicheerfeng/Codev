import type { PiToolItem, PiTranscriptItem } from "./types";

export type PiTimelineBlock =
  | { id: string; kind: "item"; item: PiTranscriptItem }
  | {
      id: string;
      kind: "process";
      items: PiTranscriptItem[];
      steps: PiTimelineStep[];
      running: boolean;
      label: string;
      startedAt?: number;
      finishedAt?: number;
    };

export type PiTimelineStep = {
  id: string;
  kind: "thinking" | "narrative" | "tool-group";
  item?: PiTranscriptItem;
  items?: PiToolItem[];
};

/** 从工具步骤中提取首个开始时间或最后结束时间。 */
function toolTime(
  items: PiTranscriptItem[],
  field: "startedAt" | "finishedAt",
): number | undefined {
  const tools = items.filter((item) => item.kind === "tool");
  const item = field === "startedAt" ? tools[0] : tools[tools.length - 1];
  return item?.kind === "tool" ? item[field] : undefined;
}

/** 从消息或工具项读取可用于过程耗时计算的时间。 */
function itemTime(item: PiTranscriptItem): number | undefined {
  if (item.kind === "message" || item.kind === "thinking")
    return item.timestamp;
  return item.startedAt ?? item.finishedAt;
}

/** 从后往前取本轮最后一个可用时间，避免完成后退回当前时刻。 */
function lastItemTime(items: PiTranscriptItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const time = itemTime(items[index]);
    if (time !== undefined) return time;
  }
}

/** 将连续工具项收纳为一个时间线步骤，保留工具调用顺序。 */
function groupTimelineSteps(items: PiTranscriptItem[]): PiTimelineStep[] {
  const steps: PiTimelineStep[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      steps.push({
        id: item.id,
        kind: item.kind === "thinking" ? "thinking" : "narrative",
        item,
      });
      continue;
    }
    const previous = steps[steps.length - 1];
    if (previous?.kind === "tool-group") previous.items?.push(item);
    else
      steps.push({
        id: `tools-${item.id}`,
        kind: "tool-group",
        items: [item],
      });
  }
  return steps;
}

/** 参考 Zeno：同一用户 turn 聚合思考、工具和中间叙述，最后回复独立呈现。 */
export function buildTimelineBlocks(
  items: PiTranscriptItem[],
  running: boolean,
  timing: { startedAt?: number; finishedAt?: number } = {},
): PiTimelineBlock[] {
  const blocks: PiTimelineBlock[] = [];
  let turn: PiTranscriptItem[] = [];
  let turnStartedAt: number | undefined;
  /** 将一轮执行记录折叠到一个过程块中。 */
  const flush = (open: boolean, useLiveTiming = false) => {
    if (!turn.length) return;
    const last = turn[turn.length - 1];
    if (!last) return;
    const final =
      last.kind === "message" && last.role === "assistant" && !last.streaming
        ? last
        : null;
    const steps = final ? turn.slice(0, -1) : turn;
    if (steps.length) {
      const timelineSteps = groupTimelineSteps(steps);
      const liveTool = steps.find(
        (item) => item.kind === "tool" && item.status === "running",
      );
      const itemStart =
        turnStartedAt ?? toolTime(steps, "startedAt") ?? itemTime(steps[0]);
      const itemEnd =
        (final ? itemTime(final) : undefined) ??
        toolTime(steps, "finishedAt") ??
        lastItemTime(final ? [final, ...steps] : steps);
      const startedAt = useLiveTiming
        ? (timing.startedAt ?? itemStart)
        : itemStart;
      let finishedAt: number | undefined;
      if (!open)
        finishedAt = useLiveTiming ? (timing.finishedAt ?? itemEnd) : itemEnd;
      blocks.push({
        id: `process-${steps[0].id}`,
        kind: "process",
        items: steps,
        steps: timelineSteps,
        running: open,
        startedAt,
        finishedAt,
        label:
          liveTool?.kind === "tool"
            ? `正在执行 ${liveTool.name}`
            : open
              ? "处理中"
              : "已完成",
      });
    }
    if (final) blocks.push({ id: final.id, kind: "item", item: final });
    turn = [];
    turnStartedAt = undefined;
  };
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      flush(false);
      blocks.push({ id: item.id, kind: "item", item });
      turnStartedAt = item.timestamp;
    } else turn.push(item);
  }
  flush(running, true);
  if (running && !blocks.some((block) => block.kind === "process"))
    blocks.push({
      id: "process-live",
      kind: "process",
      items: [],
      steps: [],
      running: true,
      label: "处理中",
      startedAt: timing.startedAt,
    });
  return blocks;
}

/** 提取完整搜索文本，包括折叠过程里的参数和输出。 */
export function itemText(item: PiTranscriptItem): string {
  return item.kind === "tool"
    ? `${item.name}\n${JSON.stringify(item.args)}\n${item.output}`
    : item.text;
}
