import {
  closePiAgent,
  listenPiEvents,
  sendPiCommand,
  startPiAgent,
} from "./native";
import { INITIAL_PI_VIEW_STATE, objectValue, piViewReducer } from "./reducer";
import type { PiEventEnvelope, PiImage, PiViewState } from "./types";

export type PiThread = {
  loadingHistory: boolean;
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
  /** 空闲 runtime 回收时间，线程数据仍保留在前端内存中。 */
  private static readonly IDLE_RUNTIME_MS = 30 * 60 * 1000;
  readonly threads = new Map<string, PiThread>();
  private pending = new Map<string, Pending>();
  private opening = new Map<string, Promise<PiThread>>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stop: Promise<() => void>;

  /** 注册一次事件监听，以 runtimeId 分发并合并流式渲染刷新。 */
  constructor(
    private changed: () => void,
    private extension: (key: string, event: Record<string, unknown>) => void,
    private modelTest = false,
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
    this.touchRuntime(thread);
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
    return this.ensureRuntime(thread).then(() =>
      this.sendRequest(thread, command),
    );
  }

  /** 首次真实 RPC 操作时才为线程启动 Pi runtime。 */
  private async ensureRuntime(thread: PiThread): Promise<void> {
    if (thread.runtimeId !== null) {
      this.touchRuntime(thread);
      return;
    }
    const pending = this.opening.get(thread.key);
    if (pending) {
      await pending;
      return;
    }
    const operation = this.start(
      thread.key,
      thread.cwd,
      thread.view.sessionFile ?? undefined,
    ).finally(() => this.opening.delete(thread.key));
    this.opening.set(thread.key, operation);
    await operation;
  }

  /** 向已经启动的 runtime 发送请求并维护请求生命周期。 */
  private sendRequest(
    thread: PiThread,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    if (thread.runtimeId === null)
      return Promise.reject(new Error("Pi 会话未启动"));
    this.touchRuntime(thread);
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
    if (existing) return Promise.resolve(existing);
    const thread: PiThread = {
      loadingHistory: false,
      key,
      cwd,
      runtimeId: null,
      view: {
        ...INITIAL_PI_VIEW_STATE,
        sessionFile: path ?? null,
      },
    };
    this.threads.set(key, thread);
    this.publish();
    return Promise.resolve(thread);
  }

  /** 在监听就绪后启动进程，再读取原生历史与模型。 */
  private async start(
    key: string,
    cwd: string,
    path?: string,
  ): Promise<PiThread> {
    await this.stop;
    if (this.disposed) throw new Error("Pi 插件已关闭");
    const thread = this.threads.get(key);
    if (!thread) throw new Error("Pi 线程不存在");
    thread.loadingHistory = true;
    thread.view = { ...thread.view, status: "starting", modelsLoading: true };
    this.threads.set(key, thread);
    this.publish();
    try {
      const runtime = await startPiAgent(cwd, path, this.modelTest);
      if (this.disposed) {
        await closePiAgent(runtime.sessionId);
        throw new Error("Pi 插件已关闭");
      }
      thread.runtimeId = runtime.sessionId;
      this.touchRuntime(thread);
      await Promise.all([
        this.sendRequest(thread, { type: "get_available_models" }),
        this.sendRequest(thread, { type: "get_state" }),
        this.sendRequest(thread, { type: "get_session_stats" }),
        this.sendRequest(thread, { type: "get_messages" }),
        this.sendRequest(thread, { type: "get_available_thinking_levels" }),
        this.sendRequest(thread, { type: "get_commands" }),
      ]);
      thread.loadingHistory = false;
      this.publish();
      return thread;
    } catch (error) {
      thread.loadingHistory = false;
      if (thread.runtimeId !== null) await this.close(key);
      thread.view = {
        ...thread.view,
        status: "failed",
        modelsLoading: false,
        error: String(error),
      };
      this.publish();
      throw error;
    }
  }

  /** 读取会话名称、模型、实际上下文用量。 */
  async refreshState(thread: PiThread) {
    await this.ensureRuntime(thread);
    await Promise.all([
      this.sendRequest(thread, { type: "get_state" }),
      this.sendRequest(thread, { type: "get_session_stats" }),
    ]);
  }

  /** 在模型选择器打开时预加载当前线程模型，避免新线程首次点击无列表。 */
  async loadModels(thread: PiThread) {
    await this.ensureRuntime(thread);
    if (thread.view.models.length) return thread.view.models;
    thread.view = { ...thread.view, modelsLoading: true, error: null };
    this.publish();
    await this.sendRequest(thread, { type: "get_available_models" });
    return thread.view.models;
  }

  /** 先取回未执行的队列文本，再中断运行，恢复操作始终绑定原线程。 */
  async stopAndRestore(thread: PiThread, restore: (texts: string[]) => void) {
    const queued = objectValue(
      await this.request(thread, { type: "clear_queue" }),
    );
    restore([
      ...(Array.isArray(queued?.steering) ? queued.steering : []),
      ...(Array.isArray(queued?.followUp) ? queued.followUp : []),
    ]);
    thread.view = piViewReducer(thread.view, { type: "stopping" });
    this.publish();
    await this.request(thread, { type: "abort" });
    await this.refreshState(thread);
  }

  /** 在当前 Pi session 分叉到最后一条用户输入前，并重发编辑后的内容。 */
  async editLastUser(
    thread: PiThread,
    text: string,
    images: PiImage[] = [],
  ): Promise<boolean> {
    if (thread.view.status !== "idle")
      throw new Error("只有自然结束的线程可以编辑");
    if (!text.trim()) throw new Error("编辑内容不能为空");
    const forkData = objectValue(
      await this.request(thread, { type: "get_fork_messages" }),
    );
    const messages = Array.isArray(forkData?.messages)
      ? forkData.messages
          .map((value) => objectValue(value))
          .filter((value): value is Record<string, unknown> => value !== null)
      : [];
    const target = messages[messages.length - 1];
    const entryId = typeof target?.entryId === "string" ? target.entryId : "";
    if (!entryId) throw new Error("无法定位最后一条用户输入");
    const forkResult = objectValue(
      await this.request(thread, { type: "fork", entryId }),
    );
    if (forkResult?.cancelled === true) return false;
    await this.request(thread, { type: "get_messages" });
    await this.refreshState(thread);
    await this.request(thread, {
      type: "prompt",
      message: text,
      ...(images.length ? { images } : {}),
    });
    return true;
  }

  /** 原生分叉会切换会话文件；为新会话分配独立界面键并保留原线程。 */
  async branch(thread: PiThread) {
    if (thread.view.status !== "idle")
      throw new Error("请先停止当前任务再分叉");
    const original = { ...thread, runtimeId: null };
    const result = objectValue(await this.request(thread, { type: "clone" }));
    if (result?.cancelled) return null;
    this.threads.set(original.key, original);
    thread.key = crypto.randomUUID();
    thread.view = {
      ...INITIAL_PI_VIEW_STATE,
      models: original.view.models,
      commands: original.view.commands,
    };
    this.threads.set(thread.key, thread);
    await Promise.all([
      this.refreshState(thread),
      this.request(thread, { type: "get_messages" }),
      this.request(thread, { type: "get_available_thinking_levels" }),
    ]);
    this.publish();
    return {
      thread,
      text: typeof result?.text === "string" ? result.text : "",
    };
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

  /** 延后回收空闲 runtime，运行中的线程和线程数据不受影响。 */
  private touchRuntime(thread: PiThread) {
    const old = this.idleTimers.get(thread.key);
    if (old) clearTimeout(old);
    if (thread.runtimeId === null || thread.view.status !== "idle") return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(thread.key);
      if (thread.runtimeId !== null && thread.view.status === "idle")
        void this.close(thread.key);
    }, PiWorkspaceClient.IDLE_RUNTIME_MS);
    this.idleTimers.set(thread.key, timer);
  }

  /** 用户显式关闭指定线程的进程，原生会话文件继续保留。 */
  async close(key: string) {
    const thread = this.threads.get(key);
    if (thread?.runtimeId == null) return;
    const idleTimer = this.idleTimers.get(key);
    if (idleTimer) clearTimeout(idleTimer);
    this.idleTimers.delete(key);
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
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    void this.stop.then((stop) => stop());
    for (const thread of this.threads.values())
      if (thread.runtimeId !== null) {
        this.rejectRequests(thread.runtimeId, "Pi 插件已关闭");
        void closePiAgent(thread.runtimeId);
      }
  }
}
