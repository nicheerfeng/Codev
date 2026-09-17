import type { Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef } from "react";
import { selectLiveTerminals } from "./lib/liveTerminals";
import { leafIds } from "./lib/panes";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";
import { labelFor } from "@/modules/tabs";
import { terminalGrid } from "./lib/terminalGrid";

type Props = {
  tabs: Tab[];
  activeId: number;
  viewCount?: number;
  visible?: boolean;
  onSelect: (id: number) => void;
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
  viewCount = 1,
  visible = true,
  onSelect,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onActivity,
  onFocusLeaf,
}: Props) {
  const terminals = useMemo(() => selectLiveTerminals(tabs), [tabs]);
  const grid = terminalGrid(
    tabs.map((tab) => tab.id),
    activeId,
    viewCount,
  );

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
    <div className="relative h-full w-full min-w-0 overflow-hidden">
      {terminals.map((t) => {
        const position = grid.visibleIds.indexOf(t.id);
        const tabVisible = visible && position >= 0;
        const row = Math.floor(Math.max(0, position) / grid.columns);
        const rowColumns = Math.max(
          1,
          Math.min(grid.columns, grid.visibleIds.length - row * grid.columns),
        );
        return (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden"
            style={{
              left: `${((Math.max(0, position) % grid.columns) * 100) / rowColumns}%`,
              top: `${(row * 100) / grid.rows}%`,
              width: `${100 / rowColumns}%`,
              height: `${100 / grid.rows}%`,
              border: viewCount > 1 ? "1px solid var(--border)" : undefined,
              visibility: tabVisible ? "visible" : "hidden",
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            {viewCount > 1 && (
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={`h-6 shrink-0 truncate border-b border-border/60 px-2 text-left text-[11px] ${t.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                title={labelFor(t)}
              >
                {labelFor(t)}
              </button>
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
    </div>
  );
}
