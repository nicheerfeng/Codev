import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GridViewIcon,
  LayoutRightIcon,
  Search01Icon,
  Folder01Icon,
  Cancel01Icon,
  Maximize01Icon,
  Minimize01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uiState } from "@/lib/uiState";
import { CodexClient, onCodexTurnFinished } from "./client";
import { speakFinalIfEnabled } from "@/modules/plugins/codex-agent/voice/output";
import { Approval, Title, Tool } from "./controls";
import { CodexComposer } from "./CodexComposer";
import { parentThread } from "./subagents";
import { CodexSidebar } from "./CodexSidebar";
import { CodexTranscript } from "./CodexTranscript";
import { CodexResources } from "./CodexResources";
import "./codex.css";
import { useCodexComposerDropStore } from "./codexComposerDropStore";
import { useCodexComposerNativeDrop } from "./codexComposerDrop";
import { ingestPaths } from "./attachments";
import { notifyFinishedThread } from "./codexNotify";
import { itemText } from "./protocol";
import { watchHistory } from "./historyWatch";
import { WorkbenchContent } from "../workbench/WorkbenchContent";
import { useWorkbench } from "../workbench/store";
import { ResizableViewportGrid } from "@/components/ResizableViewportGrid";

/** 只恢复视口数量；启动不读取旧会话，等待用户选择。 */
function readSlots(): (string | null)[] {
  try {
    const saved: unknown = JSON.parse(
      uiState.getItem("codev.codex.slots") ?? "null",
    );
    if (Array.isArray(saved) && saved.length) {
      return saved.slice(0, 6).map(() => null);
    }
  } catch {
    /* 首次启动采用单视口。 */
  }
  return [null];
}

/** 独立 Codex 插件入口，隐藏时保活，禁用时释放自身进程。 */
export function CodexPane({
  active = true,
  onOpenFile,
  onOpenDiff,
  workspaceRoots = [],
  onAddWorkspaceRoot,
}: {
  active?: boolean;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
  workspaceRoots?: string[];
  onAddWorkspaceRoot?: (path: string) => void;
}) {
  const [client] = useState(() => new CodexClient());
  const disposal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(disposal.current);
    void client.connect();
    return () => {
      disposal.current = setTimeout(() => {
        void client.dispose().catch((error) => console.error(error));
      }, 0);
    };
  }, [client]);
  return (
    <Workspace
      active={active}
      client={client}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
      workspaceRoots={workspaceRoots}
      onAddWorkspaceRoot={onAddWorkspaceRoot}
    />
  );
}

