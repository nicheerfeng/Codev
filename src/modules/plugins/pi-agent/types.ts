export type PiProbeResult = {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export type PiSessionSummary = {
  path: string;
  id: string;
  cwd: string;
  name: string | null;
  preview: string | null;
  createdAt: string;
  updatedAt: number;
  messageCount: number;
};

export type PiModelsFile = {
  path: string;
  exists: boolean;
  content: string;
};

export type PiSessionHistory = {
  messages: unknown[];
  model: PiModel | null;
  thinkingLevel?: string | null;
  sessionName: string | null;
  sessionFile: string;
  oldestOffset: number;
  hasMore: boolean;
  contextTokens?: number | null;
  contextPercent?: number | null;
};

export type PiClonedSession = {
  path: string;
  id: string;
  name: string | null;
};

export type PiStartResult = {
  sessionId: number;
  processId: number;
};

export type PiEventEnvelope = {
  sessionId: number;
  stream: "stdout" | "stderr" | "protocol" | "lifecycle";
  event: Record<string, unknown>;
};

export type PiModel = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
};

export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type PiMessageItem = {
  timestamp?: number;
  id: string;
  kind: "message";
  role: "user" | "assistant";
  text: string;
  thinking: string;
  streaming: boolean;
  images?: PiImage[];
  stopReason?: PiStopReason;
};

export type PiImage = { type: "image"; data: string; mimeType: string };
export type PiQueueState = {
  steering: string[];
  followUp: string[];
  pendingCount: number;
};

export type PiThinkingItem = {
  id: string;
  kind: "thinking";
  text: string;
  streaming: boolean;
  timestamp?: number;
};

export type PiToolItem = {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  status: "running" | "done" | "error";
  args: unknown;
  output: string;
  startedAt?: number;
  finishedAt?: number;
};

export type PiTranscriptItem = PiMessageItem | PiThinkingItem | PiToolItem;

export type PiViewStatus =
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type PiViewState = {
  compaction?: { status: "running" | "done" | "failed"; startedAt: number; finishedAt?: number };
  localQueue?: { id: string; text: string; images: PiImage[]; behavior: "steer" | "followUp" }[];
  queueSendingId?: string;
  modelsLoading: boolean;
  commands: { name: string; description?: string }[];
  status: PiViewStatus;
  items: PiTranscriptItem[];
  sessionFile: string | null;
  sessionName: string | null;
  model: PiModel | null;
  models: PiModel[];
  thinkingLevel: string;
  thinkingLevels: string[];
  contextPercent: number | null;
  contextTokens: number | null;
  queue: PiQueueState;
  phase: string;
  error: string | null;
  processStartedAt?: number;
  processFinishedAt?: number;
  historyOffset: number | null;
  historyHasMore: boolean;
  historyLoadingMore: boolean;
};
