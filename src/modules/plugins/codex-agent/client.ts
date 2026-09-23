import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sandboxPolicy, type SandboxPolicy } from "./sandbox";
import { resourceSwitchReason } from "./resources";
import { canonicalModel, mergeModels } from "./models";
import { prependPrompt } from "./promptHistory";
import { parentThread, taskFamily } from "./subagents";
import { editableLastUser, originalInputs } from "./editLastUser";
import {
  reduceNotification,
  sessionFromThread,
  type Input,
  type Message,
  type Model,
  type Request,
  type Session,
  type Skill,
  type Thread,
  type Draft,
  type Turn,
} from "./protocol";

export type Snapshot = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  sessions: Record<string, Session>;
  order: string[];
  historyProjects?: string[];
  models: Model[];
  cursor: string | null;
  archivedCursor: string | null;
  resourceId: string;
  provider: string;
  switching: boolean;
  multi: boolean;
  activeThreads: string[];
  stateUnknown: boolean;
  pendingRequests: number;
  lastModel: { model: string; effort: string } | null;
  skillsRevision: number;
  modelCatalogError?: string;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 独立管理 Codex stdio 请求与线程缓存，不依赖 Pi 事件或运行时。 */
export class CodexClient {
  private snapshot: Snapshot = {
    connected: false,
    loading: false,
    error: null,
    sessions: {},
    order: [],
    models: [],
    cursor: null,
    archivedCursor: null,
    resourceId: "native",
    provider: "",
    switching: false,
    multi: false,
    activeThreads: [],
    stateUnknown: false,
    pendingRequests: 0,
    lastModel: null,
    skillsRevision: 0,
  };
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private streaming = false;
  private listeners = new Set<() => void>();
  private pending = new Map<string, Pending>();
  private loads = new Map<string, Promise<void>>();
  private agentReads = new Set<string>();
  /** 按事件读取单个线程的原生标题与归属，不读取对话或扫描目录。 */
  private async readAgentMetadata(id: string) {
    if (this.agentReads.has(id)) return;
    this.agentReads.add(id);
    try {
      const { thread } = await this.request<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: false });
      if (!this.disposed) this.remember(thread);
    } catch (error) {
      console.error("读取子代理元数据失败", error);
    } finally {
      this.agentReads.delete(id);
    }
  }
  private refreshes = new Map<string, Promise<void>>();
  private historyProjects = new Set<string>();
  private connectionId = 0;
  private nextId = 0;
  private unlisten?: UnlistenFn;
  private startup?: Promise<void>;
  private disposed = false;
  private owner = crypto.randomUUID();
  private requestedResource: string | undefined;
  private draining = new Set<string>();
  /** 将内存草稿键映射到物化后的原生线程 ID。 */
  private threadId(id: string): string {
    return this.snapshot.sessions[id]?.thread.id ?? id;
  }
  /** 原生线程编号始终映射到唯一的界面会话，保留草稿视口标识。 */
  sessionKey(id: string): string {
    return Object.keys(this.snapshot.sessions).find(key => this.snapshot.sessions[key].thread.id === id) ?? id;
  }
  /** 丢弃尚未发送且仍停留在内存中的草稿线程。 */
  discardDraft(id: string) {
    const session = this.snapshot.sessions[id];
    if (!session?.draftThread || session.draft.trim() || session.attachments.length || session.images.length || session.skills.length) return;
    const sessions = { ...this.snapshot.sessions };
    delete sessions[id];
    this.update({ sessions, order: this.snapshot.order.filter((key) => key !== id) });
  }
  scrollPositions = new Map<string, { top: number; follow: boolean }>();

  /** 提供 React 稳定的外部状态订阅。 */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** 返回当前不可变快照。 */
  getSnapshot = () => this.snapshot;
  /** 视口模式由工作区同步，切换逻辑与界面使用同一禁用条件。 */
  setMulti(multi: boolean) {
    if (this.snapshot.multi !== multi) this.update({ multi });
  }
  /** 当前线程选择立即生效，最近模型按资源记忆供新线程复用。 */
  async selectModel(id: string, model: string, effort: string) {
    effort = effort || "medium";
    this.patch(id, { model, effort });
    const choice = { model, effort };
    this.update({ lastModel: choice });
    await invoke("codex_resources_model", {
      id: this.snapshot.resourceId,
      provider: this.snapshot.provider,
      choice,
    });
  }
  /** 汇总隐藏会话和原生事件，始终显示明确的切换阻塞原因。 */
  switchReason(): string {
    const active = new Set(this.snapshot.activeThreads);
    for (const session of Object.values(this.snapshot.sessions))
      if (
        session.busy ||
        session.sending ||
        session.requests.length ||
        session.queue.length
      )
        active.add(session.thread.id);
    return resourceSwitchReason(
      this.snapshot.multi,
      this.snapshot.connected,
      this.snapshot.switching || this.snapshot.loading,
      active.size,
      this.pending.size,
      this.snapshot.stateUnknown,
    );
  }
  /** 冻结发送后由 Rust 检查全部后台活动，再释放旧连接并初始化新资源。 */
  async switchResource(id: string) {
    const reason = this.switchReason();
    if (reason) throw new Error(reason);
    this.update({ switching: true, error: null });
    const previousResource = this.snapshot.resourceId;
    try {
      await invoke("codex_agent_prepare_switch", {
        connectionId: this.connectionId,
        resourceId: id,
      });
      this.connectionId = 0;
      this.requestedResource = id;
      this.update({
        connected: false,
        models: [],
        activeThreads: [],
        sessions: Object.fromEntries(
          Object.entries(this.snapshot.sessions).map(([key, session]) => [
            key,
            { ...session, resumed: false, effectiveSandbox: null },
          ]),
        ),
      });
      await this.connect();
      if (!this.snapshot.connected)
        throw new Error(this.snapshot.error ?? "资源连接失败");
      const choice = this.snapshot.lastModel;
      if (choice) this.update({ sessions: Object.fromEntries(Object.entries(this.snapshot.sessions).map(([key, session]) => [key, { ...session, model: choice.model, effort: choice.effort, error: null }])) });
    } catch (error) {
      await invoke("codex_resources_rollback");
      if (!this.snapshot.connected || !this.connectionId) {
        this.requestedResource = previousResource;
        await this.connect();
      }
      throw error;
    } finally {
      this.update({ switching: false });
    }
  }
  /** 发布界面状态变化。 */
  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.streaming) {
      if (!this.streamTimer) this.streamTimer = setTimeout(() => {
        this.streamTimer = undefined;
        this.listeners.forEach(listener => listener());
      }, 16);
    } else {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
      this.listeners.forEach(listener => listener());
    }
  }

  /** 修改一个线程而不影响其他视口。 */
  patch(id: string, patch: Partial<Session>) {
    const current = this.snapshot.sessions[id];
    if (current)
      this.update({
        sessions: { ...this.snapshot.sessions, [id]: { ...current, ...patch } },
      });
  }
  /** 汇总当前线程及子代理活动，供停止入口使用。 */
  taskBusy(id: string): boolean {
    return taskFamily(this.snapshot.sessions, id).some(key =>
      this.snapshot.sessions[key]?.busy || this.snapshot.activeThreads.includes(key));
  }
  /** 将原生线程纳入列表并保留已加载的对话和草稿。 */
  private remember(thread: Thread) {
    const key = Object.keys(this.snapshot.sessions).find(key => this.snapshot.sessions[key].thread.id === thread.id) ?? thread.id;
    const current = this.snapshot.sessions[key];
    const session = current
      ? { ...current, thread: { ...current.thread, ...thread, turns: current.thread.turns } }
      : sessionFromThread(thread);
    this.update({
      sessions: { ...this.snapshot.sessions, [key]: session },
      order: this.snapshot.order.includes(key)
        ? this.snapshot.order
        : [...this.snapshot.order, key],
    });
  }
  /** 断开时立即释放等待中的请求，避免界面永远处于运行态。 */
  private disconnected(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.connectionId = 0;
    this.update({
      connected: false,
      error: message,
      sessions: Object.fromEntries(
        Object.entries(this.snapshot.sessions).map(([id, session]) => [
          id,
          {
            ...session,
            resumed: false,
            busy: false,
            sending: false,
            turnId: null,
            requests: [],
          },
        ]),
      ),
    });
  }
  /** 分发响应、审批和流式通知，未知服务端请求明确返回不支持。 */
  private receive = (message: Message) => {
    if (!message.method && message.id !== undefined) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      this.update({ pendingRequests: this.pending.size });
      if (message.error)
        pending.reject(
          new Error(
            message.error.message.includes("already has an active writer")
              ? "此线程仍被另一个 Codex runtime 占用（可能来自 Desktop 或 CLI）。请在原客户端释放线程后重试；关闭视口不一定释放写锁。"
              : message.error.message,
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    const method = message.method ?? "";
    const params = message.params ?? {};
    if (method === "bridge/closed") {
      this.disconnected("Codex 连接已结束，请重新连接");
      void invoke("codex_agent_close", { connectionId: null }).catch(() => undefined);
      return;
    }
    if (method === "bridge/error") {
      this.update({ error: String(params.message), stateUnknown: true });
      return;
    }
    if (method === "skills/changed")
      this.update({ skillsRevision: this.snapshot.skillsRevision + 1 });
    if (method === "thread/started") this.remember(params.thread as Thread);
    const protocolId = (params.threadId ?? params.thread_id) as string | undefined;
    const id = protocolId
      ? Object.keys(this.snapshot.sessions).find((key) => this.snapshot.sessions[key].thread.id === protocolId) ?? protocolId
      : undefined;
    if (id && method === "thread/deleted") {
      this.removeSessions([id]);
      return;
    }
    if (id && ["thread/archived", "thread/unarchived"].includes(method)) {
      this.patch(id, { archived: method === "thread/archived", resumed: false });
      return;
    }
    if (
      id &&
      [
        "thread/status/changed",
        "turn/started",
        "turn/completed",
        "thread/closed",
      ].includes(method)
    ) {
      const active = new Set(this.snapshot.activeThreads);
      const status = (params.status as { type?: string } | undefined)?.type;
      if (method === "turn/started" || status === "active") active.add(id);
      if (
        ["turn/completed", "thread/closed"].includes(method) ||
        status === "idle" ||
        status === "notLoaded"
      )
        active.delete(id);
      this.update({
        activeThreads: [...active],
        ...(status === "systemError" ? { stateUnknown: true } : {}),
      });
    }
    if (message.id !== undefined) {
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
      ];
      if (id && this.snapshot.sessions[id] && supported.includes(method)) {
        this.patch(id, {
          requests: [
            ...this.snapshot.sessions[id].requests,
            message as Request,
          ],
        });
      } else {
        void this.write({
          id: message.id,
          error: { code: -32601, message: `Codev 尚不支持 ${method}` },
        }).catch((error) => this.update({ error: String(error) }));
      }
      return;
    }
    if (id && this.snapshot.sessions[id]) {
      const item = params.item as import("./protocol").Item | undefined;
      if (item?.type === "subAgentActivity" && typeof item.agentThreadId === "string" && item.agentThreadId !== protocolId) {
        const childKey = this.sessionKey(item.agentThreadId);
        if (!this.snapshot.sessions[childKey]) {
          void this.readAgentMetadata(item.agentThreadId);
        }

      }
      const delta = method.endsWith("/delta") || method.endsWith("Delta");
      if (delta && parentThread(this.snapshot.sessions[id].thread) && !this.snapshot.sessions[id].loaded) return;
      this.streaming = delta || !!parentThread(this.snapshot.sessions[id].thread);
      const session = this.snapshot.sessions[id];
      const next = reduceNotification(session, method, params);
      if (next !== session) this.patch(id, next);
      this.streaming = false;
      if (method === "turn/completed") {
        void this.readAgentMetadata(this.threadId(id));
        const turn = params.turn as Turn;
        if (
          turn.status !== "completed" &&
          this.snapshot.sessions[id].queue.length &&
          !this.snapshot.sessions[id].stopping
        )
          this.patch(id, {
            queueError: "上一轮未正常完成，请重试队列或退回编辑",
          });
        else void this.drain(id);
      }
    }
  };
  /** 写入官方协议消息。 */
  private write(message: Message) {
    return invoke<void>("codex_agent_send", {
      connectionId: this.connectionId,
      message,
    });
  }
  /** 建立有超时和发送失败清理的请求关联。 */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (typeof params.threadId === "string") params = { ...params, threadId: this.threadId(params.threadId) };
    if (
      this.snapshot.switching &&
      [
        "thread/start",
        "thread/resume",
        "thread/fork",
        "turn/start",
        "turn/steer",
        "thread/archive",
        "thread/name/set",
      ].includes(method)
    )
      return Promise.reject(new Error("正在切换资源，请稍后操作"));
    const id = `codev-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.update({ pendingRequests: this.pending.size, stateUnknown: true });
        reject(new Error(`${method} 请求超时`));
      }, 60000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.update({ pendingRequests: this.pending.size });
      void this.write({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.update({ pendingRequests: this.pending.size });
        reject(error);
      });
    });
  }
  /** 先订阅后启动并完成 initialize / initialized 握手。 */
  connect(): Promise<void> {
    if (this.snapshot.connected) return Promise.resolve();
    if (this.startup) return this.startup;
    this.startup = (async () => {
      this.update({ loading: true, error: null });
      try {
        this.unlisten?.();
        this.unlisten = await listen<{
          connectionId: number;
          message: Message;
        }>("codev://codex-agent-event", ({ payload }) => {
          if (payload.connectionId === this.connectionId)
            this.receive(payload.message);
        });
        this.connectionId = await invoke<number>("codex_agent_start", {
          owner: this.owner,
          resourceId: this.requestedResource ?? null,
        });
        if (this.disposed) return;
        await this.request("initialize", {
          clientInfo: { name: "codev", title: "Codev", version: "1.0.5" },
          capabilities: { experimentalApi: true },
        });
        await this.write({ method: "initialized" });
        const ready = await invoke<{
          resourceId: string;
          provider: string;
          lastModel: Snapshot["lastModel"];
        }>("codex_agent_ready", { connectionId: this.connectionId });
        this.update({
          connected: false,
          stateUnknown: false,
          resourceId: ready.resourceId,
          provider: ready.provider,
          // 每次连接都以当前资源的实时目录重建，不沿用旧渠道模型缓存。
          lastModel: null,
        });
        this.update({ models: [], modelCatalogError: undefined });
        try {
          const upstream = await invoke<Array<{ id: string; name?: string }>>("codex_resources_models", { id: "native" });
          const available = mergeModels([], upstream ?? []);
          if (!available.length) throw new Error("当前资源没有返回可用模型");
          let choice = this.snapshot.lastModel;
          if (!choice || !available.some(model => model.model === choice?.model)) {
            choice = { model: available[0].model, effort: available[0].defaultReasoningEffort || "" };
            await invoke("codex_resources_model", { id: ready.resourceId, provider: ready.provider, choice });
          }
          const selectedChoice = choice;
          await invoke("codex_agent_ready", { connectionId: this.connectionId, commit: true });
          this.update({ models: available, lastModel: selectedChoice, connected: true,
            sessions: Object.fromEntries(Object.entries(this.snapshot.sessions).map(([id, session]) => [id, {
              ...session,
              model: canonicalModel(session.model || session.thread.model || "", available),
            }])),
          });
        } catch (error) {
          if (this.snapshot.switching) throw error;
          this.update({ models: [], connected: true, modelCatalogError: String(error) });
        }
      } catch (error) {
        this.disconnected(String(error));
        if (this.connectionId)
          await invoke("codex_agent_close", {
            connectionId: this.connectionId,
          });
      } finally {
        this.update({ loading: false });
        this.startup = undefined;
      }
    })();
    return this.startup;
  }
  /** 手动刷新仅覆盖本次已由用户选择的项目，启动时没有隐式历史范围。 */
  async refresh(archived = false): Promise<void> {
    for (const cwd of this.historyProjects) await this.refreshProject(cwd, archived);
  }
  /** 用户选择项目后按 cwd 查询，重复点击复用正在执行的请求。 */
  refreshProject(cwd: string, archived = false): Promise<void> {
    if (!this.historyProjects.has(cwd)) {
      this.historyProjects.add(cwd);
      this.update({ historyProjects: [...this.historyProjects] });
    }
    const key = `${cwd}:${archived}`;
    const pending = this.refreshes.get(key);
    if (pending) return pending;
    const task = this.refreshCatalog(cwd, archived).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, task);
    return task;
  }
  /** 初次或手动加载完整目录，分页结束后一次发布，保留期间到达的会话状态。 */
  private async refreshCatalog(cwd: string, archived: boolean) {
    const fetched: Thread[] = [];
    let cursor: string | null = null;
    do {
      const response: { data: Thread[]; nextCursor: string | null } =
        await this.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          modelProviders: [],
          cwd,
          useStateDbOnly: true,
          archived,
          cursor,
        });
      fetched.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor && !this.disposed);
    if (this.disposed) return;
    const sessions = { ...this.snapshot.sessions };
    const order = new Set(this.snapshot.order);
    for (const thread of fetched) {
      const key = this.sessionKey(thread.id);
      const current = sessions[key];
      sessions[key] = current
        ? { ...current, archived, thread: { ...current.thread, ...thread, turns: current.thread.turns } }
        : { ...sessionFromThread(thread), archived };
      order.add(key);
    }
    this.update({ sessions, order: [...order], ...(archived ? { archivedCursor: cursor } : { cursor }) });
  }

  /** 文件监听只读取发生变化的线程元数据，不重新扫描全历史目录。 */
  async refreshChanged(paths: string[]) {
    const changed = new Map<string, boolean>();
    for (const path of paths) {
      const id = path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
      if (id) changed.set(id, path.includes("archived_sessions"));
    }
    const fetched: Array<{ thread: Thread; archived: boolean }> = [];
    for (const [id, archived] of changed) {
      const current = this.snapshot.sessions[id];
      if (!current || current.resumed || current.busy || current.sending) continue;
      const { thread } = await this.request<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: false });
      fetched.push({ thread, archived });
    }
    if (this.disposed || !fetched.length) return;
    const sessions = { ...this.snapshot.sessions };
    const order = new Set(this.snapshot.order);
    let dirty = false;
    for (const { thread, archived } of fetched) {
      const current = sessions[thread.id];
      if (!current || current.resumed || current.busy || current.sending) continue;
      if (current && current.archived === archived && current.thread.updatedAt === thread.updatedAt && current.thread.name === thread.name && current.thread.preview === thread.preview && current.thread.cwd === thread.cwd) continue;
      sessions[thread.id] = current
        ? { ...current, archived, thread: { ...current.thread, ...thread, turns: current.thread.turns } }
        : { ...sessionFromThread(thread), archived };
      order.add(thread.id);
      dirty = true;
    }
    if (dirty) this.update({ sessions, order: [...order] });
  }

  /** 新建明确绑定项目目录的原生线程。 */
  async create(cwd: string): Promise<string> {
    const id = `draft:${crypto.randomUUID()}`;
    const thread: Thread = { id, name: null, preview: "", cwd, updatedAt: Date.now(), turns: [], model: this.snapshot.lastModel?.model ?? null };
    this.remember(thread);
    this.patch(thread.id, {
      loaded: true,
      draftThread: true,
      ...(this.snapshot.lastModel?.model
        ? {
            model: this.snapshot.lastModel.model,
            effort: this.snapshot.lastModel.effort,
          }
        : {}),
    });
    this.update({
      order: [
        thread.id,
        ...this.snapshot.order.filter((id) => id !== thread.id),
      ],
    });
    return id;
  }
  /** 首次发送前将内存草稿物化为 Codex 原生线程。 */
  private async materializeDraft(id: string): Promise<string> {
    const session = this.snapshot.sessions[id];
    if (!session?.draftThread) return id;
    const { thread, sandbox } = await this.request<{ thread: Thread; sandbox: SandboxPolicy }>("thread/start", {
      cwd: session.thread.cwd,
      modelProvider: this.snapshot.provider,
      ...(session.model ? { model: session.model } : {}),
      sandbox: session.sandbox,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const live = this.snapshot.sessions[thread.id];
    const current = this.snapshot.sessions[id];
    const sessions = { ...this.snapshot.sessions };
    delete sessions[thread.id];
    sessions[id] = { ...current, ...(live ? { busy: live.busy, turnId: live.turnId, requests: live.requests } : {}),
      thread: { ...thread, turns: live?.thread.turns.length ? live.thread.turns : current.thread.turns },
      draftThread: false, resumed: true, loaded: true, effectiveSandbox: sandbox };
    this.update({ sessions, order: this.snapshot.order.filter(key => key !== thread.id),
      activeThreads: [...new Set(this.snapshot.activeThreads.map(key => key === thread.id ? id : key))] });
    return id;
  }
  /** 每个线程只加载一次历史，重复点击复用现有状态。 */
  load(id: string): Promise<void> {
    if (this.snapshot.sessions[id]?.loaded) return Promise.resolve();
    const existing = this.loads.get(id);
    if (existing) return existing;
    const loading = this.request<{ thread: Thread }>("thread/read", {
      threadId: id,
      includeTurns: false,
    })
      .then(async ({ thread }) => {
        if (!this.snapshot.sessions[id]) this.remember(thread);
        const page = await this.request<{
          data: Turn[];
          nextCursor: string | null;
        }>("thread/turns/list", {
          threadId: this.threadId(id),
          limit: 30,
          sortDirection: "desc",
          itemsView: "full",
        });
        const savedEffort = this.snapshot.sessions[id]?.effort || "";
        const historyPath = thread.path || this.snapshot.sessions[id]?.thread.path;
        this.patch(id, {
          thread: { ...this.snapshot.sessions[id].thread, ...thread, turns: page.data.reverse() },
          ...(this.snapshot.lastModel ? { model: this.snapshot.lastModel.model } : {}),
          loaded: true,
          historyCursor: page.nextCursor,
          effort: savedEffort,
        });
        if (historyPath) {
          try {
            const history = await invoke<{ tokenUsage: Session["tokenUsage"]; effort: string }>("codex_agent_read_usage", { path: historyPath });
            const current = this.snapshot.sessions[id];
            if (history && current && !current.busy && !current.compacting)
              this.patch(id, { tokenUsage: current.tokenUsage ?? history.tokenUsage,
                ...(current.effort === savedEffort && !savedEffort ? { effort: history.effort || "medium" } : {}),
              });
          } catch (error) { console.error("Codex 历史用量读取失败", error); }
        }
        if (!this.snapshot.sessions[id]?.effort) this.patch(id, { effort: "medium" });
      })
      .finally(() => this.loads.delete(id));
    this.loads.set(id, loading);
    return loading;
  }
  /** 原生分页读取更早轮次，保留实时到达的现有轮次。 */
  async loadOlder(id: string) {
    const session = this.snapshot.sessions[id];
    if (!session.historyCursor || session.historyLoading) return;
    this.patch(id, { historyLoading: true });
    try {
      const page = await this.request<{
        data: Turn[];
        nextCursor: string | null;
      }>("thread/turns/list", {
        threadId: id,
        cursor: session.historyCursor,
        limit: 30,
        sortDirection: "desc",
        itemsView: "full",
      });
      const latest = this.snapshot.sessions[id].thread;
      this.patch(id, {
        thread: {
          ...latest,
          turns: [
            ...page.data
              .reverse()
              .filter(
                (turn) =>
                  !latest.turns.some((current) => current.id === turn.id),
              ),
            ...latest.turns,
          ],
        },
        historyCursor: page.nextCursor,
      });
    } finally {
      this.patch(id, { historyLoading: false });
    }
  }
  /** 原生删除成功才移除界面缓存，不直接操作会话文件。 */
  async deleteThread(id: string) {
    id = this.sessionKey(id);
    const session = this.snapshot.sessions[id];
    if (!session) throw new Error("线程已不存在，请刷新列表");
    if (
      session.busy ||
      session.sending ||
      session.queue.length ||
      session.requests.length
    )
      throw new Error("请先停止任务并处理队列和审批");
    const family = taskFamily(this.snapshot.sessions, id);
    if (!session.draftThread) await this.request("thread/delete", { threadId: id });
    this.removeSessions(family);
  }
  /** 清除原生已删除线程的列表、活动记录和阅读位置；通知先于响应时可重复调用。 */
  private removeSessions(ids: string[]) {
    const removed = new Set(ids);
    const sessions = { ...this.snapshot.sessions };
    for (const id of removed) {
      delete sessions[id];
      this.scrollPositions.delete(id);
    }
    this.update({
      sessions,
      order: this.snapshot.order.filter((key) => !removed.has(key)),
      activeThreads: this.snapshot.activeThreads.filter(key => !removed.has(key)),
    });
  }
  /** 导出读取完整历史，不占用线程写锁或覆盖当前分页缓存。 */
  async exportThread(id: string) {
    const { thread } = await this.request<{ thread: Thread }>("thread/read", {
      threadId: id,
      includeTurns: false,
    });
    const turns: Turn[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Turn[]; nextCursor: string | null } =
        await this.request("thread/turns/list", {
          threadId: this.threadId(id),
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "full",
        });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return { ...thread, turns };
  }
  /** 由原生发现当前目录可用的全局与项目技能，保留扫描错误供界面提示。 */
  async listSkills(cwd: string) {
    const result = await this.request<{
      data: Array<{ skills: Skill[]; errors: Array<{ message: string }> }>;
    }>("skills/list", { cwds: [cwd], forceReload: true });
    return {
      skills: result.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled),
      error: result.data
        .flatMap((entry) => entry.errors)
        .map((error) => error.message)
        .join("；"),
    };
  }
  /** 在发送前恢复会话，运行中的输入走 steer 并绑定当前轮次。 */
  async send(id: string, queued?: Draft, leadingInputs: Input[] = []) {
    id = await this.materializeDraft(id);
    const live = this.snapshot.sessions[id];
    const initial = live && queued ? { ...live, ...queued } : live;
    if (
      !initial ||
      this.snapshot.switching ||
      !this.snapshot.connected ||
      initial.sending ||
      initial.stopping ||
      (!initial.draft.trim() &&
        !initial.attachments.length &&
        !initial.images.length &&
        !initial.skills.length) ||
      (initial.busy && !initial.turnId)
    )
      return false;
    const draft = initial.draft;
    const attachments = initial.attachments;
    this.patch(id, { busy: true, sending: true, error: null });
    try {
      if (!initial.resumed) {
        const { thread, sandbox } = await this.request<{
          thread: Thread;
          sandbox: SandboxPolicy;
        }>("thread/resume", {
          threadId: this.threadId(id),
          approvalPolicy: "on-request",
          modelProvider: this.snapshot.provider,
          approvalsReviewer: "user",
          sandbox: initial.sandbox,
          excludeTurns: true,
        });
        this.patch(id, {
          thread: { ...thread, turns: this.snapshot.sessions[id].thread.turns },
          resumed: true,
          loaded: true,
          effectiveSandbox: sandbox,
        });
      }
      const input: Input[] = [
        ...leadingInputs,
        { type: "text", text: draft, text_elements: [] },
      ];
      input.push(
        ...initial.skills.map(
          ({ name, path }): Input => ({ type: "skill", name, path }),
        ),
        ...initial.images.map((url): Input => ({ type: "image", url })),
      );
      for (const path of attachments) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(path))
          input.push({ type: "localImage", path });
        else
          input.push({
            type: "text",
            text: `- 关联${initial.directories.includes(path) ? "目录" : "文件"} ${path}`,
            text_elements: [],
          });
      }
      const policy = sandboxPolicy(
        initial.sandbox,
        initial.thread.cwd,
        this.snapshot.sessions[id].effectiveSandbox,
      );
      if (initial.turnId)
        await this.request("turn/steer", {
          threadId: this.threadId(id),
          expectedTurnId: initial.turnId,
          input,
        });
      else
        await this.request("turn/start", {
          threadId: this.threadId(id),
          input,
          ...(initial.model ? { model: initial.model } : {}),
          effort: initial.effort || "medium",
          sandboxPolicy: policy,
        });
      const latest = this.snapshot.sessions[id];
      this.patch(id, {
        ...(!initial.turnId ? { effectiveSandbox: policy } : {}),
        ...(!initial.turnId && initial.model
          ? { thread: { ...latest.thread, model: initial.model } }
          : {}),
        sendRevision: latest.sendRevision + 1,
        submitted: prependPrompt(latest.submitted, draft),
        ...(!queued
          ? {
              draft: latest.draft === draft ? "" : latest.draft,
              attachments: latest.attachments.filter(
                (path) => !attachments.includes(path),
              ),
              images: latest.images.filter(
                (url) => !initial.images.includes(url),
              ),
              skills: latest.skills.filter(
                (skill) =>
                  !initial.skills.some((sent) => sent.path === skill.path),
              ),
              directories: latest.directories.filter(
                (path) => !attachments.includes(path),
              ),
            }
          : {}),
      });
      return true;
    } catch (error) {
      this.patch(id, {
        busy: Boolean(this.snapshot.sessions[id].turnId),
        error: String(error),
      });
      return false;
    } finally {
      this.patch(id, { sending: false });
      if (!queued) void this.drain(id);
    }
  }
  /** 普通 Enter 排队，steer 立即提交，所有草稿按线程独立保存。 */
  async submit(id: string, mode: "followUp" | "steer" = "followUp") {
    const session = this.snapshot.sessions[id];
    if (
      mode === "followUp" &&
      (session.busy || session.sending || session.queue.length)
    ) {
      const { draft, attachments, images, skills, directories } = session;
      if (
        !draft.trim() &&
        !attachments.length &&
        !images.length &&
        !skills.length
      )
        return;
      this.patch(id, {
        submitted: prependPrompt(session.submitted, draft),
        queue: [
          ...session.queue,
          {
            id: crypto.randomUUID(),
            draft,
            attachments,
            images,
            skills,
            directories,
          },
        ],
        draft: "",
        attachments: [],
        images: [],
        skills: [],
        directories: [],
      });
      void this.drain(id);
    } else await this.send(id);
  }
  /** 上一轮完成后串行发送一条；失败保留原队列，避免重复提交。 */
  private async drain(id: string) {
    const session = this.snapshot.sessions[id];
    if (
      !session ||
      session.busy ||
      session.sending ||
      session.stopping ||
      session.queueError ||
      !session.queue.length ||
      this.draining.has(id) ||
      !this.snapshot.connected ||
      this.snapshot.switching
    )
      return;
    this.draining.add(id);
    const entry = session.queue[0];
    try {
      if (await this.send(id, entry))
        this.patch(id, {
          queue: this.snapshot.sessions[id].queue.filter(
            (item) => item.id !== entry.id,
          ),
        });
      else
        this.patch(id, {
          queueError: this.snapshot.sessions[id].error || "队列发送失败",
        });
    } finally {
      this.draining.delete(id);
    }
    if (
      !this.snapshot.sessions[id]?.busy &&
      !this.snapshot.sessions[id]?.queueError
    )
      void this.drain(id);
  }
  /** 退回队列保留现有草稿及附件。 */
  restoreDraft(id: string, entries: Draft[]) {
    const session = this.snapshot.sessions[id];
    this.patch(id, {
      draft: [...entries.map((entry) => entry.draft), session.draft]
        .filter(Boolean)
        .join("\n\n"),
      attachments: [
        ...new Set([
          ...entries.flatMap((entry) => entry.attachments),
          ...session.attachments,
        ]),
      ],
      directories: [
        ...new Set([
          ...entries.flatMap((entry) => entry.directories),
          ...session.directories,
        ]),
      ],
      images: [...entries.flatMap((entry) => entry.images), ...session.images],
      skills: [
        ...new Map(
          [...entries.flatMap((entry) => entry.skills), ...session.skills].map(
            (skill) => [skill.path, skill],
          ),
        ).values(),
      ],
      focusRevision: session.focusRevision + 1,
    });
  }
  /** 调整未提交队列：编辑、删除或立即追加。 */
  async queueAction(
    id: string,
    entryId: string,
    action: "edit" | "delete" | "steer",
  ) {
    if (this.draining.has(id) || this.snapshot.sessions[id].sending)
      throw new Error("队列正在提交，请稍后操作");
    const entry = this.snapshot.sessions[id].queue.find(
      (item) => item.id === entryId,
    );
    if (!entry) return;
    if (action === "steer" && !(await this.send(id, entry))) return;
    if (action === "edit") this.restoreDraft(id, [entry]);
    this.patch(id, {
      queue: this.snapshot.sessions[id].queue.filter(
        (item) => item.id !== entryId,
      ),
      ...(this.snapshot.sessions[id].queue.length === 1
        ? { queueError: null }
        : {}),
    });
  }
  /** 用户明确重试后继续队列。 */
  retryQueue(id: string) {
    this.patch(id, { queueError: null });
    void this.drain(id);
  }
  /** 停止确认后恢复尚未提交的队列，不丢失新草稿。 */
  async stopAndRestore(id: string) {
    if (this.snapshot.sessions[id].sending)
      throw new Error("正在提交消息，请稍后停止");
    this.patch(id, { stopping: true });
    try {
      const targets = taskFamily(this.snapshot.sessions, id).filter(key =>
        this.snapshot.sessions[key].busy || this.snapshot.activeThreads.includes(key));
      const results = await Promise.allSettled(targets.map(key => this.interrupt(key)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      this.restoreDraft(id, this.snapshot.sessions[id].queue);
      this.patch(id, { queue: [], queueError: null });
    } finally {
      this.patch(id, { stopping: false });
    }
  }
  /** 在最后一轮之前原生分叉，保留旧线程及文件修改。 */
  async editLast(
    id: string,
    text: string,
    expectedItemId: string,
  ): Promise<string> {
    const session = this.snapshot.sessions[id];
    const target = editableLastUser(session);
    if (
      !this.snapshot.connected ||
      this.snapshot.switching ||
      !target ||
      target.item.id !== expectedItemId
    )
      throw new Error("当前输入已不可编辑，请等待任务结束后编辑最后一条输入");
    if (!text.trim()) throw new Error("编辑内容不能为空");
    const { turn: last, item: user } = target;
    const earlierInputs = last.items
      .slice(0, last.items.indexOf(user))
      .filter((item) => item.type === "userMessage")
      .flatMap(originalInputs);
    this.patch(id, { sending: true });
    try {
      const { thread } = await this.request<{ thread: Thread }>("thread/fork", {
        threadId: id,
        beforeTurnId: last.id,
        excludeTurns: true,
        modelProvider: this.snapshot.provider,
        sandbox: session.sandbox,
        approvalPolicy: "on-request",
      });
      this.remember(thread);
      const parts = (user.content ?? []) as Array<{
        type: string;
        url?: string;
        path?: string;
        name?: string;
      }>;
      this.patch(thread.id, {
        loaded: true,
        resumed: true,
        draft: text,
        model: session.model,
        effort: session.effort,
        sandbox: session.sandbox,
        images: parts
          .filter((part) => part.type === "image" && part.url)
          .map((part) => part.url!),
        attachments: parts
          .filter((part) => part.type === "localImage" && part.path)
          .map((part) => part.path!),
        skills: parts
          .filter((part) => part.type === "skill" && part.path)
          .map((part) => ({
            name: part.name!,
            path: part.path!,
            scope: "user",
            description: "",
            enabled: true,
          })),
      });
      this.patch(thread.id, { loaded: false });
      await this.load(thread.id);
      await this.send(thread.id, undefined, earlierInputs);
      return thread.id;
    } finally {
      this.patch(id, { sending: false });
    }
  }
  /** 使用原生压缩接口，先恢复历史线程；不把 slash 文本发送给模型。 */
  async compact(id: string) {
    const session = this.snapshot.sessions[id];
    if (!session || session.busy || session.sending || this.snapshot.switching)
      throw new Error("当前线程忙碌，无法压缩上下文");
    this.patch(id, {
      busy: true,
      sending: true,
      error: null,
      compacting: true,
    });
    try {
      if (!session.resumed) {
        const { thread, sandbox } = await this.request<{
          thread: Thread;
          sandbox: SandboxPolicy;
        }>("thread/resume", {
          threadId: id,
          modelProvider: this.snapshot.provider,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: session.sandbox,
          excludeTurns: true,
        });
        this.patch(id, {
          thread: { ...thread, turns: this.snapshot.sessions[id].thread.turns },
          resumed: true,
          loaded: true,
          effectiveSandbox: sandbox,
        });
      }
      await this.request("thread/compact/start", { threadId: id });
    } catch (error) {
      this.patch(id, { busy: false, compacting: false });
      throw error;
    } finally {
      this.patch(id, { sending: false });
      void this.drain(id);
    }
  }
  /** 中止指定视口的轮次，不关闭其他线程。 */
  async interrupt(id: string) {
    let turnId = this.snapshot.sessions[id]?.turnId;
    if (!turnId) {
      const { thread } = await this.request<{ thread: Thread }>("thread/read", { threadId: this.threadId(id), includeTurns: true });
      turnId = thread.turns.find(turn => turn.status === "inProgress")?.id ?? null;
      if (!turnId && ["idle", "notLoaded"].includes(thread.status?.type ?? "")) {
        this.patch(id, { busy: false, turnId: null, stopping: false });
        this.update({ activeThreads: this.snapshot.activeThreads.filter(key => key !== id) });
        return;
      }
      if (!turnId) throw new Error("尚未取得活动轮次，请稍后重试停止");
    }
    await this.request("turn/interrupt", { threadId: this.threadId(id), turnId });
  }
  /** 使用官方重命名接口同步标题与历史列表。 */
  async rename(id: string, name: string) {
    if (!name.trim()) return;
    await this.request("thread/name/set", { threadId: id, name: name.trim() });
    this.patch(id, {
      thread: { ...this.snapshot.sessions[id].thread, name: name.trim() },
    });
  }
  /** 通过原生接口分叉线程，保留原始历史不做本地文件复制。 */
  async fork(id: string, lastTurnId?: string): Promise<string> {
    const source = this.snapshot.sessions[id]?.thread;
    const { thread } = await this.request<{ thread: Thread }>("thread/fork", {
      threadId: id,
      ...(lastTurnId ? { lastTurnId } : {}),
      excludeTurns: true,
      modelProvider: this.snapshot.provider,
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const base = source?.name || source?.preview || "新线程";
    const used = new Set(Object.values(this.snapshot.sessions)
      .filter(session => session.thread.cwd === source?.cwd)
      .map(session => session.thread.name || session.thread.preview || ""));
    let index = 1;
    let name = `${base} · 分叉 ${index}`;
    while (used.has(name)) name = `${base} · 分叉 ${++index}`;
    await this.request("thread/name/set", { threadId: thread.id, name });
    thread.name = name;
    this.remember(thread);
    this.patch(thread.id, { thread, resumed: true });
    this.update({
      order: [thread.id, ...this.snapshot.order.filter((item) => item !== thread.id)],
    });
    await this.load(thread.id);
    return thread.id;
  }
  /** 原生归档与恢复同步右侧分组，不删除会话文件。 */
  async archive(id: string, archived: boolean) {
    id = this.sessionKey(id);
    const session = this.snapshot.sessions[id];
    if (!session) throw new Error("线程已不存在，请刷新列表");
    if (session.draftThread) throw new Error("未发送的草稿尚未保存，无法归档");
    if (this.snapshot.sessions[id]?.busy)
      throw new Error("请先停止运行中的会话");
    await this.request(archived ? "thread/archive" : "thread/unarchive", {
      threadId: id,
    });
    this.patch(id, { archived, resumed: false });
  }
  /** 明确响应审批或提问，成功发送后移除对应请求。 */
  async respond(id: string, requestId: string | number, result: unknown) {
    await this.write({ id: requestId, result });
    this.patch(id, {
      requests: this.snapshot.sessions[id].requests.filter(
        (r) => r.id !== requestId,
      ),
    });
  }
  /** 卸载插件时取消监听与本插件进程。 */
  async dispose() {
    this.disposed = true;
    clearTimeout(this.streamTimer);
    await this.startup;
    this.unlisten?.();
    this.disconnected("Codex 插件已关闭");
    if (this.connectionId)
      await invoke("codex_agent_close", { connectionId: this.connectionId });
  }
}
