import {
  appendPiSession,
  clonePiSession,
  closeAllPiAgents,
  closePiAgent,
  listPiModels,
  listenPiEvents,
  readPiSession,
  sendPiCommand,
  startPiAgent,
} from "./native";
import { INITIAL_PI_VIEW_STATE, objectValue, piViewReducer } from "./reducer";
import type { PiEventEnvelope, PiImage, PiModel, PiViewState } from "./types";

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
  private static readonly IDLE_RUNTIME_MS = 20 * 60 * 1000;
  readonly threads = new Map<string, PiThread>();
  private pending = new Map<string, Pending>();
  private opening = new Map<string, Promise<PiThread>>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private toolUpdates = new Map<string, PiEventEnvelope>();
  private toolTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogModels: PiModel[] = [];
  private draining = new Set<string>();
  private manualCompactions = new Set<string>();
  private compactionResume = new Set<string>();
  private statsTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    if (payload.event.type === "tool_execution_update") {
      this.toolUpdates.set(
        `${thread.key}:${String(payload.event.toolCallId)}`,
        payload,
      );
      if (!this.toolTimer)
        this.toolTimer = setTimeout(() => this.flushToolUpdates(), 150);
      return;
    }
    this.applyEvent(thread, payload);
  }

  /** 高频工具快照按线程合并后再刷新，避免累计输出叠三份。 */
  private flushToolUpdates() {
    this.toolTimer = null;
    const pending = [...this.toolUpdates.values()];
    this.toolUpdates.clear();
    for (const payload of pending) {
      const thread = [...this.threads.values()].find(
        (item) => item.runtimeId === payload.sessionId,
      );
      if (thread) this.applyEvent(thread, payload, true);
    }
  }

  /** 将一条已归属的 Pi 事件写入线程并通知界面。 */
  private applyEvent(
    thread: PiThread,
    payload: PiEventEnvelope,
    streaming = false,
  ) {
    thread.view = piViewReducer(thread.view, { type: "event", payload });
    this.touchRuntime(thread);
    const event = payload.event;
    if (
      event.type === "auto_compaction_start" ||
      event.type === "compaction_start"
    )
      this.startCompaction(thread);
    if (
      (event.type === "auto_compaction_end" ||
        event.type === "compaction_end") &&
      !this.manualCompactions.has(thread.key)
    ) {
      const success = !event.aborted && !event.errorMessage && !!event.result;
      this.finishCompaction(thread, success);
      if (success && event.willRetry) this.compactionResume.add(thread.key);
      else this.compactionResume.delete(thread.key);
      void this.refreshState(thread)
        .then(() => {
          if (success && !event.willRetry) return this.drainQueue(thread);
        })
        .catch((error) => this.error(thread.key, error));
    }
    if (
      event.type === "process_exit" &&
      thread.view.compaction?.status === "running"
    )
      this.finishCompaction(thread, false);
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
      if (this.compactionResume.delete(thread.key))
        void this.drainQueue(thread).catch((error) =>
          this.error(thread.key, error),
        );
      void this.refreshState(thread).catch((error) =>
        this.error(thread.key, error),
      );
    }
    this.publish(streaming || event.type === "message_update");
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
    return this.ensureRuntime(thread).then(() => {
      if (command.type === "prompt") this.syncStats(thread);
      return this.sendRequest(thread, command);
    });
  }

  /** 点击发送后立刻进入运行态，不必等待 Pi runtime 或 agent_start。 */
  beginPrompt(
    thread: PiThread,
    text: string,
    images?: PiImage[],
    queued = false,
  ) {
    thread.view = piViewReducer(thread.view, {
      type: "prompt",
      text,
      images,
      queued,
    });
    this.publish();
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
    const existing = this.threads.get(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.opening.get(key);
    if (pending) return pending;
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

  /** 启动进程并同步状态；已有消息保持可见，发送中的计时继续。 */
  private async start(
    key: string,
    cwd: string,
    path?: string,
  ): Promise<PiThread> {
    await this.stop;
    if (this.disposed) throw new Error("Pi 插件已关闭");
    const thread = this.threads.get(key);
    if (!thread) throw new Error("Pi 线程不存在");
    thread.loadingHistory = thread.view.items.length === 0;
    thread.view = {
      ...thread.view,
      status: thread.view.status === "running" ? "running" : "starting",
      modelsLoading: true,
    };
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
      const hydrates: Promise<unknown>[] = [
        this.sendRequest(thread, { type: "get_state" }),
        this.sendRequest(thread, { type: "get_session_stats" }),
        this.sendRequest(thread, { type: "get_available_thinking_levels" }),
        this.sendRequest(thread, { type: "get_commands" }),
      ];
      if (!thread.view.items.length)
        hydrates.push(this.sendRequest(thread, { type: "get_messages" }));
      else {
        const last = thread.view.items[thread.view.items.length - 1];
        if (
          last?.id &&
          !last.id.startsWith("history-") &&
          !last.id.startsWith("local-user-")
        )
          hydrates.push(
            this.sendRequest(thread, { type: "get_entries", since: last.id }),
          );
      }
      if (!thread.view.models.length && !this.catalogModels.length)
        hydrates.push(
          this.sendRequest(thread, { type: "get_available_models" }),
        );
      if (thread.view.model)
        hydrates.push(
          this.sendRequest(thread, {
            type: "set_model",
            provider: thread.view.model.provider,
            modelId: thread.view.model.id,
          }),
        );
      if (thread.view.thinkingLevel && thread.view.thinkingLevel !== "off")
        hydrates.push(
          this.sendRequest(thread, {
            type: "set_thinking_level",
            level: thread.view.thinkingLevel,
          }),
        );
      await Promise.all(hydrates);
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

  /** 压缩状态独立于对话运行状态，保留已有时间线。 */
  private startCompaction(thread: PiThread) {
    if (thread.view.compaction?.status === "running") return;
    thread.view = {
      ...thread.view,
      compaction: { status: "running", startedAt: Date.now() },
      error: null,
    };
    this.touchRuntime(thread);
    this.publish();
  }

  /** 保存完成状态与耗时，原生用量未更新时由界面显示待更新。 */
  private finishCompaction(thread: PiThread, success: boolean) {
    thread.view = {
      ...thread.view,
      phase: thread.view.status === "running" ? "处理中" : "",
      compaction: {
        status: success ? "done" : "failed",
        startedAt: thread.view.compaction?.startedAt ?? Date.now(),
        finishedAt: Date.now(),
      },
    };
    this.touchRuntime(thread);
    this.publish();
  }

  /** 手动压缩不重载聊天消息，刷新完成后发送压缩期间缓存的输入。 */
  async compact(thread: PiThread, instructions?: string) {
    if (
      thread.view.status === "running" ||
      thread.view.status === "stopping" ||
      thread.view.compaction?.status === "running"
    )
      throw new Error("请等待当前任务完成后再压缩");
    this.startCompaction(thread);
    this.manualCompactions.add(thread.key);
    try {
      await this.request(thread, {
        type: "compact",
        ...(instructions ? { customInstructions: instructions } : {}),
      });
    } catch (error) {
      this.finishCompaction(thread, false);
      throw error;
    } finally {
      this.manualCompactions.delete(thread.key);
    }
    this.finishCompaction(thread, true);
    await this.refreshState(thread);
    await this.drainQueue(thread);
  }

  /** 运行期间定时读取实时上下文用量，停止后自动释放定时器。 */
  private syncStats(thread: PiThread) {
    if (this.statsTimers.has(thread.key)) return;
    const tick = async () => {
      this.statsTimers.delete(thread.key);
      if (this.disposed || thread.runtimeId === null) return;
      try {
        await this.sendRequest(thread, { type: "get_session_stats" });
      } catch {
        return;
      }
      if (thread.runtimeId !== null && thread.view.status === "running") {
        const timer = setTimeout(() => void tick(), 1000);
        this.statsTimers.set(thread.key, timer);
      }
    };
    const timer = setTimeout(() => void tick(), 1000);
    this.statsTimers.set(thread.key, timer);
  }

  /** 压缩期间输入只缓存于所属线程，包含图片和发送方式。 */
  enqueue(
    thread: PiThread,
    text: string,
    images: PiImage[],
    behavior: "steer" | "followUp",
  ) {
    thread.view = {
      ...thread.view,
      localQueue: [
        ...(thread.view.localQueue ?? []),
        { id: crypto.randomUUID(), text, images, behavior },
      ],
    };
    this.publish();
  }

  /** 删除或取回尚未投递的本地消息。 */
  removeQueued(thread: PiThread, id: string) {
    if (thread.view.queueSendingId === id) return;
    const item = thread.view.localQueue?.find((entry) => entry.id === id);
    thread.view = {
      ...thread.view,
      localQueue: thread.view.localQueue?.filter((entry) => entry.id !== id),
    };
    this.publish();
    return item;
  }

  /** 原生明确接受后移除缓存；失败保留当前及后续消息，允许用户重试。 */
  async drainQueue(thread: PiThread) {
    if (
      this.draining.has(thread.key) ||
      thread.view.compaction?.status === "running" ||
      !thread.view.localQueue?.length
    )
      return;
    this.draining.add(thread.key);
    try {
      while (
        thread.view.localQueue?.length &&
        thread.view.compaction?.status !== "running"
      ) {
        const item = thread.view.localQueue[0];
        thread.view = { ...thread.view, queueSendingId: item.id };
        this.publish();
        await this.request(thread, {
          type: "prompt",
          message: item.text,
          images: item.images,
          streamingBehavior: item.behavior,
        });
        thread.view = {
          ...thread.view,
          localQueue: thread.view.localQueue?.filter(
            (entry) => entry.id !== item.id,
          ),
        };
        this.publish();
      }
    } finally {
      this.draining.delete(thread.key);
      thread.view = { ...thread.view, queueSendingId: undefined };
      this.publish();
    }
  }

  /** 用户打开命令菜单时按需连接 Pi，复用启动阶段获取的原生命令。 */
  async loadCommands(thread: PiThread) {
    if (thread.view.commands.length) return;
    const alreadyRunning = thread.runtimeId !== null;
    await this.ensureRuntime(thread);
    if (alreadyRunning)
      await this.sendRequest(thread, { type: "get_commands" });
  }

  /** 读取会话名称、模型、实际上下文用量。 */
  async refreshState(thread: PiThread) {
    await this.ensureRuntime(thread);
    await Promise.all([
      this.sendRequest(thread, { type: "get_state" }),
      this.sendRequest(thread, { type: "get_session_stats" }),
    ]);
  }

  /** 浏览历史只读 JSONL，必须有发送等交互后才启动 runtime。 */
  async hydrateFromDisk(thread: PiThread, fallback?: PiModel | null) {
    const path = thread.view.sessionFile;
    if (!path) {
      this.applyCatalogModel(thread, fallback ?? null);
      this.publish();
      return thread;
    }
    thread.loadingHistory = true;
    this.publish();
    try {
      await this.applyHistoryPage(thread, await readPiSession(path), false);
      await this.loadCatalog();
      this.applyCatalogModel(thread, fallback ?? thread.view.model);
    } finally {
      thread.loadingHistory = false;
      this.syncStats(thread);
      this.publish();
    }
    return thread;
  }

  /** 上翻时再读更早的 150 条，不启动 runtime。 */
  async loadOlderHistory(thread: PiThread) {
    const path = thread.view.sessionFile;
    if (
      !path ||
      !thread.view.historyHasMore ||
      thread.view.historyLoadingMore ||
      thread.view.historyOffset == null
    )
      return thread;
    thread.view = { ...thread.view, historyLoadingMore: true };
    this.publish();
    try {
      await this.applyHistoryPage(
        thread,
        await readPiSession(path, thread.view.historyOffset),
        true,
      );
    } catch (error) {
      thread.view = {
        ...thread.view,
        historyLoadingMore: false,
        error: String(error),
      };
      this.publish();
      throw error;
    }
    this.publish();
    return thread;
  }

  /** 把一页磁盘历史写入线程，prepend 表示插到已有消息前面。 */
  private applyHistoryPage(
    thread: PiThread,
    history: Awaited<ReturnType<typeof readPiSession>>,
    prepend: boolean,
  ) {
    const path = thread.view.sessionFile ?? history.sessionFile;
    thread.view = piViewReducer(thread.view, {
      type: "history",
      messages: history.messages,
      prepend,
      offset: history.oldestOffset,
      hasMore: history.hasMore,
    });
    thread.view = {
      ...thread.view,
      sessionFile: history.sessionFile || path,
      sessionName: history.sessionName ?? thread.view.sessionName,
      model: history.model ?? thread.view.model,
      thinkingLevel: history.thinkingLevel ?? thread.view.thinkingLevel,
      contextTokens: history.contextTokens ?? thread.view.contextTokens,
      contextPercent: history.contextPercent ?? thread.view.contextPercent,
      status: thread.runtimeId === null ? "idle" : thread.view.status,
    };
    return thread;
  }

  /** 预读 models.json，供新线程和选择器复用，不启动 runtime。 */
  async loadCatalog(force = false) {
    if (force || !this.catalogModels.length)
      this.catalogModels = await listPiModels();
    return this.catalogModels;
  }

  /** 模型列表从 models.json 读取，不为此启动会话。 */
  async loadModels(thread: PiThread, force = false) {
    if (!force && thread.view.models.length) return thread.view.models;
    thread.view = { ...thread.view, modelsLoading: true, error: null };
    this.publish();
    try {
      await this.loadCatalog(force);
      thread.view = {
        ...thread.view,
        models: this.catalogModels,
        modelsLoading: false,
        model: this.withCatalogWindow(
          thread.view.model ?? this.catalogModels[0] ?? null,
        ),
      };
      this.fillContextPercent(thread);
    } catch (error) {
      thread.view = {
        ...thread.view,
        modelsLoading: false,
        error: String(error),
      };
      throw error;
    } finally {
      this.publish();
    }
    return thread.view.models;
  }

  /** 设置页改完 models.json 后，刷新所有线程的模型和显示名。 */
  async reloadCatalog() {
    await this.loadCatalog(true);
    for (const thread of this.threads.values()) {
      thread.view = {
        ...thread.view,
        models: this.catalogModels,
        model: this.withCatalogWindow(
          thread.view.model ?? this.catalogModels[0] ?? null,
        ),
      };
      this.fillContextPercent(thread);
    }
    this.publish();
    return this.catalogModels;
  }

  /** 新线程使用最近模型；历史线程保留自身模型，并补上 catalog 窗口。 */
  applyCatalogModel(thread: PiThread, fallback: PiModel | null) {
    thread.view = {
      ...thread.view,
      models: thread.view.models.length
        ? thread.view.models
        : this.catalogModels,
      model: this.withCatalogWindow(
        thread.view.model ?? fallback ?? this.catalogModels[0] ?? null,
      ),
      thinkingLevels:
        thread.view.thinkingLevels.length > 1
          ? thread.view.thinkingLevels
          : ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    };
    this.fillContextPercent(thread);
    this.publish();
  }

  /** 历史 model_change 没有 contextWindow，用 models.json 同名模型补上。 */
  private withCatalogWindow(model: PiModel | null): PiModel | null {
    if (!model) return null;
    const listed = catalogModelFor(this.catalogModels, model);
    if (!listed) return model;
    return {
      ...model,
      name: listed.name ?? model.name,
      contextWindow: listed.contextWindow ?? model.contextWindow,
    };
  }

  /** 离线历史没有 percent 时，用 token / contextWindow 本地算占比。 */
  private fillContextPercent(thread: PiThread) {
    if (thread.view.contextPercent != null || thread.view.contextTokens == null)
      return;
    const window = thread.view.model?.contextWindow;
    if (!window) return;
    thread.view = {
      ...thread.view,
      contextPercent: Math.min(100, (thread.view.contextTokens / window) * 100),
    };
  }

  /** 按原生队列快照修改单条消息，重建失败时将未发送文本退回草稿。 */
  async updateQueuedMessage(
    thread: PiThread,
    kind: "steering" | "followUp",
    index: number,
    text: string,
    action: "edit" | "delete" | "steer",
    restore: (texts: string[]) => void,
  ) {
    const snapshot = objectValue(
      await this.request(thread, { type: "clear_queue" }),
    );
    const entries = (["steering", "followUp"] as const).flatMap((mode) =>
      (Array.isArray(snapshot?.[mode]) ? (snapshot[mode] as string[]) : []).map(
        (message, position) => ({ mode, position, message }),
      ),
    );
    const target = entries.find(
      (entry) =>
        entry.mode === kind &&
        entry.position === index &&
        entry.message === text,
    );
    const remaining = entries.filter((entry) => entry !== target);
    if (target && action === "edit") restore([target.message]);
    if (target && action === "steer")
      remaining.unshift({ ...target, mode: "steering" });
    for (let position = 0; position < remaining.length; position++) {
      const entry = remaining[position];
      try {
        await this.request(thread, {
          type: entry.mode === "steering" ? "steer" : "follow_up",
          message: entry.message,
        });
      } catch (error) {
        restore(remaining.slice(position).map((item) => item.message));
        throw error;
      }
    }
    if (!target)
      throw new Error("这条消息已开始处理或队列已变化，请查看最新队列");
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

  /** 复制会话文件为新线程，不启动 runtime。 */
  async branch(thread: PiThread, name?: string) {
    if (thread.view.status !== "idle")
      throw new Error("请先停止当前任务再分叉");
    const source = thread.view.sessionFile;
    if (!source) throw new Error("当前线程尚未写入会话文件");
    const cloned = await clonePiSession(source);
    if (name) {
      await appendPiSession({
        path: cloned.path,
        kind: "session_info",
        name,
      });
    }
    const key = cloned.path;
    const next = await this.open(key, thread.cwd, cloned.path);
    next.view = {
      ...next.view,
      models: thread.view.models,
      thinkingLevels: thread.view.thinkingLevels,
      thinkingLevel: thread.view.thinkingLevel,
      model: thread.view.model,
      sessionName: name ?? cloned.name ?? thread.view.sessionName,
    };
    await this.hydrateFromDisk(next, thread.view.model);
    this.publish();
    return { thread: next, text: "" };
  }

  /** 改模型只写会话文件或前端草稿，发送时才交给 runtime。 */
  async setModel(
    thread: PiThread,
    provider: string,
    modelId: string,
    name?: string,
  ) {
    const model = this.withCatalogWindow({ provider, id: modelId, name });
    thread.view = { ...thread.view, model };
    this.fillContextPercent(thread);
    this.publish();
    if (thread.runtimeId !== null) {
      await this.sendRequest(thread, { type: "set_model", provider, modelId });
      return;
    }
    if (thread.view.sessionFile)
      await appendPiSession({
        path: thread.view.sessionFile,
        kind: "model_change",
        provider,
        modelId,
      });
  }

  /** 改思考等级只写会话文件或前端草稿，发送时才交给 runtime。 */
  async setThinkingLevel(thread: PiThread, level: string) {
    thread.view = { ...thread.view, thinkingLevel: level };
    this.publish();
    if (thread.runtimeId !== null) {
      await this.sendRequest(thread, { type: "set_thinking_level", level });
      return;
    }
    if (thread.view.sessionFile)
      await appendPiSession({
        path: thread.view.sessionFile,
        kind: "thinking_level_change",
        thinkingLevel: level,
      });
  }

  /** 重命名只追加 session_info，不启动 runtime。 */
  async rename(thread: PiThread, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("线程名称不能为空");
    thread.view = { ...thread.view, sessionName: trimmed };
    this.publish();
    if (thread.runtimeId !== null) {
      await this.sendRequest(thread, {
        type: "set_session_name",
        name: trimmed,
      });
      return;
    }
    if (!thread.view.sessionFile) return;
    await appendPiSession({
      path: thread.view.sessionFile,
      kind: "session_info",
      name: trimmed,
    });
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
    if (
      thread.runtimeId === null ||
      thread.view.status !== "idle" ||
      thread.view.compaction?.status === "running" ||
      thread.view.localQueue?.length
    )
      return;
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
    const statsTimer = this.statsTimers.get(key);
    if (statsTimer) clearTimeout(statsTimer);
    this.statsTimers.delete(key);
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
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.toolUpdates.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const timer of this.statsTimers.values()) clearTimeout(timer);
    this.statsTimers.clear();
    void this.stop.then((stop) => stop());
    for (const thread of this.threads.values())
      if (thread.runtimeId !== null)
        this.rejectRequests(thread.runtimeId, "Pi 插件已关闭");
    void closeAllPiAgents();
  }
}

/** 历史 JSONL 的 provider 可能过期或写成字面量，先精确匹配再按模型 id 回退。 */
function catalogModelFor(
  catalog: PiModel[],
  model: PiModel,
): PiModel | undefined {
  const exact = catalog.find(
    (item) => item.provider === model.provider && item.id === model.id,
  );
  if (exact) return exact;
  const matches = catalog.filter((item) => item.id === model.id);
  if (matches.length === 1) return matches[0];
  if (!matches.length) return undefined;
  return matches.reduce((best, item) =>
    (item.contextWindow ?? 0) > (best.contextWindow ?? 0) ? item : best,
  );
}
