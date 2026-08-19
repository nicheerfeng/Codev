import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { EntryRow, PendingRow, StatusRow, type RowActions } from "./TreeRow";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useExplorerDnd } from "./lib/useExplorerDnd";
import { useExplorerFileDrop } from "./lib/useExplorerFileDrop";
import { useFileTree } from "./lib/useFileTree";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import type { TerminalPathDropTarget } from "@/modules/terminal";

export type RootTreeHandle = {
  focus: () => void;
  isFocused: () => boolean;
  focusSearch: () => void;
  createFile: () => void;
  createFolder: () => void;
  refresh: () => void;
};

export type RootTreeProps = {
  rootPath: string | null;
  activeFilePath?: string | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  /** Starts a unified copy or move task for selected paths. */
  onTransfer?: (sources: string[], toDir: string, copy: boolean) => void;
  /** Starts a unified copy task for files dropped from the operating system. */
  onExternalCopy?: (sources: string[], toDir: string) => void;
  /** Copies selected paths into the internal explorer clipboard. */
  onCopyPaths?: (paths: string[]) => void;
  /** Cuts selected paths into the internal explorer clipboard. */
  onCutPaths?: (paths: string[]) => void;
  /** Deletes selected paths through the shared explorer action. */
  onDeletePaths?: (paths: string[]) => void;
  clipboardAvailable?: boolean;
  onPasteTo?: (directory: string) => void;
  onRevealInTerminal?: (path: string) => void;
  /** Adds the target folder to the workspace roots (multi-root). */
  onAddAsRoot?: (path: string) => void;
  /** Opens the folder picker from the tree's blank-area context menu. */
  onRequestAddRoot?: () => void;
  /** Shares Ctrl/⌘ selection across all explorer roots. */
  selectedPaths?: string[];
  /** Updates the shared explorer selection. */
  onSelectPath?: (path: string, multi: boolean) => void;
  /** Activates the root when the user interacts with its visible entries. */
  onActivateRoot?: () => void;
  /** Hides the per-root toolbar when FileExplorer owns the workspace toolbar. */
  showToolbar?: boolean;
  /** Opens a file in the secondary editor group. */
  onOpenFileToSide?: (path: string) => void;
  pathDropTarget?: TerminalPathDropTarget;
  /** Renders this root into the explorer's single continuous scroll flow. */
  sharedScroll?: boolean;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
    }
  | {
      kind: "rename";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      depth: number;
    }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | {
      kind: "status";
      key: string;
      depth: number;
      tone: "muted" | "error";
      message: string;
    };

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function parentOf(path: string, fallback: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : fallback;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number) => {
    const node = tree.nodes[parent];
    if (!node || node.status !== "loaded") return;
    for (const entry of node.entries) {
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name: entry.name,
          isDir,
          isExpanded: expanded,
          depth,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: "Loading…",
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1);
        }
      }
    }
  };

  walk(rootPath, 0);
  return { rows, entryIndexByPath };
}

