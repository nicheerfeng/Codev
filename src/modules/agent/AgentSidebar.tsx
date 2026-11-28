import {
  STORAGE_KEYS,
  readJson,
  writeJson,
} from "@/lib/clientStorage";
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
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  Layers01Icon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import {
  moveDisplayedItem,
  promoteLiveOrder,
} from "@/modules/plugins/sidebarOrder";
import { useAgentStore } from "./store";
import { ArchivedSessionsSection } from "./ArchivedSessionsSection";
import { HarnessIcon } from "./HarnessIcon";
import {
  isBusy,
  statusLabel,
  type SessionSummary,
  type SessionView,
} from "./types";

const WS_ORDER_KEY = STORAGE_KEYS.agentWorkspaceOrder;
const SESSION_ORDER_KEY = STORAGE_KEYS.agentSessionOrder;
const ORGANIZATION_KEY = STORAGE_KEYS.agentProjectOrganization;
const SESSION_PAGE = 5;
const SESSION_MORE = 50;

type Organization = {
  groups: Array<{ id: string; name: string }>;
  projectGroups: Record<string, string>;
};

function readOrganization(): Organization {
  const value = readJson<Record<string, unknown>>(ORGANIZATION_KEY, {});
  return {
    groups: Array.isArray(value.groups)
      ? value.groups.filter(
          (group: unknown): group is { id: string; name: string } =>
            typeof group === "object" &&
            group !== null &&
            typeof (group as { id?: unknown }).id === "string" &&
            typeof (group as { name?: unknown }).name === "string",
        )
      : [],
    projectGroups:
      value.projectGroups &&
      typeof value.projectGroups === "object" &&
      !Array.isArray(value.projectGroups)
        ? (value.projectGroups as Record<string, string>)
        : {},
  };
}

function readOrder(key: string): string[] {
  const raw = readJson<unknown>(key, []);
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : [];
}

function saveOrder(key: string, order: string[]) {
  writeJson(key, order);
}

