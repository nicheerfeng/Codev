import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import {
  moveDisplayedItem,
  promoteLiveOrder,
} from "@/modules/plugins/sidebarOrder";
import { useAgentStore } from "./store";
import { HarnessIcon } from "./HarnessIcon";
import { isBusy, statusLabel, type SessionSummary, type SessionView } from "./types";

const WS_ORDER_KEY = "codev.agent.workspaceOrder";
const SESSION_ORDER_KEY = "codev.agent.sessionOrder";

function readOrder(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function saveOrder(key: string, order: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(order));
  } catch {
    /* optional UI order */
  }
}

function exportSessionMarkdown(view: SessionView | undefined, summary: SessionSummary) {
  const title = (summary.title || "session").replace(/[\\/:*?"<>|]+/g, "_");
  const lines: string[] = [`# ${summary.title || "Agent 会话"}`, ""];
  for (const m of view?.messages ?? []) {
    if (m.kind === "message") {
      lines.push(`## ${m.role === "user" ? "用户" : "助手"}`);
      if (m.thinking) lines.push(`<details><summary>思考</summary>\n\n${m.thinking}\n\n</details>`);
      if (m.text) lines.push(m.text);
      lines.push("");
    } else if (m.kind === "toolCall") {
      lines.push(`- [工具] ${m.toolName} (${m.status})`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function AgentSidebar({
  onAdd,
  onSelect,
}: {
  onAdd?: () => void;
  onSelect?: () => void;
}) {
  const {
    workspaces,
    sessions,
    views,
    selected,
    workspaceId,
    harnesses,
    unread,
    mobile,
    projectHarnesses,
  } = useAgentStore();
  const [search, setSearch] = useState("");
  const [archive, setArchive] = useState(false);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [projectLimit, setProjectLimit] = useState(12);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [wsOrder, setWsOrder] = useState<string[]>(() => readOrder(WS_ORDER_KEY));
  const [sessionOrder, setSessionOrder] = useState<string[]>(() =>
    readOrder(SESSION_ORDER_KEY),
  );
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const dragState = useRef<{
    kind: "workspace" | "session";
    id: string;
    pointer: number;
    y: number;
    x: number;
    moving: boolean;
    target: HTMLElement;
  } | null>(null);
  const suppressClick = useRef(false);

  const report = useAgentStore.getState().report;
  const refreshSessions = () => {
    if (refreshing) return;
    setRefreshing(true);
    void useAgentStore.getState().command("workspace.sessions.refresh")
      .catch(report)
      .finally(() => setRefreshing(false));
  };
  const command = (op: string, value: unknown, id: string) =>
    void useAgentStore.getState().command(op, value, id).catch(report);

  const removeWorkspace = (workspaceId: string, title: string) => {
    if (!window.confirm(`从 Agent 工作区移除项目“${title}”？`)) return;
    void useAgentStore.getState()
      .command("workspace.remove", { workspaceId })
      .catch(report);
  };

  useEffect(() => {
    if (workspaceId) {
      setExpanded((prev) =>
        prev[workspaceId] ? prev : { ...prev, [workspaceId]: true },
      );
    }
  }, [workspaceId]);

  // Promote live running workspaces/sessions gently without jumping while dragging
  const liveSessionIds = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => isBusy(s))
        .map((s) => s.id),
    [sessions],
  );
  useEffect(() => {
    if (!liveSessionIds.length) return;
    setSessionOrder((prev) => {
      const base = [
        ...new Set([...prev, ...Object.keys(sessions)]),
      ];
      const next = promoteLiveOrder(base, liveSessionIds);
      saveOrder(SESSION_ORDER_KEY, next);
      return next;
    });
  }, [liveSessionIds, sessions]);

  const choose = (session: SessionSummary) => {
    void useAgentStore.getState().select(session.id).catch(report);
    onSelect?.();
  };

  const rows = useMemo(() => {
    const rank = new Map(sessionOrder.map((id, idx) => [id, idx]));
    return Object.values(sessions)
      .filter(
        (s) =>
          s.archived === archive &&
          `${s.title} ${s.preview ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (rank.has(a.id) && rank.has(b.id)
            ? (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)
            : b.updatedAt - a.updatedAt),
      );
  }, [sessions, archive, search, sessionOrder]);

  const latest = (workspace: string) =>
    rows
      .filter((row) => row.workspaceId === workspace)
      .reduce((value, row) => Math.max(value, row.updatedAt), 0);

  const projectRows = useMemo(() => {
    const rank = new Map(wsOrder.map((id, idx) => [id, idx]));
    const query = search.trim().toLowerCase();
    return workspaces
      .filter(
        (workspace) =>
          !query ||
          workspace.title.toLowerCase().includes(query) ||
          workspace.cwd.toLowerCase().includes(query) ||
          rows.some((row) => row.workspaceId === workspace.id),
      )
      .sort((a, b) => {
        if (rank.has(a.id) && rank.has(b.id)) {
          return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
        }
        return latest(b.id) - latest(a.id) || a.title.localeCompare(b.title);
      });
  }, [workspaces, rows, search, wsOrder]);

  const startPointerReorder = (
    event: ReactPointerEvent<HTMLElement>,
    kind: "workspace" | "session",
    id: string,
  ) => {
    if (mobile || event.button !== 0 || renaming) return;
    suppressClick.current = false;
    dragState.current = {
      kind,
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moving: false,
      target: event.currentTarget,
    };
  };

  const movePointerReorder = (event: ReactPointerEvent<HTMLElement>) => {
    const cur = dragState.current;
    if (!cur || cur.pointer !== event.pointerId) return;
    if (!cur.moving && Math.hypot(event.clientX - cur.x, event.clientY - cur.y) < 6) {
      return;
    }
    if (!cur.moving) {
      cur.moving = true;
      suppressClick.current = true;
      cur.target.setPointerCapture(event.pointerId);
    }
  };

  const endPointerReorder = (event: ReactPointerEvent<HTMLElement>) => {
    const cur = dragState.current;
    dragState.current = null;
    if (cur?.target.hasPointerCapture(cur.pointer)) {
      cur.target.releasePointerCapture(cur.pointer);
    }
    if (!cur?.moving) return;

    const hitEl = document.elementFromPoint(event.clientX, event.clientY);
    if (cur.kind === "session") {
      const vp = hitEl?.closest<HTMLElement>("[data-agent-viewport-index]");
      if (vp) {
        const vpIdx = Number(vp.dataset.agentViewportIndex);
        if (Number.isFinite(vpIdx) && vpIdx >= 0) {
          void useAgentStore.getState().select(cur.id, vpIdx).catch(report);
          onSelect?.();
          return;
        }
      }
      const targetRow = hitEl?.closest<HTMLElement>("[data-agent-session-row]");
      const targetId = targetRow?.dataset.agentSessionRow;
      if (targetId && targetId !== cur.id) {
        const visibleIds = rows.map((r) => r.id);
        const base = [...new Set([...sessionOrder, ...Object.keys(sessions)])];
        const rect = targetRow!.getBoundingClientRect();
        const gap =
          visibleIds.indexOf(targetId) +
          (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
        const next = moveDisplayedItem(base, visibleIds, cur.id, gap);
        setSessionOrder(next);
        saveOrder(SESSION_ORDER_KEY, next);
      }
    } else if (cur.kind === "workspace") {
      const targetWs = hitEl?.closest<HTMLElement>("[data-agent-workspace-id]");
      const targetId = targetWs?.dataset.agentWorkspaceId;
      if (targetId && targetId !== cur.id) {
        const visibleIds = projectRows.map((w) => w.id);
        const base = [...new Set([...wsOrder, ...workspaces.map((w) => w.id)])];
        const rect = targetWs!.getBoundingClientRect();
        const gap =
          visibleIds.indexOf(targetId) +
          (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
        const next = moveDisplayedItem(base, visibleIds, cur.id, gap);
        setWsOrder(next);
        saveOrder(WS_ORDER_KEY, next);
      }
    }
  };

  return (
    <aside className="agent-sidebar">
      <div className="agent-sidebar-search">
        <Input
          placeholder="搜索项目与会话"
          aria-label="搜索项目与会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 rounded-lg text-xs!"
        />
      </div>
      <div className="agent-sidebar-root">
        <span>项目 ({workspaces.length})</span>
        <span className="flex-1" />
        <button type="button" title="刷新会话" aria-label="刷新会话" disabled={refreshing} onClick={refreshSessions}>
          <HugeiconsIcon icon={Refresh01Icon} size={14} />
        </button>
        {!mobile && (
          <button type="button" title="添加工作目录" onClick={onAdd}>
            ＋
          </button>
        )}
      </div>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto">
        {projectRows
          .slice(0, search ? projectRows.length : projectLimit)
          .map((workspace) => {
            const list = rows.filter((s) => s.workspaceId === workspace.id);
            const runCount = list.filter((s) => isBusy(s)).length;
            const isOpen = !!search || (expanded[workspace.id] ?? workspace.id === workspaceId);
            const visible = isOpen ? list.slice(0, limits[workspace.id] ?? 40) : [];
            return (
              <section
                className="agent-project"
                key={workspace.id}
                data-agent-workspace-id={workspace.id}
              >
                <ContextMenu>
                <ContextMenuTrigger asChild><div
                  className={`agent-project-heading ${workspace.id === workspaceId ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="w-3 shrink-0 text-[10px] opacity-70"
                    aria-label={isOpen ? "折叠项目" : "展开项目"}
                    onClick={() => {
                      if (!isOpen) refreshSessions();
                      setExpanded((prev) => ({
                        ...prev,
                        [workspace.id]: !isOpen,
                      }));
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    title={`${workspace.cwd}\n可按住拖拽排序`}
                    onPointerDown={(e) =>
                      startPointerReorder(e, "workspace", workspace.id)
                    }
                    onPointerMove={movePointerReorder}
                    onPointerUp={endPointerReorder}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      useAgentStore.getState().setWorkspace(workspace.id);
                      setExpanded((prev) => ({ ...prev, [workspace.id]: true }));
                    }}
                  >
                    {workspace.title}
                  </button>
                  {runCount > 0 && (
                    <span className="agent-ws-running" title={`${runCount} 个任务运行中`}>
                      {runCount}
                    </span>
                  )}
                  {!mobile && <div className="agent-project-actions">
                    {(projectHarnesses[workspace.id] ?? ["pi", "acp:codex", "acp:antigravity"]).map((id) => {
                      const harness = harnesses.find((item) => item.id === id);
                      if (!harness) return null;
                      return <button type="button" key={id} disabled={creating} title={`使用 ${harness.displayName} 新建线程`} aria-label={`在 ${workspace.title} 使用 ${harness.displayName} 新建线程`} onClick={() => {
                        setExpanded((prev) => ({ ...prev, [workspace.id]: true }));
                        setCreating(true);
                        void useAgentStore.getState().createSession(workspace.id, id).catch(report).finally(() => setCreating(false));
                      }}><HarnessIcon harnessId={id} harness={harness} /></button>;
                    })}
                    <button type="button" title={`移除项目 ${workspace.title}`} aria-label={`移除项目 ${workspace.title}`} onClick={() => removeWorkspace(workspace.id, workspace.title)}><HugeiconsIcon icon={Cancel01Icon} size={14} /></button>
                  </div>}
                </div></ContextMenuTrigger>
                {!mobile && <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void revealItemInDir(workspace.cwd).catch(report)}>在目录中显示</ContextMenuItem>
                  <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(workspace.cwd).then(() => toast.success("已复制工作区路径")).catch(report)}>复制路径</ContextMenuItem>
                  <ContextMenuItem onSelect={() => removeWorkspace(workspace.id, workspace.title)}>从工作区移除</ContextMenuItem>
                </ContextMenuContent>}
                </ContextMenu>
                {!list.length && isOpen && (
                  <p className="agent-sidebar-empty">
                    {archive ? "暂无归档会话" : "暂无会话"}
                  </p>
                )}
                {visible.map((session) => (
                  <ContextMenu key={session.id}><ContextMenuTrigger asChild><div
                    className={`agent-session-row ${session.id === selected ? "is-selected" : ""}`}
                    data-agent-session-row={session.id}
                  >
                    {renaming === session.id ? (
                      <form
                        className="flex min-w-0 flex-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          command("session.rename", { title: name }, session.id);
                          setRenaming(null);
                        }}
                      >
                        <Input
                          autoFocus
                          aria-label="重命名会话"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          onBlur={() => setRenaming(null)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          className="h-6 text-xs!"
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="agent-session-select"
                        onPointerDown={(e) =>
                          startPointerReorder(e, "session", session.id)
                        }
                        onPointerMove={movePointerReorder}
                        onPointerUp={endPointerReorder}
                        onDoubleClick={() => {
                          setRenaming(session.id);
                          setName(session.title);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "F2") {
                            e.preventDefault();
                            setRenaming(session.id);
                            setName(session.title);
                          }
                        }}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          choose(session);
                        }}
                        title={`${session.title}\n${harnesses.find((h) => h.id === session.harnessId)?.displayName ?? session.harnessId} · ${statusLabel(session.state)}\n可拖拽排序或拖入视口；双击或 F2 重命名`}
                      >
                        <span
                          className={`agent-state-dot ${isBusy(session) ? "is-working" : unread.includes(session.id) ? "is-unread" : ""}`}
                        />
                        <HarnessIcon
                          harnessId={session.harnessId}
                          harness={harnesses.find((h) => h.id === session.harnessId)}
                          readOnly={session.readOnly}
                          size={14}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {session.pinned ? "· " : ""}
                          {session.title || "新会话"}
                        </span>
                      </button>
                    )}
                  </div></ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => { setRenaming(session.id); setName(session.title); }}>重命名</ContextMenuItem>
                    {views[session.id]?.capabilities.supportsFork && !session.readOnly && <ContextMenuItem disabled={isBusy(session)} onSelect={() => {
                      void useAgentStore.getState().command<SessionView>("session.fork", {}, session.id).then((view) => {
                        useAgentStore.setState((state) => ({ sessions: { ...state.sessions, [view.id]: view }, views: { ...state.views, [view.id]: view } }));
                        return useAgentStore.getState().select(view.id);
                      }).catch(report);
                    }}>分叉线程</ContextMenuItem>}
                    <ContextMenuItem onSelect={() => command("session.pin", { value: !session.pinned }, session.id)}>{session.pinned ? "取消置顶" : "置顶"}</ContextMenuItem>
                    <ContextMenuItem disabled={isBusy(session)} onSelect={() => command("session.archive", { value: !session.archived }, session.id)}>{session.archived ? "恢复到列表" : "归档"}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => exportSessionMarkdown(views[session.id], session)}>导出 Markdown</ContextMenuItem>
                    {!mobile && <>
                      <ContextMenuItem onSelect={() => command("session.close", isBusy(session) ? { force: true } : {}, session.id)}>{isBusy(session) ? "强制断开并终止任务" : "断开代理进程"}</ContextMenuItem>
                      <ContextMenuItem disabled={isBusy(session)} onSelect={() => command("session.delete", { removeFromCodev: true }, session.id)}>从列表移除</ContextMenuItem>
                    </>}
                  </ContextMenuContent></ContextMenu>
                ))}
                {isOpen && list.length > visible.length && (
                  <button
                    type="button"
                    className="agent-sidebar-empty"
                    onClick={() =>
                      setLimits((s) => ({
                        ...s,
                        [workspace.id]: (s[workspace.id] ?? 40) + 40,
                      }))
                    }
                  >
                    显示更多（还有 {list.length - visible.length} 条）
                  </button>
                )}
              </section>
            );
          })}
        {!search && projectRows.length > projectLimit && (
          <button
            type="button"
            className="agent-sidebar-empty"
            onClick={() => setProjectLimit(projectLimit + 12)}
          >
            显示更多项目（{projectRows.length - projectLimit}）
          </button>
        )}
        {!workspaces.length && (
          <div className="agent-sidebar-empty">
            {mobile
              ? "请先在桌面添加工作目录。"
              : "添加工作目录。"}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        className="agent-archive-toggle"
        onClick={() => setArchive(!archive)}
      >
        {archive ? "返回会话" : "已归档"}{" "}
        <span>{Object.values(sessions).filter((s) => s.archived).length}</span>
      </Button>

    </aside>
  );
}
