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
import {
  Cancel01Icon,
  PlusSignIcon,
  GridViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { TerminalStack } from "./TerminalStack";
import type { TerminalPaneHandle } from "./TerminalPane";
import { COMPACT_CONTENT, COMPACT_ITEM } from "../explorer/lib/menuItemClass";
import { leafIds, findLeafCwd } from "./lib/panes";
import {
  fillTerminalViewport,
  placeTerminalInViewport,
  terminalGrid,
  MAX_TERMINAL_VIEWS,
} from "./lib/terminalGrid";
import { toast } from "sonner";

type Props = {
  /** Terminal tabs only (filtered upstream). */
  tabs: Tab[];
  /** Hide the terminal-owned header when hosted by the right dock. */
  showHeader?: boolean;
  visible?: boolean;
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => number;
  onDuplicate: (cwd?: string) => number;
  onShowTerminals: (ids: number[]) => void;
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
  showHeader = true,
  visible = true,
  activeId,
  onSelect,
  onClose,
  onNew,
  onDuplicate,
  onShowTerminals,
  onRename,
  onReorder,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
}: Props) {
  const t = useT();
  const handles = useRef(new Map<number, TerminalPaneHandle>());
  /** 保留句柄供右侧列表点击后直接聚焦，同时维持主窗口的搜索和输入注册。 */
  const registerPane = useCallback(
    (id: number, handle: TerminalPaneHandle | null) => {
      if (handle) handles.current.set(id, handle);
      else handles.current.delete(id);
      registerHandle(id, handle);
    },
    [registerHandle],
  );
  /** 即使点击已选中的终端，也将键盘输入焦点送回对应视口。 */
  const selectTerminal = (id: number) => {
    if (multi) {
      const next = fillTerminalViewport(viewSlots, id);
      if (!next) {
        toast.info(
          viewSlots.length >= MAX_TERMINAL_VIEWS
            ? "视口已满，请拖拽终端到目标视口进行替换。"
            : "建议拖拽覆盖已有视口或者增加视口。",
          {
          id: "terminal-viewport-full",
          },
        );
        return;
      }
      setViewSlots(next);
    }
    onSelect(id);
    const tab = tabs.find((entry) => entry.id === id);
    if (tab?.kind === "terminal")
      requestAnimationFrame(() => {
        if (
          !renameInputRef.current &&
          !document.activeElement?.matches("[data-terminal-title-input]")
        )
          handles.current.get(tab.activeLeafId)?.focus();
      });
  };
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [viewSlots, setViewSlots] = useState<(number | null)[]>([]);
  const [dropViewport, setDropViewport] = useState<number | null>(null);
  const multi = viewSlots.length > 1;
  const displaySlots = multi
    ? viewSlots
    : [tabs.some((tab) => tab.id === activeId) ? activeId : (tabs[0]?.id ?? null)];
  const grid = terminalGrid(displaySlots);
  const visibleKey = grid.visibleIds.join(",");
  const tabIdsKey = tabs.map((tab) => tab.id).join(",");
  useEffect(() => {
    if (!visible) return;
    onShowTerminals(visibleKey ? visibleKey.split(",").map(Number) : []);
  }, [visibleKey, onShowTerminals, visible]);
  useEffect(() => {
    const live = new Set(tabIdsKey ? tabIdsKey.split(",").map(Number) : []);
    setViewSlots((slots) =>
      slots.some((id) => id !== null && !live.has(id))
        ? slots.map((id) => (id !== null && !live.has(id) ? null : id))
        : slots,
    );
  }, [tabIdsKey]);

  /** 切换多视口并保持新视口为空，后续由点击或拖拽填入终端。 */
  const toggleViewports = () => {
    setViewSlots((slots) =>
      slots.length > 1
        ? []
        : [tabs.some((tab) => tab.id === activeId) ? activeId : null, null],
    );
  };

  /** 关闭单个视口但保留其中的终端会话。 */
  const closeViewport = (index: number) => {
    const next = viewSlots.filter((_, position) => position !== index);
    if (next.length > 1) setViewSlots(next);
    else {
      setViewSlots([]);
      const fallback =
        next[0] ??
        (tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id);
      if (fallback !== undefined && fallback !== null) onSelect(fallback);
    }
    setDropViewport(null);
  };

  /** 新建或复制只占用空视口，视口已满时不创建隐藏终端。 */
  const createTerminal = (cwd?: string, duplicate = false) => {
    if (tabs.length >= MAX_TERMINAL_VIEWS) {
      toast.info("最多支持 6 个终端，请先关闭不需要的终端。", {
        id: "terminal-view-limit",
      });
      return;
    }
    const emptySlot = multi ? viewSlots.indexOf(null) : -1;
    if (multi && emptySlot < 0) {
      toast.info("请先增加一个空视口，再新建或复制终端。", {
        id: "terminal-viewport-full",
      });
      return;
    }
    const id = duplicate ? onDuplicate(cwd) : onNew();
    if (multi && emptySlot >= 0)
      setViewSlots((slots) => {
        const next = [...slots];
        const firstEmpty = next.indexOf(null);
        if (firstEmpty >= 0) next[firstEmpty] = id;
        return next;
      });
    onSelect(id);
  };
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
    targetViewport: number | null;
  } | null>(null);
  const suppressClickRef = useRef<number | null>(null);

  /** 查找指针下方的终端视口，用于显式拖拽替换。 */
  const viewportAtPoint = (x: number, y: number): number | null => {
    if (!multi) return null;
    const target = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-terminal-viewport-index]");
    return target ? Number(target.dataset.terminalViewportIndex) : null;
  };

  /** 将侧栏终端放入用户指定视口，已展示终端与目标交换位置。 */
  const dropTerminalIntoViewport = (id: number, index: number) => {
    if (!multi || index < 0 || index >= viewSlots.length) return;
    setViewSlots((slots) => placeTerminalInViewport(slots, index, id));
    onSelect(id);
  };

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
    setDropViewport(null);
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
      {showHeader && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span className="min-w-0 flex-1 truncate pr-1 text-[11px] font-medium text-muted-foreground">
            {t("Terminal")}
          </span>
        </div>
      )}

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="terminal-content" minSize="0px">
          <div className="h-full min-h-0 min-w-0 pl-2">
            <TerminalStack
              tabs={tabs}
              activeId={activeId}
              viewSlots={viewSlots}
              dropViewport={dropViewport}
              visible={visible}
              onSelect={selectTerminal}
              onCloseViewport={closeViewport}
              onRename={onRename}
              onDuplicate={(cwd) => createTerminal(cwd, true)}
              onClose={onClose}
              registerHandle={registerPane}
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
          onResize={(size) => setNavCollapsed(size.inPixels <= 36)}
        >
          <aside
            ref={navRef}
            className="flex h-full min-w-0 flex-col overflow-y-auto border-l border-border/60 p-1"
            aria-label={t("Terminal navigation")}
          >
            <div
              className="sticky top-0 z-10 mb-1 flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-card pb-1"
              data-terminal-controls=""
            >
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => createTerminal()}
                title={t("New terminal")}
                aria-label={t("New terminal")}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
              </button>
              {!navCollapsed && (
                <>
                  <button
                    type="button"
                    aria-label={multi ? "退出终端多视口" : "终端多视口"}
                    title={multi ? "退出终端多视口" : "终端多视口"}
                    aria-pressed={multi}
                    onClick={toggleViewports}
                    className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <HugeiconsIcon icon={GridViewIcon} size={14} />
                  </button>
                  {multi && (
                    <button
                      type="button"
                      aria-label="增加终端视口"
                      title="增加终端视口"
                      className="h-[22px] shrink-0 rounded-sm px-2 text-[10px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => {
                        if (viewSlots.length >= MAX_TERMINAL_VIEWS) {
                          toast.info(
                            "最多支持 6 个终端视口，请关闭不需要的视口。",
                            { id: "terminal-view-limit" },
                          );
                          return;
                        }
                        setViewSlots((slots) => [...slots, null]);
                      }}
                    >
                      + {viewSlots.length}/6
                    </button>
                  )}
                </>
              )}
            </div>
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
                          selectTerminal(tab.id);
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
                            targetViewport: null,
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
                          drag.targetViewport = viewportAtPoint(
                            event.clientX,
                            event.clientY,
                          );
                          setDropViewport(drag.targetViewport);
                          if (drag.targetViewport === null) {
                            drag.gap = gapAtY(event.clientY);
                            setDropGap(drag.gap);
                          } else setDropGap(null);
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
                            if (drag.targetViewport !== null) {
                              dropTerminalIntoViewport(
                                drag.fromId,
                                drag.targetViewport,
                              );
                            } else {
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
                          }
                          endDrag(event.currentTarget);
                        }}
                        onPointerCancel={(event) =>
                          endDrag(event.currentTarget)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectTerminal(tab.id);
                          }
                          if (event.key === "F2") {
                            event.preventDefault();
                            beginRename(tab);
                          }
                        }}
                        className={cn(
                          "group flex min-w-0 items-center rounded-sm px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/60",
                          isActive
                            ? "bg-[#7894b0]/20 text-[#5f7f9d] dark:text-[#9ab8d0]"
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
                                  ? "animate-pulse text-[#6f95b8] dark:text-[#9ab8d0]"
                                  : isActive
                                    ? "text-[#5f7f9d] dark:text-[#9ab8d0]"
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
                      <ContextMenuItem
                        className={COMPACT_ITEM}
                        onSelect={() => {
                          if (tab.kind === "terminal")
                            createTerminal(
                              findLeafCwd(tab.paneTree, tab.activeLeafId) ??
                                tab.cwd,
                              true,
                            );
                        }}
                      >
                        复制终端
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
