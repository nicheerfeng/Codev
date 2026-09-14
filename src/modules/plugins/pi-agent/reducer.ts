import type {
  PiEventEnvelope,
  PiImage,
  PiModel,
  PiStopReason,
  PiTranscriptItem,
  PiViewState,
} from "./types";

export const INITIAL_PI_VIEW_STATE: PiViewState = {
  modelsLoading: false,
  commands: [],
  status: "stopped",
  items: [],
  sessionFile: null,
  sessionName: null,
  model: null,
  models: [],
  thinkingLevel: "off",
  thinkingLevels: ["off"],
  contextPercent: null,
  contextTokens: null,
  queue: { steering: [], followUp: [], pendingCount: 0 },
  phase: "",
  error: null,
  historyOffset: null,
  historyHasMore: false,
  historyLoadingMore: false,
};

type PiViewAction =
  | { type: "reset"; status?: PiViewState["status"] }
  | { type: "stopping" }
  | { type: "error"; message: string }
  | {
      type: "prompt";
      text: string;
      images?: PiImage[];
      queued?: boolean;
    }
  | {
      type: "history";
      messages: unknown[];
      prepend?: boolean;
      offset: number;
      hasMore: boolean;
    }
  | { type: "event"; payload: PiEventEnvelope };

/** 读取 RPC 对象，不把数组当成消息。 */
export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 提取原生工具结果文本，避免将 content 数组直接作为 JSON 显示。 */
export function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => {
        const item = objectValue(part);
        return typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  const result = objectValue(value);
  if (result?.content) return resultText(result.content);
  return value == null ? "" : JSON.stringify(value, null, 2);
}

/** 将 Pi 的毫秒、秒或 ISO 时间统一为毫秒时间戳。 */
function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 读取单条 Pi 记录的时间，兼容外层记录和嵌套消息。 */
function messageTimestamp(
  value: Record<string, unknown>,
  fallback?: Record<string, unknown> | null,
): number | undefined {
  return timestampValue(value.timestamp) ?? timestampValue(fallback?.timestamp);
}

/** 读取 Pi assistant 消息的结束原因，未知值不参与编辑判断。 */
function stopReasonValue(value: unknown): PiStopReason | undefined {
  return value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
    ? value
    : undefined;
}

/** 按 Pi contentIndex 保留每一段正文、思考和工具的原始顺序。 */
function normalizeMessage(message: unknown, id: string): PiTranscriptItem[] {
  const raw = objectValue(message);
  const value = objectValue(raw?.message) ?? raw;
  if (!value) return [];
  const timestamp = messageTimestamp(value, raw);
  if (value.role === "toolResult")
    return [
      {
        id: String(value.toolCallId ?? id),
        kind: "tool",
        toolCallId: String(value.toolCallId ?? id),
        name: String(value.toolName ?? "tool"),
        status: value.isError ? "error" : "done",
        args: null,
        output: resultText(value.content),
        finishedAt: timestamp,
      },
    ];
  if (value.role !== "user" && value.role !== "assistant") return [];
  const role = value.role;
  const stopReason = stopReasonValue(value.stopReason ?? raw?.stopReason);
  const content = Array.isArray(value.content)
    ? value.content
    : [{ type: "text", text: value.content ?? "" }];
  if (role === "user")
    return [
      {
        id,
        kind: "message",
        role,
        text: resultText(content).replace(/\s+$/u, ""),
        thinking: "",
        streaming: false,
        images: content.filter(
          (part) => part.type === "image" && typeof part.data === "string",
        ),
        timestamp,
      },
    ];
  return content.flatMap((part, index): PiTranscriptItem[] => {
    if (part.type === "thinking")
      return [
        {
          id: `${id}:${index}`,
          kind: "thinking",
          text: part.thinking ?? "",
          streaming: false,
          timestamp,
        },
      ];
    if (part.type === "text")
      return [
        {
          id: `${id}:${index}`,
          kind: "message",
          role,
          text: part.text ?? "",
          thinking: "",
          streaming: false,
          timestamp,
          ...(stopReason ? { stopReason } : {}),
        },
      ];
    if (part.type === "toolCall")
      return [
        {
          id: part.id,
          kind: "tool",
          toolCallId: part.id,
          name: part.name,
          args: part.arguments,
          output: "",
          status: "running",
          startedAt: timestamp,
        },
      ];
    return [];
  });
}

