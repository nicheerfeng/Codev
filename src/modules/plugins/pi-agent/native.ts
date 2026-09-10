import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  PiEventEnvelope,
  PiProbeResult,
  PiSessionSummary,
  PiStartResult,
  PiModelsFile,
} from "./types";

const PI_EVENT = "codev://pi-agent-event";

/** 探测本机 Pi 可执行文件和版本。 */
export function probePiAgent(): Promise<PiProbeResult> {
  return invoke<PiProbeResult>("pi_agent_probe");
}

/** 列出属于指定工作目录的 Pi 原生线程。 */
export function listPiSessions(cwd: string): Promise<PiSessionSummary[]> {
  return invoke<PiSessionSummary[]>("pi_agent_list_sessions", {
    cwd,
    limit: 100,
  });
}

/** 读取所有 Pi 原生线程，供插件按 cwd 自动分组。 */
export function listAllPiSessions(): Promise<PiSessionSummary[]> {
  return invoke<PiSessionSummary[]>("pi_agent_list_all_sessions");
}

/** 读取 Pi 的单一 models.json 文件。 */
export function readPiModels(): Promise<PiModelsFile> {
  return invoke<PiModelsFile>("pi_agent_read_models");
}

/** 校验并直接保存 Pi 的 models.json 文件。 */
export function writePiModels(content: string): Promise<void> {
  return invoke("pi_agent_write_models", { content });
}

/** 重命名当前 Pi 会话，写入 Pi 原生 session_info 记录。 */
export function renamePiSession(
  sessionId: number,
  name: string,
): Promise<void> {
  return sendPiCommand(sessionId, { type: "set_session_name", name });
}

/** 启动新建或恢复的 Pi RPC 会话。 */
export function startPiAgent(
  cwd: string,
  sessionPath?: string,
): Promise<PiStartResult> {
  return invoke<PiStartResult>("pi_agent_start", {
    request: {
      cwd,
      sessionPath: sessionPath ?? null,
      name: null,
      piPath: null,
    },
  });
}

/** 向 Pi RPC 会话发送一条协议命令。 */
export function sendPiCommand(
  sessionId: number,
  command: Record<string, unknown>,
): Promise<void> {
  return invoke("pi_agent_send", { sessionId, command });
}

/** 关闭指定 Pi RPC 进程。 */
export function closePiAgent(sessionId: number): Promise<boolean> {
  return invoke<boolean>("pi_agent_close", { sessionId });
}

/** 监听所有 Pi RPC 事件并由调用方按会话过滤。 */
export function listenPiEvents(
  callback: (payload: PiEventEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<PiEventEnvelope>(PI_EVENT, (event) => callback(event.payload));
}
