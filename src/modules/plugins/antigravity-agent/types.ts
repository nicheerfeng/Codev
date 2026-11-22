export type AntigravitySession = {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  updatedAt: number;
  /** 用户手动改过标题，后续不再被 CLI 的会话名覆盖。 */
  renamed?: boolean;
};

export type AntigravityTranscriptItem = {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  name?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
};

export type AntigravityPermission = {
  requestId: unknown;
  sessionId: string;
  title: string;
  name?: string;
  input?: unknown;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

/** 项目分组只按路径末段展示，完整路径留在 title。 */
export function projectLabel(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

export function sessionLabel(session: AntigravitySession) {
  return (
    session.title.trim() ||
    session.preview.trim().slice(0, 40) ||
    "新对话"
  );
}