/** 合并工具结果到原始调用位置，历史恢复不会重复显示同一工具。 */
function mergeItems(
  items: PiTranscriptItem[],
  incoming: PiTranscriptItem[],
): PiTranscriptItem[] {
  const next = [...items];
  for (const item of incoming) {
    let index = next.findIndex((existing) => existing.id === item.id);
    if (index < 0 && item.kind === "message" && item.role === "user")
      index = next.findIndex(
        (existing) =>
          existing.kind === "message" &&
          existing.role === "user" &&
          existing.id.startsWith("local-user-") &&
          existing.text === item.text,
      );
    if (index < 0) next.push(item);
    else {
      const previous = next[index];
      next[index] =
        previous.kind === "tool" && item.kind === "tool"
          ? {
              ...item,
              args: item.args ?? previous.args,
              startedAt: item.startedAt ?? previous.startedAt,
              finishedAt: item.finishedAt ?? previous.finishedAt,
            }
          : item;
    }
  }
  return next;
}

/** 标准化模型标识。 */
function modelValue(value: unknown): PiModel | null {
  const model = objectValue(value);
  return typeof model?.provider === "string" && typeof model.id === "string"
    ? {
        provider: model.provider,
        id: model.id,
        name: typeof model.name === "string" ? model.name : undefined,
        contextWindow:
          typeof model.contextWindow === "number"
            ? model.contextWindow
            : undefined,
      }
    : null;
}

/** 用消息起始位置构造稳定的流式块编号。 */
function streamBase(items: PiTranscriptItem[]): string {
  const streaming = items.find(
    (item) => item.kind !== "tool" && item.streaming,
  );
  return streaming ? streaming.id.split(":")[0] : `message-${items.length}`;
}

/** 读取 RPC 事件时间，缺失时使用事件到达时间。 */
function eventTimestamp(event: Record<string, unknown>): number {
  return timestampValue(event.timestamp) ?? Date.now();
}

