export type Capabilities = {
  supportsResume: boolean;
  supportsFork: boolean;
  supportsThinking: boolean;
  supportsPermission: boolean;
  supportsImages: boolean;
  supportsFileMentions: boolean;
  supportsQueue: boolean;
  supportsCompaction: boolean;
  supportsModelSelection: boolean;
  supportsSkills: boolean;
  supportsExtensionUi: boolean;
  supportsContextUsage: boolean;
};
export type Harness = {
  id: string;
  displayName: string;
  kind: "nativePi" | "acp";
  command: string;
  args: string[];
  installed: boolean;
  capabilities: Capabilities;
};
export type Workspace = {
  id: string;
  cwd: string;
  title: string;
  manual?: boolean;
};
export type Model = {
  id: string;
  provider?: string;
  name?: string;
  contextWindow?: number;
  configId?: string;
};
export type AgentImage = {
  type: "image";
  id?: string;
  data: string;
  mimeType: string;
  unavailable?: boolean;
};
export type AgentMessage = {
  id: string;
  kind: string;
  role: string;
  text: string;
  thinking: string;
  toolName: string;
  toolCallId: string;
  toolKind?: string;
  arguments: unknown;
  diff?: unknown;
  locations?: Array<{ path?: string; line?: number }>;
  isError?: boolean;
  status: string;
  images: AgentImage[];
  streaming: boolean;
  rawKind: string;
  createdAt?: number;
  sourceEventId?: string;
};
export type PendingRequest = {
  id: string;
  kind: string;
  title: string;
  message: string;
  options: Array<string | { optionId: string; name: string; kind?: string }>;
  defaultValue: string;
};
export type ConfigChoice = {
  value: string;
  name?: string;
  label?: string;
  options?: ConfigChoice[];
};
export type ConfigOption = {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue: string;
  options: ConfigChoice[];
};
export type SessionSummary = {
  id: string;
  workspaceId: string;
  harnessId: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  readOnly: boolean;
  imported: boolean;
  instanceId: string | null;
  revision?: number;
  state: string;
  error?: string | null;
  preview?: string;
};
export type SessionView = SessionSummary & {
  nativeSessionId?: string | null;
  nativeSessionPath?: string | null;
  _messageOrder?: string[];
  capabilities: Capabilities;
  messages: AgentMessage[];
  models: Model[];
  model: Model | null;
  thinkingLevels: string[];
  thinkingLevel: string;
  configOptions: ConfigOption[];
  commands: Array<{
    name: string;
    description?: string;
    source?: string;
    input?: { hint?: string } | null;
  }>;
  pendingRequests: PendingRequest[];
  queue: Array<{
    id?: string;
    index?: number;
    text: string;
    imageCount?: number;
    images?: AgentImage[];
    steer?: boolean;
  }>;
  context: {
    tokens?: number;
    window?: number;
    percent?: number;
    used?: number;
    size?: number;
    [key: string]: unknown;
  };
  statuses?: Record<string, unknown>;
  historyLoaded: boolean;
  historyOffset: number;
  historyAvailable: boolean;
  truncated: boolean;
};
export type HostSnapshot = {
  protocolVersion: number;
  serverId: string;
  sequence: number;
  workspaces: Workspace[];
  sessions: SessionSummary[];
  harnesses: Harness[];
  vcsSnapshots?: import("@/modules/vcs/types").VcsSnapshot[];
  forgeInboxes?: import("@/modules/vcs/types").ForgeInboxSnapshot[];
};
export type HostEvent = {
  protocolVersion: number;
  sequence: number;
  kind: string;
  sessionId?: string;
  instanceId?: string;
  payload: unknown;
};
export type Frame =
  | { type: "snapshot" | "resync"; snapshot: HostSnapshot }
  | { type: "event"; event: HostEvent };
export const isBusy = (session?: SessionSummary) =>
  !!session &&
  ["starting", "working", "stopping", "compacting"].includes(session.state);
export const statusLabel = (state?: string) =>
  ({
    starting: "连接中",
    working: "运行中",
    stopping: "停止中",
    compacting: "压缩中",
    idle: "就绪",
    stopped: "未连接",
    crashed: "连接中断",
    suspended: "已挂起",
  })[state ?? ""] ?? "未连接";
export const choices = (option: ConfigOption) =>
  option.options.flatMap((o) => o.options ?? [o]);
