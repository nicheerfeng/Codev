import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { Tab } from "@/modules/tabs";
import { labelFor, TabIcon } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { TerminalStack } from "./TerminalStack";
import type { TerminalPaneHandle } from "./TerminalPane";
import { COMPACT_CONTENT, COMPACT_ITEM } from "../explorer/lib/menuItemClass";
import { leafIds } from "./lib/panes";

type Props = {
  /** Terminal tabs only (filtered upstream). */
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onReorder: (fromId: number, toGapIndex: number) => void;
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

/** 将终端工作目录压缩为最后一级文件夹名称。 */
function cwdLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** 渲染右侧终端面板、可伸缩终端树和当前 PTY 内容。 */
export function TerminalPanel({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onRename,
  onReorder,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
}: Props) {
  const t = useT();
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const [activeLeaves, setActiveLeaves] = useState<Set<number>>(
    () => new Set(),
  );
  const renameInputRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    fromId: number;
    active: boolean;
    gap: number;
  } | null>(null);
  const suppressClickRef = useRef<number | null>(null);

  /** 根据指针纵坐标计算终端列表中的插入间隙。 */
  const gapAtY = (clientY: number) => {
    const rows = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>("[data-terminal-nav]") ??
        [],
    );
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return rows.length;
  };

  /** 清理一次终端导航拖拽及其视觉状态。 */
  const endDrag = (target: HTMLElement) => {
    const drag = dragRef.current;
    if (drag) target.releasePointerCapture?.(drag.pointerId);
    dragRef.current = null;
    setDraggingId(null);
    setDropGap(null);
    document.body.style.userSelect = "";
  };

  /** 更新终端子面板的近期输出活动态。 */
  const handleActivity = (leafId: number, active: boolean) => {
    setActiveLeaves((current) => {
      if (active === current.has(leafId)) return current;
      const next = new Set(current);
      if (active) next.add(leafId);
      else next.delete(leafId);
      return next;
    });
  };

  useEffect(() => {
    if (renamingId === null) return;
    if (!tabs.some((tab) => tab.id === renamingId)) {
      setRenamingId(null);
      setRenameDraft("");
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId, tabs]);

  /** 开始编辑指定终端的自定义名称。 */
  const beginRename = (tab: Tab) => {
    if (tab.kind !== "terminal") return;
    setRenamingId(tab.id);
    setRenameDraft(tab.customTitle ?? "");
  };

  /** 提交终端名称，空值恢复工作目录默认名称。 */
  const commitRename = () => {
    if (renamingId === null) return;
    onRename(renamingId, renameDraft.trim());
    setRenamingId(null);
    setRenameDraft("");
  };

  /** 取消当前终端名称编辑。 */
  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <span className="min-w-0 flex-1 truncate pr-1 text-[11px] font-medium text-muted-foreground">
          {t("Terminal")}
        </span>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onNew}
          title={t("New terminal")}
          aria-label={t("New terminal")}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
        </button>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="terminal-content" minSize="40%">
          <div className="h-full min-h-0 min-w-0 pl-2">
            <TerminalStack
              tabs={tabs}
              activeId={activeId}
              registerHandle={registerHandle}
              onSearchReady={onSearchReady}
              onCwd={onCwd}
              onExit={onExit}
              onActivity={handleActivity}
              onFocusLeaf={onFocusLeaf}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="terminal-navigation"
          defaultSize="160px"
          minSize="32px"
          maxSize="40%"
          onResize={(size) => setNavCollapsed(size.inPixels <= 36)}
        >
          <aside
            ref={navRef}
            className="flex h-full min-w-0 flex-col overflow-y-auto border-l border-border/60 p-1"
            aria-label={t("Terminal navigation")}
          >
            {tabs.map((tab, index) => {
              const isActive = tab.id === activeId;
              const isRenaming = tab.id === renamingId;
              const cwd = tab.kind === "terminal" ? tab.cwd : null;
              const active =
                tab.kind === "terminal" &&
                leafIds(tab.paneTree).some((leafId) =>
                  activeLeaves.has(leafId),
                );
              const sourceIndex = tabs.findIndex(
                (item) => item.id === draggingId,
              );
              const showGap =
                draggingId !== null &&
                dropGap === index &&
                index !== sourceIndex &&
                index !== sourceIndex + 1;
              return (
                <Fragment key={tab.id}>
                  <div className="relative h-0">
                    {showGap ? (
                      <span className="pointer-events-none absolute -top-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary" />
                    ) : null}
                  </div>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div
                        data-terminal-nav={tab.id}
                        role="button"
                        tabIndex={0}
                        title={
                          cwd ? `${labelFor(tab)} · ${cwd}` : labelFor(tab)
                        }
                        onClick={() => {
                          if (suppressClickRef.current === tab.id) {
                            suppressClickRef.current = null;
                            return;
                          }
                          onSelect(tab.id);
                        }}
                        onDoubleClick={() => beginRename(tab)}
                        onPointerDown={(event) => {
                          if (
                            event.button !== 0 ||
                            isRenaming ||
                            (event.target as HTMLElement).closest(
                              "[data-terminal-nav-no-drag]",
                            )
                          ) {
                            return;
                          }
                          dragRef.current = {
                            pointerId: event.pointerId,
                            startY: event.clientY,
                            fromId: tab.id,
                            active: false,
                            gap: index,
                          };
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                        }}
                        onPointerMove={(event) => {
                          const drag = dragRef.current;
                          if (!drag || drag.pointerId !== event.pointerId)
                            return;
                          if (!drag.active) {
                            if (Math.abs(event.clientY - drag.startY) < 4)
                              return;
                            drag.active = true;
                            setDraggingId(drag.fromId);
                            document.body.style.userSelect = "none";
                          }
                          drag.gap = gapAtY(event.clientY);
                          setDropGap(drag.gap);
                        }}
                        onPointerUp={(event) => {
                          const drag = dragRef.current;
                          if (!drag || drag.pointerId !== event.pointerId)
                            return;
                          if (drag.active) {
                            event.preventDefault();
                            suppressClickRef.current = drag.fromId;
                            window.setTimeout(() => {
                              suppressClickRef.current = null;
                            }, 0);
                            const fromIndex = tabs.findIndex(
                              (item) => item.id === drag.fromId,
                            );
                            if (
                              drag.gap !== fromIndex &&
                              drag.gap !== fromIndex + 1
                            ) {
                              onReorder(drag.fromId, drag.gap);
                            }
                          }
                          endDrag(event.currentTarget);
                        }}
                        onPointerCancel={(event) =>
                          endDrag(event.currentTarget)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelect(tab.id);
                          }
                          if (event.key === "F2") {
                            event.preventDefault();
                            beginRename(tab);
                          }
                        }}
                        className={cn(
                          "group flex min-w-0 items-center rounded-sm px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/60",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            data-terminal-nav-no-drag=""
                            value={renameDraft}
                            onChange={(event) =>
                              setRenameDraft(event.target.value)
                            }
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitRename();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={commitRename}
                            placeholder={labelFor(tab)}
                            className="h-5 w-full min-w-0 rounded-sm border border-border/70 bg-background px-1 text-[11px] text-foreground outline-none focus:border-primary/60"
                            aria-label={t("Rename terminal")}
                          />
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-1">
                            <span
                              data-terminal-active={active ? "true" : "false"}
                              className={cn(
                                "flex size-3.5 shrink-0 items-center justify-center transition-colors",
                                active
                                  ? "animate-pulse text-primary"
                                  : "text-muted-foreground",
                              )}
                            >
                              <TabIcon tab={tab} />
                            </span>
                            {!navCollapsed && (
                              <span className="min-w-0 flex-1 truncate text-[11px] leading-4">
                                {labelFor(tab)} ·{" "}
                                {cwd
                                  ? cwdLabel(cwd)
                                  : t("No current directory")}
                              </span>
                            )}
                            {!navCollapsed && (
                              <button
                                type="button"
                                data-terminal-nav-no-drag=""
                                aria-label={t("Close terminal")}
                                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-80"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onClose(tab.id);
                                }}
                              >
                                <HugeiconsIcon
                                  icon={Cancel01Icon}
                                  size={10}
                                  strokeWidth={2}
                                />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className={COMPACT_CONTENT}>
                      <ContextMenuItem
                        className={COMPACT_ITEM}
                        onSelect={() => beginRename(tab)}
                      >
                        {t("Rename terminal")}
                      </ContextMenuItem>
                      <ContextMenuSeparator className="my-0.5" />
                      <ContextMenuItem
                        className={COMPACT_ITEM}
                        variant="destructive"
                        onSelect={() => onClose(tab.id)}
                      >
                        {t("Close terminal")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </Fragment>
              );
            })}
            <div className="relative h-0">
              {draggingId !== null &&
              dropGap === tabs.length &&
              tabs.findIndex((item) => item.id === draggingId) !==
                tabs.length - 1 ? (
                <span className="pointer-events-none absolute -top-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary" />
              ) : null}
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
