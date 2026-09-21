import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  PlusSignIcon,
  Folder01Icon,
  Search01Icon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { uiState } from "@/lib/uiState";
import type { CodexClient, Snapshot } from "./client";
import type { Session } from "./protocol";
import { Tool } from "./controls";
import { useCodexSidebarReorder } from "./useCodexSidebarReorder";
import { exportMarkdown } from "./export";
import { homeDir } from "@tauri-apps/api/path";

type Layout = {
  projects: string[];
  temporaryOpen: boolean;
  hidden: string[];
  collapsed: string[];
  projectOrder: string[];
  sessionOrder: string[];
  groups: Array<{ id: string; name: string }>;
  projectGroups: Record<string, string>;
};
const emptyLayout: Layout = {
  projects: [],
  temporaryOpen: false,
  hidden: [],
  collapsed: [],
  projectOrder: [],
  sessionOrder: [],
  groups: [],
  projectGroups: {},
};
/** 独立保存 Codex 侧栏组织信息，避免污染 Pi 的分组记忆。 */
function readLayout(): Layout {
  try {
    return {
      ...emptyLayout,
      ...JSON.parse(uiState.getItem("codev.codex.sidebar") ?? "{}"),
    };
  } catch {
    return emptyLayout;
  }
}
/** 统一 Windows 项目目录的比较形式。 */
function pathKey(path: string) {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
/** 提取紧凑的项目名称，完整路径保留在悬停提示中。 */
export function projectName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
/** 将已有顺序应用到新发现的项目或会话。 */
function ordered(ids: string[], order: string[], prependUnseen = false) {
  const unseen = ids.filter((id) => !order.includes(id));
  return [
    ...(prependUnseen ? unseen : []),
    ...order.filter((id) => ids.includes(id)),
    ...(!prependUnseen ? unseen : []),
  ];
}

/** 以 Pi 相同的组、项目、线程层级提供搜索、重命名、归档和 pointer 拖放。 */
export function CodexSidebar({
  client,
  state,
  selected,
  onSelect,
  onNew,
  onDrop,
  onHover,
  width,
  onWidth,
}: {
  client: CodexClient;
  state: Snapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (cwd: string) => void;
  onDrop: (id: string, index: number) => void;
  onHover: (index: number | null) => void;
  width: number;
  onWidth: (width: number) => void;
}) {
  const [layout, setLayout] = useState(readLayout);
  const [filter, setFilter] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [home, setHome] = useState("");
  const [openedProjects, setOpenedProjects] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{
    kind: "project" | "thread";
    id: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [inline, setInline] = useState<{ id: string; name: string } | null>(
    null,
  );
  const inlineCommitting = useRef(false);
  useEffect(() => {
    void homeDir()
      .then(setHome)
      .catch((error) => toast.error(String(error)));
  }, []);
  /** 双击行内改名，回车和失焦只提交一次。 */
  const commitInline = () => {
    if (!inline || inlineCommitting.current) return;
    inlineCommitting.current = true;
    void client
      .rename(inline.id, inline.name)
      .then(() => setInline(null))
      .catch((error) => {
        inlineCommitting.current = false;
        toast.error(String(error));
      });
  };
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    group?: boolean;
  } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    uiState.setItem("codev.codex.sidebar", JSON.stringify(layout));
  }, [layout]);
  useEffect(() => {
    if (editing) {
      renameInput.current?.focus();
      renameInput.current?.select();
    }
  }, [editing?.id]);
  const { projectMap, projects, sessionIds, sessionsByProject } = useMemo(() => {
    const projectMap = new Map<string, string>();
    const sessionsByProject = new Map<string, typeof state.sessions[string][]>();
    const sessionIds = ordered(state.order, layout.sessionOrder, true);
    for (const cwd of [...layout.projects, ...(state.historyProjects ?? [])])
      if (!layout.hidden.includes(pathKey(cwd))) projectMap.set(pathKey(cwd), cwd);
    for (const id of sessionIds) {
      const session = state.sessions[id];
      const key = pathKey(session.thread.cwd);
      if (!layout.hidden.includes(key)) projectMap.set(key, session.thread.cwd);
      const rows = sessionsByProject.get(key) ?? [];
      rows.push(session);
      sessionsByProject.set(key, rows);
    }
    return { projectMap, projects: ordered([...projectMap.keys()], layout.projectOrder), sessionIds, sessionsByProject };
  }, [state.sessions, state.order, layout.projects, layout.hidden, layout.projectOrder, layout.sessionOrder, state.historyProjects]);
  useEffect(() => {
    const discovered = [...new Set([...(state.historyProjects ?? []), ...Object.values(state.sessions).map(session => session.thread.cwd)])];
    setLayout(current => {
      const added = discovered.filter(cwd => !current.hidden.includes(pathKey(cwd)) && !current.projects.some(path => pathKey(path) === pathKey(cwd)));
      return added.length ? { ...current, projects: [...current.projects, ...added] } : current;
    });
  }, [state.sessions, state.historyProjects]);
  const query = filter.trim().toLowerCase();
  /** 只有用户展开项目时读取该目录历史，显示已保存入口不触发读取。 */
  const loadProject = (cwd: string, archived = false) => {
    setOpenedProjects(current => new Set(current).add(pathKey(cwd)));
    void client.refreshProject(cwd, archived).catch(error => toast.error(String(error)));
  };
  /** 收纳状态写入统一布局文件。 */
  const toggle = (key: string) =>
    setLayout((current) => ({
      ...current,
      collapsed: current.collapsed.includes(key)
        ? current.collapsed.filter((id) => id !== key)
        : [...current.collapsed, key],
    }));
  /** 选择目录仅添加项目入口，不会自动向模型发送任务。 */
  const addProject = async () => {
    const cwd = await open({ directory: true });
    if (cwd) {
      loadProject(cwd);
      setLayout((current) => ({
        ...current,
        projects: [...new Set([...current.projects, cwd])],
        hidden: current.hidden.filter((key) => key !== pathKey(cwd)),
      }));
    }
  };
  /** 提交会话或分组名称，保持原生会话与右栏同步。 */
  const rename = async () => {
    if (!editing?.name.trim()) return;
    if (editing.group)
      setLayout((current) => ({
        ...current,
        groups: editing.id
          ? current.groups.map((g) =>
              g.id === editing.id ? { ...g, name: editing.name.trim() } : g,
            )
          : [
              ...current.groups,
              { id: crypto.randomUUID(), name: editing.name.trim() },
            ],
      }));
    else await client.rename(editing.id, editing.name);
    setEditing(null);
  };
  /** 原生归档完成后保持主视口可阅读，恢复时重新加载到原项目。 */
  const archive = async (session: Session) => {
    await client.archive(session.thread.id, !session.archived);
  };
  /** 与 Pi 使用相同的同层间隙排序算法，保存状态仍归 Codex 所有。 */
  const visibleIds = (kind: "session" | "project", group: string) =>
    kind === "session"
      ? sessionIds
          .filter(
            (id) =>
              !state.sessions[id].archived &&
              pathKey(state.sessions[id].thread.cwd) === group,
          )
          .slice(0, counts[group] ?? 5)
      : projects.filter((id) => (layout.projectGroups[id] ?? "") === group);
  const { position, ghost, itemProps } = useCodexSidebarReorder(
    (kind, source, gap, group) => {
      const values = visibleIds(kind, group);
      const from = values.indexOf(source);
      if (from < 0) return;
      const next = values.filter((id) => id !== source);
      next.splice(gap > from ? gap - 1 : gap, 0, source);
      const key = kind === "session" ? "sessionOrder" : "projectOrder";
      setLayout((current) => ({
        ...current,
        [key]: [...next, ...current[key].filter((id) => !next.includes(id))],
      }));
    },
    {
      hover: (kind, _source, x, y) => {
        const slot =
          kind === "session"
            ? document
                .elementFromPoint(x, y)
                ?.closest<HTMLElement>("[data-codex-slot]")
            : null;
        onHover(slot ? Number(slot.dataset.codexSlot) : null);
        return Boolean(slot);
      },
      drop: (kind, source, x, y) => {
        const slot =
          kind === "session"
            ? document
                .elementFromPoint(x, y)
                ?.closest<HTMLElement>("[data-codex-slot]")
            : null;
        if (!slot) return false;
        onDrop(source, Number(slot.dataset.codexSlot));
        return true;
      },
      clear: () => onHover(null),
    },
  );
  /** 根据 Pi 同款间隙索引显示插入线，原位置不显示无效落点。 */
  const dropMark = (id: string, kind: "project" | "session") => {
    if (!position || position.kind !== kind || position.gap == null)
      return undefined;
    const list = visibleIds(kind, position.group);
    const index = list.indexOf(id);
    const from = list.indexOf(position.source);
    if (index < 0 || position.gap === from || position.gap === from + 1)
      return undefined;
    if (position.gap === index) return "before";
    if (index === list.length - 1 && position.gap === list.length)
      return "after";
    return undefined;
  };
  /** 线程行沿用 Pi 的单行标题、状态点与右键操作布局。 */
  const row = (session: Session) => {
    const { thread } = session;
    const title = thread.name || thread.preview || "新线程";
    return (
      <ContextMenu key={thread.id}>
        <ContextMenuTrigger asChild>
          <div
            data-codex-kind="session"
            data-codex-id={thread.id}
            data-dragging={ghost?.source === thread.id ? "true" : undefined}
            data-drop-position={dropMark(thread.id, "session")}
            {...(!filter && !session.archived
              ? itemProps("session", thread.id, pathKey(thread.cwd), title)
              : {})}
            className={`codex-session group ${selected === thread.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
          >
            {inline?.id === thread.id ? (
              <Input
                autoFocus
                aria-label="线程名称"
                className="h-8 text-xs"
                value={inline.name}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) =>
                  setInline({ ...inline, name: event.target.value })
                }
                onBlur={commitInline}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitInline();
                  if (event.key === "Escape") {
                    inlineCommitting.current = true;
                    setInline(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                aria-label={`${title} ${projectName(thread.cwd)}`}
                onClick={() => {
                  onSelect(thread.id);
                }}
                onDoubleClick={() => {
                  inlineCommitting.current = false;
                  setInline({ id: thread.id, name: title });
                }}
              >
                <span
                  role="img"
                  aria-label={
                    session.requests.length
                      ? "等待输入"
                      : session.busy
                        ? "运行中"
                        : "就绪"
                  }
                  className={`codex-status-dot ${session.requests.length ? "codex-waiting" : session.busy ? "codex-running" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate text-xs">{title}</span>
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="rounded-xl">
          <ContextMenuItem
            onSelect={() => setEditing({ id: thread.id, name: title })}
          >
            重命名
          </ContextMenuItem>
          <ContextMenuItem
            disabled={session.busy}
            onSelect={() =>
              void client
                .fork(thread.id)
                .then(onSelect)
                .catch((error) => toast.error(String(error)))
            }
          >
            分叉线程
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void writeText(title)}>
            复制标题
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!thread.path}
            onSelect={() => void writeText(thread.path ?? "")}
          >
            复制会话路径
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() =>
              void exportMarkdown(client, thread.id).catch((error) =>
                toast.error(String(error)),
              )
            }
          >
            导出 Markdown
          </ContextMenuItem>
          <ContextMenuItem
            disabled={session.busy}
            onSelect={() =>
              void archive(session).catch((error) => toast.error(String(error)))
            }
          >
            {session.archived ? "恢复线程" : "归档线程"}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={session.busy || session.sending || !!session.queue.length}
            onSelect={() => setConfirm({ kind: "thread", id: thread.id })}
          >
            彻底删除线程
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  /** 项目默认展示五条线程，可展开更多并独立创建会话。 */
  const project = (key: string, archived = false) => {
    const cwd =
      projectMap.get(key) ??
      Object.values(state.sessions).find(
        (session) => pathKey(session.thread.cwd) === key,
      )?.thread.cwd ??
      key;
    const nodeKey = archived ? `archive:${key}` : key;
    const rows = (sessionsByProject.get(key) ?? [])
      .filter(
        (session) =>
          pathKey(session.thread.cwd) === key &&
          session.archived === archived &&
          (!query ||
            `${session.thread.name} ${session.thread.preview} ${cwd}`
              .toLowerCase()
              .includes(query)),
      );
    if (archived && !rows.length) return null;
    if (query && !rows.length && !cwd.toLowerCase().includes(query))
      return null;
    const closed = (!openedProjects.has(key) && !rows.length) || (!query && layout.collapsed.includes(nodeKey));
    const live = rows.some((session) => session.busy);
    return (
      <div key={key} className="mb-1 min-w-0">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-codex-kind="project"
              data-dragging={ghost?.source === key ? "true" : undefined}
              data-drop-position={dropMark(key, "project")}
              data-live={closed && live ? "true" : undefined}
              data-codex-id={key}
              {...(!filter && !archived
                ? itemProps(
                    "project",
                    key,
                    layout.projectGroups[key] ?? "",
                    projectName(cwd),
                  )
                : {})}
              className="group flex min-w-0 touch-none items-center rounded-lg hover:bg-muted/70"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-2 text-left text-xs text-muted-foreground"
                aria-expanded={!closed}
                onClick={() => {
                  if (!openedProjects.has(key)) {
                    loadProject(cwd, archived);
                    setLayout(current => ({ ...current, collapsed: current.collapsed.filter(value => value !== nodeKey) }));
                  } else {
                    if (closed) loadProject(cwd, archived);
                    toggle(nodeKey);
                  }
                }}
              >
                <HugeiconsIcon
                  icon={closed ? ArrowRight01Icon : ArrowDown01Icon}
                  size={12}
                />
                <HugeiconsIcon icon={Folder01Icon} size={14} />
                <span className="truncate font-medium">{projectName(cwd)}</span>
                {closed && live && (
                  <span className="codex-status-dot codex-running" />
                )}
              </button>
              {!archived && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-no-drag=""
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    title={`移除项目 ${projectName(cwd)}`}
                    aria-label={`移除项目 ${projectName(cwd)}`}
                    onClick={() => setConfirm({ kind: "project", id: key })}
                  >
                    ×
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-no-drag=""
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    title={`在 ${projectName(cwd)} 新建线程`}
                    aria-label={`在 ${projectName(cwd)} 新建线程`}
                    disabled={!state.connected}
                    onClick={() => onNew(cwd)}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={12} />
                  </Button>
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="rounded-xl">
            <ContextMenuItem
              onSelect={() =>
                void openPath(cwd).catch((error) => toast.error(String(error)))
              }
            >
              打开文件夹
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void writeText(cwd)}>
              复制项目路径
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>移动到组</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {[{ id: "", name: "项目" }, ...layout.groups].map((group) => (
                  <ContextMenuItem
                    key={group.id}
                    onSelect={() =>
                      setLayout((current) => ({
                        ...current,
                        projectGroups: {
                          ...current.projectGroups,
                          [key]: group.id,
                        },
                      }))
                    }
                  >
                    {group.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => setConfirm({ kind: "project", id: key })}
            >
              移除项目
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {!closed && (
          <div className="ml-3 border-l border-border/60 pl-1">
            {rows
              .slice(0, query ? rows.length : (counts[nodeKey] ?? 5))
              .map(row)}
            {!rows.length && (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                暂无会话
              </p>
            )}
            {!query && rows.length > (counts[nodeKey] ?? 5) && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() =>
                  setCounts({
                    ...counts,
                    [nodeKey]: (counts[nodeKey] ?? 5) + 50,
                  })
                }
              >
                显示更多 ({rows.length - (counts[nodeKey] ?? 5)})
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <aside className="codex-sidebar" style={{ width }}>
      <div
        className="codex-sidebar-resize"
        role="separator"
        aria-valuenow={width}
        aria-valuemin={120}
        aria-orientation="vertical"
        aria-label="调整线程栏宽度"
        tabIndex={0}
        onDoubleClick={() => onWidth(236)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onWidth(
              Math.max(
                120,
                Math.min(
                  (event.currentTarget.parentElement?.parentElement
                    ?.clientWidth ?? 660) - 180,
                  width + (event.key === "ArrowLeft" ? 16 : -16),
                ),
              ),
            );
          }
        }}
        onPointerDown={(event) => {
          const start = event.clientX;
          const initial = width;
          event.currentTarget.setPointerCapture(event.pointerId);
          const target = event.currentTarget;
          target.onpointermove = (move) =>
            onWidth(
              Math.max(
                120,
                Math.min(
                  (target.parentElement?.parentElement?.clientWidth ?? 660) -
                    180,
                  initial + start - move.clientX,
                ),
              ),
            );
          target.onpointerup = target.onpointercancel = () => {
            target.onpointermove = null;
          };
        }}
      />
      <div className="flex px-2 pt-3 pb-2">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 justify-start rounded-lg text-xs"
          disabled={!state.connected}
          onClick={() =>
            onNew((selected && state.sessions[selected]?.thread.cwd) || home)
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} />
          新建线程
        </Button>
      </div>
      <div className="relative mx-2 mb-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          className="absolute left-2 top-2 text-muted-foreground"
        />
        <Input
          className="h-7 rounded-lg bg-muted/40 pl-7 text-xs!"
          aria-label="搜索会话"
          placeholder="搜索线程"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-auto px-2 pb-3">
        {[{ id: "", name: "项目" }, ...layout.groups].map((group) => (
          <section key={group.id} className="mb-3">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="flex items-center py-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-[11px] text-muted-foreground"
                    onClick={() => toggle(`group:${group.id}`)}
                  >
                    <HugeiconsIcon
                      icon={
                        layout.collapsed.includes(`group:${group.id}`)
                          ? ArrowRight01Icon
                          : ArrowDown01Icon
                      }
                      size={12}
                    />
                    <span className="truncate">{group.name}</span>
                  </button>
                  {!group.id && (
                    <>
                      <Tool
                        icon={Layers01Icon}
                        label="新建组"
                        onClick={() =>
                          setEditing({ id: "", name: "", group: true })
                        }
                      />
                      <Tool
                        icon={Folder01Icon}
                        label="添加项目"
                        onClick={() =>
                          void addProject().catch((error) =>
                            toast.error(String(error)),
                          )
                        }
                      />
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              {group.id && (
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => setEditing({ ...group, group: true })}
                  >
                    重命名组
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      setLayout((current) => ({
                        ...current,
                        groups: current.groups.filter(
                          (item) => item.id !== group.id,
                        ),
                        projectGroups: Object.fromEntries(
                          Object.entries(current.projectGroups).filter(
                            ([, id]) => id !== group.id,
                          ),
                        ),
                      }))
                    }
                  >
                    解散组（保留项目）
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
            </ContextMenu>
            {(!layout.collapsed.includes(`group:${group.id}`) || query) &&
              projects
                .filter(
                  (key) =>
                    key !== pathKey(home) &&
                    (layout.projectGroups[key] ?? "") === group.id,
                )
                .map((key) => project(key))}
          </section>
        ))}
        {home && (
          <section className="mb-3">
            <div className="flex items-center py-1">
              <button
                type="button"
                aria-expanded={layout.temporaryOpen || !!query}
                className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-[11px] text-muted-foreground"
                onClick={() => {
                  if (!layout.temporaryOpen || !openedProjects.has(pathKey(home))) loadProject(home);
                  setLayout(current => ({ ...current, temporaryOpen: !openedProjects.has(pathKey(home)) || !current.temporaryOpen }));
                }}
              >
                <HugeiconsIcon
                  icon={
                    layout.temporaryOpen || query
                      ? ArrowDown01Icon
                      : ArrowRight01Icon
                  }
                  size={12}
                />
                <span className="truncate">临时对话</span>
              </button>
              <Tool
                icon={PlusSignIcon}
                label="新建临时对话"
                disabled={!state.connected}
                onClick={() => {
                  setLayout((current) => ({ ...current, temporaryOpen: true }));
                  onNew(home);
                }}
              />
            </div>
            {(layout.temporaryOpen || query) &&
              (() => {
                const rows = sessionIds
                  .map((id) => state.sessions[id])
                  .filter(
                    (session) =>
                      !session.archived &&
                      pathKey(session.thread.cwd) === pathKey(home) &&
                      (!query ||
                        `${session.thread.name} ${session.thread.preview} 临时对话`
                          .toLowerCase()
                          .includes(query)),
                  );
                const visible = query
                  ? rows
                  : rows.slice(0, counts[pathKey(home)] ?? 5);
                return (
                  <>
                    {visible.map(row)}
                    {visible.length < rows.length && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-muted-foreground"
                        onClick={() =>
                          setCounts((current) => ({
                            ...current,
                            [pathKey(home)]: (current[pathKey(home)] ?? 5) + 50,
                          }))
                        }
                      >
                        显示更多（{rows.length - visible.length}）
                      </Button>
                    )}
                  </>
                );
              })()}
          </section>
        )}
        <section className="mt-3 border-t border-border pt-2">
          <button
            type="button"
            className="flex w-full items-center gap-1 py-2 text-xs text-muted-foreground"
            aria-expanded={archiveOpen}
            onClick={() => {
              if (!archiveOpen)
                void client
                  .refresh(true)
                  .catch((error) => toast.error(String(error)));
              setArchiveOpen(!archiveOpen);
            }}
          >
            <HugeiconsIcon
              icon={archiveOpen ? ArrowDown01Icon : ArrowRight01Icon}
              size={12}
            />
            已归档{" "}
            <span className="ml-auto">
              {sessionIds.filter((id) => state.sessions[id].archived).length}
            </span>
          </button>
          {(archiveOpen || query) && (
            <>
              {[
                ...new Set(
                  sessionIds
                    .filter((id) => state.sessions[id].archived)
                    .map((id) => state.sessions[id].thread.cwd),
                ),
              ].map((cwd) => project(pathKey(cwd), true))}
            </>
          )}
        </section>
      </div>
      {ghost && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg bg-popover/75 px-2 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-sky-400/40"
          style={{ left: ghost.x, top: ghost.y, width: ghost.width }}
        >
          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/70" />
          <span className="min-w-0 flex-1 truncate">{ghost.label}</span>
        </div>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(value) => {
          if (!value && !deleting) setConfirm(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="max-w-sm rounded-xl"
        >
          <DialogTitle>
            {confirm?.kind === "thread" ? "彻底删除线程？" : "移除项目？"}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {confirm?.kind === "thread"
              ? "原生会话将被删除，此操作无法撤销。"
              : "仅移除项目入口，保留会话历史；可通过添加项目恢复。"}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
            <Button
              disabled={deleting}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "project") {
                  setLayout((current) => ({
                    ...current,
                    hidden: [...current.hidden, confirm.id],
                  }));
                  setConfirm(null);
                } else {
                  setDeleting(true);
                  void client
                    .deleteThread(confirm.id)
                    .then(() => setConfirm(null))
                    .catch((error) => toast.error(String(error)))
                    .finally(() => setDeleting(false));
                }
              }}
            >
              确认
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
      >
        <DialogContent
          className="max-w-sm rounded-xl"
          aria-describedby={undefined}
        >
          <DialogTitle>
            {editing?.group ? "分组名称" : "重命名线程"}
          </DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename().catch((error) => toast.error(String(error)));
            }}
          >
            <Input
              ref={renameInput}
              aria-label="线程名称"
              value={editing?.name ?? ""}
              onChange={(event) =>
                setEditing(
                  editing ? { ...editing, name: event.target.value } : null,
                )
              }
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
              <Button type="submit" size="sm" disabled={!editing?.name.trim()}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
