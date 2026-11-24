import { splitInlineThinking } from "./inlineThinking";
import {
  collectTurnFileChanges,
  describeToolCall,
  summarizeProcessBlock,
  type ToolCategory,
  type TurnFileChange,
} from "./toolFormat";
import type { AgentMessage } from "./types";

export type LiveTickerLine = {
  id: string;
  status: "running" | "done" | "error";
  verb: string;
  text: string;
};

export type TurnStep =
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      createdAt?: number;
    }
  | {
      kind: "narrative";
      id: string;
      message: AgentMessage;
      text: string;
    }
  | {
      kind: "explore";
      id: string;
      messages: AgentMessage[];
    }
  | {
      kind: "tool";
      id: string;
      message: AgentMessage;
      recoveredAfterFailure?: boolean;
    }
  | {
      kind: "plan";
      id: string;
      message: AgentMessage;
    }
  | {
      kind: "notice";
      id: string;
      message: AgentMessage;
    };

export type TurnProcessBlock = {
  id: string;
  kind: "process";
  steps: TurnStep[];
  tickerItems: LiveTickerLine[];
  rawMessages: AgentMessage[];
  running: boolean;
  statusTitle: string;
  summaryText: string;
  stepCount: number;
  toolCount: number;
  startedAt?: number;
  finishedAt?: number;
  fileChanges: TurnFileChange[];
};

export type TranscriptBlock =
  | {
      id: string;
      kind: "message";
      message: AgentMessage;
      hideThinking?: boolean;
    }
  | TurnProcessBlock;

function hasVisibleText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /[^\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/u.test(value)
  );
}

function singleLinePreview(text: string, max = 110): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isTool(message: AgentMessage): boolean {
  return message.kind === "toolCall" || message.kind === "toolResult";
}

function isVisibleMessage(message: AgentMessage): boolean {
  if (isTool(message) || message.kind === "plan" || message.kind === "notice") {
    return true;
  }
  if (message.role === "user") return true;
  const resolved = splitInlineThinking(
    message.text,
    message.thinking,
    message.streaming,
  );
  return (
    hasVisibleText(resolved.text) ||
    hasVisibleText(resolved.thinking) ||
    Boolean(message.images?.length)
  );
}

function toolTickerStatus(message: AgentMessage): LiveTickerLine["status"] {
  const desc = describeToolCall(message);
  if (desc.isGrepEmpty) return "done";
  if (
    message.isError ||
    message.status === "error" ||
    message.status === "failed"
  ) {
    return "error";
  }
  if (
    message.status === "running" ||
    message.status === "pending" ||
    message.status === "in_progress"
  ) {
    return "running";
  }
  return "done";
}

function activeVerbForCategory(category: ToolCategory): string {
  switch (category) {
    case "read":
      return "正在读取";
    case "search":
      return "正在搜索";
    case "list":
      return "正在浏览目录";
    case "edit":
      return "正在修改";
    case "write":
      return "正在写入";
    case "command":
      return "正在运行命令";
    case "web":
      return "正在检索网络";
    case "subagent":
      return "子代理运行中";
    default:
      return "正在执行";
  }
}

