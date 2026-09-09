import type {
  PiEventEnvelope,
  PiMessageItem,
  PiModel,
  PiToolItem,
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
  error: null,
};

type PiViewAction =
  | { type: "reset"; status?: PiViewState["status"] }
  | { type: "optimistic_user"; id: string; text: string }
  | { type: "stopping" }
  | { type: "error"; message: string }
  | { type: "event"; payload: PiEventEnvelope };

/** 将未知值安全转换成普通对象。 */
function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** 将未知输出压缩为工具卡片可展示的文本。 */
function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 返回数组中最后一个满足条件的下标，兼容项目当前 TypeScript 目标。 */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

/** 从 Pi 消息内容中提取正文与思考文本。 */
function messageText(message: Record<string, unknown>): {
  text: string;
  thinking: string;
} {
  const content = message.content;
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const part of content) {
    const item = objectValue(part);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") text.push(item.text);
    if (item.type === "thinking" && typeof item.thinking === "string") {
      thinking.push(item.thinking);
    }
  }
  return { text: text.join(""), thinking: thinking.join("") };
}

/** 将 Pi 完整消息转换成轻量对话记录。 */
function normalizeMessage(message: unknown, fallbackId: string): PiTranscriptItem[] {
  const value = objectValue(message);
  if (!value) return [];
  const role = value.role;
  const id = typeof value.id === "string" ? value.id : fallbackId;
  if (role === "user" || role === "assistant") {
    const content = messageText(value);
    return [
      {
        id,
        kind: "message",
        role,
        text: content.text,
        thinking: content.thinking,
        streaming: false,
      },
    ];
  }
  if (role === "toolResult") {
    const content = Array.isArray(value.content)
      ? value.content
          .map((part) => objectValue(part)?.text)
          .filter((part): part is string => typeof part === "string")
          .join("\n")
      : displayText(value.content);
    return [
      {
        id,
        kind: "tool",
        toolCallId:
          typeof value.toolCallId === "string" ? value.toolCallId : id,
        name: typeof value.toolName === "string" ? value.toolName : "tool",
        status: value.isError === true ? "error" : "done",
        args: null,
        output: content,
      },
    ];
  }
  return [];
}

/** 将恢复接口返回的完整消息列表转换为显示记录。 */
function normalizeMessages(value: unknown): PiTranscriptItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message, index) =>
    normalizeMessage(message, `restored-${index}`),
  );
}

/** 更新或创建当前流式助手消息。 */
function updateStreamingMessage(
  items: PiTranscriptItem[],
  field: "text" | "thinking",
  delta: string,
): PiTranscriptItem[] {
  const next = [...items];
  const index = findLastIndex(next,
    (item) => item.kind === "message" && item.role === "assistant" && item.streaming,
  );
  const current: PiMessageItem =
    index >= 0
      ? (next[index] as PiMessageItem)
      : {
          id: `assistant-${Date.now()}`,
          kind: "message",
          role: "assistant",
          text: "",
          thinking: "",
          streaming: true,
        };
  const updated = { ...current, [field]: current[field] + delta };
  if (index >= 0) next[index] = updated;
  else next.push(updated);
  return next;
}

/** 将最终助手消息替换对应的流式草稿。 */
function finishMessage(
  items: PiTranscriptItem[],
  message: unknown,
): PiTranscriptItem[] {
  const normalized = normalizeMessage(message, `message-${Date.now()}`);
  const finalMessage = normalized[0];
  if (!finalMessage) return items;
  if (finalMessage.kind === "message" && finalMessage.role === "user") {
  const last = items[items.length - 1];
    if (last?.kind === "message" && last.role === "user" && last.text === finalMessage.text) {
      return items;
    }
    return [...items, finalMessage];
  }
  const index = findLastIndex(items,
    (item) => item.kind === "message" && item.role === "assistant" && item.streaming,
  );
  if (index < 0) return [...items, finalMessage];
  const next = [...items];
  next[index] = finalMessage;
  return next;
}

/** 更新工具调用卡片的开始、进度或结束状态。 */
function updateTool(
  items: PiTranscriptItem[],
  event: Record<string, unknown>,
  status: PiToolItem["status"],
): PiTranscriptItem[] {
  const toolCallId =
    typeof event.toolCallId === "string" ? event.toolCallId : `tool-${Date.now()}`;
  const index = items.findIndex(
    (item) => item.kind === "tool" && item.toolCallId === toolCallId,
  );
  const previous = index >= 0 ? (items[index] as PiToolItem) : null;
  const result = objectValue(event.result);
  const outputSource =
    event.partialResult ?? result?.content ?? event.result ?? previous?.output ?? "";
  const tool: PiToolItem = {
    id: previous?.id ?? toolCallId,
    kind: "tool",
    toolCallId,
    name:
      typeof event.toolName === "string"
        ? event.toolName
        : (previous?.name ?? "tool"),
    status: event.isError === true ? "error" : status,
    args: event.args ?? previous?.args ?? null,
    output: displayText(outputSource),
  };
  if (index < 0) return [...items, tool];
  const next = [...items];
  next[index] = tool;
  return next;
}