/** 沿用 Pi 的整页顶部工具栏、右侧线程栏及最多六个并行视口。 */
function Workspace({
  active,
  client,
  onOpenFile,
  onOpenDiff,
  workspaceRoots,
  onAddWorkspaceRoot,
}: {
  active: boolean;
  client: CodexClient;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string, diff: string) => void;
  workspaceRoots: string[];
  onAddWorkspaceRoot?: (path: string) => void;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const hasSelectedHistory = state.order.length > 0;
  useEffect(() => {
    if (!hasSelectedHistory) return;
    return watchHistory(client, (error) =>
      console.error("Codex 历史监听", error),
    );
  }, [client, hasSelectedHistory]);
  useEffect(() => {
    return onCodexTurnFinished((sessionId, turn) => {
      const session = client.getSnapshot().sessions[sessionId];
      if (!session) return;
      void notifyFinishedThread({
        thread: {
          cwd: session.thread.cwd,
          name: session.thread.name,
          summary: turn.items
            .filter((item) => item.type === "agentMessage")
            .map(itemText)
            .join("\n"),
        },
        outcome: turn.status,
        codexActive: active,
      });
    });
  }, [client, active]);
  const [slots, setSlots] = useState(readSlots);
  const [focused, setFocused] = useState(0);
  const [maximizedViewport, setMaximizedViewport] = useState<number | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(
    () => uiState.getItem("codev.codex.sidebar.collapsed") === "true",
  );
  const [width, setWidth] = useState(() =>
    Math.max(120, Number(uiState.getItem("codev.codex.sidebar.width")) || 236),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const workbenchSlots = useWorkbench((state) => state.slots);
  const workbenchTargets = useWorkbench((state) => state.targets);
  const collected = workbenchSlots
    .filter((source) => source?.kind === "codex")
    .map((source) => source!.id);
  const renderSlots = [
    ...slots,
    ...collected.filter((id) => !slots.includes(id)),
  ];
  const selected = slots[focused] ?? null;
  const current = selected ? state.sessions[selected] : undefined;
  const multi = slots.length > 1;
  const viewportColumns =
    viewportWidth >= 1200 && slots.length > 1
      ? Math.min(3, slots.length)
      : slots.length > 4
        ? 3
        : multi
          ? 2
          : 1;
  const viewportRows = Math.ceil(slots.length / viewportColumns);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换线程或提交输入后退出旧的搜索定位。
  useEffect(() => {
    setSearch("");
  }, [selected, current?.sendRevision]);
  const knownSessions = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!state.connected || state.loading) return;
    const removed = new Set(
      [...knownSessions.current].filter((id) => !state.sessions[id]),
    );
    knownSessions.current = new Set(Object.keys(state.sessions));
    for (const id of removed) useWorkbench.getState().release("codex", id);
    setSlots((currentSlots) =>
      currentSlots.some((id) => id && removed.has(id))
        ? currentSlots.map((id) => (id && removed.has(id) ? null : id))
        : currentSlots,
    );
  }, [state.sessions, state.connected, state.loading]);
  /** 文件异步读入使用落点 id，切换焦点不会改变目标。 */
  const drop = (
    items: Array<{ path: string; kind: "file" | "dir" }>,
    id?: string,
  ) => {
    if (id)
      void ingestPaths(client, id, items).catch((error) =>
        toast.error(String(error)),
      );
  };
  useEffect(() => {
    const store = useCodexComposerDropStore.getState();
    store.setActive(active);
    store.setDrop(drop);
    return () => {
      store.setActive(false);
      store.setDrop(null);
      store.setHover(false);
    };
  }, [active, client]);
  useCodexComposerNativeDrop({
    active: () => active,
    onDrop: drop,
    onHover: (hover, id) =>
      useCodexComposerDropStore.getState().setHover(hover, id),
  });
  useEffect(() => {
    return onCodexTurnFinished((sessionId, turn) => {
      if (turn.status !== "completed") return;
      const text = turn.items
        .filter((item) => item.type === "agentMessage")
        .map(itemText)
        .join("\n")
        .trim();
      if (!text) return;
      void speakFinalIfEnabled(text, `${sessionId}:${turn.id}`).catch((error) =>
        console.error("Codex 语音播放失败", error),
      );
    });
  }, []);
  useEffect(() => {
    client.setMulti(multi);
  }, [multi, client]);
  useEffect(() => {
    uiState.setItem("codev.codex.slots", JSON.stringify(slots));
  }, [slots]);
  useEffect(() => {
    uiState.setItem("codev.codex.sidebar.collapsed", String(collapsed));
  }, [collapsed]);
  useEffect(() => {
    uiState.setItem("codev.codex.sidebar.width", String(width));
  }, [width]);
  /** 点击按顺序补空位，只有明确拖入目标才替换或交换。 */
  const place = (id: string, target?: number) => {
    id = client.sessionKey(id);
    const previous = slots.indexOf(id);
    const index =
      target ?? (previous >= 0 ? previous : multi ? slots.indexOf(null) : 0);
    if (index < 0) {
      toast.info("建议拖拽覆盖已有窗口或者新开窗口");
      return false;
    }
    const replaced = slots[index];
    if (replaced && replaced !== id && previous < 0)
      client.discardDraft(replaced);
    setFocused(index);
    setSlots((currentSlots) => {
      const next = [...currentSlots];
      const from = next.indexOf(id);
      if (from >= 0 && from !== index) next[from] = next[index];
      next[index] = id;
      return next;
    });
    void client.load(id).catch((error) => {
      client.patch(id, { error: String(error) });
      toast.error(String(error));
    });
    return true;
  };
  /** 空视口选择目录只加载关联历史，新对话由独立新建入口创建。 */
  const chooseProject = async () => {
    const cwd = await open({ directory: true });
    if (!cwd) return;
    setCollapsed(false);
    try {
      await client.refreshProject(cwd);
    } catch (error) {
      toast.error(String(error));
    }
  };
  /** 明确选择工作目录后新建线程，不发送模型请求。 */
  const create = async (cwd?: string) => {
    if (multi && !slots.includes(null)) {
      toast.info("建议关闭已有窗口或者新开窗口");
      return false;
    }
    setCreating(true);
    try {
      const path = cwd ?? (await open({ directory: true }));
      if (path) {
        const id = await client.create(path);
        if (place(id)) return true;
        client.discardDraft(id);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCreating(false);
    }
    return false;
  };
  /** 清空单个视口内容，格子数量不变。 */
  const close = (index: number) => {
    setMaximizedViewport(null);
    const closing = slots[index];
    if (closing) client.discardDraft(closing);
    setSlots((currentSlots) =>
      currentSlots.map((id, i) => (i === index ? null : id)),
    );
  };
  return (
    <section
      className="codex-workspace"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
        }
      }}
    >
      <header className="codex-header">
        <Button
          variant="ghost"
          size="icon-sm"
          title="搜索当前线程"
          aria-label="搜索当前线程"
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <HugeiconsIcon icon={Search01Icon} size={15} />
        </Button>
        <div className="codex-header-title">
          {current ? <Title session={current} client={client} /> : "Codex"}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CodexResources client={client} state={state} active={active}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={multi ? "退出多视口" : "多视口"}
              title={multi ? "退出多视口" : "多视口"}
              aria-pressed={multi}
              disabled={state.switching}
              onClick={() => {
                setMaximizedViewport(null);
                setSlots(multi ? [selected] : [selected, null]);
                setFocused(0);
              }}
            >
              <HugeiconsIcon icon={GridViewIcon} size={14} />
            </Button>
            {multi && (
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5"
                  aria-label="减少视口"
                  title="减少最后一个视口"
                  disabled={slots.length <= 2}
                  onClick={() => {
                    if (slots.length <= 2) return;
                    setMaximizedViewport(null);
                    setSlots(slots.slice(0, -1));
                    setFocused((current) =>
                      Math.min(current, slots.length - 2),
                    );
                  }}
                >
                  <HugeiconsIcon icon={MinusSignIcon} size={12} />
                </Button>
                <span className="w-6 text-center text-[10px] leading-none text-muted-foreground">
                  {slots.length}/6
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5"
                  aria-label="增加视口"
                  title="增加 Codex 视口"
                  disabled={slots.length >= 6}
                  onClick={() => {
                    if (slots.length >= 6) {
                      toast.info("最多支持 6 个视口");
                      return;
                    }
                    setSlots([...slots, null]);
                    setFocused(slots.length);
                  }}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={12} />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={collapsed ? "展开线程栏" : "收起线程栏"}
              title={collapsed ? "展开线程栏" : "收起线程栏"}
              onClick={() => setCollapsed(!collapsed)}
            >
              <HugeiconsIcon icon={LayoutRightIcon} size={16} />
            </Button>
          </CodexResources>
        </div>
      </header>
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1">
          <Input
            aria-label="搜索对话内容"
            placeholder="搜索当前线程"
            className="h-7 text-xs!"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Tool
            icon={Cancel01Icon}
            label="关闭搜索"
            onClick={() => {
              setSearchOpen(false);
              setSearch("");
            }}
          />
        </div>
      )}
      {state.error && (
        <div role="alert" className="codex-error">
          {state.error}
          {!state.connected && (
            <Button
              size="xs"
              variant="outline"
              disabled={state.loading}
              onClick={() => void client.connect()}
            >
              重新连接
            </Button>
          )}
        </div>
      )}
      <div className="codex-body">
        <ResizableViewportGrid
          className={`min-h-0 min-w-0 flex-1 !overflow-auto ${multi ? "codex-multi" : ""}`}
          columns={viewportColumns}
          rows={viewportRows}
          positions={renderSlots.map((_, index) =>
            index >= slots.length ||
            (maximizedViewport !== null && index !== maximizedViewport)
              ? null
              : {
                  column:
                    maximizedViewport !== null ? 0 : index % viewportColumns,
                  row:
                    maximizedViewport !== null
                      ? 0
                      : Math.floor(index / viewportColumns),
                },
          )}
          onWidthChange={setViewportWidth}
        >
          {renderSlots.map((id, index) => {
            const session = id ? state.sessions[id] : null;
            return (
              <section
                key={id ?? `empty-${index}`}
                data-codex-slot={index}
                data-codex-viewport-key={id ?? ""}
                className={`codex-slot ${focused === index ? "codex-focused" : ""} ${hover === index ? "codex-drop-target" : ""}`}
                onPointerDown={() => {
                  if (index < slots.length) setFocused(index);
                }}
                onFocusCapture={() => {
                  if (index < slots.length) setFocused(index);
                }}
              >
                {session ? (
                  <WorkbenchContent
                    source={{ kind: "codex", id: id!, title: "Codex" }}
                  >
                    <div className="codex-viewport">
                      {multi && index < slots.length && (
                        <header className="codex-viewport-header">
                          <Title session={session} client={client} />
                          <Tool
                            icon={
                              maximizedViewport === index
                                ? Minimize01Icon
                                : Maximize01Icon
                            }
                            label={
                              maximizedViewport === index
                                ? "还原视口"
                                : "放大视口"
                            }
                            onClick={() =>
                              setMaximizedViewport(
                                maximizedViewport === index ? null : index,
                              )
                            }
                          />
                          <Tool
                            icon={Cancel01Icon}
                            label="关闭视口"
                            onClick={() => close(index)}
                          />
                        </header>
                      )}
                      <CodexTranscript
                        active={
                          active &&
                          (index < slots.length ||
                            !!workbenchTargets[`codex:${id}`])
                        }
                        onFork={place}
                        session={session}
                        client={client}
                        search={focused === index && searchOpen ? search : ""}
                        onOpenFile={onOpenFile}
                        onOpenDiff={onOpenDiff}
                      />
                      {!!session.requests.length && (
                        <div className="codex-approvals reader-scrollbar">
                          {session.requests.map((request) => (
                            <Approval
                              key={request.id}
                              request={request}
                              sessionId={session.thread.id}
                              client={client}
                            />
                          ))}
                        </div>
                      )}
                      {parentThread(session.thread) ? (
                        <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                          子代理由主线程调度，无法直接输入
                        </p>
                      ) : (
                        <CodexComposer
                          onSelect={place}
                          onNew={create}
                          session={session}
                          client={client}
                          models={state.models}
                          connected={state.connected && !state.switching}
                        />
                      )}
                    </div>
                  </WorkbenchContent>
                ) : (
                  <div className="codex-empty">
                    {multi && (
                      <>
                        <span className="text-xs text-muted-foreground">
                          视口 {index + 1}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground"
                          onClick={() => setFocused(index)}
                        >
                          从右侧拖入会话
                          <br />
                          或点击此处后在侧栏选择
                        </button>
                      </>
                    )}
                    {multi && (
                      <div className="absolute top-1 right-1 flex gap-1">
                        <Tool
                          icon={
                            maximizedViewport === index
                              ? Minimize01Icon
                              : Maximize01Icon
                          }
                          label={
                            maximizedViewport === index
                              ? "还原视口"
                              : "放大视口"
                          }
                          onClick={() =>
                            setMaximizedViewport(
                              maximizedViewport === index ? null : index,
                            )
                          }
                        />
                        <Tool
                          icon={Cancel01Icon}
                          label="关闭视口"
                          onClick={() => close(index)}
                        />
                      </div>
                    )}
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={24}
                      className="text-muted-foreground/50"
                    />
                    {state.loading ? (
                      <p className="text-muted-foreground">正在连接 Codex...</p>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!state.connected || creating}
                        onClick={() => void chooseProject()}
                      >
                        <HugeiconsIcon icon={Folder01Icon} size={14} />
                        选择项目
                      </Button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </ResizableViewportGrid>
        {!collapsed && (
          <CodexSidebar
            client={client}
            state={state}
            selected={selected}
            onSelect={place}
            onNew={(cwd) => void create(cwd)}
            onDrop={place}
            onHover={setHover}
            width={width}
            onWidth={setWidth}
            workspaceRoots={workspaceRoots}
            onAddWorkspaceRoot={onAddWorkspaceRoot}
          />
        )}
      </div>
    </section>
  );
}
