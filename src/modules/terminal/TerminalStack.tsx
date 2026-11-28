import type { Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Copy01Icon,
  Cancel01Icon,
  Maximize01Icon,
  Minimize01Icon,
} from "@hugeicons/core-free-icons";
import { ViewportSlotActions } from "@/components/ViewportCount";
import { HugeiconsIcon } from "@hugeicons/react";
import { selectLiveTerminals } from "./lib/liveTerminals";
import { leafIds, findLeafCwd } from "./lib/panes";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";
import { labelFor } from "@/modules/tabs";
import { terminalGrid } from "./lib/terminalGrid";
import { ResizableViewportGrid } from "@/components/ResizableViewportGrid";

type Props = {
  tabs: Tab[];
  activeId: number;
  viewSlots: (number | null)[];
  dropViewport: number | null;
  visible?: boolean;
  onSelect: (id: number) => void;
  onClearViewport: (index: number) => void;
  onCloseViewport: (index: number) => void;
  onSwapViewports: (from: number, to: number) => void;
  onRename: (id: number, title: string) => void;
  onDuplicate: (cwd?: string) => void;
  onClose: (id: number) => void;
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onActivity: (leafId: number, active: boolean) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onActivity: (leafId: number, active: boolean) => void;
};

/** 保持会话挂载，按所选布局展示当前组终端并区分输入焦点。 */
export function TerminalStack({
  tabs,
  activeId,
  viewSlots,
  dropViewport,
  visible = true,
  onSelect,
  onClearViewport,
  onCloseViewport,
  onSwapViewports,
  onRename,
  onDuplicate,
  onClose,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onActivity,
  onFocusLeaf,
}: Props) {
  const [rename, setRename] = useState<{ id: number; text: string } | null>(
    null,
  );
  const [viewportWidth, setViewportWidth] = useState(0);
  const [maximizedViewport, setMaximizedViewport] = useState<number | null>(
    null,
  );
  /** 保存视口标题到终端共享状态，侧栏同步更新。 */
  const commitRename = () => {
    if (!rename) return;
    onRename(rename.id, rename.text.trim());
    setRename(null);
  };
  const terminals = useMemo(() => selectLiveTerminals(tabs), [tabs]);
  const multi = viewSlots.length > 1;
  const [titleHover, setTitleHover] = useState<number | null>(null);
  const titleDrag = useRef<{
    pointerId: number;
    from: number;
    x: number;
    y: number;
    active: boolean;
    target: HTMLElement;
    sourceId: number;
  } | null>(null);
  const suppressTitleClick = useRef(false);
  const canDragTerminalTitles =
    multi && maximizedViewport === null && rename === null;
  const endTerminalTitleDrag = () => {
    const current = titleDrag.current;
    titleDrag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
    setTitleHover(null);
    document.body.style.userSelect = "";
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && titleDrag.current) {
        suppressTitleClick.current = titleDrag.current.active;
        endTerminalTitleDrag();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const startTerminalTitleDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    from: number,
    sourceId: number,
  ) => {
    if (
      !canDragTerminalTitles ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest("input")
    )
      return;
    suppressTitleClick.current = false;
    titleDrag.current = {
      pointerId: event.pointerId,
      from,
      x: event.clientX,
      y: event.clientY,
      active: false,
      target: event.currentTarget,
      sourceId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTerminalTitleDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = titleDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
        return;
      current.active = true;
      document.body.style.userSelect = "none";
    }
    event.preventDefault();
    const node = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-terminal-viewport-index]");
    setTitleHover(
      node?.dataset.terminalViewportIndex === undefined
        ? null
        : Number(node.dataset.terminalViewportIndex),
    );
  };
  const finishTerminalTitleDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const current = titleDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.active) {
      suppressTitleClick.current = true;
      const node = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-terminal-viewport-index]");
      if (node?.dataset.terminalViewportIndex !== undefined) {
        const to = Number(node.dataset.terminalViewportIndex);
        if (to !== current.from && to < viewSlots.length) {
          onSwapViewports(current.from, to);
          if (current.sourceId >= 0) onSelect(current.sourceId);
        }
      }
    }
    endTerminalTitleDrag();
  };
  const captureTerminalTitleClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (!suppressTitleClick.current) return;
    suppressTitleClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  useEffect(() => {
    if (maximizedViewport !== null) setMaximizedViewport(null);
  }, [viewSlots]);

  const displaySlots = multi
    ? maximizedViewport !== null && maximizedViewport < viewSlots.length
      ? [viewSlots[maximizedViewport]]
      : viewSlots
    : [
        tabs.some((tab) => tab.id === activeId)
          ? activeId
          : (tabs[0]?.id ?? null),
      ];
  const grid = terminalGrid(displaySlots, viewportWidth);
  const positions = [
    ...terminals.map((terminal) => {
      const position = grid.slots.indexOf(terminal.id);
      if (!visible || position < 0) return null;
      return {
        column: position % grid.columns,
        row: Math.floor(position / grid.columns),
      };
    }),
    ...(multi
      ? grid.slots.flatMap((id, index) =>
          id === null
            ? [
                {
                  column: index % grid.columns,
                  row: Math.floor(index / grid.columns),
                },
              ]
            : [],
        )
      : []),
  ];

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  const activityRef = useRef(onActivity);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);
  useEffect(() => {
    activityRef.current = onActivity;
  }, [onActivity]);

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onSearchReady: (id, addon) => searchReadyRef.current(id, addon),
        onCwd: (id, cwd) => cwdRef.current(id, cwd),
        onExit: (id, code) => exitRef.current(id, code),
        onActivity: (id, active) => activityRef.current(id, active),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals)
      for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  return (
    <ResizableViewportGrid
      columns={grid.columns}
      rows={grid.rows}
      positions={positions}
      onWidthChange={setViewportWidth}
    >
      {terminals.map((t) => {
        const position = grid.slots.indexOf(t.id);
        const tabVisible = visible && position >= 0;
        return (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            data-terminal-viewport-index={position >= 0 ? position : undefined}
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${multi ? "rounded-md border border-border" : ""} ${dropViewport === position || titleHover === position ? "ring-2 ring-primary/60" : ""}`}
          >
            {multi && (
              <div
                className={`flex h-6 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[11px] ${t.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground"}`}
              >
                {rename?.id === t.id ? (
                  <input
                    ref={(node) => {
                      node?.focus();
                      node?.select();
                    }}
                    data-terminal-title-input=""
                    aria-label="重命名终端视口"
                    className="h-5 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-[11px] outline-none focus:border-primary/60"
                    value={rename.text}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) =>
                      setRename({ id: t.id, text: event.target.value })
                    }
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRename(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left ${
                      canDragTerminalTitles ? "cursor-grab touch-none" : ""
                    }`}
                    onClick={() => {
                      if (suppressTitleClick.current) return;
                      onSelect(t.id);
                    }}
                    onDoubleClick={() =>
                      setRename({
                        id: t.id,
                        text: t.customTitle ?? labelFor(t),
                      })
                    }
                    title={labelFor(t)}
                    onPointerDown={(event) =>
                      startTerminalTitleDrag(event, position, t.id)
                    }
                    onPointerMove={moveTerminalTitleDrag}
                    onPointerUp={finishTerminalTitleDrag}
                    onPointerCancel={endTerminalTitleDrag}
                    onLostPointerCapture={() => {
                      if (titleDrag.current) endTerminalTitleDrag();
                    }}
                    onClickCapture={captureTerminalTitleClick}
                    onDragStart={(event) => event.preventDefault()}
                  >
                    {labelFor(t)}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="复制终端"
                  title="在相同目录新建终端"
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    onDuplicate(
                      findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd,
                    )
                  }
                >
                  <HugeiconsIcon icon={Copy01Icon} size={12} />
                </button>
                {multi && (
                  <button
                    type="button"
                    aria-label={
                      maximizedViewport === position ? "还原视口" : "放大视口"
                    }
                    title={
                      maximizedViewport === position
                        ? "还原到分组视图"
                        : "放大视口"
                    }
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() =>
                      setMaximizedViewport(
                        maximizedViewport === position ? null : position,
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={
                        maximizedViewport === position
                          ? Minimize01Icon
                          : Maximize01Icon
                      }
                      size={12}
                    />
                  </button>
                )}
                {multi ? (
                  <ViewportSlotActions
                    onClear={() => onClearViewport(position)}
                    onClose={() => onCloseViewport(position)}
                    closeDisabled={viewSlots.length <= 1}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label="关闭终端"
                    title="关闭终端"
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onClose(t.id)}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={12} />
                  </button>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <PaneTreeView
                node={t.paneTree}
                tabVisible={tabVisible}
                activeLeafId={t.id === activeId ? t.activeLeafId : -1}
                onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
                getBundle={getBundle}
              />
            </div>
          </div>
        );
      })}
      {multi &&
        grid.slots.map((id, index) =>
          id === null ? (
            <div
              key={`empty-${index}`}
              data-terminal-viewport-index={index}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-dashed ${dropViewport === index || titleHover === index ? "border-primary ring-2 ring-primary/40" : "border-border"}`}
            >
              <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  className={`min-w-0 flex-1 truncate text-left ${
                    canDragTerminalTitles ? "cursor-grab touch-none" : ""
                  }`}
                  onPointerDown={(event) =>
                    startTerminalTitleDrag(event, index, -1)
                  }
                  onPointerMove={moveTerminalTitleDrag}
                  onPointerUp={finishTerminalTitleDrag}
                  onPointerCancel={endTerminalTitleDrag}
                  onLostPointerCapture={() => {
                    if (titleDrag.current) endTerminalTitleDrag();
                  }}
                  onClickCapture={captureTerminalTitleClick}
                  onDragStart={(event) => event.preventDefault()}
                >
                  视口 {index + 1}
                </button>
                <button
                  type="button"
                  aria-label={
                    maximizedViewport === index ? "还原视口" : "放大视口"
                  }
                  title={
                    maximizedViewport === index ? "还原到分组视图" : "放大视口"
                  }
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    setMaximizedViewport(
                      maximizedViewport === index ? null : index,
                    )
                  }
                >
                  <HugeiconsIcon
                    icon={
                      maximizedViewport === index
                        ? Minimize01Icon
                        : Maximize01Icon
                    }
                    size={12}
                  />
                </button>
                <ViewportSlotActions
                  onClear={() => onClearViewport(index)}
                  onClose={() => onCloseViewport(index)}
                  closeDisabled={viewSlots.length <= 1}
                />
              </div>
              <div className="grid min-h-0 flex-1 place-items-center px-3 text-center text-xs text-muted-foreground">
                从右侧拖入终端，或点击右侧终端填入
              </div>
            </div>
          ) : null,
        )}
    </ResizableViewportGrid>
  );
}
