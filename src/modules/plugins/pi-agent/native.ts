import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  PiEventEnvelope,
  PiProbeResult,
  PiSessionSummary,
  PiStartResult,
  PiModelsFile,
  PiSessionHistory,
  PiClonedSession,
  PiModel,
} from "./types";

const PI_EVENT = "codev://pi-agent-event";

export type PiAsset = {
  name: string;
  path: string;
  source: string;
  summary?: string | null;
};

export type PiSubagentRun = {
  session?: PiSessionSummary | null;
  runId: string;
  agent: string;
  title: string;
  status: string;
  summary?: string | null;
  updatedAt: string;
};

/** 读取当前父 Pi 会话关联的 pi-subagents 运行摘要。 */
export function listPiSubagentRuns(ownerSessionPath: string): Promise<PiSubagentRun[]> {
  return invoke<PiSubagentRun[]>("pi_agent_list_subagent_runs", { ownerSessionPath });
}

/** 读取 Pi 技能或插件目录的只读展示数据。 */
export function listPiAssets(kind: "skills" | "plugins"): Promise<PiAsset[]> {
  return invoke<PiAsset[]>("pi_agent_list_assets", { kind });
}

/** 读取 settings.json 的 packages 列表，用于推荐插件的已装标记。 */
export function listPiPackageSpecs(): Promise<string[]> {
  return invoke<string[]>("pi_agent_list_package_specs");
}

/** 一次性安装公开 npm 插件，不启动 RPC。 */
export function installPiPackage(packageName: string): Promise<string> {
  return invoke<string>("pi_agent_install_package", { package: packageName });
}

/** 订阅原生会话目录变化，无需认识外部插件。 */
export async function watchPiSessions(
  changed: () => void,
  cwd: string,
): Promise<UnlistenFn> {
  const stop = await listen("codev://pi-sessions-changed", changed);
  try {
    await invoke("pi_agent_watch_sessions", { enabled: true, cwd });
  } catch (error) {
    stop();
    throw error;
  }
  return () => {
    stop();
    void invoke("pi_agent_watch_sessions", { enabled: false, cwd });
  };
}

/** 删除已经确认的 Pi 原生会话文件。 */
export function deletePiSession(path: string): Promise<void> {
  return invoke("pi_agent_delete_session", { path });
}

/** 探测本机 Pi 可执行文件和版本。 */
export function probePiAgent(): Promise<PiProbeResult> {
  return invoke<PiProbeResult>("pi_agent_probe");
}

/** 读取 Pi 主目录，供临时聊天作为工作目录。 */
export function piAgentHomeDir(): Promise<string | null> {
  return invoke<string | null>("pi_agent_home_dir");
}

/** 读取安装戳，覆盖安装后可再次显示起始页。 */
export function codevInstallStamp(): Promise<string | null> {
  return invoke<string | null>("codev_install_stamp");
}

/** 列出属于指定工作目录的 Pi 原生线程。 */
export function listPiSessions(cwd: string): Promise<PiSessionSummary[]> {
  return invoke<PiSessionSummary[]>("pi_agent_list_sessions", {
    cwd,
    limit: 100,
  });
}

/** 读取 Pi 的单一 models.json 文件。 */
export function readPiModels(): Promise<PiModelsFile> {
  return invoke<PiModelsFile>("pi_agent_read_models");
}

/** 校验并直接保存 Pi 的 models.json 文件。 */
export function writePiModels(content: string): Promise<void> {
  return invoke("pi_agent_write_models", { content });
}

/** 向会话 JSONL 追加名称、模型或思考等级，不启动 runtime。 */
export function appendPiSession(request: {
  path: string;
  kind: "session_info" | "model_change" | "thinking_level_change";
  name?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}): Promise<void> {
  return invoke("pi_agent_append_session", { request });
}

/** 复制会话 JSONL 为新线程，不启动 runtime。 */
export function clonePiSession(path: string): Promise<PiClonedSession> {
  return invoke<PiClonedSession>("pi_agent_clone_session", { path });
}

/** 启动新建或恢复的 Pi RPC 会话。 */
export function startPiAgent(
  cwd: string,
  sessionPath?: string,
  modelTest = false,
): Promise<PiStartResult> {
  return invoke<PiStartResult>("pi_agent_start", {
    request: {
      cwd,
      sessionPath: sessionPath ?? null,
      name: null,
      piPath: null,
      modelTest,
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

/** 结束 Codev 当前管理的全部 Pi RPC 进程树。 */
export function closeAllPiAgents(): Promise<number> {
  return invoke<number>("pi_agent_close_all");
}

/** 真正退出：先停 Pi，再结束进程。 */
export function quitCodev(): Promise<void> {
  return invoke("codev_quit");
}

/** 浏览历史时只读 JSONL，默认最近 150 条，不启动 Pi runtime。 */
export function readPiSession(
  path: string,
  before?: number | null,
  limit = 150,
): Promise<PiSessionHistory> {
  return invoke<PiSessionHistory>("pi_agent_read_session", {
    path,
    before: before ?? null,
    limit,
  });
}

/** 从 models.json 列出可选模型，不启动 Pi runtime。 */
export function listPiModels(): Promise<PiModel[]> {
  return invoke<PiModel[]>("pi_agent_list_models");
}

/** 监听所有 Pi RPC 事件并由调用方按会话过滤。 */
export function listenPiEvents(
  callback: (payload: PiEventEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<PiEventEnvelope>(PI_EVENT, (event) => callback(event.payload));
}
