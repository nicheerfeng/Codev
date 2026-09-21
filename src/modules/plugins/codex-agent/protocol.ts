import type { SandboxMode, SandboxPolicy } from "./sandbox";

export type Input =
  | { type: "text"; text: string; text_elements: never[] }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "image"; url: string };
export type Skill = {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
};
export type Item = {
  id: string;
  type: string;
  text?: string;
  content?:
    | Array<{ type: string; text?: string; path?: string; url?: string }>
    | string[];
  summary?: string[];
  command?: string;
  aggregatedOutput?: string | null;
  status?: string;
  tool?: string;
  changes?: Array<{
    path: string;
    diff: string;
    kind?: { type: string; move_path?: string | null };
  }>;
  [key: string]: unknown;
};
export type Turn = {
  id: string;
  status: string;
  items: Item[];
  error?: { message: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
};
export type Thread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  turns: Turn[];
  model?: string | null;
  modelProvider?: string;
  path?: string | null;
};
export type Model = {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
};
export type Question = {
  id: string;
  question: string;
  isSecret: boolean;
  options?: Array<{ label: string; description: string }> | null;
};
export type Request = {
  id: number | string;
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    questions?: Question[];
    availableDecisions?: unknown[];
    [key: string]: unknown;
  };
};
export type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
export type Session = {
  thread: Thread;
  draftThread: boolean;
  loaded: boolean;
  resumed: boolean;
  turnId: string | null;
  busy: boolean;
  sending: boolean;
  error: string | null;
  requests: Request[];
  draft: string;
  attachments: string[];
  images: string[];
  skills: Skill[];
  directories: string[];
  queue: Array<Draft & { id: string }>;
  queueError: string | null;
  stopping: boolean;
  sendRevision: number;
  focusRevision: number;
  submitted: string[];
  tokenUsage: {
    last: { totalTokens: number };
    total: { totalTokens: number };
    modelContextWindow: number | null;
  } | null;
  compacting: boolean;
  historyCursor: string | null;
  historyLoading: boolean;
  archived: boolean;
  model: string;
  effort: string;
  sandbox: SandboxMode;
  effectiveSandbox: SandboxPolicy | null;
};
export type Draft = Pick<
  Session,
  "draft" | "attachments" | "images" | "skills" | "directories"
>;

/** 为每个 Codex 线程创建独立的会话状态。 */
export function sessionFromThread(thread: Thread): Session {
  return {
    thread,
    draftThread: false,
    loaded: false,
    resumed: false,
    turnId: null,
    busy: false,
    sending: false,
    error: null,
    requests: [],
    draft: "",
    attachments: [],
    images: [],
    skills: [],
    directories: [],
    queue: [],
    queueError: null,
    stopping: false,
    sendRevision: 0,
    focusRevision: 0,
    submitted: [],
    tokenUsage: null,
    compacting: false,
    historyCursor: null,
    historyLoading: false,
    archived: false,
    model: thread.model ?? "",
    effort: "",
    sandbox: "danger-full-access",
    effectiveSandbox: null,
  };
}

/** 完成事件可能只携带最终答复，按编号合并并保留已经收到的过程顺序。 */
function mergeTurnItems(previous: Item[], incoming: Item[]): Item[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, { ...merged.get(item.id), ...item });
  return [...merged.values()];
}

/** 兼容 app-server 用量字段命名，缺少上报时保持未知。 */
function normalizeTokenUsage(raw: unknown): Session["tokenUsage"] {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as {
    last?: { totalTokens?: number; total_tokens?: number };
    total?: { totalTokens?: number; total_tokens?: number };
    modelContextWindow?: number | null;
    model_context_window?: number | null;
  };
  return {
    last: { totalTokens: Number(value.last?.totalTokens ?? value.last?.total_tokens ?? 0) },
    total: { totalTokens: Number(value.total?.totalTokens ?? value.total?.total_tokens ?? 0) },
    modelContextWindow: value.modelContextWindow ?? value.model_context_window ?? null,
  };
}

