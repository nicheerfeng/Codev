import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  Settings01Icon,
  SidebarRight01Icon,
  Maximize01Icon,
  Minimize01Icon,
  Analytics01Icon,
  GridViewIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ViewportCount, ViewportSlotActions } from "@/components/ViewportCount";
import { ResizableViewportGrid } from "@/components/ResizableViewportGrid";
import { AgentSidebar } from "./AgentSidebar";
import { AgentTranscript } from "./AgentTranscript";
import { AgentComposer } from "./AgentComposer";
import { AgentSettings } from "./AgentSettings";
import { UsageDialog } from "./UsageDialog";
import { focusAgentSession, useAgentStore } from "./store";
import {
  finishAgentProjectRequest,
  useAgentProjectRequest,
} from "@/modules/plugins/agentProjectRequest";
import { useNativeAgentDrop } from "./drop";
import { isBusy, type SessionView } from "./types";
import "./agent.css";

function Conversation({
  id,
  onOpenFile,
  onOpenDiff,
  onFork,
  searchOpen,
  onCloseSearch,
}: {
  id: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
  onFork?: (entryId: string) => void;
  searchOpen: boolean;
  onCloseSearch: () => void;
}) {
  const view = useAgentStore((s) => s.views[id]);
  const summary = useAgentStore((s) => s.sessions[id]);
  const report = useAgentStore.getState().report;
  if (!view)
    return (
      <div className="agent-empty">
        <p>{summary?.error ?? "正在读取会话…"}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void useAgentStore.getState().select(id).catch(report)}
        >
          重新读取
        </Button>
      </div>
    );
  return (
    <>
      <AgentTranscript
        session={view}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onFork={onFork}
        searchOpen={searchOpen}
        onCloseSearch={onCloseSearch}
      />
      <AgentComposer session={view} />
    </>
  );
}
export function AgentPane({
  active = true,
  workspaceRoots = [],
  onOpenFile,
  onOpenDiff,
  onAddWorkspaceRoot,
  mobile = false,
}: {
  active?: boolean;
  workspaceRoots?: string[];
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
  onAddWorkspaceRoot?: (cwd: string) => void;
  mobile?: boolean;
}) {
  const state = useAgentStore();
  const [sidebar, setSidebar] = useState(!mobile || !state.selected);
  useEffect(() => {
    if (mobile && !state.selected && state.connection === "connected") {
      setSidebar(true);
    }
  }, [mobile, state.selected, state.connection]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      return Math.max(
        180,
        Math.min(
          420,
          Number(localStorage.getItem("codev.agent.sidebar.width")) || 236,
        ),
      );
    } catch {
      return 236;
    }
  });
  const [settings, setSettings] = useState(false);
  const [usage, setUsage] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try {
      return localStorage.getItem("codev.agent.welcomeDismissed") === "1";
    } catch {
      return false;
    }
  });
  const [renamingSlot, setRenamingSlot] = useState<string | null>(null);
  const [slotTitle, setSlotTitle] = useState("");
  const [width, setWidth] = useState(800);
  const [maximized, setMaximized] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{
    pointer: number;
    from: number;
    x: number;
    y: number;
    moving: boolean;
    target: HTMLButtonElement;
  } | null>(null);
  const suppress = useRef(false);
  const rootsKey = workspaceRoots.join("\n");
  const report = useAgentStore.getState().report;
  const projectRequest = useAgentProjectRequest((s) => s.request);
  const handledRequest = useRef<number | null>(null);
  const initializedWorkspace = useRef(false);
  useEffect(() => {
    if (
      !projectRequest ||
      mobile ||
      !active ||
      state.connection !== "connected" ||
      handledRequest.current === projectRequest.id
    )
      return;
    handledRequest.current = projectRequest.id;
    void state
      .addWorkspace(projectRequest.cwd)
      .then(() => {
        setSidebar(true);
        toast.success("已添加到 Agent 工作区");
        finishAgentProjectRequest(projectRequest.id);
      })
      .catch(report);
  }, [
    projectRequest,
    mobile,
    active,
    state.connection,
    state.addWorkspace,
    report,
  ]);
  useEffect(() => {
    if (mobile) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("codev.agent.sidebar.width", String(sidebarWidth));
      } catch {
        /* optional layout persistence */
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [sidebarWidth, mobile]);
  useEffect(() => {
    if (!mobile) void state.initDesktop().catch(report);
  }, [mobile, state.initDesktop, report]);
  useNativeAgentDrop(!mobile && active);
  useEffect(() => {
    if (
      mobile ||
      initializedWorkspace.current ||
      state.connection !== "connected" ||
      !rootsKey
    )
      return;
    const key = (value: string) =>
      value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const root = key(rootsKey.split(String.fromCharCode(10))[0] ?? "");
    const match = state.workspaces.find(
      (workspace) => key(workspace.cwd) === root,
    );
    if (match) {
      initializedWorkspace.current = true;
      state.setWorkspace(match.id);
    }
  }, [
    mobile,
    state.connection,
    state.workspaces,
    rootsKey,
    state.setWorkspace,
  ]);
  const finishDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setHover(null);
    if (current?.target.hasPointerCapture(current.pointer))
      current.target.releasePointerCapture(current.pointer);
  }, []);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finishDrag();
        setMaximized(null);
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onEscape);
      finishDrag();
    };
  }, [finishDrag]);
  const startDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    from: number,
  ) => {
    if (
      mobile ||
      state.slots.length < 2 ||
      maximized !== null ||
      event.button !== 0
    )
      return;
    suppress.current = false;
    drag.current = {
      pointer: event.pointerId,
      from,
      x: event.clientX,
      y: event.clientY,
      moving: false,
      target: event.currentTarget,
    };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (
      !current.moving &&
      Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6
    )
      return;
    if (!current.moving) {
      current.moving = true;
      suppress.current = true;
      current.target.setPointerCapture(event.pointerId);
    }
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-agent-viewport-index]");
    setHover(target ? Number(target.dataset.agentViewportIndex) : null);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current?.moving) {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-agent-viewport-index]");
      const to = target ? Number(target.dataset.agentViewportIndex) : -1;
      const slots = [...useAgentStore.getState().slots];
      if (to >= 0 && to < slots.length && to !== current.from) {
        [slots[current.from], slots[to]] = [slots[to], slots[current.from]];
        state.setSlots(slots);
      }
    }
    finishDrag();
  };
  const addDirectory = async () => {
    if (mobile) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const cwd = await open({
      directory: true,
      multiple: false,
      title: "选择 Agent 工作目录",
    });
    if (typeof cwd === "string") {
      await state.addWorkspace(cwd);
      onAddWorkspaceRoot?.(cwd);
    }
  };
  const create = async () => {
    setCreating(true);
    try {
      await state.createSession();
    } catch (e) {
      report(e);
    } finally {
      setCreating(false);
    }
  };
  const columns =
    mobile || state.slots.length === 1
      ? 1
      : width >= 1200
        ? Math.min(3, state.slots.length)
        : state.slots.length > 4
          ? 3
          : 2;
  const items = useMemo(
    () => [
      ...state.opened,
      ...state.slots
        .map((id, index) => (id ? null : `empty:${index}`))
        .filter((id): id is string => !!id),
    ],
    [state.opened, state.slots],
  );
  const positions = items.map((id) => {
    const index = id.startsWith("empty:")
      ? Number(id.slice(6))
      : state.slots.indexOf(id);
    return index < 0 || (maximized !== null && index !== maximized)
      ? null
      : maximized !== null
        ? { row: 0, column: 0 }
        : { row: Math.floor(index / columns), column: index % columns };
  });
  const current = state.selected ? state.views[state.selected] : undefined;
  const currentSummary = state.selected
    ? state.sessions[state.selected]
    : undefined;
  const activeWorkspace =
    (current?.workspaceId ?? currentSummary?.workspaceId)
      ? state.workspaces.find(
          (w) => w.id === (current?.workspaceId ?? currentSummary?.workspaceId),
        )
      : undefined;
  return (
    <section
      className={`agent-pane ${mobile ? "agent-mobile" : ""}`}
      aria-label="统一 Agent 工作区"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f" &&
          state.selected
        ) {
          event.preventDefault();
          event.stopPropagation();
          const input = event.currentTarget.querySelector<HTMLInputElement>(
            'input[aria-label="搜索当前对话"]',
          );
          if (input) {
            input.focus();
            input.select();
          }
          setSearchOpen(true);
        }
      }}
    >
      <header className="agent-header">
        {mobile && (
          <div className="agent-header-new">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              title="在当前选定工作区使用所选代理新建会话"
              aria-label="新建会话"
              disabled={
                !state.workspaceId ||
                creating ||
                state.connection !== "connected"
              }
              onClick={() => void create()}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={13} />
              <span>新建</span>
            </Button>
            <select
              className="agent-harness-picker"
              aria-label="新建会话时使用的代理"
              title="新建会话默认代理（仅影响点击“新建”时创建的会话，不会改变已有会话的底层代理）"
              value={state.harnessId}
              onChange={(e) => state.setHarness(e.target.value)}
            >
              {state.harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.displayName}
                  {!h.installed ? "（待配置）" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="搜索当前线程"
          aria-label="搜索当前线程"
          aria-pressed={searchOpen}
          disabled={!state.selected}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <HugeiconsIcon icon={Search01Icon} size={15} />
        </Button>
        <div className="agent-header-current">
          <span
            className="agent-header-title"
            title={`${current?.title ?? currentSummary?.title ?? activeWorkspace?.title ?? "Agent 工作区"}${state.selected && activeWorkspace ? ` (${activeWorkspace.cwd})` : ""}`}
          >
            {current?.title ??
              currentSummary?.title ??
              activeWorkspace?.title ??
              "Agent 工作区"}
            {state.selected && activeWorkspace
              ? ` (${activeWorkspace.title})`
              : ""}
          </span>
        </div>
        {mobile && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="断开此手机设备的配对会话"
            aria-label="退出设备连接"
            onClick={() =>
              window.dispatchEvent(new Event("codev:agent-logout"))
            }
          >
            退出配对
          </Button>
        )}
        {!mobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={state.slots.length > 1 ? "退出多视口" : "多视口"}
            aria-label={state.slots.length > 1 ? "退出多视口" : "多视口"}
            aria-pressed={state.slots.length > 1}
            onClick={() => {
              const currentSlot = state.slots[state.activeViewport] ?? null;
              state.setSlots(
                state.slots.length > 1 ? [currentSlot] : [state.selected, null],
              );
              setMaximized(null);
            }}
          >
            <HugeiconsIcon icon={GridViewIcon} size={16} />
          </Button>
        )}
        {!mobile && state.slots.length > 1 && (
          <ViewportCount
            count={state.slots.length}
            onMinus={() => {
              if (state.slots.length > 1) {
                const next = state.slots.slice(0, -1);
                state.setSlots(next);
                if (next.length === 1) state.focusViewport(0);
                setMaximized(null);
              }
            }}
            onPlus={() => {
              if (state.slots.length < 6) {
                state.setSlots([...state.slots, null]);
              }
            }}
            minusLabel="减少视口"
            plusLabel="增加视口"
          />
        )}
        {!mobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="用量统计"
            aria-label="用量统计"
            onClick={() => setUsage(true)}
          >
            <HugeiconsIcon icon={Analytics01Icon} size={16} />
          </Button>
        )}
        {!mobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="代理命令、环境诊断、手机连接与语音设置"
            aria-label="代理与手机设置"
            onClick={() => setSettings(true)}
          >
            <HugeiconsIcon icon={Settings01Icon} size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="会话侧栏"
          aria-label="会话侧栏"
          onClick={() => setSidebar(!sidebar)}
        >
          <HugeiconsIcon icon={SidebarRight01Icon} size={16} />
        </Button>
      </header>
      {!mobile && <UsageDialog open={usage} onClose={() => setUsage(false)} />}
      {!mobile && !welcomeDismissed && (
        <div className="agent-welcome-tip" role="note">
          <span>
            提示：在右侧项目上选择代理即可新建会话。输入框支持拖放图片/文件与 <code>Ctrl+F</code> 搜索。
          </span>
          <button
            type="button"
            onClick={() => {
              setWelcomeDismissed(true);
              try {
                localStorage.setItem("codev.agent.welcomeDismissed", "1");
              } catch {
                /* optional */
              }
            }}
          >
            知道了
          </button>
        </div>
      )}
      {state.error && (
        <div className="agent-global-error" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => useAgentStore.setState({ error: "" })}
          >
            ×
          </button>
        </div>
      )}
      <div className="agent-body">
        <main className="agent-main">
          {!state.selected &&
          !state.slots.some(Boolean) &&
          state.slots.length === 1 ? (
            <div className="agent-empty">
              <h2>从一个任务开始</h2>
              <p>选择工作目录和代理，在统一工作区中创建或恢复会话。</p>
              {!mobile && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void addDirectory().catch(report)}
                  >
                    选择工作目录
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <ResizableViewportGrid
              columns={maximized !== null ? 1 : columns}
              rows={
                maximized !== null ? 1 : Math.ceil(state.slots.length / columns)
              }
              positions={positions}
              onWidthChange={setWidth}
              className="agent-grid"
            >
              {items.map((id) => {
                const index = id.startsWith("empty:")
                  ? Number(id.slice(6))
                  : state.slots.indexOf(id);
                const summary = state.sessions[id];
                const liveSummary = state.views[id] ?? summary;
                const slotBusy = isBusy(liveSummary);
                const slotWaiting = !!(
                  state.views[id]?.pendingRequests?.length
                );
                const slotUnread = state.unread.includes(id);
                const slotTitleText = liveSummary?.title ?? summary?.title ?? "";
                return (
                  <div
                    key={id}
                    data-agent-viewport-index={index >= 0 ? index : undefined}
                    data-agent-session-id={summary?.id}
                    className={`agent-viewport ${state.slots.length > 1 ? "is-multi" : ""} ${!summary && state.slots.length > 1 ? "is-empty" : ""} ${state.activeViewport === index && state.slots.length > 1 ? "is-active" : ""} ${hover === index ? "is-drop-target" : ""}`}
                    inert={
                      index < 0 || (maximized !== null && index !== maximized)
                    }
                    onPointerDownCapture={() => {
                      if (summary && !suppress.current && state.selected !== id)
                        focusAgentSession(id);
                    }}
                    onFocusCapture={() => {
                      if (summary && state.selected !== id)
                        focusAgentSession(id);
                    }}
                  >
                    {summary && state.slots.length > 1 && (
                      <div
                        className={`agent-viewport-heading ${state.selected === id ? "is-active" : ""}`}
                      >
                        {renamingSlot !== id && (
                          <span
                            role="img"
                            aria-label={
                              slotWaiting
                                ? "等待输入"
                                : slotBusy
                                  ? "运行中"
                                  : slotUnread
                                    ? "已完成，待查看"
                                    : "就绪"
                            }
                            className={`agent-state-dot agent-viewport-heading-dot ${slotWaiting ? "is-waiting" : slotBusy ? "is-working" : slotUnread ? "is-unread" : ""}`}
                          />
                        )}
                        {renamingSlot === id ? (
                          <form
                            className="flex min-w-0 flex-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              e.currentTarget.querySelector("input")?.blur();
                            }}
                          >
                            <Input
                              autoFocus
                              className="h-5 text-[11px]!"
                              value={slotTitle}
                              onChange={(e) => setSlotTitle(e.target.value)}
                              onBlur={() => {
                                const title = slotTitle.trim();
                                setRenamingSlot(null);
                                if (title && title !== summary.title)
                                  void state
                                    .command("session.rename", { title }, id)
                                    .catch(report);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") setRenamingSlot(null);
                              }}
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            className={`agent-viewport-title ${slotWaiting ? "is-waiting" : slotBusy ? "is-running" : ""}`}
                            onPointerDown={(e) => startDrag(e, index)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={finishDrag}
                            onLostPointerCapture={() => {
                              if (drag.current) finishDrag();
                            }}
                            onDoubleClick={() => {
                              setRenamingSlot(id);
                              setSlotTitle(slotTitleText);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "F2") {
                                e.preventDefault();
                                setRenamingSlot(id);
                                setSlotTitle(slotTitleText);
                              }
                            }}
                            onClick={() => {
                              if (!suppress.current) focusAgentSession(id);
                              suppress.current = false;
                            }}
                            title={`${slotTitleText}${slotWaiting ? " · 等待确认" : slotBusy ? " · 运行中" : ""}（双击或 F2 重命名，拖动标题交换格子）`}
                          >
                            <span>
                              {slotTitleText}
                              {state.workspaces.find(
                                (workspace) =>
                                  workspace.id === summary.workspaceId,
                              )?.title
                                ? ` (${state.workspaces.find((workspace) => workspace.id === summary.workspaceId)?.title})`
                                : ""}
                            </span>
                          </button>
                        )}
                        {!mobile && state.slots.length > 1 && (
                          <button
                            type="button"
                            title={
                              maximized === index ? "还原视口" : "最大化视口"
                            }
                            onClick={() =>
                              setMaximized(maximized === index ? null : index)
                            }
                          >
                            <HugeiconsIcon
                              icon={
                                maximized === index
                                  ? Minimize01Icon
                                  : Maximize01Icon
                              }
                              size={12}
                            />
                          </button>
                        )}
                        <ViewportSlotActions
                          closeDisabled={state.slots.length <= 1}
                          onClear={() => {
                            const next = [...state.slots];
                            next[index] = null;
                            state.setSlots(next);
                            setMaximized(null);
                          }}
                          onClose={() => {
                            const next = state.slots.filter(
                              (_, i) => i !== index,
                            );
                            state.setSlots(next);
                            if (next.length === 1) state.focusViewport(0);
                            setMaximized(null);
                          }}
                        />
                      </div>
                    )}
                    {summary ? (
                      <Conversation
                        id={id}
                        searchOpen={searchOpen && state.selected === id}
                        onCloseSearch={() => setSearchOpen(false)}
                        onOpenFile={onOpenFile}
                        onOpenDiff={onOpenDiff}
                        onFork={(entryId) => {
                          if (
                            state.slots.length > 1 &&
                            !state.slots.includes(null)
                          ) {
                            report(new Error("视口已满，请先新增或清空视口"));
                            return;
                          }
                          void state
                            .command<SessionView>(
                              "session.fork",
                              { entryId },
                              id,
                            )
                            .then((view) => {
                              useAgentStore.setState((current) => ({
                                sessions: {
                                  ...current.sessions,
                                  [view.id]: view,
                                },
                                views: { ...current.views, [view.id]: view },
                              }));
                              return state.select(view.id);
                            })
                            .catch(report);
                        }}
                      />
                    ) : state.slots.length > 1 ? (
                      <>
                        <div className="agent-viewport-heading">
                          <button
                            type="button"
                            className="agent-viewport-title"
                            onPointerDown={(event) => startDrag(event, index)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={finishDrag}
                            onLostPointerCapture={() => {
                              if (drag.current) finishDrag();
                            }}
                            onClick={() => {
                              if (!suppress.current) state.focusViewport(index);
                              suppress.current = false;
                            }}
                          >
                            视口 {index + 1}
                          </button>
                          <button
                            type="button"
                            title={
                              maximized === index ? "还原视口" : "最大化视口"
                            }
                            aria-label={
                              maximized === index ? "还原视口" : "最大化视口"
                            }
                            onClick={() =>
                              setMaximized(maximized === index ? null : index)
                            }
                          >
                            <HugeiconsIcon
                              icon={
                                maximized === index
                                  ? Minimize01Icon
                                  : Maximize01Icon
                              }
                              size={12}
                            />
                          </button>
                          <ViewportSlotActions
                            onClear={() => {}}
                            onClose={() => {
                              const next = state.slots.filter(
                                (_, i) => i !== index,
                              );
                              state.setSlots(next);
                              if (next.length === 1) state.focusViewport(0);
                              setMaximized(null);
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          className="agent-empty agent-empty-viewport"
                          onClick={() => state.focusViewport(index)}
                        >
                          从右侧拖入线程
                          <br />
                          或点击此处后在侧栏选择
                        </button>
                      </>
                    ) : (
                      <div className="agent-empty">
                        <p>{mobile ? "欢迎使用手机端 Agent" : "空视口"}</p>
                        <p>
                          {mobile
                            ? "从会话列表选择一个已有对话，或按当前工作区新建任务。"
                            : "从右侧选择会话，或拖动已有视口标题交换内容。"}
                        </p>
                        <div className="flex flex-wrap justify-center gap-2">
                          {mobile && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSidebar(true)}
                            >
                              打开会话列表
                            </Button>
                          )}
                          {mobile && state.workspaceId && (
                            <Button
                              size="sm"
                              disabled={
                                creating || state.connection !== "connected"
                              }
                              onClick={() => void create()}
                            >
                              新建会话
                            </Button>
                          )}
                          {state.slots.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                state.setSlots(
                                  state.slots.filter((_, i) => i !== index),
                                );
                                setMaximized(null);
                              }}
                            >
                              关闭空视口
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </ResizableViewportGrid>
          )}
        </main>
        {sidebar && (
          <>
            {!mobile && (
              <button
                type="button"
                className="agent-sidebar-resize"
                aria-label="调整会话侧栏宽度"
                onDoubleClick={() => {
                  setSidebarWidth(236);
                  localStorage.setItem("codev.agent.sidebar.width", "236");
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  const start = event.clientX;
                  const original = sidebarWidth;
                  const node = event.currentTarget;
                  node.setPointerCapture(event.pointerId);
                  const move = (e: PointerEvent) =>
                    setSidebarWidth(
                      Math.max(
                        180,
                        Math.min(420, original + start - e.clientX),
                      ),
                    );
                  const end = () => {
                    node.removeEventListener("pointermove", move);
                    node.removeEventListener("pointerup", end);
                    node.removeEventListener("pointercancel", end);
                  };
                  node.addEventListener("pointermove", move);
                  node.addEventListener("pointerup", end, { once: true });
                  node.addEventListener("pointercancel", end, { once: true });
                }}
              />
            )}
            <div
              className="agent-sidebar-container"
              style={mobile ? undefined : { width: sidebarWidth }}
            >
              <AgentSidebar
                onAdd={() => void addDirectory().catch(report)}
                onSelect={mobile ? () => setSidebar(false) : undefined}
                onViewportHover={state.slots.length > 1 ? setHover : undefined}
              />
            </div>
          </>
        )}
      </div>
      {!mobile && (
        <AgentSettings open={settings} onClose={() => setSettings(false)} />
      )}
    </section>
  );
}
