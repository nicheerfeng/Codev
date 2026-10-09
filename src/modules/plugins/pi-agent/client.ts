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
  truncatePiSession,
} from "./native";
import {
  DEFAULT_PI_THINKING_LEVELS,
  INITIAL_PI_VIEW_STATE,
  lastPiTurnAssistant,
  comparableUserText,
  objectValue,
  piViewReducer,
} from "./reducer";
import type {
  PiEventEnvelope,
  PiImage,
  PiMessageItem,
  PiModel,
  PiTurnOutcome,
  PiViewState,
} from "./types";
import {
  capturePiRuntimeConfig,
  planPiRuntimeConfig,
  samePiModel,
  type PiRuntimeAdaptation,
  type PiRuntimeConfig,
} from "./runtimeConfig";
import {
  anchorPiTurn,
  beginPiTurn,
  freezePiTurn,
  recordPiToolPre,
  refreshPiTurn,
} from "./turnDiff";

export type PiSettledListener = (
  thread: PiThread,
  text: string,
  outcome: PiTurnOutcome,
) => void;
const piSettledListeners = new Set<PiSettledListener>();

export function onPiAgentSettled(listener: PiSettledListener): () => void {
  piSettledListeners.add(listener);
  return () => piSettledListeners.delete(listener);
}

export type PiThread = {
  loadingHistory: boolean;
  key: string;
  cwd: string;
  runtimeId: number | null;
  /** 当前进程已加载的资源快照与已确认的选择，独立于界面模型。 */
  runtimeConfig: PiRuntimeConfig | null;
  view: PiViewState;
};
type Pending = {
  runtimeId: number;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  command: unknown;
  timer: ReturnType<typeof setTimeout> | undefined;
  observedModel: PiRuntimeConfig["model"] | undefined;
};

