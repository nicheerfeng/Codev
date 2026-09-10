import type {
  PiEventEnvelope,
  PiModel,
  PiTranscriptItem,
  PiViewState,
} from "./types";

export const INITIAL_PI_VIEW_STATE: PiViewState = {
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
  phase: "",
  error: null,
};

type PiViewAction =
  | { type: "reset"; status?: PiViewState["status"] }
  | { type: "stopping" }
  | { type: "error"; message: string }
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
        return typeof item?.text === "string"
          ? item.text
          : item?.type === "image"
            ? "[图片结果]"
            : "";
      })
      .filter(Boolean)
      .join("\n");
  const result = objectValue(value);
  if (result?.content) return resultText(result.content);
  return value == null ? "" : JSON.stringify(value, null, 2);
}

/** 按 Pi contentIndex 保留每一段正文、思考和工具的原始顺序。 */
function normalizeMessage(message: unknown, id: string): PiTranscriptItem[] {
  const value = objectValue(message);
  if (!value) return [];
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
      },
    ];
  if (value.role !== "user" && value.role !== "assistant") return [];
  const role = value.role;
  const content = Array.isArray(value.content)
    ? value.content
    : [{ type: "text", text: value.content ?? "" }];
  if (role === "user")
    return [
      {
        id,
        kind: "message",
        role,
        text: resultText(content),
        thinking: "",
        streaming: false,
        images: content.filter(
          (part) => part.type === "image" && typeof part.data === "string",
        ),
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
    const index = next.findIndex((existing) => existing.id === item.id);
    if (index < 0) next.push(item);
    else {
      const previous = next[index];
      next[index] =
        previous.kind === "tool" && item.kind === "tool"
          ? { ...item, args: item.args ?? previous.args }
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
  if (type === "process_exit")
    return {
      ...state,
      status: "stopped",
      phase: "",
      items: settleItems(state.items),
    };
  if (type === "agent_start")
    return { ...state, status: "running", phase: "思考中", error: null };
  if (type === "agent_settled")
    return {
      ...state,
      status: "idle",
      phase: "",
      items: settleItems(state.items),
    };
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
    const previous = state.items.find((item) => item.id === id);
    const text =
      (previous && previous.kind !== "tool" ? previous.text : "") +
      update.delta;
    const item: PiTranscriptItem =
      update.type === "thinking_delta"
        ? { id, kind: "thinking", text, streaming: true }
        : {
            id,
            kind: "message",
            role: "assistant",
            text,
            thinking: "",
            streaming: true,
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
        },
      ]),
    };
  }
  if (type !== "response") return state;
  if (event.success === false)
    return { ...state, error: String(event.error ?? "Pi 命令失败") };
  const data = objectValue(event.data);
  if (event.command === "get_messages") {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    return {
      ...state,
      items: messages.reduce(
        (items: PiTranscriptItem[], message, index) =>
          mergeItems(items, normalizeMessage(message, `history-${index}`)),
        [],
      ),
    };
  }
  if (event.command === "get_state")
    return {
      ...state,
      status: data?.isStreaming === true ? "running" : "idle",
      sessionFile:
        typeof data?.sessionFile === "string"
          ? data.sessionFile
          : state.sessionFile,
      sessionName:
        typeof data?.sessionName === "string"
          ? data.sessionName
          : state.sessionName,
      model: modelValue(data?.model),
      thinkingLevel: String(data?.thinkingLevel ?? state.thinkingLevel),
    };
  if (event.command === "get_session_stats") {
    const usage = objectValue(data?.contextUsage);
    return {
      ...state,
      contextPercent: typeof usage?.percent === "number" ? usage.percent : null,
      contextTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
    };
  }
  if (event.command === "get_available_models")
    return {
      ...state,
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

/** 维护单个 Pi 会话的纯状态，供前端与协议回归共用。 */
export function piViewReducer(
  state: PiViewState,
  action: PiViewAction,
): PiViewState {
  if (action.type === "reset")
    return { ...INITIAL_PI_VIEW_STATE, status: action.status ?? "stopped" };
  if (action.type === "stopping") return { ...state, status: "stopping" };
  if (action.type === "error") return { ...state, error: action.message };
  return reduceEvent(state, action.payload);
}
