import { Streamdown } from "streamdown";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  closePiAgent,
  listPiSessions,
  listenPiEvents,
  probePiAgent,
  sendPiCommand,
  startPiAgent,
} from "./native";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "./reducer";
import type { PiSessionSummary, PiTranscriptItem } from "./types";

type Props = {
  cwd: string | null;
  active: boolean;
};

/** 返回适合紧凑顶栏展示的运行状态文本。 */
function statusLabel(status: typeof INITIAL_PI_VIEW_STATE.status): string {
  if (status === "starting") return "启动中";
  if (status === "running") return "运行中";
  if (status === "stopping") return "停止中";
  if (status === "idle") return "就绪";
  if (status === "failed") return "异常";
  return "未启动";
}

/** 把工具输出限制在可阅读范围内，完整结果仍保留在 Pi 会话文件中。 */
function compactToolOutput(value: string): string {
  const limit = 8_000;
  return value.length > limit ? `${value.slice(0, limit)}\n…输出已截断` : value;
}

/** 渲染一条用户、助手或工具调用记录。 */
function TranscriptItem({ item }: { item: PiTranscriptItem }) {
  if (item.kind === "tool") {
    return (
      <details
        className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px]"
        open={item.status === "running"}
      >
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">
          {item.status === "running" ? "执行中" : item.status === "error" ? "执行失败" : "已完成"}
          {" · "}
          {item.name}
        </summary>
        {item.args !== null && (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-foreground/80">
            {typeof item.args === "string"
              ? item.args
              : JSON.stringify(item.args, null, 2)}
          </pre>
        )}
        {item.output && (
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 pt-1 text-foreground/80">
            {compactToolOutput(item.output)}
          </pre>
        )}
      </details>
    );
  }

  return (
    <article
      className={
        item.role === "user"
          ? "ml-8 rounded-lg bg-accent/70 px-3 py-2 text-[12px]"
          : "mr-2 px-1 py-2 text-[12px]"
      }
    >
      {item.thinking && (
        <details className="mb-2 rounded-md border border-border/50 bg-muted/25 px-2 py-1 text-muted-foreground">
          <summary className="cursor-pointer select-none text-[10px]">思考过程</summary>
          <div className="mt-1 whitespace-pre-wrap">{item.thinking}</div>
        </details>
      )}
      <div className="select-text break-words leading-5 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap">
        <Streamdown>{item.text || (item.streaming ? "…" : "")}</Streamdown>
      </div>
    </article>
  );
}

