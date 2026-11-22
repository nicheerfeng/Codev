import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  GridViewIcon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  projectLabel,
  sessionLabel,
  type AntigravitySession,
} from "./types";

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

/** 右侧线程栏：按项目分组，宽度可拖，重命名走双击。 */
export function AntigravitySidebar({
  width,
  onWidthChange,
  sessions,
  projects,
  selectedId,
  viewportIds,
  busy,
  onSelect,
  onNew,
  onAddProject,
  onRemoveProject,
  onRename,
  onRemove,
  onAddToWorkbench,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  sessions: AntigravitySession[];
  projects: string[];
  selectedId: string | null;
  viewportIds: string[];
  busy: Record<string, boolean>;
  onSelect: (session: AntigravitySession) => void;
  onNew: (cwd?: string) => void;
  onAddProject: () => void;
  onRemoveProject: (cwd: string) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (session: AntigravitySession) => void;
  onAddToWorkbench: (session: AntigravitySession) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  const drag = useRef<{ x: number; width: number } | null>(null);
  const editor = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    editor.current?.focus();
    editor.current?.select();
  }, [editing]);

  const groups = useMemo(() => {
    const map = new Map<string, AntigravitySession[]>();
    for (const project of projects) map.set(project, []);
    for (const session of sessions) {
      const list = map.get(session.cwd);
      if (list) list.push(session);
      else map.set(session.cwd, [session]);
    }
    const keyword = query.trim().toLowerCase();
    return [...map.entries()]
      .map(([cwd, list]) => ({
        cwd,
        list: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .filter(({ cwd, list }) => {
        if (!keyword) return true;
        return (
          projectLabel(cwd).toLowerCase().includes(keyword) ||
          list.some(
            (session) =>
              sessionLabel(session).toLowerCase().includes(keyword) ||
              session.preview.toLowerCase().includes(keyword),
          )
        );
      })
      .sort((a, b) => {
        const left = Math.max(0, ...a.list.map((s) => s.updatedAt));
        const right = Math.max(0, ...b.list.map((s) => s.updatedAt));
        return right - left;
      });
  }, [projects, query, sessions]);

  const commitRename = useCallback(() => {
    if (!editing) return;
    const value = editing.text.trim();
    if (value) onRename(editing.id, value);
    setEditing(null);
  }, [editing, onRename]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, current.width + current.x - event.clientX),
    );
    onWidthChange(next);
  };
  const endResize = () => {
    drag.current = null;
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border/60"
      style={{ width }}
      aria-label="Antigravity 线程栏"
    >
      <div
        role="separator"
        aria-label="调整 Antigravity 线程栏宽度"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-ring/20 focus-visible:bg-ring/30 focus-visible:outline-none"
        onDoubleClick={() => onWidthChange(236)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onWidthChange(
            Math.min(
              MAX_WIDTH,
              Math.max(
                MIN_WIDTH,
                width + (event.key === "ArrowLeft" ? 16 : -16),
              ),
            ),
          );
        }}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="relative mx-2 mt-3 mb-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          className="absolute top-2 left-2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选项目与线程"
          aria-label="筛选项目与线程"
          className="h-7 rounded-lg pl-7 text-xs!"
        />
      </div>

      <div className="reader-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="flex items-center py-1">
          <span className="flex min-w-0 flex-1 items-center gap-1 py-1 text-[11px] text-muted-foreground">
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
            项目
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              title="添加项目"
              aria-label="添加项目"
              onClick={onAddProject}
            >
              <HugeiconsIcon icon={Folder01Icon} size={13} />
            </Button>
          </div>
        </div>

        {groups.map(({ cwd, list }) => {
          const open = !collapsed.has(cwd);
          return (
            <section key={cwd} className="mb-1 min-w-0">
              <div className="group/ag-project flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted/70"
                  title={cwd}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(cwd)) next.delete(cwd);
                      else next.add(cwd);
                      return next;
                    })
                  }
                >
                  <HugeiconsIcon
                    icon={open ? ArrowDown01Icon : ArrowRight01Icon}
                    size={11}
                    className="shrink-0"
                  />
                  <span className="truncate font-medium">
                    {projectLabel(cwd)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground opacity-0 group-hover/ag-project:opacity-100 focus-visible:opacity-100"
                  title="移除项目"
                  aria-label="移除项目"
                  onClick={() => onRemoveProject(cwd)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover/ag-project:opacity-100 focus-visible:opacity-100"
                  title="在此项目新建对话"
                  aria-label="在此项目新建对话"
                  onClick={() => onNew(cwd)}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={13} />
                </Button>
              </div>

              {open &&
                list.map((session) => {
                  const active = session.id === selectedId;
                  const inViewport = viewportIds.includes(session.id);
                  return (
                    <ContextMenu key={session.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "group/ag-thread ml-5 flex min-w-0 items-center rounded-lg",
                            active
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted",
                          )}
                        >
                          {editing?.id === session.id ? (
                            <input
                              ref={editor}
                              aria-label="重命名会话"
                              className="mx-2 my-1 h-6 min-w-0 flex-1 rounded-sm border border-border/70 bg-transparent px-1 text-xs outline-none"
                              value={editing.text}
                              onChange={(event) =>
                                setEditing({
                                  id: session.id,
                                  text: event.target.value,
                                })
                              }
                              onBlur={commitRename}
                              onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitRename();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setEditing(null);
                                }
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                              title={`${sessionLabel(session)}\n${session.cwd}`}
                              onClick={() => onSelect(session)}
                              onDoubleClick={() => {
                                setEditing({
                                  id: session.id,
                                  text: sessionLabel(session),
                                });
                              }}
                            >
                              <span
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  busy[session.id]
                                    ? "ag-running-dot bg-[#477faf] text-[#477faf] dark:bg-[#a6cceb] dark:text-[#a6cceb]"
                                    : inViewport
                                      ? "bg-primary"
                                      : "bg-muted-foreground/50",
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate text-xs">
                                {sessionLabel(session)}
                              </span>
                            </button>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="rounded-xl">
                        <ContextMenuItem
                          onSelect={() =>
                            setEditing({
                              id: session.id,
                              text: sessionLabel(session),
                            })
                          }
                        >
                          重命名
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() => onAddToWorkbench(session)}
                        >
                          <HugeiconsIcon icon={GridViewIcon} size={13} />
                          放入工作台
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => onRemove(session)}
                        >
                          移除会话
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}

              {open && !list.length && (
                <p className="ml-4 px-2 py-1 text-[10px] text-muted-foreground/70">
                  暂无会话
                </p>
              )}
            </section>
          );
        })}

        {!groups.length && (
          <p className="px-2 py-3 text-[10px] text-muted-foreground">
            没有匹配的项目或线程
          </p>
        )}
      </div>
    </aside>
  );
}
