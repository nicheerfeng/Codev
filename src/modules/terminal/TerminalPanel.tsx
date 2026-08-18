import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { Tab } from "@/modules/tabs";
import { labelFor, TabIcon } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { Cancel01Icon, ComputerTerminal02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { TerminalStack } from "./TerminalStack";
import type { TerminalPaneHandle } from "./TerminalPane";

type Props = {
  /** Terminal tabs only (filtered upstream). */
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onCollapse: () => void;
  registerHandle: (
    leafId: number,
    handle: TerminalPaneHandle | null,
  ) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

/**
 * Dockable terminal panel: a slim tab strip on top (multiple terminals can
 * sit side by side as tabs) and the shared TerminalStack below. Rendered to
 * the right of the file workspace, never inside the header TabBar.
 */
export function TerminalPanel({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onRename,
  onCollapse,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
}: Props) {
  const translate = useT();
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={ComputerTerminal02Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-muted-foreground"
        />
        <span className="pr-1 text-[11px] font-medium text-muted-foreground">
          {translate("Terminal")}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              title={
                t.kind === "terminal" ? (t.cwd ?? labelFor(t)) : labelFor(t)
              }
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => onRename(t.id, "")}
              className={cn(
                "group flex h-6 shrink-0 max-w-44 items-center gap-1 rounded-sm px-1.5 text-[11px]",
                t.id === activeId
                  ? "bg-accent/70 text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <TabIcon tab={t} />
              <span className="truncate">{labelFor(t)}</span>
              <button
                type="button"
                aria-label={translate("Close terminal")}
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-70"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
              </button>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onNew}
          title={translate("New terminal")}
          aria-label={translate("New terminal")}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onCollapse}
          title={translate("Hide terminal panel")}
          aria-label={translate("Hide terminal panel")}
        >
          <span className="text-[11px] leading-4">»</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerHandle}
          onSearchReady={onSearchReady}
          onCwd={onCwd}
          onExit={onExit}
          onFocusLeaf={onFocusLeaf}
        />
      </div>
    </div>
  );
}
