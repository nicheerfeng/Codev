import type { Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { selectLiveTerminals } from "./lib/liveTerminals";
import { leafIds, findLeafCwd } from "./lib/panes";
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
  viewCount = 1,
  visible = true,
  onSelect,
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
  /** 保存视口标题到终端共享状态，侧栏同步更新。 */
  const commitRename = () => {
    if (!rename) return;
    onRename(rename.id, rename.text.trim());
    setRename(null);
  };
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
              <div
                className={`flex h-6 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[11px] ${t.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground"}`}
              >
                {rename?.id === t.id ? (
                  <input
                    autoFocus
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
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => onSelect(t.id)}
                    onDoubleClick={() =>
                      setRename({
                        id: t.id,
                        text: t.customTitle ?? labelFor(t),
                      })
                    }
                    title={labelFor(t)}
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
                <button
                  type="button"
                  aria-label="关闭终端视口"
                  title="关闭终端"
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onClose(t.id)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </button>
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
    </div>
  );
}