/** 规范化 Pi 返回的模型对象。 */
function normalizeModel(value: unknown): PiModel | null {
  const model = objectValue(value);
  if (!model) return null;
  const provider = typeof model.provider === "string" ? model.provider : null;
  const id =
    typeof model.id === "string"
      ? model.id
      : typeof model.modelId === "string"
        ? model.modelId
        : null;
  if (!provider || !id) return null;
  return {
    provider,
    id,
    name: typeof model.name === "string" ? model.name : undefined,
  };
}

/** 把一条 Pi RPC 事件归并到当前面板状态。 */
function reduceEvent(state: PiViewState, payload: PiEventEnvelope): PiViewState {
  const event = payload.event;
  const type = typeof event.type === "string" ? event.type : "";
  if (payload.stream === "stderr") {
    return {
      ...state,
      error:
        typeof event.message === "string" ? event.message : "Pi 运行输出异常",
    };
  }
  if (payload.stream === "protocol") {
    return { ...state, status: "failed", error: displayText(event.error) };
  }
  if (type === "process_exit") {
    return { ...state, status: "stopped" };
  }
  if (type === "agent_start") return { ...state, status: "running", error: null };
  if (type === "agent_settled") return { ...state, status: "idle" };
  if (type === "message_update") {
    const update = objectValue(event.assistantMessageEvent);
    if (!update) return state;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      return { ...state, items: updateStreamingMessage(state.items, "text", update.delta) };
    }
    if (update.type === "thinking_delta" && typeof update.delta === "string") {
      return {
        ...state,
        items: updateStreamingMessage(state.items, "thinking", update.delta),
      };
    }
    return state;
  }
  if (type === "message_end") {
    return { ...state, items: finishMessage(state.items, event.message) };
  }
  if (type === "tool_execution_start") {
    return { ...state, items: updateTool(state.items, event, "running") };
  }
  if (type === "tool_execution_update") {
    return { ...state, items: updateTool(state.items, event, "running") };
  }
  if (type === "tool_execution_end") {
    return { ...state, items: updateTool(state.items, event, "done") };
  }
  if (type !== "response" || event.success === false) {
    return event.success === false
      ? { ...state, error: displayText(event.error) || "Pi 命令执行失败" }
      : state;
  }

  const command = typeof event.command === "string" ? event.command : "";
  const data = objectValue(event.data);
  if (command === "get_messages") {
    return { ...state, items: normalizeMessages(data?.messages) };
  }
  if (command === "get_state") {
    const contextUsage = objectValue(data?.contextUsage);
    return {
      ...state,
      status: data?.isStreaming === true ? "running" : "idle",
      sessionFile:
        typeof data?.sessionFile === "string" ? data.sessionFile : state.sessionFile,
      sessionName:
        typeof data?.sessionName === "string" ? data.sessionName : state.sessionName,
      model: normalizeModel(data?.model) ?? state.model,
      thinkingLevel:
        typeof data?.thinkingLevel === "string"
          ? data.thinkingLevel
          : state.thinkingLevel,
      contextPercent:
        typeof contextUsage?.percent === "number"
          ? contextUsage.percent
          : state.contextPercent,
    };
  }
  if (command === "get_available_models") {
    const models = Array.isArray(data?.models)
      ? data.models.map(normalizeModel).filter((model): model is PiModel => model !== null)
      : [];
    return { ...state, models };
  }
  if (command === "get_available_thinking_levels") {
    const levels = Array.isArray(data?.levels)
      ? data.levels.filter((level): level is string => typeof level === "string")
      : ["off"];
    return { ...state, thinkingLevels: levels };
  }
  if (command === "set_model") {
    return { ...state, model: normalizeModel(event.data) ?? state.model };
  }
  return state;
}

/** 维护 Pi Agent 面板的纯前端状态。 */
export function piViewReducer(
  state: PiViewState,
  action: PiViewAction,
): PiViewState {
  if (action.type === "reset") {
    return { ...INITIAL_PI_VIEW_STATE, status: action.status ?? "stopped" };
  }
  if (action.type === "optimistic_user") {
    return {
      ...state,
      items: [
        ...state.items,
        {
          id: action.id,
          kind: "message",
          role: "user",
          text: action.text,
          thinking: "",
          streaming: false,
        },
      ],
    };
  }
  if (action.type === "stopping") return { ...state, status: "stopping" };
  if (action.type === "error") {
    return { ...state, status: "failed", error: action.message };
  }
  return reduceEvent(state, action.payload);
}
