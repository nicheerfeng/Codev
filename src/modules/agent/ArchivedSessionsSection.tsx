import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HarnessIcon } from "./HarnessIcon";
import type { SessionSummary, Workspace } from "./types";

export function ArchivedSessionsSection({
  archive,
  onToggleArchive,
  search,
  totalArchivedCount,
  archivedRows,
  workspaces,
  selected,
  mobile,
  onChoose,
  onRestore,
  onDelete,
}: {
  archive: boolean;
  onToggleArchive: () => void;
  search: string;
  totalArchivedCount: number;
  archivedRows: SessionSummary[];
  workspaces: Workspace[];
  selected: string | null;
  mobile: boolean;
  onChoose: (session: SessionSummary) => void;
  onRestore: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  return (
    <section className="mx-1.5 mt-2 border-t border-border pt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-expanded={archive}
        onClick={onToggleArchive}
      >
        <HugeiconsIcon
          icon={archive ? ArrowDown01Icon : ArrowRight01Icon}
          size={12}
        />
        <span>已归档</span>
        <span className="ml-auto tabular-nums">{totalArchivedCount}</span>
      </button>
      {(archive || search.trim().length > 0) && (
        <div className="mt-1 flex flex-col gap-0.5">
          {archivedRows.length === 0 ? (
            <p className="agent-sidebar-empty">暂无归档会话</p>
          ) : (
            archivedRows.map((session) => {
              const ws = workspaces.find((w) => w.id === session.workspaceId);
              return (
                <ContextMenu key={session.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={`agent-session-row ${session.id === selected ? "is-selected" : ""}`}
                      data-agent-session-row={session.id}
                    >
                      <button
                        type="button"
                        className="agent-session-select"
                        onClick={() => onChoose(session)}
                      >
                        <HarnessIcon
                          harnessId={session.harnessId}
                          size={12}
                          readOnly={session.readOnly}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {session.title}
                        </span>
                        {ws?.title && <small>{ws.title}</small>}
                      </button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => onRestore(session.id)}>
                      恢复线程
                    </ContextMenuItem>
                    {!mobile && (
                      <ContextMenuItem
                        className="text-destructive"
                        onSelect={() => {
                          if (
                            window.confirm(`确认永久删除「${session.title}」？`)
                          ) {
                            onDelete(session.id);
                          }
                        }}
                      >
                        删除线程
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