/** 根据 RPC 事件更新一个线程，保留工具调用与内容块的相对位置。 */
function reduceEvent(
  state: PiViewState,
  payload: PiEventEnvelope,
): PiViewState {
  const event = payload.event;
  const type = event.type;
  if (payload.stream === "stderr")
    return { ...state, error: String(event.message ?? "Pi 运行输出异常") };
  if (payload.stream === "protocol")
    return { ...state, error: String(event.error), status: "failed" };
  if (type === "process_exit") {
    const finishedAt = Date.now();
    return {
      ...state,
      status: "stopped",
      phase: "",
      processFinishedAt: finishedAt,
      items: stampTurnTiming(
        settleItems(state.items),
        state.processStartedAt,
        finishedAt,
      ),
    };
  }
  if (type === "agent_start") {
    const continuing =
      state.status === "running" && state.processFinishedAt == null;
    return {
      ...state,
      status: "running",
      phase: "思考中",
      error: null,
      processStartedAt: continuing
        ? (state.processStartedAt ?? Date.now())
        : Date.now(),
      processFinishedAt: undefined,
    };
  }
  if (type === "agent_settled") {
    const finishedAt = Date.now();
    return {
      ...state,
      status: "idle",
      phase: "",
      processFinishedAt: finishedAt,
      items: stampTurnTiming(
        settleItems(state.items),
        state.processStartedAt,
        finishedAt,
      ),
    };
  }
  if (type === "queue_update") {
    const steering = Array.isArray(event.steering)
      ? event.steering.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const followUp = Array.isArray(event.followUp)
      ? event.followUp.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      ...state,
      queue: {
        steering,
        followUp,
        pendingCount: steering.length + followUp.length,
      },
    };
  }
  if (type === "auto_retry_start") return { ...state, phase: "正在重试" };
  if (type === "auto_compaction_start")
    return { ...state, phase: "正在压缩上下文" };
  if (type === "message_update") {
    const update = objectValue(event.assistantMessageEvent);
    if (
      !update ||
      !["text_delta", "thinking_delta"].includes(String(update.type)) ||
      typeof update.delta !== "string"
    )
      return state;
    const id = `${streamBase(state.items)}:${Number(update.contentIndex ?? 0)}`;
    const timestamp = timestampValue(update.timestamp);
    const previous = state.items.find((item) => item.id === id);
    const text =
      (previous && previous.kind !== "tool" ? previous.text : "") +
      update.delta;
    const item: PiTranscriptItem =
      update.type === "thinking_delta"
        ? { id, kind: "thinking", text, streaming: true, timestamp }
        : {
            id,
            kind: "message",
            role: "assistant",
            text,
            thinking: "",
            streaming: true,
            timestamp,
          };
    return {
      ...state,
      phase: item.kind === "thinking" ? "思考中" : "正在回复",
      items: mergeItems(state.items, [item]),
    };
  }
  if (type === "message_end") {
    const value = objectValue(event.message);
    const id =
      value?.role === "assistant"
        ? streamBase(state.items)
        : `message-${state.items.length}`;
    return {
      ...state,
      items: mergeItems(state.items, normalizeMessage(value, id)),
      error:
        typeof value?.errorMessage === "string"
          ? value.errorMessage
          : state.error,
    };
  }
  if (
    [
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ].includes(String(type))
  ) {
    const id = String(event.toolCallId);
    const previous = state.items.find(
      (item) => item.kind === "tool" && item.toolCallId === id,
    );
    const old = previous?.kind === "tool" ? previous : null;
    const currentTime = eventTimestamp(event);
    return {
      ...state,
      phase: "执行工具",
      items: mergeItems(state.items, [
        {
          id,
          kind: "tool",
          toolCallId: id,
          name: String(event.toolName ?? old?.name ?? "tool"),
          args: event.args ?? old?.args ?? null,
          output:
            event.result !== undefined || event.partialResult !== undefined
              ? resultText(event.result ?? event.partialResult)
              : (old?.output ?? ""),
          status:
            type !== "tool_execution_end"
              ? "running"
              : event.isError
                ? "error"
                : "done",
          startedAt:
            type === "tool_execution_start"
              ? currentTime
              : (old?.startedAt ?? currentTime),
          finishedAt:
            type === "tool_execution_end" ? currentTime : old?.finishedAt,
        },
      ]),
    };
  }
  if (type !== "response") return state;
  if (event.success === false)
    return { ...state, error: String(event.error ?? "Pi 命令失败") };
  const data = objectValue(event.data);
  if (event.command === "get_commands")
    return {
      ...state,
      commands: Array.isArray(data?.commands) ? data.commands : [],
    };
  if (event.command === "get_messages") {
    return hydrateHistory(
      state,
      Array.isArray(data?.messages) ? data.messages : [],
      false,
      state.historyOffset,
      false,
    );
  }
  if (event.command === "get_state")
    return {
      ...state,
      status:
        data?.isStreaming === true
          ? "running"
          : state.status === "running" || state.status === "stopping"
            ? state.status
            : "idle",
      sessionFile:
        typeof data?.sessionFile === "string"
          ? data.sessionFile
          : state.sessionFile,
      sessionName:
        typeof data?.sessionName === "string"
          ? data.sessionName
          : state.sessionName,
      model: state.model ?? modelValue(data?.model),
      thinkingLevel: String(data?.thinkingLevel ?? state.thinkingLevel),
      queue: {
        ...state.queue,
        pendingCount:
          typeof data?.pendingMessageCount === "number"
            ? data.pendingMessageCount
            : state.queue.pendingCount,
      },
    };
  if (event.command === "clear_queue")
    return {
      ...state,
      queue: { steering: [], followUp: [], pendingCount: 0 },
    };
  if (event.command === "get_session_stats") {
    const usage = objectValue(data?.contextUsage);
    const tokens = typeof usage?.tokens === "number" ? usage.tokens : null;
    const window =
      typeof state.model?.contextWindow === "number"
        ? state.model.contextWindow
        : null;
    return {
      ...state,
      contextPercent:
        typeof usage?.percent === "number"
          ? usage.percent
          : tokens !== null && window
            ? Math.min(100, (tokens / window) * 100)
            : null,
      contextTokens: tokens,
    };
  }
  if (event.command === "get_available_models")
    return {
      ...state,
      modelsLoading: false,
      models: Array.isArray(data?.models)
        ? data.models
            .map(modelValue)
            .filter((value): value is PiModel => value !== null)
        : [],
    };
  if (event.command === "get_available_thinking_levels")
    return {
      ...state,
      thinkingLevels: Array.isArray(data?.levels)
        ? data.levels.filter(
            (value): value is string => typeof value === "string",
          )
        : ["off"],
    };
  if (event.command === "set_model")
    return { ...state, model: modelValue(event.data) ?? state.model };
  return state;
}

