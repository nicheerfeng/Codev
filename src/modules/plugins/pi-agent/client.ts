import {
  closePiAgent,
  listenPiEvents,
  sendPiCommand,
  startPiAgent,
} from "./native";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "./reducer";
import type { PiEventEnvelope, PiViewState } from "./types";

export type PiThread = {
  key: string;
  cwd: string;
  runtimeId: number | null;
  view: PiViewState;
};
type Pending = {
  runtimeId: number;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 管理 Pi 原生进程与请求关联，切换界面不会停止其他线程。 */
export class PiWorkspaceClient {
  readonly threads = new Map<string, PiThread>();
  private pending = new Map<string, Pending>();
  private opening = new Map<string, Promise<PiThread>>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stop: Promise<() => void>;

  /** 注册一次事件监听，以 runtimeId 分发并合并流式渲染刷新。 */
  constructor(
    private changed: () => void,
    private extension: (key: string, event: Record<string, unknown>) => void,
  ) {
    this.stop = listenPiEvents((payload) => this.receive(payload));
    void this.stop.catch((error) => {
      if (!this.disposed)
        this.extension("", { method: "notify", message: String(error) });
    });
  }

  /** 将进程输出应用到所属线程，并完成对应的 RPC 请求。 */
  private receive(payload: PiEventEnvelope) {
    const thread = [...this.threads.values()].find(
      (item) => item.runtimeId === payload.sessionId,
    );
    if (!thread) return;
    thread.view = piViewReducer(thread.view, { type: "event", payload });
    const event = payload.event;
    if (event.type === "response") {
      const id = String(event.id);
      const request = this.pending.get(id);
      if (request && request.runtimeId === payload.sessionId) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        if (event.success === false)
          request.reject(new Error(String(event.error)));
        else request.resolve(event.data);
      }
    }
    if (event.type === "extension_ui_request")
      this.extension(thread.key, event);
    if (event.type === "process_exit") {
      this.rejectRequests(payload.sessionId, "Pi 会话已结束");
      thread.runtimeId = null;
    }
    if (event.type === "agent_settled" && thread.runtimeId !== null) {
      void this.refreshState(thread).catch((error) =>
        this.error(thread.key, error),
      );
    }
    this.publish(
      event.type === "message_update" || event.type === "tool_execution_update",
    );
  }

  /** 每帧最多通知一次高频内容变化，命令和生命周期立即生效。 */
  private publish(streaming = false) {
    if (this.disposed) return;
    if (!streaming) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.changed();
    } else if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.changed();
      }, 16);
  }

  /** 发送带关联 ID 的请求，等待 Pi 接受或返回明确错误。 */
  request(
    thread: PiThread,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    if (thread.runtimeId === null)
      return Promise.reject(new Error("Pi 会话未启动"));
    const runtimeId = thread.runtimeId;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi ${command.type} 响应超时`));
      }, 120_000);
      this.pending.set(id, { runtimeId, resolve, reject, timer });
      void sendPiCommand(runtimeId, { ...command, id }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** 新建或恢复指定线程，多次点击同一线程共用启动任务。 */
  open(key: string, cwd: string, path?: string): Promise<PiThread> {
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = this.threads.get(key);
    if (existing?.runtimeId != null) return Promise.resolve(existing);
    const operation = this.start(key, cwd, path).finally(() =>
      this.opening.delete(key),
    );
    this.opening.set(key, operation);
    return operation;
  }

  /** 在监听就绪后启动进程，再读取原生历史与模型。 */
  private async start(
    key: string,
    cwd: string,
    path?: string,
  ): Promise<PiThread> {
    await this.stop;
    if (this.disposed) throw new Error("Pi 插件已关闭");
    const thread: PiThread = {
      key,
      cwd,
      runtimeId: null,
      view: { ...INITIAL_PI_VIEW_STATE, status: "starting" },
    };
    this.threads.set(key, thread);
    this.publish();
    try {
      const runtime = await startPiAgent(cwd, path);
      if (this.disposed) {
        await closePiAgent(runtime.sessionId);
        throw new Error("Pi 插件已关闭");
      }
      thread.runtimeId = runtime.sessionId;
      await Promise.all([
        this.request(thread, { type: "get_messages" }),
        this.refreshState(thread),
        this.request(thread, { type: "get_available_models" }),
        this.request(thread, { type: "get_available_thinking_levels" }),
      ]);
      return thread;
    } catch (error) {
      if (thread.runtimeId !== null) await this.close(key);
      thread.view = { ...thread.view, status: "failed", error: String(error) };
      this.publish();
      throw error;
    }
  }

  /** 读取会话名称、模型、实际上下文用量。 */
  async refreshState(thread: PiThread) {
    await Promise.all([
      this.request(thread, { type: "get_state" }),
      this.request(thread, { type: "get_session_stats" }),
    ]);
  }

  /** 展示当前操作错误，不覆盖已有消息。 */
  error(key: string, error: unknown) {
    const thread = this.threads.get(key);
    if (thread) {
      thread.view = { ...thread.view, error: String(error) };
      this.publish();
    }
  }

  /** 结束进程时释放尚未返回的请求。 */
  private rejectRequests(runtimeId: number, message: string) {
    for (const [id, pending] of this.pending)
      if (pending.runtimeId === runtimeId) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(message));
      }
  }

  /** 用户显式关闭指定线程的进程，原生会话文件继续保留。 */
  async close(key: string) {
    const thread = this.threads.get(key);
    if (thread?.runtimeId == null) return;
    const id = thread.runtimeId;
    await closePiAgent(id);
    thread.runtimeId = null;
    thread.view = piViewReducer(thread.view, {
      type: "event",
      payload: {
        sessionId: id,
        stream: "lifecycle",
        event: { type: "process_exit" },
      },
    });
    this.rejectRequests(id, "Pi 会话已关闭");
    this.publish();
  }

  /** 插件真正卸载时释放监听、计时器和由插件启动的进程。 */
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    void this.stop.then((stop) => stop());
    for (const thread of this.threads.values())
      if (thread.runtimeId !== null) {
        this.rejectRequests(thread.runtimeId, "Pi 插件已关闭");
        void closePiAgent(thread.runtimeId);
      }
  }
}
