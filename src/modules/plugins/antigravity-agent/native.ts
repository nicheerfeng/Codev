import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AntigravityConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: Array<
    | { value: string; name: string; description?: string }
    | {
        group: string;
        name: string;
        options: Array<{ value: string; name: string; description?: string }>;
      }
  >;
};

export type AntigravityStartResult = {
  connectionId: number;
  sessionId: string;
  loadSession: boolean;
  imageInput: boolean;
  configOptions: AntigravityConfigOption[];
};

export type AntigravityEnvelope = {
  connectionId: number;
  message: Record<string, unknown>;
};

export function startAntigravitySession(
  cwd: string,
  sessionId?: string,
): Promise<AntigravityStartResult> {
  return invoke("antigravity_agent_start", {
    cwd,
    sessionId: sessionId ?? null,
  });
}

export type AntigravityImage = { data: string; mimeType: string };

export function sendAntigravityPrompt(
  connectionId: number,
  sessionId: string,
  text: string,
  images: AntigravityImage[] = [],
): Promise<void> {
  return invoke("antigravity_agent_send", {
    connectionId,
    sessionId,
    text,
    images,
  });
}

export function cancelAntigravityPrompt(
  connectionId: number,
  sessionId: string,
): Promise<void> {
  return invoke("antigravity_agent_cancel", { connectionId, sessionId });
}

export function answerAntigravityPermission(
  connectionId: number,
  requestId: unknown,
  optionId: string | null,
): Promise<void> {
  return invoke("antigravity_agent_permission", {
    connectionId,
    requestId,
    optionId,
  });
}

export function setAntigravityConfigOption(
  connectionId: number,
  sessionId: string,
  configId: string,
  value: string | boolean,
): Promise<AntigravityConfigOption[]> {
  return invoke("antigravity_agent_set_config_option", {
    connectionId,
    sessionId,
    configId,
    value,
  });
}

export function closeAntigravitySession(
  connectionId: number,
  sessionId: string,
): Promise<void> {
  return invoke("antigravity_agent_close_session", { connectionId, sessionId });
}

export function closeAllAntigravitySessions(): Promise<void> {
  return invoke("antigravity_agent_close_all");
}

export function listenAntigravityEvents(
  callback: (event: AntigravityEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<AntigravityEnvelope>(
    "codev://antigravity-agent-event",
    (event) => callback(event.payload),
  );
}