function buildStepsAndTicker(
  processEntries: Array<
    | { kind: "raw"; message: AgentMessage }
    | { kind: "thinkingOnly"; message: AgentMessage; thinking: string }
  >,
): {
  steps: TurnStep[];
  tickerItems: LiveTickerLine[];
  rawMessages: AgentMessage[];
  toolCount: number;
  liveStepTitle: string;
} {
  const steps: TurnStep[] = [];
  const tickerItems: LiveTickerLine[] = [];
  const rawMessages: AgentMessage[] = [];
  const failedCats = new Set<ToolCategory>();
  let toolCount = 0;

  for (const entry of processEntries) {
    if (entry.kind === "thinkingOnly") {
      const m = entry.message;
      rawMessages.push(m);
      if (hasVisibleText(entry.thinking)) {
        const preview = singleLinePreview(entry.thinking, 110);
        steps.push({
          kind: "thinking",
          id: `think:${m.id}`,
          text: entry.thinking,
          streaming: m.streaming,
          createdAt: m.createdAt,
        });
        tickerItems.push({
          id: `think:${m.id}`,
          status: m.streaming ? "running" : "done",
          verb: "思考",
          text: preview,
        });
      }
      continue;
    }

    const m = entry.message;
    rawMessages.push(m);

    if (m.kind === "plan") {
      steps.push({ kind: "plan", id: `plan:${m.id}`, message: m });
      tickerItems.push({
        id: `plan:${m.id}`,
        status: "done",
        verb: "计划",
        text: "更新执行步骤",
      });
      continue;
    }

    if (m.kind === "notice") {
      steps.push({ kind: "notice", id: `notice:${m.id}`, message: m });
      const preview = singleLinePreview(m.text, 90);
      if (preview) {
        tickerItems.push({
          id: `notice:${m.id}`,
          status: m.isError ? "error" : "done",
          verb: "提示",
          text: preview,
        });
      }
      continue;
    }

    if (isTool(m)) {
      if (m.kind === "toolCall") toolCount += 1;
      const desc = describeToolCall(m);
      const isExplore =
        m.kind === "toolCall" &&
        (desc.category === "read" ||
          desc.category === "search" ||
          desc.category === "list");
      const status = toolTickerStatus(m);

      tickerItems.push({
        id: `tick:${m.id}`,
        status,
        verb: desc.badge,
        text: desc.target || desc.title,
      });

      const lastStep = steps[steps.length - 1];
      if (isExplore) {
        if (lastStep?.kind === "explore") {
          lastStep.messages.push(m);
        } else {
          steps.push({
            kind: "explore",
            id: `exp:${m.id}`,
            messages: [m],
          });
        }
        continue;
      }

      const failed = status === "error";
      const succeeded = m.status === "completed";
      let recoveredAfterFailure = false;
      if (succeeded && failedCats.has(desc.category)) {
        recoveredAfterFailure = true;
        failedCats.delete(desc.category);
      } else if (failed) {
        failedCats.add(desc.category);
      }
      steps.push({
        kind: "tool",
        id: m.id,
        message: m,
        recoveredAfterFailure,
      });
      continue;
    }

    // Intermediate assistant message (thinking + optional narrative prose)
    const resolved = splitInlineThinking(m.text, m.thinking, m.streaming);
    if (hasVisibleText(resolved.thinking)) {
      steps.push({
        kind: "thinking",
        id: `think:${m.id}`,
        text: resolved.thinking,
        streaming: m.streaming && !hasVisibleText(resolved.text),
        createdAt: m.createdAt,
      });
      tickerItems.push({
        id: `think:${m.id}`,
        status: m.streaming && !hasVisibleText(resolved.text) ? "running" : "done",
        verb: "思考",
        text: singleLinePreview(resolved.thinking, 110),
      });
    }
    if (hasVisibleText(resolved.text)) {
      steps.push({
        kind: "narrative",
        id: `narr:${m.id}`,
        message: m,
        text: resolved.text,
      });
      tickerItems.push({
        id: `narr:${m.id}`,
        status: m.streaming ? "running" : "done",
        verb: "说明",
        text: singleLinePreview(resolved.text, 110),
      });
    }
  }

  let liveStepTitle = "处理中";
  const runningTool = [...rawMessages]
    .reverse()
    .find(
      (m) =>
        isTool(m) &&
        (m.status === "running" ||
          m.status === "in_progress" ||
          m.status === "pending"),
    );
  if (runningTool) {
    liveStepTitle = activeVerbForCategory(describeToolCall(runningTool).category);
  } else {
    const latestTick = tickerItems[tickerItems.length - 1];
    if (latestTick?.verb === "思考") liveStepTitle = "正在思考";
    else if (latestTick?.verb === "说明") liveStepTitle = "正在组织输出";
  }

  return { steps, tickerItems, rawMessages, toolCount, liveStepTitle };
}

/**
 * Turn 级信息流聚合（参考 CodexScope PiTimeline）：
 * 同一用户回合内的思考、工具调用与中间过渡说明统一收拢到一个过程流块；
 * 仅最后完成的正式答复独立展示。
 */