function exportSessionMarkdown(
  view: SessionView | undefined,
  summary: SessionSummary,
) {
  const title = (summary.title || "session").replace(/[\\/:*?"<>|]+/g, "_");
  const lines: string[] = [`# ${summary.title || "Agent 会话"}`, ""];
  for (const m of view?.messages ?? []) {
    if (m.kind === "message") {
      lines.push(`## ${m.role === "user" ? "用户" : "助手"}`);
      if (m.thinking)
        lines.push(
          `<details><summary>思考</summary>\n\n${m.thinking}\n\n</details>`,
        );
      if (m.text) lines.push(m.text);
      lines.push("");
    } else if (m.kind === "toolCall") {
      lines.push(`- [工具] ${m.toolName} (${m.status})`);
    }
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/markdown;charset=utf-8",
  });
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
  onViewportHover,
}: {
  onAdd?: () => void;
  onSelect?: () => void;
  onViewportHover?: (index: number | null) => void;
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
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [wsOrder, setWsOrder] = useState<string[]>(() =>
    readOrder(WS_ORDER_KEY),
  );
  const [sessionOrder, setSessionOrder] = useState<string[]>(() =>
    readOrder(SESSION_ORDER_KEY),
  );
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [organization, setOrganization] =
    useState<Organization>(readOrganization);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [groupEdit, setGroupEdit] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    kind: "workspace" | "session";
    id: string;
    after: boolean;
  } | null>(null);
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownLive = useRef<Set<string> | null>(null);
  const knownSessions = useRef<Set<string> | null>(null);

  const updateOrganization = (next: Organization) => {
    setOrganization(next);
    writeJson(ORGANIZATION_KEY, next);
  };
  useEffect(
    () => () => {
      if (selectTimer.current) clearTimeout(selectTimer.current);
    },
    [],
  );
  useEffect(() => {
    const ids = Object.keys(sessions);
    if (!ids.length) return;
    const previous = knownSessions.current;
    knownSessions.current = new Set(ids);
    const added = Object.values(sessions)
      .filter((session) => !previous || !previous.has(session.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => session.id);
    if (!added.length) return;
    setSessionOrder((current) => {
      const unseen = added.filter((id) => !current.includes(id));
      const next = previous ? [...unseen, ...current] : [...current, ...unseen];
      saveOrder(SESSION_ORDER_KEY, next);
      return next;
    });
  }, [sessions]);
  useEffect(() => {
    if (!workspaces.length) return;
    setWsOrder((current) => {
      const unseen = workspaces
        .filter((workspace) => !current.includes(workspace.id))
        .map((workspace) => workspace.id);
      if (!unseen.length) return current;
      const next = [...current, ...unseen];
      saveOrder(WS_ORDER_KEY, next);
      return next;
    });
  }, [workspaces]);

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
    void useAgentStore
      .getState()
      .command("workspace.sessions.refresh")
      .catch(report)
      .finally(() => setRefreshing(false));
  };
  const command = (op: string, value: unknown, id: string) =>
    void useAgentStore.getState().command(op, value, id).catch(report);

  const removeWorkspace = (workspaceId: string, title: string) => {
    if (!window.confirm(`从 Agent 工作区移除项目“${title}”？`)) return;
    void useAgentStore
      .getState()
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

  const liveSessionIds = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.state === "working")
        .map((s) => s.id),
    [sessions],
  );
  useEffect(() => {
    if (!Object.keys(sessions).length) return;
    const previous = knownLive.current;
    knownLive.current = new Set(liveSessionIds);
    if (!previous) return;
    const newly = liveSessionIds.filter((id) => !previous.has(id));
    if (!newly.length || dragState.current || renaming || selectTimer.current)
      return;
    setSessionOrder((prev) => {
      const base = [
        ...new Set([
          ...prev,
          ...Object.values(sessions)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((session) => session.id),
        ]),
      ];
      const next = promoteLiveOrder(base, newly);
      saveOrder(SESSION_ORDER_KEY, next);
      return next;
    });
  }, [liveSessionIds, sessions, renaming]);

  const choose = (session: SessionSummary) => {
    void useAgentStore.getState().select(session.id).catch(report);
    onSelect?.();
  };
  const finishRename = (session: SessionSummary) => {
    const title = name.trim();
    setRenaming(null);
    if (title && title !== session.title)
      command("session.rename", { title }, session.id);
  };
  const loadSession = (id: string) =>
    useAgentStore.getState().command<SessionView>("session.open", {}, id);

  const matchesSearch = (s: SessionSummary) =>
    `${s.title} ${s.preview ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()) ||
    workspaces.some(
      (workspace) =>
        workspace.id === s.workspaceId &&
        `${workspace.title} ${workspace.cwd}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );

  const sortSessions = (list: SessionSummary[]) => {
    const rank = new Map(sessionOrder.map((id, idx) => [id, idx]));
    return list.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        b.updatedAt - a.updatedAt,
    );
  };

  const rows = useMemo(
    () =>
      sortSessions(
        Object.values(sessions).filter((s) => !s.archived && matchesSearch(s)),
      ),
    [sessions, search, sessionOrder, workspaces],
  );

  const archivedRows = useMemo(
    () =>
      sortSessions(
        Object.values(sessions).filter((s) => s.archived && matchesSearch(s)),
      ),
    [sessions, search, sessionOrder, workspaces],
  );

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
        return (
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          latest(b.id) - latest(a.id) ||
          a.title.localeCompare(b.title)
        );
      });
  }, [workspaces, rows, search, wsOrder]);

  const startPointerReorder = (
    event: ReactPointerEvent<HTMLElement>,
    kind: "workspace" | "session",
    id: string,
  ) => {
    if (mobile || event.button !== 0 || renaming || archive) return;
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
    if (
      !cur.moving &&
      Math.hypot(event.clientX - cur.x, event.clientY - cur.y) < 6
    ) {
      return;
    }
    if (!cur.moving) {
      if (selectTimer.current) clearTimeout(selectTimer.current);
      selectTimer.current = null;
      cur.moving = true;
      suppressClick.current = true;
      cur.target.setPointerCapture(event.pointerId);
    }
    if (cur.kind === "session" && onViewportHover) {
      const viewport = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-agent-viewport-index]");
      onViewportHover(
        viewport ? Number(viewport.dataset.agentViewportIndex) : null,
      );
    }
    if (search) {
      setDropTarget(null);
      return;
    }
    const selector =
      cur.kind === "session"
        ? "[data-agent-session-row]"
        : "[data-agent-workspace-id]";
    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(selector);
    const id =
      cur.kind === "session"
        ? hit?.dataset.agentSessionRow
        : hit?.dataset.agentWorkspaceId;
    const sameContainer =
      cur.kind === "session"
        ? sessions[id ?? ""]?.workspaceId === sessions[cur.id]?.workspaceId &&
          sessions[id ?? ""]?.pinned === sessions[cur.id]?.pinned
        : (organization.projectGroups[id ?? ""] ?? "") ===
          (organization.projectGroups[cur.id] ?? "");
    if (hit && id && id !== cur.id && sameContainer) {
      const rect = hit.getBoundingClientRect();
      setDropTarget({
        kind: cur.kind,
        id,
        after: event.clientY > rect.top + rect.height / 2,
      });
    } else setDropTarget(null);
  };
  const cancelPointerReorder = () => {
    const current = dragState.current;
    dragState.current = null;
    setDropTarget(null);
    onViewportHover?.(null);
    if (current?.target.hasPointerCapture(current.pointer))
      current.target.releasePointerCapture(current.pointer);
  };

  const endPointerReorder = (event: ReactPointerEvent<HTMLElement>) => {
    const cur = dragState.current;
    dragState.current = null;
    setDropTarget(null);
    onViewportHover?.(null);
    if (cur?.target.hasPointerCapture(cur.pointer)) {
      cur.target.releasePointerCapture(cur.pointer);
    }
    if (!cur?.moving) return;

    const hitEl = document.elementFromPoint(event.clientX, event.clientY);
    if (cur.kind === "session") {
      const vp =
        onViewportHover &&
        hitEl?.closest<HTMLElement>("[data-agent-viewport-index]");
      if (vp) {
        const vpIdx = Number(vp.dataset.agentViewportIndex);
        if (Number.isFinite(vpIdx) && vpIdx >= 0) {
          void useAgentStore.getState().select(cur.id, vpIdx).catch(report);
          onSelect?.();
          return;
        }
      }
      if (search) return;
      const targetRow = hitEl?.closest<HTMLElement>("[data-agent-session-row]");
      const targetId = targetRow?.dataset.agentSessionRow;
      if (targetId && targetId !== cur.id) {
        const workspace = sessions[cur.id]?.workspaceId;
        if (
          !workspace ||
          sessions[targetId]?.workspaceId !== workspace ||
          sessions[targetId]?.pinned !== sessions[cur.id]?.pinned
        )
          return;
        const visibleIds = rows
          .filter((r) => r.workspaceId === workspace)
          .slice(0, search ? undefined : (limits[workspace] ?? SESSION_PAGE))
          .map((r) => r.id);
        const base = [...new Set([...sessionOrder, ...rows.map((r) => r.id)])];
        const rect = targetRow!.getBoundingClientRect();
        const gap =
          visibleIds.indexOf(targetId) +
          (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
        const next = moveDisplayedItem(base, visibleIds, cur.id, gap);
        setSessionOrder(next);
        saveOrder(SESSION_ORDER_KEY, next);
      }
    } else if (cur.kind === "workspace") {
      if (search) return;
      const targetWs = hitEl?.closest<HTMLElement>("[data-agent-workspace-id]");
      const targetId = targetWs?.dataset.agentWorkspaceId;
      if (targetId && targetId !== cur.id) {
        const group = organization.projectGroups[cur.id] ?? "";
        if ((organization.projectGroups[targetId] ?? "") !== group) return;
        const visibleIds = projectRows
          .filter((w) => (organization.projectGroups[w.id] ?? "") === group)
          .map((w) => w.id);
        const base = [
          ...new Set([...wsOrder, ...projectRows.map((w) => w.id)]),
        ];
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
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          className="agent-sidebar-search-icon"
        />
        <Input
          placeholder="筛选项目与线程"
          aria-label="筛选项目与线程"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 rounded-lg pl-7 text-xs!"
        />
      </div>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto">
        {[{ id: "", name: "项目" }, ...organization.groups].map((group) => (
          <section key={group.id} className="agent-project-group">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="agent-sidebar-root">
                  <button
                    type="button"
                    className="agent-group-toggle"
                    aria-expanded={!collapsedGroups.includes(group.id)}
                    onClick={() =>
                      setCollapsedGroups((current) =>
                        current.includes(group.id)
                          ? current.filter((id) => id !== group.id)
                          : [...current, group.id],
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={
                        collapsedGroups.includes(group.id)
                          ? ArrowRight01Icon
                          : ArrowDown01Icon
                      }
                      size={12}
                    />
                    <span className="truncate">{group.name}</span>
                  </button>
                  {!group.id && (
                    <>
                      <button
                        type="button"
                        title="刷新会话"
                        aria-label="刷新会话"
                        disabled={refreshing}
                        onClick={refreshSessions}
                      >
                        <HugeiconsIcon icon={Refresh01Icon} size={13} />
                      </button>
                      {!mobile && (
                        <>
                          <button
                            type="button"
                            title="新建组"
                            aria-label="新建组"
                            onClick={() =>
                              setGroupEdit({
                                id: crypto.randomUUID(),
                                name: "",
                              })
                            }
                          >
                            <HugeiconsIcon icon={Layers01Icon} size={13} />
                          </button>
                          <button
                            type="button"
                            title="添加项目"
                            aria-label="添加项目"
                            onClick={onAdd}
                          >
                            <HugeiconsIcon icon={Folder01Icon} size={13} />
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              {!!group.id && (
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setGroupEdit(group)}>
                    重命名组
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      updateOrganization({
                        groups: organization.groups.filter(
                          (item) => item.id !== group.id,
                        ),
                        projectGroups: Object.fromEntries(
                          Object.entries(organization.projectGroups).filter(
                            ([, id]) => id !== group.id,
                          ),
                        ),
                      })
                    }
                  >
                    解散组（保留项目）
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
            </ContextMenu>
            {(!collapsedGroups.includes(group.id) || !!search) &&
              projectRows
                .filter(
                  (workspace) =>
                    (organization.projectGroups[workspace.id] ?? "") ===
                    group.id,
                )
                .map((workspace) => {
                  const list = rows.filter(
                    (s) => s.workspaceId === workspace.id,
                  );
                  const isOpen =
                    !!search ||
                    (expanded[workspace.id] ?? workspace.id === workspaceId);
                  const visible = isOpen
                    ? list.slice(
                        0,
                        search
                          ? undefined
                          : (limits[workspace.id] ?? SESSION_PAGE),
                      )
                    : [];
                  return (
                    <section className="agent-project" key={workspace.id}>
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            data-agent-workspace-id={workspace.id}
                            className={`agent-project-heading ${workspace.id === workspaceId ? "is-selected" : ""} ${dropTarget?.kind === "workspace" && dropTarget.id === workspace.id ? (dropTarget.after ? "agent-drop-after" : "agent-drop-before") : ""}`}
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
                                if (isOpen)
                                  setLimits((prev) => {
                                    const next = { ...prev };
                                    delete next[workspace.id];
                                    return next;
                                  });
                              }}
                            >
                              <HugeiconsIcon
                                icon={
                                  isOpen ? ArrowDown01Icon : ArrowRight01Icon
                                }
                                size={12}
                              />
                            </button>
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left"
                              title={`${workspace.cwd}\n可按住拖拽排序`}
                              onPointerDown={(e) =>
                                startPointerReorder(
                                  e,
                                  "workspace",
                                  workspace.id,
                                )
                              }
                              onPointerMove={movePointerReorder}
                              onPointerUp={endPointerReorder}
                              onPointerCancel={cancelPointerReorder}
                              onLostPointerCapture={cancelPointerReorder}
                              onClick={() => {
                                if (suppressClick.current) {
                                  suppressClick.current = false;
                                  return;
                                }
                                useAgentStore
                                  .getState()
                                  .setWorkspace(workspace.id);
                                setExpanded((prev) => ({
                                  ...prev,
                                  [workspace.id]: true,
                                }));
                              }}
                            >
                              <HugeiconsIcon
                                icon={Folder01Icon}
                                size={14}
                                className="inline-block mr-1.5"
                              />
                              {workspace.title}
                            </button>
                            {!mobile && (
                              <div className="agent-project-actions">
                                {(
                                  projectHarnesses[workspace.id] ?? [
                                    "pi",
                                    "acp:codex",
                                    "acp:antigravity",
                                  ]
                                ).map((id) => {
                                  const harness = harnesses.find(
                                    (item) => item.id === id,
                                  );
                                  if (!harness) return null;
                                  return (
                                    <button
                                      type="button"
                                      key={id}
                                      disabled={creating}
                                      title={`使用 ${harness.displayName} 新建线程`}
                                      aria-label={`在 ${workspace.title} 使用 ${harness.displayName} 新建线程`}
                                      onClick={() => {
                                        setExpanded((prev) => ({
                                          ...prev,
                                          [workspace.id]: true,
                                        }));
                                        setCreating(true);
                                        void useAgentStore
                                          .getState()
                                          .createSession(workspace.id, id)
                                          .catch(report)
                                          .finally(() => setCreating(false));
                                      }}
                                    >
                                      <HarnessIcon
                                        harnessId={id}
                                        harness={harness}
                                      />
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  title={`移除项目 ${workspace.title}`}
                                  aria-label={`移除项目 ${workspace.title}`}
                                  onClick={() =>
                                    removeWorkspace(
                                      workspace.id,
                                      workspace.title,
                                    )
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={Cancel01Icon}
                                    size={14}
                                  />
                                </button>
                              </div>
                            )}
                          </div>
                        </ContextMenuTrigger>
                        {!mobile && (
                          <ContextMenuContent>
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>
                                移到组
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent>
                                {[
                                  { id: "", name: "项目" },
                                  ...organization.groups,
                                ].map((target) => (
                                  <ContextMenuItem
                                    key={target.id}
                                    onSelect={() => {
                                      updateOrganization({
                                        ...organization,
                                        projectGroups: {
                                          ...organization.projectGroups,
                                          [workspace.id]: target.id,
                                        },
                                      });
                                      setCollapsedGroups((current) =>
                                        current.filter(
                                          (id) => id !== target.id,
                                        ),
                                      );
                                    }}
                                  >
                                    {target.name}
                                  </ContextMenuItem>
                                ))}
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                            <ContextMenuItem
                              onSelect={() =>
                                void revealItemInDir(workspace.cwd).catch(
                                  report,
                                )
                              }
                            >
                              在目录中显示
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() =>
                                void navigator.clipboard
                                  .writeText(workspace.cwd)
                                  .then(() => toast.success("已复制工作区路径"))
                                  .catch(report)
                              }
                            >
                              复制路径
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onSelect={() =>
                                removeWorkspace(workspace.id, workspace.title)
                              }
                            >
                              从工作区移除
                            </ContextMenuItem>
                          </ContextMenuContent>
                        )}
                      </ContextMenu>
                      {!list.length && isOpen && (
                        <p className="agent-sidebar-empty">暂无会话</p>
                      )}
                      {visible.map((session) => {
                        const liveSession = views[session.id] ?? session;
                        return (
                          <ContextMenu key={session.id}>
                            <ContextMenuTrigger asChild>
                              <div
                                className={`agent-session-row ${session.id === selected ? "is-selected" : ""} ${dropTarget?.kind === "session" && dropTarget.id === session.id ? (dropTarget.after ? "agent-drop-after" : "agent-drop-before") : ""}`}
                                data-agent-session-row={session.id}
                                onContextMenu={() => {
                                  if (selectTimer.current)
                                    clearTimeout(selectTimer.current);
                                  selectTimer.current = null;
                                }}
                              >
                                {renaming === session.id ? (
                                  <form
                                    className="flex min-w-0 flex-1"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      finishRename(session);
                                    }}
                                  >
                                    <Input
                                      autoFocus
                                      aria-label="重命名会话"
                                      value={name}
                                      onChange={(e) => setName(e.target.value)}
                                      onBlur={() => finishRename(session)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Escape")
                                          setRenaming(null);
                                      }}
                                      className="h-6 text-xs!"
                                    />
                                  </form>
                                ) : (
                                  <button
                                    type="button"
                                    className="agent-session-select"
                                    onPointerDown={(e) =>
                                      startPointerReorder(
                                        e,
                                        "session",
                                        session.id,
                                      )
                                    }
                                    onPointerMove={movePointerReorder}
                                    onPointerUp={endPointerReorder}
                                    onPointerCancel={cancelPointerReorder}
                                    onLostPointerCapture={cancelPointerReorder}
                                    onDoubleClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      if (selectTimer.current)
                                        clearTimeout(selectTimer.current);
                                      selectTimer.current = null;
                                      setRenaming(session.id);
                                      setName(session.title);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "F2") {
                                        e.preventDefault();
                                        if (selectTimer.current)
                                          clearTimeout(selectTimer.current);
                                        selectTimer.current = null;
                                        setRenaming(session.id);
                                        setName(session.title);
                                      }
                                    }}
                                    onClick={() => {
                                      if (suppressClick.current) {
                                        suppressClick.current = false;
                                        return;
                                      }
                                      if (selectTimer.current)
                                        clearTimeout(selectTimer.current);
                                      selectTimer.current = setTimeout(() => {
                                        selectTimer.current = null;
                                        choose(session);
                                      }, 220);
                                    }}
                                    title={`${session.title}\n${harnesses.find((h) => h.id === session.harnessId)?.displayName ?? session.harnessId} · ${statusLabel(liveSession.state)}\n可拖拽排序或拖入视口；双击或 F2 重命名`}
                                  >
                                    <span
                                      role="img"
                                      aria-label={
                                        views[session.id]?.pendingRequests
                                          ?.length
                                          ? "等待输入"
                                          : isBusy(liveSession)
                                            ? "运行中"
                                            : unread.includes(session.id)
                                              ? "已完成，待查看"
                                              : "就绪"
                                      }
                                      className={`agent-state-dot ${views[session.id]?.pendingRequests?.length ? "is-waiting" : isBusy(liveSession) ? "is-working" : unread.includes(session.id) ? "is-unread" : ""}`}
                                    />
                                    <HarnessIcon
                                      harnessId={session.harnessId}
                                      harness={harnesses.find(
                                        (h) => h.id === session.harnessId,
                                      )}
                                      readOnly={session.readOnly}
                                      size={14}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {session.pinned ? "· " : ""}
                                      {session.title || "新会话"}
                                    </span>
                                  </button>
                                )}
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="rounded-xl">
                              <ContextMenuItem
                                onSelect={() => {
                                  setRenaming(session.id);
                                  setName(session.title);
                                }}
                              >
                                重命名
                              </ContextMenuItem>
                              {(views[session.id]?.capabilities.supportsFork ??
                                session.harnessId === "pi") &&
                                !session.readOnly && (
                                  <ContextMenuItem
                                    disabled={isBusy(liveSession)}
                                    onSelect={() => {
                                      const state = useAgentStore.getState();
                                      if (
                                        state.slots.length > 1 &&
                                        !state.slots.includes(null)
                                      ) {
                                        report(
                                          new Error(
                                            "视口已满，请先新增或清空视口",
                                          ),
                                        );
                                        return;
                                      }
                                      void loadSession(session.id)
                                        .then(() =>
                                          useAgentStore
                                            .getState()
                                            .command<SessionView>(
                                              "session.fork",
                                              {},
                                              session.id,
                                            ),
                                        )
                                        .then((view) => {
                                          useAgentStore.setState((state) => ({
                                            sessions: {
                                              ...state.sessions,
                                              [view.id]: view,
                                            },
                                            views: {
                                              ...state.views,
                                              [view.id]: view,
                                            },
                                          }));
                                          return useAgentStore
                                            .getState()
                                            .select(view.id);
                                        })
                                        .catch(report);
                                    }}
                                  >
                                    分叉线程
                                  </ContextMenuItem>
                                )}
                              <ContextMenuItem
                                onSelect={() =>
                                  void loadSession(session.id)
                                    .then((view) => {
                                      if (!view.nativeSessionPath)
                                        throw new Error(
                                          "当前线程没有本地会话路径",
                                        );
                                      return navigator.clipboard.writeText(
                                        view.nativeSessionPath,
                                      );
                                    })
                                    .then(() => toast.success("已复制会话路径"))
                                    .catch(report)
                                }
                              >
                                复制会话路径
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() =>
                                  void loadSession(session.id)
                                    .then((view) =>
                                      exportSessionMarkdown(view, session),
                                    )
                                    .catch(report)
                                }
                              >
                                导出 Markdown
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onSelect={() =>
                                  command(
                                    "session.pin",
                                    { value: !session.pinned },
                                    session.id,
                                  )
                                }
                              >
                                {session.pinned ? "取消置顶" : "置顶"}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={isBusy(liveSession)}
                                onSelect={() =>
                                  command(
                                    "session.archive",
                                    { value: !session.archived },
                                    session.id,
                                  )
                                }
                              >
                                {session.archived ? "恢复线程" : "归档线程"}
                              </ContextMenuItem>
                              {!mobile && (
                                <>
                                  <ContextMenuItem
                                    onSelect={() => {
                                      if (
                                        isBusy(liveSession) &&
                                        !window.confirm(
                                          "该线程正在运行，确定要断开并终止任务吗？",
                                        )
                                      )
                                        return;
                                      command(
                                        "session.close",
                                        isBusy(liveSession)
                                          ? { force: true }
                                          : {},
                                        session.id,
                                      );
                                    }}
                                  >
                                    {isBusy(liveSession)
                                      ? "强制断开并终止任务"
                                      : "断开代理进程"}
                                  </ContextMenuItem>
                                </>
                              )}
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                      {isOpen && list.length > visible.length && (
                        <button
                          type="button"
                          className="agent-sidebar-empty"
                          onClick={() =>
                            setLimits((s) => ({
                              ...s,
                              [workspace.id]:
                                (s[workspace.id] ?? SESSION_PAGE) +
                                SESSION_MORE,
                            }))
                          }
                        >
                          显示更多（{list.length - visible.length}）
                        </button>
                      )}
                    </section>
                  );
                })}
          </section>
        ))}
        {!workspaces.length && (
          <div className="agent-sidebar-empty">
            {mobile ? "请先在桌面添加工作目录。" : "添加工作目录。"}
          </div>
        )}
        <ArchivedSessionsSection
          archive={archive}
          onToggleArchive={() => setArchive(!archive)}
          search={search}
          totalArchivedCount={
            Object.values(sessions).filter((s) => s.archived).length
          }
          archivedRows={archivedRows}
          workspaces={workspaces}
          selected={selected}
          mobile={mobile}
          onChoose={choose}
          onRestore={(sessionId) =>
            command("session.archive", { value: false }, sessionId)
          }
          onDelete={(sessionId) => command("session.delete", {}, sessionId)}
        />
      </div>
      <Dialog
        open={!!groupEdit}
        onOpenChange={(open) => {
          if (!open) setGroupEdit(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>
            {organization.groups.some((group) => group.id === groupEdit?.id)
              ? "重命名组"
              : "新建组"}
          </DialogTitle>
          <DialogDescription>将项目整理到组中。</DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!groupEdit?.name.trim()) return;
              const value = { ...groupEdit, name: groupEdit.name.trim() };
              const exists = organization.groups.some(
                (group) => group.id === value.id,
              );
              updateOrganization({
                ...organization,
                groups: exists
                  ? organization.groups.map((group) =>
                      group.id === value.id ? value : group,
                    )
                  : [...organization.groups, value],
              });
              setGroupEdit(null);
            }}
          >
            <Input
              autoFocus
              aria-label="组名称"
              value={groupEdit?.name ?? ""}
              onChange={(event) =>
                setGroupEdit((current) =>
                  current ? { ...current, name: event.target.value } : current,
                )
              }
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setGroupEdit(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!groupEdit?.name.trim()}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