/** 按原生线程、轮次和消息编号合并增量，最终消息覆盖流式副本。 */
export function reduceNotification(
  session: Session,
  method: string,
  params: Record<string, unknown>,
): Session {
  if (method === "thread/tokenUsage/updated")
    return {
      ...session,
      tokenUsage: normalizeTokenUsage(params.tokenUsage ?? params.token_usage),
      compacting: false,
    };
  if (method === "thread/name/updated")
    return {
      ...session,
      thread: { ...session.thread, name: params.threadName as string },
    };
  if (method === "error")
    return {
      ...session,
      error:
        (params.error as { message?: string })?.message ?? "Codex 执行失败",
    };
  if (method === "serverRequest/resolved")
    return {
      ...session,
      requests: session.requests.filter((r) => r.id !== params.requestId),
    };
  const turnId =
    (params.turnId as string | undefined) ??
    (params.turn as Turn | undefined)?.id;
  if (!turnId) return session;
  const turns = [...session.thread.turns];
  let index = turns.findIndex((t) => t.id === turnId);
  if (index < 0) {
    index = turns.length;
    turns.push({ id: turnId, status: "inProgress", items: [] });
  }
  let turn = { ...turns[index], items: [...turns[index].items] };
  let next = { ...session };
  if (method === "turn/started") {
    const started = params.turn as Turn;
    turn = {
      ...turn,
      ...started,
      items: started.items?.length ? started.items : turn.items,
      startedAt: started.startedAt ?? Date.now() / 1000,
    };
    next = { ...next, turnId, busy: true, error: null };
  }
  if (method === "turn/completed") {
    const completed = params.turn as Turn;
    turn = {
      ...turn,
      ...completed,
      completedAt: completed.completedAt ?? Date.now() / 1000,
      items: mergeTurnItems(turn.items, completed.items ?? []),
    };
    next = {
      ...next,
      turnId: null,
      busy: false,
      requests: next.requests.filter((r) => r.params.turnId !== turnId),
      error: completed.error?.message ?? null,
    };
  }
  if (method === "item/started" || method === "item/completed") {
    const incoming = params.item as Item;
    const item =
      ["reasoning", "webSearch"].includes(incoming.type)
        ? {
            ...incoming,
            status: method === "item/started" ? "inProgress" : "completed",
          }
        : incoming;
    const itemIndex = turn.items.findIndex((i) => i.id === item.id);
    if (itemIndex < 0) turn.items.push(item);
    else turn.items[itemIndex] = method === "item/started"
      ? { ...item, ...turn.items[itemIndex] }
      : { ...turn.items[itemIndex], ...item };
  }
  if (method.endsWith("/delta") || method.endsWith("Delta")) {
    const itemId = params.itemId as string;
    let itemIndex = turn.items.findIndex((i) => i.id === itemId);
    if (itemIndex < 0 && (method === "item/agentMessage/delta" || method === "item/plan/delta")) {
      itemIndex = turn.items.length;
      turn.items.push({ id: itemId, type: method === "item/plan/delta" ? "plan" : "agentMessage", text: "" });
    }
    if (itemIndex >= 0) {
      const item = { ...turn.items[itemIndex] };
      const delta = String(params.delta ?? "");
      if (method === "item/agentMessage/delta" || method === "item/plan/delta")
        item.text = (item.text ?? "") + delta;
      if (method === "item/commandExecution/outputDelta")
        item.aggregatedOutput = (item.aggregatedOutput ?? "") + delta;
      if (
        method === "item/reasoning/summaryTextDelta" ||
        method === "item/reasoning/textDelta"
      ) {
        const field = method.includes("summary") ? "summary" : "content";
        const parts = [...((item[field] as string[] | undefined) ?? [])];
        const part = Number(params.summaryIndex ?? params.contentIndex ?? 0);
        parts[part] = (parts[part] ?? "") + delta;
        item[field] = parts;
      }
      turn.items[itemIndex] = item;
    }
  }
  turns[index] = turn;
  return { ...next, thread: { ...next.thread, turns } };
}

/** 提取真实消息摘要，保留开头并由界面截断尾部。 */
export function itemText(item: Item): string {
  if (item.type === "agentMessage" || item.type === "plan") return item.text ?? "";
  if (item.text) return item.text;
  if (item.type === "userMessage")
    return ((item.content as Array<{ text?: string; path?: string }>) ?? [])
      .map((part) => part.text ?? part.path ?? "")
      .join("\n");
  if (item.type === "reasoning")
    return [
      ...(item.summary ?? []),
      ...((item.content as string[]) ?? []),
    ].join("\n");
  if (item.type === "webSearch") {
    const action = item.action as { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string } | null;
    if (action?.type === "open_page") return `打开网页 · ${action.url ?? ""}`;
    if (action?.type === "find_in_page") return `页内查找 · ${action.pattern ?? ""} · ${action.url ?? ""}`;
    return `搜索 · ${action?.queries?.join(" · ") || action?.query || (typeof item.query === "string" ? item.query : "")}`;
  }
  if (item.command) return item.command;
  if (item.changes) return item.changes.map((change) => change.path).join(", ");
  return item.tool ?? item.type;
}