/** 统一 Pi 会话路径，避免 Windows 长路径与普通路径创建两个 runtime。 */
function runtimeThreadKey(key: string, path?: string | null): string {
  const value = path || key;
  if (!value || value.startsWith("draft:")) return key;
  return value
    .replace(/\\/g, "/")
    .replace(/^\/\/?\?\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function forkEntryId(id: string): string {
  const entryId = id.split(":")[0];
  if (
    !entryId ||
    entryId.startsWith("local-user-") ||
    entryId.startsWith("history-") ||
    entryId.startsWith("message-")
  )
    throw new Error("找不到分叉位置，请等本轮写入后再试");
  return entryId;
}

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
  private adapting = new Map<string, Promise<PiRuntimeAdaptation>>();
  private draining = new Set<string>();
  private editing = new Set<string>();
  private inserting = new Map<
    string,
    { id: string; text: string; seenNative: boolean; userCount: number }
  >();
  private manualCompactions = new Set<string>();
  private compactionResume = new Set<string>();
  private statsTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotWaiters = new Map<string, Promise<void>>();
  private stop: Promise<() => void>;

  /** 模型 RPC 只更新已应用选择，不改写进程启动时的资源快照。 */
  private async applyRuntimeModel(thread: PiThread, model: PiModel) {
    const binding = thread.runtimeConfig;
    const response = objectValue(
      await this.sendRequest(thread, {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      }),
    );
    if (!binding || thread.runtimeConfig !== binding)
      throw new Error("Pi 会话已变化，请重新发送");
    if (
      response?.provider &&
      response.id &&
      !samePiModel(model, {
        provider: String(response.provider),
        id: String(response.id),
      })
    )
      throw new Error("Pi 返回的模型与当前选择不一致，请重新选择模型");
    binding.model = { provider: model.provider, id: model.id };
    binding.thinkingLevel = null;
  }

  /** 等级失败保留健康进程，下次显式适配可重试。 */
  private async applyRuntimeThinking(thread: PiThread, level: string) {
    const binding = thread.runtimeConfig;
    await this.sendRequest(thread, { type: "set_thinking_level", level });
    if (!binding || thread.runtimeConfig !== binding)
      throw new Error("Pi 会话已变化，请重新发送");
    binding.thinkingLevel = level;
  }

  /** 注册一次事件监听，以 runtimeId 分发并合并流式渲染刷新。 */
  constructor(
    private changed: () => void,
    private extension: (key: string, event: Record<string, unknown>) => void,
    private modelTest = false,
  ) {
    this.stop = listenPiEvents((payload) => this.receive(payload));
    void this.stop.catch((error) => {
      if (!this.disposed)
        this.extension("", { method: "error", message: String(error) });
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
    const event = payload.event;
    // 原生结束事件可能先于 RPC 回复到达，已收尾的压缩回复不再覆盖界面。
    if (
      event.type === "response" &&
      event.command === "compact" &&
      !this.pending.has(String(event.id))
    )
      return;
    thread.view = piViewReducer(thread.view, { type: "event", payload });
    this.touchRuntime(thread);
    if (event.type === "agent_start") beginPiTurn(thread.key);
    if (event.type === "queue_update" || event.type === "message_end")
      this.finishInserted(thread, false);
    if (event.type === "agent_end") this.finishInserted(thread, true);
    if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId ?? "");
      if (id) anchorPiTurn(thread.key, id);
      const recorded = recordPiToolPre(
        thread.key,
        thread.cwd,
        String(event.toolName ?? ""),
        event.args,
        objectValue(event.snapshotBefore),
      );
      const turn = this.snapshotWaiters.get(thread.key) ?? Promise.resolve();
      this.snapshotWaiters.set(
        thread.key,
        turn.then(() => recorded),
      );
    }
    if (
      event.type === "auto_compaction_start" ||
      event.type === "compaction_start"
    )
      this.startCompaction(thread);
    if (
      (event.type === "auto_compaction_end" ||
        event.type === "compaction_end") &&
      this.manualCompactions.has(thread.key)
    ) {
      for (const [id, request] of this.pending) {
        if (
          request.runtimeId !== payload.sessionId ||
          request.command !== "compact"
        )
          continue;
        clearTimeout(request.timer);
        this.pending.delete(id);
        if (event.aborted || event.errorMessage || !event.result)
          request.reject(
            new Error(
              String(
                event.errorMessage ||
                  (event.aborted ? "压缩已停止" : "压缩未完成"),
              ),
            ),
          );
        else request.resolve(event.result);
      }
    }
    if (
      (event.type === "auto_compaction_end" ||
        event.type === "compaction_end") &&
      !this.manualCompactions.has(thread.key)
    ) {
      const success = !event.aborted && !event.errorMessage && !!event.result;
      const running =
        thread.view.status === "running" || thread.view.status === "stopping";
      this.finishCompaction(thread, success);
      if (!success)
        thread.view = {
          ...thread.view,
          error: String(
            event.errorMessage || (event.aborted ? "压缩已停止" : "压缩未完成"),
          ),
        };
      if (success && event.willRetry) this.compactionResume.add(thread.key);
      else this.compactionResume.delete(thread.key);
      void this.refreshState(thread)
        .then(() => {
          if (success && !event.willRetry && !running)
            return this.drainQueue(thread);
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
        else {
          if (
            event.command === "get_state" &&
            thread.runtimeConfig &&
            request.observedModel === thread.runtimeConfig.model
          ) {
            const actual = objectValue(objectValue(event.data)?.model);
            if (
              typeof actual?.provider === "string" &&
              typeof actual.id === "string"
            ) {
              const model = { provider: actual.provider, id: actual.id };
              if (!samePiModel(thread.runtimeConfig.model, model))
                thread.runtimeConfig.thinkingLevel = null;
              thread.runtimeConfig.model = model;
            }
          }
          request.resolve(event.data);
        }
      }
    }
    if (event.type === "extension_ui_request")
      this.extension(thread.key, event);
    if (event.type === "process_exit") {
      this.rejectRequests(payload.sessionId, "Pi 会话已结束");
      thread.runtimeId = null;
      thread.runtimeConfig = null;
    }
    if (
      event.type === "agent_settled" &&
      thread.runtimeId !== null &&
      thread.view.turnOutcome === "completed"
    ) {
      const resumeQueue = this.compactionResume.delete(thread.key);
      void this.refreshState(thread)
        .then(async () => {
          if (
            thread.view.compaction?.status !== "failed" &&
            (resumeQueue || thread.view.localQueue?.length)
          )
            await this.drainQueue(thread);
        })
        .catch((error) => this.error(thread.key, error));
    }
    this.publish(streaming || event.type === "message_update");
    if (event.type === "tool_execution_end" && !event.isError) {
      const wait = this.snapshotWaiters.get(thread.key) ?? Promise.resolve();
      this.snapshotWaiters.set(
        thread.key,
        wait.then(async () => {
          const snapshot = await refreshPiTurn(thread.key);
          if (!snapshot) return;
          thread.view = {
            ...thread.view,
            snapshotRevision: (thread.view.snapshotRevision ?? 0) + 1,
          };
          this.publish();
        }),
      );
    }
    if (event.type === "agent_settled") {
      const last = lastPiTurnAssistant(thread.view.items);
      const outcome = thread.view.turnOutcome!;
      piSettledListeners.forEach((listener) =>
        listener(thread, last?.text ?? "", outcome),
      );
      const wait = this.snapshotWaiters.get(thread.key) ?? Promise.resolve();
      this.snapshotWaiters.delete(thread.key);
      void wait
        .then(() => freezePiTurn(thread.key))
        .then((snapshot) => {
          if (!snapshot) return;
          thread.view = {
            ...thread.view,
            snapshotRevision: (thread.view.snapshotRevision ?? 0) + 1,
          };
          this.publish();
        });
    }
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
    if (this.editing.has(thread.key))
      return Promise.reject(new Error("正在重新编辑当前轮，请稍候"));
    const adapt =
      command.type === "prompt"
        ? this.adaptCatalogRuntime(thread)
        : Promise.resolve<PiRuntimeAdaptation>({ kind: "unchanged" });
    return adapt.then(() =>
      this.ensureRuntime(thread).then(() => {
        if (command.type === "prompt") this.syncStats(thread);
        return this.sendRequest(thread, command);
      }),
    );
  }

  /** 点击发送后立刻进入运行态，不必等待 Pi runtime 或 agent_start。 */
  beginPrompt(
    thread: PiThread,
    text: string,
    images?: PiImage[],
    queued = false,
    keepCompaction = false,
  ) {
    thread.view = piViewReducer(thread.view, {
      type: "prompt",
      text,
      images,
      queued,
      keepCompaction,
    });
    if (!queued) beginPiTurn(thread.key);
    this.publish();
  }

  /** 同一线程只允许一次配置适配，运行期间不改变请求资源。 */
  private adaptCatalogRuntime(thread: PiThread): Promise<PiRuntimeAdaptation> {
    const pending = this.adapting.get(thread.key);
    if (pending) return pending;
    const operation = this.adaptRuntimeConfig(thread).finally(() => {
      if (this.adapting.get(thread.key) === operation)
        this.adapting.delete(thread.key);
    });
    this.adapting.set(thread.key, operation);
    return operation;
  }

  private async adaptRuntimeConfig(
    thread: PiThread,
  ): Promise<PiRuntimeAdaptation> {
    const opening = this.opening.get(thread.key);
    if (opening) await opening;
    if (
      thread.runtimeId === null ||
      thread.view.status === "running" ||
      thread.view.status === "stopping" ||
      thread.view.status === "starting" ||
      thread.view.compaction?.status === "running"
    )
      return { kind: "deferred" };
    return this.synchronizeRuntimeConfig(thread);
  }

  /** 唯一配置应用路径；初始化时不自动递归重启。 */
  private async synchronizeRuntimeConfig(
    thread: PiThread,
    allowRestart = true,
  ): Promise<PiRuntimeAdaptation> {
    const binding = thread.runtimeConfig;
    if (!binding || binding.runtimeId !== thread.runtimeId)
      throw new Error("Pi 运行配置未知，请关闭当前连接后重试");
    let result: PiRuntimeAdaptation = { kind: "unchanged" };
    // Re-evaluate after awaited RPCs so a newer selection is never marked applied.
    while (true) {
      if (thread.runtimeConfig !== binding)
        throw new Error("Pi 会话已变化，请重新发送");
      const model = thread.view.model;
      const plan = planPiRuntimeConfig(binding, this.catalogModels, model);
      if (plan.kind === "restart") {
        if (!allowRestart)
          throw new Error(
            "模型配置在连接期间发生变化，请重新发送以加载最新配置",
          );
        await this.close(thread.key);
        await this.ensureRuntime(thread);
        return { kind: "runtime-restarted", reason: plan.reason };
      }
      if (plan.kind === "switch-model" && model) {
        await this.applyRuntimeModel(thread, model);
        result = { kind: "model-switched" };
        continue;
      }
      const thinking = thread.view.thinkingLevel;
      if (thinking && binding.thinkingLevel !== thinking) {
        await this.applyRuntimeThinking(thread, thinking);
        continue;
      }
      return result;
    }
  }

  /** 首次真实 RPC 操作时才为线程启动 Pi runtime。 */
  private async ensureRuntime(thread: PiThread): Promise<void> {
    const pending = this.opening.get(thread.key);
    if (pending) {
      await pending;
      return;
    }
    if (thread.runtimeId !== null) {
      this.touchRuntime(thread);
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
      // 压缩由 Pi 原生结束事件或 RPC 回复收尾，不设前端执行期限。
      const timer =
        command.type === "compact"
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Pi ${command.type} 响应超时`));
            }, 120_000);
      this.pending.set(id, {
        runtimeId,
        command: command.type,
        resolve,
        reject,
        timer,
        observedModel:
          command.type === "get_state"
            ? thread.runtimeConfig?.model
            : undefined,
      });
      void sendPiCommand(runtimeId, { ...command, id }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** 新建或恢复指定线程，多次点击同一线程共用启动任务。 */
  open(key: string, cwd: string, path?: string): Promise<PiThread> {
    if (!key.trim()) return Promise.reject(new Error("Pi 线程 ID 不能为空"));
    const identity = runtimeThreadKey(key, path);
    const existing =
      this.threads.get(key) ??
      [...this.threads.values()].find(
        (thread) =>
          thread.view.sessionFile &&
          runtimeThreadKey(thread.key, thread.view.sessionFile) === identity,
      );
    if (existing) return Promise.resolve(existing);
    const pending = this.opening.get(identity);
    if (pending) return pending;
    const thread: PiThread = {
      loadingHistory: false,
      key,
      cwd,
      runtimeId: null,
      runtimeConfig: null,
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
    let initialized = false;
    try {
      await this.loadCatalog();
      const catalogAtStart = this.catalogModels;
      const runtime = await startPiAgent(cwd, path, this.modelTest);
      if (this.disposed) {
        await closePiAgent(runtime.sessionId);
        throw new Error("Pi 插件已关闭");
      }
      thread.runtimeId = runtime.sessionId;
      this.touchRuntime(thread);
      const stateRequest = this.sendRequest(thread, { type: "get_state" });
      const modelsRequest = this.sendRequest(thread, {
        type: "get_available_models",
      });
      const hydrates: Promise<unknown>[] = [
        stateRequest,
        modelsRequest,
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
          !last.id.startsWith("local-user-") &&
          !last.id.includes(":")
        )
          hydrates.push(
            this.sendRequest(thread, { type: "get_entries", since: last.id }),
          );
      }
      await Promise.all(hydrates);
      const state = objectValue(await stateRequest);
      const actual = objectValue(state?.model);
      const available = objectValue(await modelsRequest);
      const resources = runtime.resourceModels ?? catalogAtStart;
      if (runtime.resourceModels && this.catalogModels === catalogAtStart)
        this.catalogModels = runtime.resourceModels;
      const availableModels: PiModel[] = Array.isArray(available?.models)
        ? available.models.filter(
            (item): item is PiModel =>
              typeof item?.provider === "string" &&
              typeof item?.id === "string",
          )
        : [];
      thread.runtimeConfig = capturePiRuntimeConfig(
        runtime.sessionId,
        resources,
        availableModels,
        typeof actual?.provider === "string" && typeof actual.id === "string"
          ? { provider: actual.provider, id: actual.id }
          : null,
      );
      initialized = true;
      thread.loadingHistory = false;
      thread.view = {
        ...thread.view,
        modelsLoading: false,
        models: this.catalogModels.length
          ? this.catalogModels
          : availableModels,
        model:
          this.withCatalogWindow(thread.view.model, false) ?? thread.view.model,
      };
      await this.synchronizeRuntimeConfig(thread, false);
      this.publish();
      return thread;
    } catch (error) {
      thread.loadingHistory = false;
      // Startup/protocol failure may close a broken process; configuration RPC
      // failure after initialization must keep the healthy process available.
      if (!initialized && thread.runtimeId !== null) await this.close(key);
      thread.view = {
        ...thread.view,
        status: initialized ? "idle" : "failed",
        phase: "",
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
    await this.ensureRuntime(thread);
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
    const id = crypto.randomUUID();
    thread.view = {
      ...thread.view,
      localQueue: [
        ...(thread.view.localQueue ?? []),
        { id, text, images, behavior },
      ],
    };
    this.publish();
    return id;
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

  /** 插队提到队首；其余消息保持相对顺序。 */
  setQueuedBehavior(
    thread: PiThread,
    id: string,
    behavior: "steer" | "followUp",
  ) {
    const queue = thread.view.localQueue ?? [];
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    const rest = queue.filter((entry) => entry.id !== id);
    const next = { ...item, behavior };
    thread.view = {
      ...thread.view,
      localQueue: behavior === "steer" ? [next, ...rest] : [...rest, next],
    };
    this.publish();
  }

  private userMessageCount(thread: PiThread, text: string) {
    const cleaned = text.replace(/\s+$/u, "");
    return thread.view.items.filter(
      (item) =>
        item.kind === "message" &&
        item.role === "user" &&
        item.text === cleaned,
    ).length;
  }

  /** 插入中的条目留在队列里，直到原生真正收下或本轮结束。 */
  private finishInserted(thread: PiThread, force: boolean) {
    const pending = this.inserting.get(thread.key);
    if (!pending) return;
    const cleaned = pending.text.replace(/\s+$/u, "");
    const nativeTexts = [
      ...thread.view.queue.steering.map((item) => item.text),
      ...thread.view.queue.followUp.map((item) => item.text),
    ].map((text) => text.replace(/\s+$/u, ""));
    const stillNative = nativeTexts.includes(cleaned);
    if (stillNative) pending.seenNative = true;
    const appeared =
      this.userMessageCount(thread, pending.text) > pending.userCount;
    if (!force && stillNative) return;
    if (!force && !appeared && !pending.seenNative) return;
    this.inserting.delete(thread.key);
    thread.view = {
      ...thread.view,
      queueSendingId:
        thread.view.queueSendingId === pending.id
          ? undefined
          : thread.view.queueSendingId,
      localQueue: thread.view.localQueue?.filter(
        (entry) => entry.id !== pending.id,
      ),
    };
    this.publish();
  }

  /** 空闲时按队列顺序逐条发送；运行中不投递，让用户能看见待发送队列。 */
  async drainQueue(thread: PiThread) {
    if (this.editing.has(thread.key)) return;
    const insertingId = this.inserting.get(thread.key)?.id;
    const queue = (thread.view.localQueue ?? []).filter(
      (entry) => entry.id !== insertingId,
    );
    if (
      this.draining.has(thread.key) ||
      thread.view.compaction?.status === "running" ||
      thread.view.status === "running" ||
      thread.view.status === "stopping" ||
      thread.view.status === "starting" ||
      !queue.length
    )
      return;
    const item = queue[0];
    this.draining.add(thread.key);
    thread.view = { ...thread.view, queueSendingId: item.id };
    this.publish();
    try {
      await this.prepareCatalogRuntime(thread);
      this.beginPrompt(thread, item.text, item.images, false, true);
      await this.request(thread, {
        type: "prompt",
        message: item.text,
        ...(item.images.length ? { images: item.images } : {}),
        streamingBehavior: item.behavior,
      });
      thread.view = {
        ...thread.view,
        localQueue: thread.view.localQueue?.filter(
          (entry) => entry.id !== item.id,
        ),
      };
      this.publish();
    } catch (error) {
      const cleaned = item.text.replace(/\s+$/u, "");
      const last = thread.view.items[thread.view.items.length - 1];
      const revertOptimistic =
        last?.kind === "message" &&
        last.role === "user" &&
        last.id.startsWith("local-user-") &&
        last.text === cleaned;
      thread.view = {
        ...thread.view,
        ...(revertOptimistic ? { items: thread.view.items.slice(0, -1) } : {}),
        ...(thread.view.phase === "处理中"
          ? { status: "idle" as const, phase: "" }
          : {}),
      };
      this.error(thread.key, error);
    } finally {
      this.draining.delete(thread.key);
      thread.view = { ...thread.view, queueSendingId: undefined };
      this.publish();
    }
  }

  /** 运行中立刻插入当前轮；空闲则提到队首后按普通发送排出。 */
  async sendQueued(thread: PiThread, id: string) {
    if (this.editing.has(thread.key)) return;
    if (thread.view.queueSendingId === id) return;
    const item = thread.view.localQueue?.find((entry) => entry.id === id);
    if (!item) return;
    if (thread.view.compaction?.status === "running") {
      this.setQueuedBehavior(thread, id, "steer");
      return;
    }
    const live =
      thread.view.status === "running" || thread.view.status === "stopping";
    if (!live) {
      this.setQueuedBehavior(thread, id, "steer");
      await this.drainQueue(thread);
      return;
    }
    thread.view = { ...thread.view, queueSendingId: id };
    this.inserting.set(thread.key, {
      id,
      text: item.text,
      seenNative: false,
      userCount: this.userMessageCount(thread, item.text),
    });
    this.publish();
    try {
      this.beginPrompt(thread, item.text, item.images, true);
      await this.request(thread, {
        type: "steer",
        message: item.text,
        ...(item.images.length ? { images: item.images } : {}),
      });
      this.finishInserted(thread, false);
    } catch (error) {
      this.inserting.delete(thread.key);
      thread.view = { ...thread.view, queueSendingId: undefined };
      this.publish();
      this.error(thread.key, error);
    }
  }

  /** 用户打开命令菜单时按需连接 Pi，复用启动阶段获取的原生命令。 */
  async loadCommands(thread: PiThread) {
    if (this.editing.has(thread.key)) return;
    if (thread.view.commands.length) return;
    const alreadyRunning = thread.runtimeId !== null;
    await this.ensureRuntime(thread);
    if (alreadyRunning)
      await this.sendRequest(thread, { type: "get_commands" });
  }

  /** 读取会话名称、模型、实际上下文用量。 */
  async refreshState(thread: PiThread) {
    if (this.editing.has(thread.key)) return;
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

  catalog(): PiModel[] {
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
        model: thread.view.model
          ? (this.withCatalogWindow(thread.view.model, !thread.runtimeConfig) ??
            thread.view.model)
          : (this.catalogModels[0] ?? null),
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

  /** 刷新选择器元数据，保留每个运行进程已加载的资源快照。 */
  async reloadCatalog() {
    await this.loadCatalog(true);
    for (const thread of this.threads.values()) {
      thread.view = {
        ...thread.view,
        models: this.catalogModels,
        model:
          this.withCatalogWindow(thread.view.model, false) ?? thread.view.model,
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
      model:
        (thread.view.model
          ? (this.withCatalogWindow(thread.view.model, !thread.runtimeConfig) ??
            thread.view.model)
          : null) ??
        this.withCatalogWindow(fallback) ??
        this.catalogModels[0] ??
        fallback,
      thinkingLevels:
        thread.view.thinkingLevels.length > 1
          ? thread.view.thinkingLevels
          : DEFAULT_PI_THINKING_LEVELS,
    };
    this.fillContextPercent(thread);
    this.publish();
  }

  /** 用当前 models.json 对齐 provider/窗口；已删除的模型返回 null。 */
  private withCatalogWindow(
    model: PiModel | null,
    allowLegacyProvider = true,
  ): PiModel | null {
    if (!model) return null;
    const listed = allowLegacyProvider
      ? catalogModelFor(this.catalogModels, model)
      : this.catalogModels.find((item) => samePiModel(item, model));
    if (!listed) return null;
    return {
      provider: listed.provider,
      id: listed.id,
      name: listed.name ?? model.name,
      contextWindow: listed.contextWindow ?? model.contextWindow,
      baseUrl: listed.baseUrl,
      keyFingerprint: listed.keyFingerprint,
      resourceFingerprint: listed.resourceFingerprint,
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
  private async clearQueue(
    thread: PiThread,
  ): Promise<Record<string, unknown> | null> {
    try {
      return objectValue(await this.request(thread, { type: "clear_queue" }));
    } catch (error) {
      if (/unknown command\s*:\s*clear_queue/i.test(String(error))) return null;
      throw error;
    }
  }

  /** 归一化 Pi 原生队列快照，统一兼容 follow_up 与图片字段命名。 */
  private normalizeNativeQueue(snapshot: Record<string, unknown> | null) {
    const normalize = (value: unknown) => {
      if (!Array.isArray(value)) return [];
      return value.flatMap((raw) => {
        const item = typeof raw === "string" ? { text: raw } : objectValue(raw);
        const text =
          typeof item?.text === "string"
            ? item.text
            : typeof item?.message === "string"
              ? item.message
              : null;
        if (text === null) return [];
        const images = Array.isArray(item?.images)
          ? item.images.flatMap((image) => {
              const value = objectValue(image);
              if (!value || typeof value.data !== "string") return [];
              const mimeType = value.mimeType ?? value.mime_type ?? "image/png";
              return [
                {
                  type: "image" as const,
                  data: value.data,
                  mimeType:
                    typeof mimeType === "string" ? mimeType : "image/png",
                },
              ];
            })
          : [];
        return [{ text, images }];
      });
    };
    return {
      steering: normalize(snapshot?.steering),
      followUp: normalize(snapshot?.followUp ?? snapshot?.follow_up),
    };
  }

  /** 按原生队列快照修改单条消息，重建失败时将未发送文本和图片退回草稿。 */
  async updateQueuedMessage(
    thread: PiThread,
    kind: "steering" | "followUp",
    index: number,
    text: string,
    action: "edit" | "delete" | "steer",
    restore: (texts: string[], images?: PiImage[]) => void,
  ) {
    const snapshot = await this.clearQueue(thread);
    if (!snapshot) throw new Error("当前 Pi runtime 不支持编辑已排队消息");
    const nativeQueue = this.normalizeNativeQueue(snapshot);
    const entries = (["steering", "followUp"] as const).flatMap((mode) =>
      nativeQueue[mode].map((item, position) => ({
        mode,
        position,
        message: item.text,
        images: item.images,
      })),
    );
    const byIndex = entries.find(
      (entry) => entry.mode === kind && entry.position === index,
    );
    const target =
      byIndex ??
      entries.find((entry) => entry.mode === kind && entry.message === text);
    if (!target)
      throw new Error("这条消息已开始处理或队列已变化，请查看最新队列");
    const remaining = entries.filter((entry) => entry !== target);
    if (action === "edit") {
      if (target.images.length) restore([target.message], target.images);
      else restore([target.message]);
    }
    if (action === "steer") remaining.unshift({ ...target, mode: "steering" });
    for (let position = 0; position < remaining.length; position++) {
      const entry = remaining[position];
      try {
        await this.request(thread, {
          type: entry.mode === "steering" ? "steer" : "follow_up",
          message: entry.message,
          ...(entry.images.length ? { images: entry.images } : {}),
        });
      } catch (error) {
        const unsent = remaining.slice(position);
        restore(
          unsent.map((item) => item.message),
          unsent.flatMap((item) => item.images),
        );
        throw error;
      }
    }
  }

  /** 停止态先阻止续发，再退回队列并中断；不触发模型适配。 */
  async stopAndRestore(
    thread: PiThread,
    restore: (texts: string[], images?: PiImage[]) => void,
  ) {
    if (thread.view.status === "stopping") return;
    const previousStatus = thread.view.status;
    this.compactionResume.delete(thread.key);
    thread.view = piViewReducer(thread.view, { type: "stopping" });
    this.publish();
    try {
      if (thread.view.compaction?.status !== "running") {
        const queued = await this.clearQueue(thread);
        const nativeQueue = this.normalizeNativeQueue(queued);
        const steering = nativeQueue.steering.length
          ? nativeQueue.steering.map((item) => item.text)
          : thread.view.queue.steering.map((item) => item.text);
        const followUp = nativeQueue.followUp.length
          ? nativeQueue.followUp.map((item) => item.text)
          : thread.view.queue.followUp.map((item) => item.text);
        const localQueue = thread.view.localQueue ?? [];
        this.inserting.delete(thread.key);
        thread.view = {
          ...thread.view,
          localQueue: [],
          queue: { steering: [], followUp: [], pendingCount: 0 },
          queueSendingId: undefined,
        };
        const images = [
          ...nativeQueue.steering,
          ...nativeQueue.followUp,
        ].flatMap((item) => item.images);
        const restored = [
          ...steering,
          ...followUp,
          ...localQueue.map((entry) => entry.text),
        ];
        const restoredImages = [
          ...images,
          ...localQueue.flatMap((entry) => entry.images),
        ];
        if (restoredImages.length) restore(restored, restoredImages);
        else restore(restored);
      }
      await this.request(thread, { type: "abort" });
      thread.view = {
        ...thread.view,
        status: "idle",
        phase: "",
        turnOutcome: "interrupted",
      };
    } catch (error) {
      // A failed request must not leave the stop button permanently disabled.
      thread.view = {
        ...thread.view,
        status: thread.view.processFinishedAt == null ? previousStatus : "idle",
      };
      throw error;
    } finally {
      this.publish();
    }
  }

  /** 在原会话中撤回最后一轮，重启同路径 runtime 后发送编辑内容。 */
  async editLastUser(
    thread: PiThread,
    text: string,
    images: PiImage[] = [],
  ): Promise<boolean> {
    if (
      thread.view.status !== "idle" ||
      this.editing.has(thread.key) ||
      thread.view.compaction?.status === "running" ||
      thread.view.historyLoadingMore
    )
      throw new Error("请等待运行结束后再编辑");
    if (!text.trim() && !images.length) throw new Error("编辑内容不能为空");
    const target = [...thread.view.items]
      .reverse()
      .find((item) => item.kind === "message" && item.role === "user");
    if (!target || target.kind !== "message")
      throw new Error("找不到最后一条用户输入");
    this.editing.add(thread.key);
    let truncated = false;
    try {
      // Display IDs are not JSONL cursors; only read Pi's native entry index.
      await this.ensureRuntime(thread);
      const data = objectValue(
        await this.sendRequest(thread, { type: "get_fork_messages" }),
      );
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const last = objectValue(messages[messages.length - 1]);
      const entryId = typeof last?.entryId === "string" ? last.entryId : "";
      const source = thread.view.sessionFile;
      if (
        !source ||
        !entryId ||
        typeof last?.text !== "string" ||
        comparableUserText(last.text) !== comparableUserText(target.text)
      )
        throw new Error("最后一条输入已变化，请刷新后重试");
      await this.close(thread.key);
      await truncatePiSession(source, entryId);
      truncated = true;
      const index = thread.view.items.findIndex(
        (item) => item.id === target.id,
      );
      thread.view = {
        ...thread.view,
        items: index >= 0 ? thread.view.items.slice(0, index) : [],
        status: "idle",
        phase: "",
        error: null,
        compaction: undefined,
        contextTokens: null,
        contextPercent: null,
        processStartedAt: undefined,
        processFinishedAt: undefined,
        queue: { steering: [], followUp: [], pendingCount: 0 },
      };
      this.beginPrompt(thread, text, images);
      await this.ensureRuntime(thread);
      await this.sendRequest(thread, {
        type: "prompt",
        message: text,
        ...(images.length ? { images } : {}),
      });
      this.syncStats(thread);
      return true;
    } catch (error) {
      if (truncated) {
        await this.close(thread.key);
        thread.view = {
          ...thread.view,
          items: thread.view.items.filter(
            (item) => !item.id.startsWith("local-user-"),
          ),
          status: "idle",
          phase: "",
        };
      } else thread.view = { ...thread.view, status: "idle" };
      throw error;
    } finally {
      this.editing.delete(thread.key);
      this.publish();
    }
  }

  /** 复制会话文件为新线程，不启动 runtime。传入助手消息时截到该轮。 */
  async branch(thread: PiThread, name?: string, until?: PiMessageItem) {
    if (
      thread.view.status === "running" ||
      thread.view.status === "stopping" ||
      thread.view.status === "starting" ||
      thread.view.compaction?.status === "running"
    )
      throw new Error(
        thread.view.status === "starting"
          ? "正在连接 Pi，请稍后再分叉"
          : "请先停止当前任务再分叉",
      );
    const source = thread.view.sessionFile;
    if (!source) throw new Error("当前线程尚未写入会话文件");
    const cloned = until
      ? await clonePiSession(source, forkEntryId(until.id))
      : await clonePiSession(source);
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

  /** 在空闲发送前明确决定复用、原地切换或重新加载配置。 */
  async prepareCatalogRuntime(thread: PiThread) {
    return this.adaptCatalogRuntime(thread);
  }

  /** 改模型只写会话文件或前端草稿；运行中的进程不跟随，发送时再适配。 */
  async setModel(
    thread: PiThread,
    provider: string,
    modelId: string,
    name?: string,
  ) {
    const model = this.withCatalogWindow(
      { provider, id: modelId, name },
      false,
    ) ?? {
      provider,
      id: modelId,
      name,
    };
    thread.view = { ...thread.view, model };
    this.fillContextPercent(thread);
    this.publish();
    const busy =
      thread.view.status === "running" ||
      thread.view.status === "stopping" ||
      thread.view.status === "starting" ||
      thread.view.compaction?.status === "running";
    if (!busy && thread.runtimeId !== null) {
      await this.adaptCatalogRuntime(thread);
      return;
    }
    if (thread.view.sessionFile)
      await appendPiSession({
        path: thread.view.sessionFile,
        kind: "model_change",
        provider: model.provider,
        modelId: model.id,
      });
  }

  /** 改思考等级只写会话文件或前端草稿，发送时才交给 runtime。 */
  async setThinkingLevel(thread: PiThread, level: string) {
    thread.view = { ...thread.view, thinkingLevel: level };
    this.publish();
    if (thread.runtimeId !== null) {
      const opening = this.opening.get(thread.key);
      if (opening) await opening;
      const adapting = this.adapting.get(thread.key);
      if (adapting) await adapting;
      const selected = thread.view.thinkingLevel;
      if (thread.runtimeConfig?.thinkingLevel !== selected)
        await this.applyRuntimeThinking(thread, selected);
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
    const binding = thread.runtimeConfig;
    thread.runtimeId = null;
    thread.runtimeConfig = null;
    this.rejectRequests(id, "Pi 会话已关闭");
    try {
      await closePiAgent(id);
    } catch (error) {
      thread.runtimeId = id;
      thread.runtimeConfig = binding;
      throw error;
    }
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
