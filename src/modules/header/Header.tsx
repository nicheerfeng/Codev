import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { useT } from "@/lib/i18n";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import {
  Settings01Icon,
  SidebarLeftIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

type Props = {
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  terminalPanelCollapsed: boolean;
  onToggleTerminalPanel: () => void;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
};

const COMPACT_WIDTH = 720;

export function Header({
  onToggleSidebar,
  onOpenSettings,
  terminalPanelCollapsed,
  onToggleTerminalPanel,
  searchTarget,
  searchRef,
}: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title={t("Settings")}
    >
      <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

  return (
    <div
      ref={rootRef}
      className="shrink-0 bg-card select-none"
    >
      <div
        data-tauri-drag-region
        className={`relative flex h-10 items-center gap-2 border-b border-border/60 ${
          IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
        }`}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            onClick={onToggleSidebar}
            title={t("Toggle sidebar")}
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
          </Button>
        </div>

        {!IS_MAC && <span className="mx-1 h-full w-px shrink-0 bg-border/70" />}

        {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border/70" />}

        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

        <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <SearchInline ref={searchRef} target={searchTarget} compact={compact} />
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {settingsButton}

          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onToggleTerminalPanel}
            title={t(terminalPanelCollapsed ? "Show terminal panel" : "Hide terminal panel")}
            aria-label={t(terminalPanelCollapsed ? "Show terminal panel" : "Hide terminal panel")}
          >
            <HugeiconsIcon icon={TerminalIcon} size={15} strokeWidth={1.75} />
          </Button>

          {USE_CUSTOM_WINDOW_CONTROLS && (
            <>
              <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
              <WindowControls />
            </>
          )}
        </div>
      </div>

    </div>
  );
}