export function buildTranscriptBlocks(
  messages: AgentMessage[],
  running: boolean,
  cwd: string,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let turn: AgentMessage[] = [];
  let turnStartedAt: number | undefined;

  const flushTurn = (isLiveTurn: boolean) => {
    const visible = turn.filter(isVisibleMessage);
    if (!visible.length) {
      turn = [];
      turnStartedAt = undefined;
      return;
    }

    const last = visible[visible.length - 1];
    const lastResolved =
      last?.kind === "message" && last.role === "assistant"
        ? splitInlineThinking(last.text, last.thinking, last.streaming)
        : null;
    const lastIsDeliverable =
      last?.kind === "message" &&
      last.role === "assistant" &&
      (hasVisibleText(lastResolved?.text) || Boolean(last.images?.length)) &&
      (!last.streaming || (isLiveTurn && hasVisibleText(lastResolved?.text)));

    const processSlice = lastIsDeliverable ? visible.slice(0, -1) : visible;
    const processEntries: Array<
      | { kind: "raw"; message: AgentMessage }
      | { kind: "thinkingOnly"; message: AgentMessage; thinking: string }
    > = processSlice.map((message) => ({ kind: "raw", message }));

    let hideFinalThinking = false;
    if (lastIsDeliverable && lastResolved && hasVisibleText(lastResolved.thinking)) {
      processEntries.push({
        kind: "thinkingOnly",
        message: last,
        thinking: lastResolved.thinking,
      });
      hideFinalThinking = true;
    }

    if (processEntries.length > 0) {
      const { steps, tickerItems, rawMessages, toolCount, liveStepTitle } =
        buildStepsAndTicker(processEntries);
      const times = rawMessages
        .map((m) => m.createdAt ?? 0)
        .filter((t) => t > 0);
      const startedAt =
        turnStartedAt ?? (times.length ? Math.min(...times) : undefined);
      const lastTime = times.length ? Math.max(...times) : undefined;
      const processLive = isLiveTurn && !lastIsDeliverable;
      const finishedAt = processLive
        ? undefined
        : lastIsDeliverable && last.createdAt && last.createdAt > 0
          ? last.createdAt
          : lastTime;
      const fileChanges = collectTurnFileChanges(rawMessages, cwd);
      const toolSummary = summarizeProcessBlock(rawMessages, false);
      const hasError = tickerItems.some((item) => item.status === "error");
      const summaryParts: string[] = [];
      if (toolCount > 0) summaryParts.push(toolSummary);
      else if (steps.length > 0) summaryParts.push(`${steps.length} 个推理步骤`);
      if (fileChanges.length > 0) {
        summaryParts.push(`变更 ${fileChanges.length} 文件`);
      }

      blocks.push({
        id: `process:${rawMessages[0]?.id ?? steps[0]?.id ?? "turn"}`,
        kind: "process",
        steps,
        tickerItems,
        rawMessages,
        running: processLive,
        statusTitle: processLive
          ? liveStepTitle
          : hasError
            ? "已执行（含失败）"
            : "已完成",
        summaryText: summaryParts.join(" · ") || "执行完成",
        stepCount: Math.max(steps.length, tickerItems.length),
        toolCount,
        startedAt,
        finishedAt,
        fileChanges,
      });
    }

    if (lastIsDeliverable && last) {
      blocks.push({
        id: last.id,
        kind: "message",
        message: last,
        hideThinking: hideFinalThinking,
      });
    }

    turn = [];
    turnStartedAt = undefined;
  };

  let lastUserTime: number | undefined;
  for (const m of messages) {
    if (!isVisibleMessage(m)) continue;
    if (m.kind === "message" && m.role === "user") {
      flushTurn(false);
      blocks.push({ id: m.id, kind: "message", message: m });
      turnStartedAt = m.createdAt && m.createdAt > 0 ? m.createdAt : undefined;
      lastUserTime = turnStartedAt;
    } else {
      turn.push(m);
    }
  }
  flushTurn(running);

  // 发送后若模型尚未返回任何事件，立即呈现即时响应过程占位。
  if (
    running &&
    !blocks.some((b) => b.kind === "process" && b.running) &&
    blocks[blocks.length - 1]?.kind === "message" &&
    (blocks[blocks.length - 1] as { message: AgentMessage }).message.role ===
      "user"
  ) {
    blocks.push({
      id: "process:live-wait",
      kind: "process",
      steps: [],
      tickerItems: [
        {
          id: "live-wait",
          status: "running",
          verb: "准备",
          text: "等待模型开始思考或调用工具…",
        },
      ],
      rawMessages: [],
      running: true,
      statusTitle: "等待响应",
      summaryText: "建立上下文",
      stepCount: 0,
      toolCount: 0,
      startedAt: lastUserTime,
      fileChanges: [],
    });
  }

  return blocks;
}
