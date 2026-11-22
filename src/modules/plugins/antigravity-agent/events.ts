import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AntigravityConfigOption, AntigravityEnvelope } from "./native";
import type {
  AntigravityPermission,
  AntigravitySession,
  AntigravityTranscriptItem,
} from "./types";

type Actions = {
  setMessages: Dispatch<
    SetStateAction<Record<string, AntigravityTranscriptItem[]>>
  >;
  setBusy: Dispatch<SetStateAction<Record<string, boolean>>>;
  setPermissions: Dispatch<
    SetStateAction<Record<string, AntigravityPermission | undefined>>
  >;
  setConfigs: Dispatch<
    SetStateAction<Record<string, AntigravityConfigOption[]>>
  >;
  setSessions: Dispatch<SetStateAction<AntigravitySession[]>>;
  setError: Dispatch<SetStateAction<string>>;
  loaded: MutableRefObject<Map<string, number>>;
  connectionId: MutableRefObject<number | null>;
};

function textOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const item = content as { type?: unknown; text?: unknown };
  return item.type === "text" && typeof item.text === "string" ? item.text : "";
}

function appendChunk(
  current: AntigravityTranscriptItem[],
  id: string,
  role: "user" | "assistant",
  chunk: string,
): AntigravityTranscriptItem[] {
  const index = current.findIndex(
    (item) => item.id === id && item.role === role,
  );
  if (index < 0) return [...current, { id, role, text: chunk }];
  const next = [...current];
  next[index] = { ...next[index], text: next[index].text + chunk };
  return next;
}

/** 按会话记录轮次，messageId 缺失时也能把不同轮拆开。 */
const turnState = new Map<
  string,
  { turn: number; last: "user" | "assistant" | null }
>();

function nextMessageId(
  sessionId: string,
  role: "user" | "assistant",
  messageId: unknown,
): string {
  const state = turnState.get(sessionId) ?? { turn: 0, last: null };
  if (role === "user" && state.last !== "user") state.turn += 1;
  state.last = role;
  turnState.set(sessionId, state);
  if (typeof messageId === "string" && messageId) return messageId;
  return `${sessionId}-${role}-${state.turn}`;
}

/** 把 ACP 的 session/update 归并成线程消息；连接断开时清空运行态。 */
export function applyAgentEvent(event: AntigravityEnvelope, actions: Actions) {
  const { message } = event;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (
    message.params && typeof message.params === "object" ? message.params : {}
  ) as Record<string, unknown>;
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : "";

  if (method === "bridge/closed") {
    actions.connectionId.current = null;
    actions.loaded.current.clear();
    actions.setBusy({});
    actions.setPermissions({});
    turnState.clear();
    return;
  }

  if (method === "bridge/error" || method === "bridge/stderr") {
    const text = (params as { message?: unknown }).message;
    if (typeof text === "string" && method === "bridge/error")
      actions.setError(text);
    return;
  }

  if (method === "bridge/response") {
    if (params.requestMethod === "session/prompt" && sessionId) {
      actions.setBusy((current) => ({ ...current, [sessionId]: false }));
      if (params.error) {
        actions.setMessages((current) => ({
          ...current,
          [sessionId]: [
            ...(current[sessionId] ?? []),
            {
              id: `error-${Date.now()}`,
              role: "error",
              text: String(
                (params.error as { message?: unknown }).message ??
                  "Antigravity 请求失败",
              ),
            },
          ],
        }));
      }
    }
    return;
  }

  if (method === "session/request_permission") {
    const id = message.id;
    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const options = Array.isArray(params.options) ? params.options : [];
    if (!sessionId || id === undefined) return;
    const request: AntigravityPermission = {
      requestId: id,
      sessionId,
      title:
        typeof toolCall?.title === "string"
          ? toolCall.title
          : "Antigravity 请求执行操作",
      name: typeof toolCall?.name === "string" ? toolCall.name : undefined,
      input: toolCall?.rawInput,
      options: options.filter(
        (item): item is AntigravityPermission["options"][number] =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { optionId?: unknown }).optionId === "string" &&
          typeof (item as { name?: unknown }).name === "string" &&
          typeof (item as { kind?: unknown }).kind === "string",
      ),
    };
    actions.setPermissions((current) => ({ ...current, [sessionId]: request }));
    return;
  }

  if (method !== "session/update" || !sessionId) return;
  const update = params.update as Record<string, unknown> | undefined;
  if (!update) return;
  const kind = update.sessionUpdate;

  if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
    const role = kind === "user_message_chunk" ? "user" : "assistant";
    const id = nextMessageId(sessionId, role, update.messageId);
    const text = textOf(update);
    actions.setMessages((current) => ({
      ...current,
      [sessionId]: appendChunk(current[sessionId] ?? [], id, role, text),
    }));
    if (role === "user") {
      actions.setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                preview: `${session.preview}${text}`.slice(-160),
                updatedAt: Date.now(),
              }
            : session,
        ),
      );
    }
    return;
  }

  if (kind === "tool_call") {
    const toolId =
      typeof update.toolCallId === "string"
        ? update.toolCallId
        : `tool-${Date.now()}`;
    actions.setMessages((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        {
          id: toolId,
          role: "tool",
          text: typeof update.title === "string" ? update.title : "工具调用",
          name: typeof update.name === "string" ? update.name : undefined,
          status: typeof update.status === "string" ? update.status : "pending",
          input: update.rawInput,
          output: update.rawOutput,
        },
      ],
    }));
    return;
  }

  if (kind === "tool_call_update") {
    const toolId = update.toolCallId;
    actions.setMessages((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) =>
        item.id === toolId
          ? {
              ...item,
              text: typeof update.title === "string" ? update.title : item.text,
              status:
                typeof update.status === "string" ? update.status : item.status,
              output: update.rawOutput ?? update.content ?? item.output,
            }
          : item,
      ),
    }));
    return;
  }

  if (kind === "config_option_update") {
    const options = update.configOptions;
    if (Array.isArray(options)) {
      actions.setConfigs((current) => ({
        ...current,
        [sessionId]: options as AntigravityConfigOption[],
      }));
    }
    return;
  }

  if (kind === "session_info_update") {
    const title = (update as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) return;
    actions.setSessions((current) =>
      current.map((session) =>
        session.id === sessionId && !session.renamed
          ? { ...session, title }
          : session,
      ),
    );
  }
}
