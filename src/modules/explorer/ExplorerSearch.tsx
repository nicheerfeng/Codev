import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Cancel01Icon,
  Folder01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { fileIconUrl } from "./lib/iconResolver";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type SearchHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

type SearchResult = {
  hits: SearchHit[];
  truncated: boolean;
};

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 300;

type Props = {
  rootPath: string;
  searchRoots?: string[];
  onOpenFile: (path: string) => void;
  onAddAsRoot?: (path: string) => void;
  onCopyPaths?: (paths: string[]) => void;
  onCutPaths?: (paths: string[]) => void;
  clipboardAvailable?: boolean;
  onPasteTo?: (directory: string) => void;
  selectedPaths?: string[];
  onSelectPath?: (path: string, multi: boolean) => void;
  open: boolean;
  onRequestClose: () => void;
  onActiveChange?: (active: boolean) => void;
  onRevealInTerminal?: (path: string) => void;
};

/** 返回文件所在目录，用于从文件右键菜单加入其所在文件夹。 */
function parentOf(path: string, fallback: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : fallback;
}

export type ExplorerSearchHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

export const ExplorerSearch = forwardRef<ExplorerSearchHandle, Props>(
  function ExplorerSearch(
    {
      rootPath,
      searchRoots,
      onOpenFile,
      onAddAsRoot,
      onCopyPaths,
      onCutPaths,
      clipboardAvailable = false,
      onPasteTo,
      selectedPaths = [],
      onSelectPath,
      open,
      onRequestClose,
      onActiveChange,
      onRevealInTerminal,
    }: Props,
    ref,
  ) {
    const t = useT();
    const showHidden = usePreferencesStore((s) => s.showHidden);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchHit[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searching, setSearching] = useState(false);
    const [truncated, setTruncated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [retryToken, setRetryToken] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastKeyboardNavAt = useRef(0);

    const active = query.trim().length > 0;

    useEffect(() => {
      onActiveChange?.(active);
    }, [active, onActiveChange]);

    useEffect(() => {
      if (open) {
        inputRef.current?.focus();
      } else {
        setQuery("");
        setResults([]);
        setSelectedIndex(0);
        setSearching(false);
        setTruncated(false);
        setError(null);
      }
    }, [open]);

    useEffect(() => {
      const q = query.trim();
      if (q.length < MIN_QUERY_LEN) {
        setResults([]);
        setSelectedIndex(0);
        setSearching(false);
        setTruncated(false);
        setError(null);
        return;
      }
      setSearching(true);
      setError(null);
      let alive = true;
      const handle = setTimeout(async () => {
        try {
          const res = await invoke<SearchResult>("fs_search", {
            roots: searchRoots?.length ? searchRoots : [rootPath],
            query: q,
            limit: 200,
            showHidden,
            workspace: currentWorkspaceEnv(),
          });
          if (alive) {
            setResults(res.hits);
            setTruncated(res.truncated);
            setSelectedIndex(0);
          }
        } catch (e) {
          if (alive) {
            setResults([]);
            setTruncated(false);
            setSelectedIndex(0);
            setError(String(e));
          }
        } finally {
          if (alive) setSearching(false);
        }
      }, DEBOUNCE_MS);

      return () => {
        alive = false;
        clearTimeout(handle);
      };
    }, [query, retryToken, rootPath, searchRoots, showHidden]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          requestAnimationFrame(() => {
            inputRef.current?.focus();
          });
        },
        isFocused: () => document.activeElement === inputRef.current,
      }),
      [],
    );

    useEffect(() => {
      if (active && results.length > 0) {
        const el = scrollRef.current?.querySelector(
          `[data-index="${selectedIndex}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      }
    }, [selectedIndex, results, active]);

    /** 处理搜索结果点击与 Ctrl/⌘ 多选点击。 */
    const handleSelect = (hit: SearchHit, multi = false) => {
      if (multi) {
        onSelectPath?.(hit.path, true);
        return;
      }
      onSelectPath?.(hit.path, false);
      if (!hit.is_dir) {
        onOpenFile(hit.path);
      }
    };

    return (
      <div className={cn("flex flex-col", active && "min-h-0 flex-1")}>
        {open ? (
          <div className="relative shrink-0 px-2 py-1.5 animate-in fade-in-0 slide-in-from-top-3 duration-200 ease-out">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={2}
              className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose();
                  return;
                }
                if (results.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    lastKeyboardNavAt.current = Date.now();
                    setSelectedIndex((prev) => (prev + 1) % results.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    lastKeyboardNavAt.current = Date.now();
                    setSelectedIndex(
                      (prev) => (prev - 1 + results.length) % results.length,
                    );
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    handleSelect(results[selectedIndex]);
                  }
                }
              }}
              placeholder={`${t("Search files")}…`}
              className="h-7 pr-7 pl-6.5 text-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-3.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t("Clear search")}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        ) : null}

        {active ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="py-1" ref={scrollRef}>
              {error ? (
                <div className="flex flex-col gap-1 px-3 py-2 text-[11px] text-destructive">
                  <span>{t("Search failed")}</span>
                  <span
                    className="truncate text-[10px] text-destructive/70"
                    title={error}
                  >
                    {error}
                  </span>
                  <button
                    type="button"
                    className="w-fit rounded-sm px-1.5 py-0.5 text-[11px] text-foreground hover:bg-accent"
                    onClick={() => setRetryToken((v) => v + 1)}
                  >
                    {t("Retry")}
                  </button>
                </div>
              ) : query.trim().length < MIN_QUERY_LEN ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  {t("Type at least 2 characters")}
                </div>
              ) : searching && results.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  {t("Searching...")}
                </div>
              ) : results.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  {t("No matches")}
                </div>
              ) : (
                results.map((hit, index) => {
                  const url = hit.is_dir ? null : fileIconUrl(hit.name);
                  const isSelected = selectedPaths.includes(hit.path);
                  const isActive = index === selectedIndex;
                  const menuPaths = isSelected ? selectedPaths : [hit.path];
                  return (
                    <ContextMenu key={hit.path}>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          data-index={index}
                          onClick={(event) =>
                            handleSelect(hit, event.ctrlKey || event.metaKey)
                          }
                          onContextMenu={() => {
                            if (!isSelected) onSelectPath?.(hit.path, false);
                          }}
                          onMouseEnter={() => {
                            if (Date.now() - lastKeyboardNavAt.current > 250) {
                              setSelectedIndex(index);
                            }
                          }}
                          className={cn(
                            "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors",
                            isSelected || isActive
                              ? "bg-accent text-foreground"
                              : "hover:bg-accent/50 text-foreground/80",
                          )}
                          title={hit.path}
                        >
                          {url ? (
                            <img
                              src={url}
                              alt=""
                              className="size-3.5 shrink-0"
                            />
                          ) : (
                            <HugeiconsIcon
                              icon={Folder01Icon}
                              size={13}
                              strokeWidth={1.75}
                              className="shrink-0 text-muted-foreground"
                            />
                          )}
                          <span className="truncate">{hit.name}</span>
                          <span className="ml-auto truncate text-[10px] text-muted-foreground">
                            {hit.rel}
                          </span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className={COMPACT_CONTENT}>
                        {!hit.is_dir && (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onOpenFile(hit.path)}
                          >
                            {t("Open")}
                          </ContextMenuItem>
                        )}
                        {hit.is_dir && onRevealInTerminal && (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onRevealInTerminal(hit.path)}
                          >
                            {t("Open in Terminal")}
                          </ContextMenuItem>
                        )}
                        {onAddAsRoot && (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() =>
                              onAddAsRoot(
                                hit.is_dir
                                  ? hit.path
                                  : parentOf(hit.path, rootPath),
                              )
                            }
                          >
                            {t("Add folder to workspace")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem
                          className={COMPACT_ITEM}
                          onSelect={() => void revealInFinder(hit.path)}
                        >
                          {t("Reveal in Finder")}
                        </ContextMenuItem>
                        {onCopyPaths && (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onCopyPaths(menuPaths)}
                          >
                            {t("Copy")}
                          </ContextMenuItem>
                        )}
                        {onCutPaths && (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onCutPaths(menuPaths)}
                          >
                            {t("Cut")}
                          </ContextMenuItem>
                        )}
                        {clipboardAvailable && onPasteTo && hit.is_dir ? (
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onPasteTo(hit.path)}
                          >
                            {t("Paste")}
                          </ContextMenuItem>
                        ) : null}
                        <ContextMenuSeparator className="my-0.5" />
                        <ContextMenuItem
                          className={COMPACT_ITEM}
                          onSelect={() =>
                            void copyToClipboard(menuPaths.join("\n"))
                          }
                        >
                          {t(menuPaths.length > 1 ? "Copy Paths" : "Copy Path")}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })
              )}
              {truncated && results.length > 0 ? (
                <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
                  {t("Showing partial results — refine your query.")}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    );
  },
);