export const RootTree = memo(
  forwardRef<RootTreeHandle, RootTreeProps>(function RootTree(
    {
      rootPath,
      activeFilePath,
      onOpenFile,
      onPathRenamed,
      onPathDeleted,
      onTransfer,
      onExternalCopy,
      onCopyPaths,
      onCutPaths,
      onDeletePaths,
      clipboardAvailable = false,
      onPasteTo,
      onRevealInTerminal,
      onAddAsRoot,
      onRequestAddRoot,
      selectedPaths: selectedPathsProp,
      onSelectPath: onSelectPathProp,
      onActivateRoot,
      showToolbar = true,
      onOpenFileToSide,
      pathDropTarget,
      sharedScroll = false,
    },
    ref,
  ) {
    const t = useT();
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const [localSelectedPaths, setLocalSelectedPaths] = useState<string[]>([]);
    const selectedPaths = selectedPathsProp ?? localSelectedPaths;
    /** 更新文件树选择，支持跨根目录共享 Ctrl/⌘ 多选状态。 */
    const selectPath = useCallback(
      (path: string, multi: boolean) => {
        if (onSelectPathProp) {
          onSelectPathProp(path, multi);
          return;
        }
        setLocalSelectedPaths((paths) => {
          if (!multi) return [path];
          return paths.includes(path)
            ? paths.filter((item) => item !== path)
            : [...paths, path];
        });
      },
      [onSelectPathProp],
    );
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [isSearchActive, setIsSearchActive] = useState(false);
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath)
        return {
          rows: [] as Row[],
          entryIndexByPath: new Map<string, number>(),
        };
      return buildRows(rootPath, tree);
      // `tree` is intentionally omitted: its identity changes every render, but
      // the listed fields are the only inputs buildRows actually reads.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      rootPath,
      tree.nodes,
      tree.expanded,
      tree.renaming,
      tree.pendingCreate,
    ]);

    const selectedPath =
      [...selectedPaths].reverse().find((path) => entryIndexByPath.has(path)) ??
      null;

    const rowActions = useMemo<RowActions>(
      () => ({
        toggle: tree.toggle,
        beginRename: tree.beginRename,
        commitRename: tree.commitRename,
        cancelRename: tree.cancelRename,
      }),
      [tree.toggle, tree.beginRename, tree.commitRename, tree.cancelRename],
    );
    const renameInProgress =
      tree.renaming !== null || tree.pendingCreate !== null;

    const [menuTarget, setMenuTarget] = useState<{
      path: string;
      name: string;
      isDir: boolean;
    } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    // Bumped on every right-click so the menu content remounts and the popper
    // re-anchors to the new cursor (floating-ui won't reposition on an anchor
    // change alone, only on scroll/resize).
    const [menuNonce, setMenuNonce] = useState(0);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    const isDirAt = useCallback(
      (path: string): boolean | undefined => {
        const idx = entryIndexByPath.get(path);
        const row = idx !== undefined ? rows[idx] : undefined;
        return row?.kind === "entry" ? row.isDir : undefined;
      },
      [entryIndexByPath, rows],
    );
    const dnd = useExplorerDnd({
      rootPath: rootPath ?? "",
      isDir: isDirAt,
      selectedPaths,
      onMove: (sources, toDir, copy) => {
        if (onTransfer) onTransfer(sources, toDir, copy);
        else if (!copy && sources[0]) void tree.movePath(sources[0], toDir);
      },
      pathDropTarget,
    });

    const fileDrop = useExplorerFileDrop({
      rootPath,
      isDir: isDirAt,
      onTransfer: (sources, toDir) => {
        if (onExternalCopy) onExternalCopy(sources, toDir);
        else if (rootPath) void tree.refresh(rootPath);
      },
    });

    const dropTargetDir = dnd.dropTargetDir ?? fileDrop.externalTargetDir;
    const rootIsDropTarget =
      dropTargetDir != null && dropTargetDir === rootPath;
    useEffect(() => {
      if (!dropTargetDir || dropTargetDir === rootPath) return;
      if (tree.expanded.has(dropTargetDir)) return;
      const id = window.setTimeout(() => tree.expand(dropTargetDir), 700);
      return () => window.clearTimeout(id);
    }, [dropTargetDir, rootPath, tree.expanded, tree.expand]);

    useEffect(() => {
      if (selectedPathsProp) return;
      if (selectedPaths.some((path) => !entryIndexByPath.has(path))) {
        setLocalSelectedPaths((paths) =>
          paths.filter((path) => entryIndexByPath.has(path)),
        );
      }
    }, [entryIndexByPath, selectedPaths, selectedPathsProp]);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        if (sharedScroll) {
          const element = [
            ...(scrollRef.current?.querySelectorAll<HTMLElement>(
              "[data-fs-path]",
            ) ?? []),
          ].find((candidate) => candidate.dataset.fsPath === path);
          element?.scrollIntoView({ block: "nearest" });
          return;
        }
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, sharedScroll, virtualizer],
    );

    const lastSyncedActivePathRef = useRef<string | null>(null);
    useEffect(() => {
      if (
        !activeFilePath ||
        activeFilePath === lastSyncedActivePathRef.current
      ) {
        return;
      }
      if (!entryIndexByPath.has(activeFilePath)) return;
      lastSyncedActivePathRef.current = activeFilePath;
      selectPath(activeFilePath, false);
      requestAnimationFrame(() => scrollEntryIntoView(activeFilePath));
    }, [activeFilePath, entryIndexByPath, scrollEntryIntoView, selectPath]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          containerRef.current?.focus();
          if (!selectedPath && entryPaths.length > 0) {
            const first = entryPaths[0];
            selectPath(first, false);
            requestAnimationFrame(() => scrollEntryIntoView(first));
          }
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
        focusSearch: () => {
          setIsSearchOpen(true);
          searchRef.current?.focus();
        },
        createFile: () => {
          if (rootPath) tree.beginCreate(rootPath, "file");
        },
        createFolder: () => {
          if (rootPath) tree.beginCreate(rootPath, "dir");
        },
        refresh: () => {
          if (rootPath) tree.refresh(rootPath);
        },
      }),
      [
        entryPaths,
        scrollEntryIntoView,
        selectedPath,
        selectPath,
        rootPath,
        tree.beginCreate,
        tree.refresh,
      ],
    );

    useGlobalShortcuts({
      "explorer.search": () => {
        if (searchRef.current?.isFocused()) {
          setIsSearchOpen(false);
          return;
        }
        setIsSearchOpen(true);
        searchRef.current?.focus();
      },
    });

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            {t("No current directory")}
          </div>
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || isSearchOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      if (entryPaths.length === 0) return;

      const currentIdx = selectedPath ? entryPaths.indexOf(selectedPath) : -1;
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(entryPaths.length - 1, next));
        const path = entryPaths[clamped];
        selectPath(path, false);
        requestAnimationFrame(() => scrollEntryIntoView(path));
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(currentIdx < 0 ? 0 : currentIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(currentIdx < 0 ? entryPaths.length - 1 : currentIdx - 1);
          break;
        case "ArrowRight": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else move(currentIdx + 1);
          }
          break;
        }
        case "ArrowLeft": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) selectPath(parent, false);
          }
          break;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              actions={rowActions}
              renameInProgress={renameInProgress}
              isSelected={selectedPaths.includes(row.path)}
              isRenaming={row.kind === "rename"}
              isDropTarget={dropTargetDir === row.path}
              onOpenFile={onOpenFile}
              onSelectPath={(path, multi) => {
                selectPath(path, multi);
              }}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow
              depth={row.depth}
              message={row.message}
              tone={row.tone}
            />
          );
      }
    };

    const menuPaths = selectedPaths.length
      ? selectedPaths
      : menuTarget
        ? [menuTarget.path]
        : [];
    const copyPathLabel = menuPaths.length > 1 ? "Copy Paths" : "Copy Path";
    const visibleRows = sharedScroll
      ? rows.map((row, index) => ({
          key: row.key,
          index,
          start: index * ROW_HEIGHT,
          size: ROW_HEIGHT,
        }))
      : virtualizer.getVirtualItems();

    return (
      <div
        ref={containerRef}
        data-fs-path={rootPath ?? undefined}
        data-fs-kind="dir"
        className={cn(
          "min-w-0 outline-none",
          !sharedScroll && "flex h-full flex-col",
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={onActivateRoot}
      >
        {showToolbar ? (
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => setIsSearchOpen((v) => !v)}
              title={t("Search files")}
              aria-label={t("Search files")}
            >
              <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => tree.beginCreate(rootPath, "file")}
              title={t("New file")}
            >
              <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => tree.beginCreate(rootPath, "dir")}
              title={t("New folder")}
            >
              <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => tree.refresh(rootPath)}
              title={t("Refresh")}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
            </Button>
          </div>
        ) : null}

        <ExplorerSearch
          ref={searchRef}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          open={isSearchOpen}
          onRequestClose={() => setIsSearchOpen(false)}
          onActiveChange={setIsSearchActive}
          onRevealInTerminal={onRevealInTerminal}
          onAddAsRoot={onAddAsRoot}
          onCopyPaths={onCopyPaths}
          onCutPaths={onCutPaths}
          clipboardAvailable={clipboardAvailable}
          onPasteTo={onPasteTo}
          selectedPaths={selectedPaths}
          onSelectPath={selectPath}
        />

        {!isSearchActive ? (
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) setDeleteConfirm(false);
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                data-explorer-drop=""
                className={cn(
                  sharedScroll
                    ? "min-w-0 overflow-visible"
                    : "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
                  rootIsDropTarget &&
                    "rounded-sm ring-1 ring-inset ring-primary/50",
                )}
                onPointerDown={dnd.onPointerDown}
                onClickCapture={dnd.onClickCapture}
                onContextMenuCapture={(e) => {
                  const el = (e.target as HTMLElement).closest<HTMLElement>(
                    "[data-fs-path]",
                  );
                  const path = el?.getAttribute("data-fs-path") ?? null;
                  const idx =
                    path != null ? entryIndexByPath.get(path) : undefined;
                  const row = idx !== undefined ? rows[idx] : undefined;
                  if (row && row.kind === "entry") {
                    if (!selectedPaths.includes(row.path)) {
                      selectPath(row.path, false);
                    }
                    setMenuTarget({
                      path: row.path,
                      name: row.name,
                      isDir: row.isDir,
                    });
                  } else {
                    setMenuTarget(null);
                  }
                  setDeleteConfirm(false);
                  setMenuNonce((n) => n + 1);
                }}
              >
                {pendingAtRoot ? (
                  <div
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir"
                          ? t("New folder")
                          : t("New file")
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={
                      sharedScroll
                        ? { width: "100%" }
                        : {
                            height: virtualizer.getTotalSize(),
                            position: "relative",
                            width: "100%",
                          }
                    }
                  >
                    {visibleRows.map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={
                            sharedScroll
                              ? undefined
                              : {
                                  position: "absolute",
                                  top: 0,
                                  left: 0,
                                  width: "100%",
                                  height: virtualRow.size,
                                  transform: `translateY(${virtualRow.start}px)`,
                                }
                          }
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              key={menuNonce}
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {menuTarget ? (
                <>
                  {!menuTarget.isDir && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenFile(menuTarget.path, true)}
                    >
                      {t("Open")}
                    </ContextMenuItem>
                  )}
                  {!menuTarget.isDir && onOpenFileToSide && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenFileToSide(menuTarget.path)}
                    >
                      {t("Open in Side")}
                    </ContextMenuItem>
                  )}
                  {onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() =>
                        onRevealInTerminal(
                          menuTarget.isDir
                            ? menuTarget.path
                            : parentOf(menuTarget.path, rootPath),
                        )
                      }
                    >
                      {t("Open in Terminal")}
                    </ContextMenuItem>
                  )}
                  {onAddAsRoot && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() =>
                        onAddAsRoot(
                          menuTarget.isDir
                            ? menuTarget.path
                            : parentOf(menuTarget.path, rootPath),
                        )
                      }
                    >
                      {t("Add folder to workspace")}
                    </ContextMenuItem>
                  )}
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
                  {clipboardAvailable && onPasteTo && menuTarget.isDir ? (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onPasteTo(menuTarget.path)}
                    >
                      {t("Paste")}
                    </ContextMenuItem>
                  ) : null}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    disabled={menuPaths.length > 1}
                    onSelect={() => tree.beginRename(menuTarget.path)}
                  >
                    {t("Rename")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void revealInFinder(menuTarget.path)}
                  >
                    {t("Reveal in Finder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator className="my-0.5" />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "file",
                      )
                    }
                  >
                    {t("New file")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "dir",
                      )
                    }
                  >
                    {t("New folder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator className="my-0.5" />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(menuPaths.join("\n"))}
                  >
                    {t(copyPathLabel)}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      void copyToClipboard(
                        relativePath(rootPath, menuTarget.path),
                      )
                    }
                  >
                    {t("Copy Relative Path")}
                  </ContextMenuItem>
                  <ContextMenuSeparator className="my-0.5" />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    variant="destructive"
                    onSelect={(e) => {
                      if (deleteConfirm) {
                        if (onDeletePaths) onDeletePaths(menuPaths);
                        else void tree.deletePath(menuTarget.path);
                      } else {
                        // Keep the menu open on the first click so the user
                        // can confirm; let it close normally on the second.
                        e.preventDefault();
                        setDeleteConfirm(true);
                      }
                    }}
                  >
                    {deleteConfirm ? t("Click again to confirm") : t("Delete")}
                  </ContextMenuItem>
                </>
              ) : (
                <>
                  {clipboardAvailable && onPasteTo ? (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onPasteTo(rootPath)}
                    >
                      {t("Paste")}
                    </ContextMenuItem>
                  ) : null}
                  {onRequestAddRoot && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={onRequestAddRoot}
                    >
                      {t("Add folder to workspace")}
                    </ContextMenuItem>
                  )}
                  {onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onRevealInTerminal(rootPath)}
                    >
                      {t("Open in Terminal")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void revealInFinder(rootPath)}
                  >
                    {t("Reveal in Finder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator className="my-0.5" />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "file")}
                  >
                    {t("New file")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "dir")}
                  >
                    {t("New folder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator className="my-0.5" />
                  {menuPaths.length > 0 ? (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() =>
                        void copyToClipboard(menuPaths.join("\n"))
                      }
                    >
                      {t(copyPathLabel)}
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => void copyToClipboard(rootPath)}
                    >
                      {t("Copy Path")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.refresh(rootPath)}
                  >
                    {t("Refresh")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        {dnd.dragLabel ? (
          <div
            ref={dnd.ghostRef}
            className="pointer-events-none fixed left-0 top-0 z-50 flex items-center gap-1.5 rounded-sm border border-border/70 bg-card/95 px-2 py-1 text-[12px] text-foreground shadow-md"
          >
            {dnd.dragLabel}
          </div>
        ) : null}
      </div>
    );
  }),
);