/** 结束时解除流式占位，未结束的工具显示已中断。 */
function settleItems(items: PiTranscriptItem[]): PiTranscriptItem[] {
  return items.map((item) =>
    item.kind === "tool"
      ? item.status === "running"
        ? { ...item, status: "error", output: item.output || "执行已中断" }
        : item
      : item.streaming
        ? { ...item, streaming: false }
        : item,
  );
}

/** 把本轮起止时间写回消息，下一轮开始后仍能算出当轮耗时。 */
function stampTurnTiming(
  items: PiTranscriptItem[],
  startedAt?: number,
  finishedAt?: number,
): PiTranscriptItem[] {
  if (!items.length || (startedAt == null && finishedAt == null)) return items;
  let lastUser = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "user") {
      lastUser = index;
      break;
    }
  }
  return items.map((item, index) => {
    if (lastUser >= 0 && index < lastUser) return item;
    if (
      item.kind === "message" &&
      item.role === "user" &&
      item.timestamp == null &&
      startedAt != null
    )
      return { ...item, timestamp: startedAt };
    if (index !== items.length - 1) return item;
    if (item.kind === "tool")
      return { ...item, finishedAt: item.finishedAt ?? finishedAt };
    if (finishedAt == null) return item;
    return {
      ...item,
      timestamp: Math.max(item.timestamp ?? 0, finishedAt),
    };
  });
}

/** 把磁盘或 RPC 历史合并进当前线程，分页时把更早消息插到前面。 */
function hydrateHistory(
  state: PiViewState,
  messages: unknown[],
  prepend: boolean,
  offset: number | null,
  hasMore: boolean,
): PiViewState {
  const incoming = messages.reduce(
    (next: PiTranscriptItem[], message, index) => {
      const record = objectValue(message);
      const nested = objectValue(record?.message) ?? record;
      const id =
        typeof record?.id === "string"
          ? record.id
          : typeof nested?.id === "string"
            ? nested.id
            : `history-${index}`;
      return mergeItems(next, normalizeMessage(message, id));
    },
    [],
  );
  const last = state.items[state.items.length - 1];
  let items = prepend ? mergeItems(incoming, state.items) : incoming;
  if (
    last?.kind === "message" &&
    last.role === "user" &&
    last.id.startsWith("local-user-") &&
    !items.some(
      (item) =>
        item.kind === "message" &&
        item.role === "user" &&
        item.text === last.text,
    )
  )
    items = [...items, last];
  return {
    ...state,
    items,
    historyOffset: offset,
    historyHasMore: hasMore,
    historyLoadingMore: false,
  };
}

/** 点击发送后立刻进入运行态，不必等待 Pi 的 agent_start。 */
function beginPrompt(
  state: PiViewState,
  text: string,
  images: PiImage[] | undefined,
  queued = false,
): PiViewState {
  const cleaned = text.replace(/\s+$/u, "");
  const now = Date.now();
  const last = state.items[state.items.length - 1];
  const duplicate =
    last?.kind === "message" && last.role === "user" && last.text === cleaned;
  return {
    ...state,
    compaction:
      state.compaction?.status === "running" ? state.compaction : undefined,
    status: "running",
    phase: queued ? state.phase || "处理中" : "处理中",
    error: null,
    processStartedAt:
      queued && state.status === "running" && state.processFinishedAt == null
        ? (state.processStartedAt ?? now)
        : now,
    processFinishedAt:
      queued && state.status === "running"
        ? state.processFinishedAt
        : undefined,
    items:
      queued || duplicate || !cleaned
        ? state.items
        : [
            ...state.items,
            {
              id: `local-user-${now}`,
              kind: "message",
              role: "user",
              text: cleaned,
              thinking: "",
              streaming: false,
              images,
              timestamp: now,
            },
          ],
  };
}

/** 维护单个 Pi 会话的纯状态，供前端与协议回归共用。 */
export function piViewReducer(
  state: PiViewState,
  action: PiViewAction,
): PiViewState {
  if (action.type === "reset")
    return { ...INITIAL_PI_VIEW_STATE, status: action.status ?? "stopped" };
  if (action.type === "stopping") return { ...state, status: "stopping" };
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "prompt")
    return beginPrompt(state, action.text, action.images, action.queued);
  if (action.type === "history")
    return hydrateHistory(
      state,
      action.messages,
      action.prepend === true,
      action.offset,
      action.hasMore,
    );
  return reduceEvent(state, action.payload);
}
