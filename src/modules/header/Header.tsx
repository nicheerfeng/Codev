import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WindowControls } from "@/components/WindowControls";
import { useT } from "@/lib/i18n";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import type { Tab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import {
  Files01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
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
  openFileTabs: Tab[];
  activeFileId: number | null;
  onSelectFile: (id: number) => void;
};

const COMPACT_WIDTH = 720;

type FileTab = Exclude<Tab, { kind: "terminal" }>;

/** 判断标签是否为可切换的文件标签。 */
function isFileTab(tab: Tab): tab is FileTab {
  return tab.kind !== "terminal";
}

/** 返回文件路径中紧邻文件名的父目录，用于列表中的轻量定位提示。 */
function parentFolder(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
}

/** 渲染顶部已打开文件筛选器，直接切换主阅览器或侧边阅览器文件。 */
function OpenFilePicker({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: Tab[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const fileTabs = useMemo(() => tabs.filter(isFileTab), [tabs]);
  const visibleTabs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return fileTabs;
    return fileTabs.filter((tab) =>
      `${labelFor(tab)} ${tab.path}`.toLocaleLowerCase().includes(needle),
    );
  }, [fileTabs, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (fileTabs.length === 0) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-no-drag
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("Open files")}
          aria-label={t("Open files")}
        >
          <HugeiconsIcon icon={Files01Icon} size={15} strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1rem)] p-1.5"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          className="px-1 pb-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder={t("Filter open files")}
            className="h-7 rounded-md px-2 text-xs! focus-visible:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {visibleTabs.length > 0 ? (
            visibleTabs.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                className="min-w-0 gap-2 rounded-md px-2 py-1.5 text-xs"
                onSelect={() => {
                  onSelect(tab.id);
                  setOpen(false);
                }}
              >
                <img
                  src={fileIconUrl(tab.title)}
                  alt=""
                  className="size-3.5 shrink-0 object-contain"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{labelFor(tab)}</span>
                  <span className="block truncate text-[10px] text-muted-foreground/70">
                    {parentFolder(tab.path)}
                  </span>
                </span>
                {tab.id === activeId && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                )}
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t("No open files match")}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Header({
  onToggleSidebar,
  onOpenSettings,
  terminalPanelCollapsed,
  onToggleTerminalPanel,
  searchTarget,
  searchRef,
  openFileTabs,
  activeFileId,
  onSelectFile,
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
    <div ref={rootRef} className="shrink-0 bg-card select-none">
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
            <HugeiconsIcon
              icon={SidebarLeftIcon}
              size={18}
              strokeWidth={1.75}
            />
          </Button>
        </div>

        {!IS_MAC && <span className="mx-1 h-full w-px shrink-0 bg-border/70" />}

        {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border/70" />}

        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

        <div className="pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1">
          <OpenFilePicker
            tabs={openFileTabs}
            activeId={activeFileId}
            onSelect={onSelectFile}
          />
          <SearchInline
            ref={searchRef}
            target={searchTarget}
            compact={compact}
          />
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {settingsButton}

          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onToggleTerminalPanel}
            title={t(
              terminalPanelCollapsed
                ? "Show terminal panel"
                : "Hide terminal panel",
            )}
            aria-label={t(
              terminalPanelCollapsed
                ? "Show terminal panel"
                : "Hide terminal panel",
            )}
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
