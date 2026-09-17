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
  kind: "narrative" | "activity";
  item?: PiTranscriptItem;
  items?: PiTranscriptItem[];
};

function normalizedToolName(name: string): string {
  return name.split(/[.:/]/u).pop()?.toLowerCase() || name;
}

/** 工具摘要始终保留动作；文件路径和命令只作为操作目标。 */
export function toolSummary(item: PiToolItem): string {
  const action = item.name;
  if (!item.args || typeof item.args !== "object") return action;
  const args = item.args as Record<string, unknown>;
  const normalized = normalizedToolName(item.name);
  let target = "";
  if (normalized === "bash" && typeof args.command === "string")
    target = args.command;
  else if (
    ["grep", "symbol_search", "web_search"].includes(normalized) &&
    typeof (args.query ?? args.pattern) === "string"
  )
    target = String(args.query ?? args.pattern);
  else {
    for (const key of [
      "path",
      "file_path",
      "query",
      "pattern",
      "symbol",
      "url",
      "command",
      "script",
      "cmd",
    ]) {
      if (typeof args[key] === "string" && args[key]) {
        target = String(args[key]);
        break;
      }
    }
  }
  if (!target && Object.keys(args).length) target = JSON.stringify(args);
  const details: string[] = target ? [target] : [];
  if (normalized === "read") {
    if (typeof args.offset === "number") details.push(`第 ${args.offset} 行起`);
    if (typeof args.limit === "number") details.push(`${args.limit} 行`);
  }
  return details.length ? `${action} · ${details.join(" · ")}` : action;
}

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

/** 将真实记录压成单行预览；保留思考开头并在末尾省略，详情保留全文。 */
export function activityPreview(item: PiTranscriptItem): string {
  if (item.kind === "tool") {
    const status =
      item.status === "running"
        ? "正在运行"
        : item.status === "error"
          ? "执行失败"
          : "已完成";
    return `${status} · ${toolSummary(item)}`.replace(/\s+/gu, " ");
  }
  const text = item.text.replace(/\s+/gu, " ").trim();
  const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
  return `${item.streaming ? "思考中" : "已思考"}${preview ? ` · ${preview}` : " · 等待内容"}`;
}

/** 优先展示最新执行中的工具，否则展示最后一条真实记录。 */
export function currentActivity(
  items: PiTranscriptItem[],
): PiTranscriptItem | undefined {
  const live = [...items]
    .reverse()
    .find((item) => item.kind === "tool" && item.status === "running");
  return live ?? items[items.length - 1];
}

/** 从当前记录生成外部摘要，与动画使用相同的记录来源。 */
export function activitySummary(current: PiTranscriptItem | undefined): string {
  return current ? activityPreview(current) : "等待模型响应";
}

/** 以助手正文为界合并连续思考和工具，保留原始顺序与稳定分组 ID。 */
function groupTimelineSteps(items: PiTranscriptItem[]): PiTimelineStep[] {
  const steps: PiTimelineStep[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      steps.push({
        id: item.id,
        kind: "narrative",
        item,
      });
      continue;
    }
    const previous = steps[steps.length - 1];
    if (previous?.kind === "activity") previous.items?.push(item);
    else
      steps.push({
        id: `activity-${item.id}`,
        kind: "activity",
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
              ? steps.length && steps.every((item) => item.kind === "thinking")
                ? "思考中"
                : "处理中"
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
  if (
    running &&
    !blocks.some((block) => block.kind === "process" && block.running)
  )
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
