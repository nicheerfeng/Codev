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
};

export type PiMessageItem = {
  id: string;
  kind: "message";
  role: "user" | "assistant";
  text: string;
  thinking: string;
  streaming: boolean;
};

export type PiToolItem = {
  id: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  status: "running" | "done" | "error";
  args: unknown;
  output: string;
};

export type PiTranscriptItem = PiMessageItem | PiToolItem;

export type PiViewStatus =
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type PiViewState = {
  status: PiViewStatus;
  items: PiTranscriptItem[];
  sessionFile: string | null;
  sessionName: string | null;
  model: PiModel | null;
  models: PiModel[];
  thinkingLevel: string;
  thinkingLevels: string[];
  contextPercent: number | null;
  error: string | null;
};