/** 渲染可恢复的 Pi 原生线程抽屉。 */
function SessionDrawer({
  sessions,
  loading,
  onSelect,
  onRefresh,
}: {
  sessions: PiSessionSummary[];
  loading: boolean;
  onSelect: (session: PiSessionSummary) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="absolute inset-y-0 left-0 z-20 flex w-[min(86%,280px)] flex-col border-r border-border bg-card shadow-xl">
      <header className="flex h-9 shrink-0 items-center border-b border-border/60 px-2 text-[11px] font-medium">
        Pi 线程
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onRefresh}
        >
          刷新
        </button>
      </header>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">正在读取线程…</p>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">当前工作区暂无 Pi 线程</p>
        ) : (
          sessions.map((session) => (
            <button
              type="button"
              key={session.path}
              className="mb-0.5 flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => onSelect(session)}
              title={session.path}
            >
              <span className="w-full truncate text-[11px] font-medium">
                {session.name || session.preview || "未命名线程"}
              </span>
              <span className="mt-0.5 text-[9px] text-muted-foreground">
                {session.messageCount} 条消息 · {new Date(session.updatedAt).toLocaleString()}
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

/** 渲染内置 Pi Agent 命令页面并管理一个活动 RPC 会话。 */
export function PiAgentPane({ cwd, active }: Props) {
  const [view, dispatch] = useReducer(piViewReducer, INITIAL_PI_VIEW_STATE);
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof probePiAgent>> | null>(null);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listenerReady, setListenerReady] = useState(false);
  const [runtimeId, setRuntimeId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const runtimeRef = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const requestIdRef = useRef(1);

  const virtualizer = useVirtualizer({
    count: view.items.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: (index) => (view.items[index]?.kind === "tool" ? 52 : 88),
    overscan: 6,
  });

  /** 重新读取当前工作目录的 Pi 原生线程。 */
  const refreshSessions = useCallback(async () => {
    if (!cwd) {
      setSessions([]);
      return;
    }
    setSessionsLoading(true);
    try {
      setSessions(await listPiSessions(cwd));
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    void probePiAgent().then(setProbe);
  }, [active]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenPiEvents((payload) => {
      if (payload.sessionId !== runtimeRef.current) return;
      dispatch({ type: "event", payload });
      if (payload.event.type === "process_exit") {
        runtimeRef.current = null;
        setRuntimeId(null);
      }
      if (payload.event.type === "agent_settled") void refreshSessions();
    }).then((stop) => {
      if (disposed) stop();
      else {
        unlisten = stop;
        setListenerReady(true);
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
      const id = runtimeRef.current;
      runtimeRef.current = null;
      if (id !== null) void closePiAgent(id);
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!active) return;
    void refreshSessions();
  }, [active, refreshSessions]);

  useEffect(() => {
    const id = runtimeRef.current;
    runtimeRef.current = null;
    setRuntimeId(null);
    dispatch({ type: "reset" });
    if (id !== null) void closePiAgent(id);
  }, [cwd]);

  useEffect(() => {
    if (!nearBottomRef.current || view.items.length === 0) return;
    virtualizer.scrollToIndex(view.items.length - 1, { align: "end" });
  }, [view.items.length, virtualizer]);

  /** 启动一个 RPC 进程并加载会话、模型和思考等级。 */
  const openRuntime = useCallback(
    async (sessionPath?: string): Promise<number> => {
      if (!cwd) throw new Error("请先选择一个工作区根目录");
      if (!probe?.available) throw new Error(probe?.error || "未找到 Pi");
      if (!listenerReady) throw new Error("Pi 事件通道尚未就绪");
      const previous = runtimeRef.current;
      runtimeRef.current = null;
      setRuntimeId(null);
      if (previous !== null) await closePiAgent(previous);
      dispatch({ type: "reset", status: "starting" });
      const result = await startPiAgent(cwd, sessionPath);
      runtimeRef.current = result.sessionId;
      setRuntimeId(result.sessionId);
      for (const type of [
        "get_messages",
        "get_state",
        "get_available_models",
        "get_available_thinking_levels",
      ]) {
        await sendPiCommand(result.sessionId, {
          id: `codev-${requestIdRef.current++}`,
          type,
        });
      }
      return result.sessionId;
    },
    [cwd, listenerReady, probe],
  );

  /** 新建一个空白 Pi 原生线程。 */
  const createSession = useCallback(async () => {
    setDrawerOpen(false);
    try {
      await openRuntime();
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  }, [openRuntime]);

  /** 恢复线程抽屉中选中的 Pi 会话。 */
  const resumeSession = useCallback(
    async (session: PiSessionSummary) => {
      setDrawerOpen(false);
      try {
        await openRuntime(session.path);
      } catch (error) {
        dispatch({ type: "error", message: String(error) });
      }
    },
    [openRuntime],
  );

  /** 发送普通提示或在运行期间发送 steering 指令。 */
  const submit = useCallback(async () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    dispatch({
      type: "optimistic_user",
      id: `local-user-${requestIdRef.current}`,
      text: message,
    });
    try {
      const id = runtimeRef.current ?? (await openRuntime());
      await sendPiCommand(id, {
        id: `codev-${requestIdRef.current++}`,
        type: "prompt",
        message,
        ...(view.status === "running" ? { streamingBehavior: "steer" } : {}),
      });
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
      setDraft(message);
    }
  }, [draft, openRuntime, view.status]);

  /** 请求 Pi 中止当前轮次。 */
  const stopTurn = useCallback(async () => {
    const id = runtimeRef.current;
    if (id === null) return;
    dispatch({ type: "stopping" });
    try {
      await sendPiCommand(id, {
        id: `codev-${requestIdRef.current++}`,
        type: "abort",
      });
    } catch (error) {
      dispatch({ type: "error", message: String(error) });
    }
  }, []);

  /** 处理输入框的 Enter 发送与 Shift+Enter 换行。 */
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const modelValue = view.model ? `${view.model.provider}\u0000${view.model.id}` : "";
  const title = view.sessionName || "Pi Agent";
  const canSend = Boolean(cwd && probe?.available && listenerReady && draft.trim());
  const virtualItems = virtualizer.getVirtualItems();
  const emptyText = useMemo(() => {
    if (!cwd) return "请先在左侧选择工作区根目录";
    if (probe && !probe.available) return probe.error || "未找到 Pi Coding Agent";
    return "输入任务，开始当前工作区的 Pi 会话";
  }, [cwd, probe]);

  return (
    <section className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background">
      {drawerOpen && (
        <SessionDrawer
          sessions={sessions}
          loading={sessionsLoading}
          onSelect={(session) => void resumeSession(session)}
          onRefresh={() => void refreshSessions()}
        />
      )}
      {drawerOpen && (
        <button
          type="button"
          className="absolute inset-0 z-10 bg-black/20"
          aria-label="关闭线程列表"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <button
          type="button"
          className="rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setDrawerOpen((value) => !value)}
        >
          线程
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={view.sessionFile || undefined}>
          {title}
        </span>
        <span
          className={
            view.status === "running"
              ? "text-[9px] text-[#7894b0]"
              : view.status === "failed"
                ? "text-[9px] text-destructive"
                : "text-[9px] text-muted-foreground"
          }
        >
          {statusLabel(view.status)}
        </span>
        <button
          type="button"
          className="rounded-sm px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void createSession()}
          disabled={!cwd || !probe?.available || !listenerReady}
        >
          新建
        </button>
      </header>

      {(view.models.length > 0 || view.thinkingLevels.length > 1) && runtimeId !== null && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/50 px-2">
          {view.models.length > 0 && (
            <select
              value={modelValue}
              className="min-w-0 flex-1 bg-transparent text-[10px] text-muted-foreground outline-none"
              onChange={(event) => {
                const [provider, modelId] = event.target.value.split("\u0000");
                if (!provider || !modelId || runtimeId === null) return;
                void sendPiCommand(runtimeId, { type: "set_model", provider, modelId });
              }}
            >
              {view.models.map((model) => (
                <option key={`${model.provider}/${model.id}`} value={`${model.provider}\u0000${model.id}`}>
                  {model.name || `${model.provider}/${model.id}`}
                </option>
              ))}
            </select>
          )}
          {view.thinkingLevels.length > 1 && (
            <select
              value={view.thinkingLevel}
              className="bg-transparent text-[10px] text-muted-foreground outline-none"
              onChange={(event) => {
                if (runtimeId === null) return;
                void sendPiCommand(runtimeId, {
                  type: "set_thinking_level",
                  level: event.target.value,
                });
              }}
            >
              {view.thinkingLevels.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          )}
        </div>
      )}

      <div
        ref={transcriptRef}
        className="reader-scrollbar min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const node = event.currentTarget;
          nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {view.items.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const item = view.items[virtualItem.index];
              return (
                <div
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute top-0 left-0 w-full px-2"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <TranscriptItem item={item} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {view.error && (
        <div className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {view.error}
        </div>
      )}

      <footer className="shrink-0 border-t border-border/60 p-2">
        <textarea
          value={draft}
          rows={3}
          placeholder="向 Pi 发送任务，Shift+Enter 换行"
          className="reader-scrollbar max-h-40 min-h-16 w-full resize-none rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-[12px] outline-none focus:border-muted-foreground/60"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          disabled={!cwd || probe?.available === false}
        />
        <div className="mt-1 flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[9px] text-muted-foreground">
            {probe?.available ? `Pi ${probe.version ?? ""}` : probe ? "Pi 不可用" : "正在探测 Pi…"}
            {view.contextPercent !== null ? ` · 上下文 ${Math.round(view.contextPercent)}%` : ""}
          </span>
          {(view.status === "running" || view.status === "stopping") && (
            <button
              type="button"
              className="h-7 rounded-md border border-border px-2 text-[11px] hover:bg-muted"
              onClick={() => void stopTurn()}
              disabled={view.status === "stopping"}
            >
              停止
            </button>
          )}
          <button
            type="button"
            className="h-7 rounded-md bg-primary px-3 text-[11px] text-primary-foreground disabled:opacity-40"
            onClick={() => void submit()}
            disabled={!canSend}
          >
            {view.status === "running" ? "追加" : "发送"}
          </button>
        </div>
      </footer>
    </section>
  );
}
