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
  PlusSignIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useT } from "@/lib/i18n";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "./lib/contextActions";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { RootTree, type RootTreeHandle, type RootTreeProps } from "./RootTree";
import { folderIconUrl } from "./lib/iconResolver";
import { useFileTransfer } from "./lib/useFileTransfer";
import { useSelectedFileMeta } from "./lib/useSelectedFileMeta";
import { useWorkspaceFolderDrop } from "./lib/useWorkspaceFolderDrop";
import { ExplorerStatusBar } from "./ExplorerStatusBar";
import { ScrollArea } from "@/components/ui/scroll-area";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
  focusSearch: () => void;
};

type Props = Omit<
  RootTreeProps,
  | "rootPath"
  | "selectedPaths"
  | "onSelectPath"
  | "onActivateRoot"
  | "showToolbar"
  | "onAddAsRoot"
  | "onRequestAddRoot"
> & {
  /** Imported workspace roots (forward-slash absolute paths). */
  roots: string[];
  activeRoot: string | null;
  onAddRoot: (path: string) => void;
  onRemoveRoot: (path: string) => void;
  onSetActiveRoot: (path: string | null) => void;
};

type ClipboardKind = "files" | "directories" | "mixed";

type ExternalFileClipboard = {
  paths: string[];
  mode: "copy" | "move";
};

/** 提取工作区根目录的最后一级名称。 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** 为文件树空白区域提供稳定的添加工作区目录菜单。 */
function EmptyExplorerContextMenu({
  onAddFolder,
  onPaste,
  children,
}: {
  onAddFolder: () => void;
  onPaste?: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={COMPACT_CONTENT}>
        {onPaste ? (
          <ContextMenuItem className={COMPACT_ITEM} onSelect={onPaste}>
            {t("Paste")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem className={COMPACT_ITEM} onSelect={onAddFolder}>
          {t("Add folder to workspace")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 保留项目根目录的可见分组与独立管理入口。 */
function RootSection({
  root,
  active,
  onActivate,
  onRemove,
  onCopy,
  onAddFolder,
  onOpenTerminal,
  onPaste,
  children,
}: {
  root: string;
  active: boolean;
  onActivate: () => void;
  onRemove: () => void;
  onCopy: () => void;
  onAddFolder: () => void;
  onOpenTerminal?: () => void;
  onPaste?: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <div
      className="flex min-w-0 flex-col"
      data-explorer-drop=""
      data-fs-path={root}
      data-fs-kind="dir"
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "flex h-7 shrink-0 cursor-pointer items-center gap-1 border-b border-border/60 px-2 text-xs font-medium select-none",
              active
                ? "bg-accent/60 text-accent-foreground"
                : "text-foreground/80 hover:bg-muted/50",
            )}
            onClick={() => {
              onActivate();
              setOpen((value) => !value);
            }}
            title={root}
          >
            <button
              type="button"
              className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setOpen((value) => !value);
              }}
              aria-label={open ? t("Collapse") : t("Expand")}
            >
              <span className="inline-block text-[10px] leading-4">
                {open ? "▾" : "▸"}
              </span>
            </button>
            <img
              src={folderIconUrl(basename(root), false)}
              alt=""
              height={14}
              width={14}
              className="mx-0.5 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">
              {basename(root) || root}
            </span>
            <button
              type="button"
              className="size-4 shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
              aria-label={t("Remove root")}
              title={t("Remove from workspace")}
            >
              <span className="inline-block text-[11px] leading-4">×</span>
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className={COMPACT_CONTENT}>
          {onPaste ? (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={onPaste}>
              {t("Paste")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem className={COMPACT_ITEM} onSelect={onAddFolder}>
            {t("Add folder to workspace")}
          </ContextMenuItem>
          {onOpenTerminal ? (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={onOpenTerminal}>
              {t("New terminal")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator className="my-0.5" />
          <ContextMenuItem className={COMPACT_ITEM} onSelect={onCopy}>
            {t("Copy Path")}
          </ContextMenuItem>
          <ContextMenuSeparator className="my-0.5" />
          <ContextMenuItem className={COMPACT_ITEM} onSelect={onRemove}>
            {t("Remove from workspace")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open ? <div className="min-w-0 pt-1">{children}</div> : null}
    </div>
  );
}

export const FileExplorer = memo(
  forwardRef<FileExplorerHandle, Props>(function FileExplorer(
    {
      roots,
      activeRoot,
      onAddRoot,
      onRemoveRoot,
      onSetActiveRoot,
      ...treeProps
    },
    ref,
  ) {
    const t = useT();
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [clipboard, setClipboard] = useState<{
      paths: string[];
      mode: "copy" | "move";
      kind: ClipboardKind;
    } | null>(null);
    const [externalClipboard, setExternalClipboard] =
      useState<ExternalFileClipboard | null>(null);
    const transfer = useFileTransfer();
    const selectedMeta = useSelectedFileMeta(treeProps.activeFilePath ?? null);
    const containerRef = useRef<HTMLDivElement>(null);
    const treeRefs = useRef<Map<string, RootTreeHandle>>(new Map());
    const refreshedTransferIds = useRef<Set<string>>(new Set());
    const { onPathDeleted } = treeProps;

    /** 查询 Windows 外部文件剪贴板，供 Ctrl+V 和右键菜单使用。 */
    const refreshExternalClipboard = useCallback(async () => {
      const value = await invoke<ExternalFileClipboard | null>(
        "fs_get_file_clipboard",
      ).catch(() => null);
      setExternalClipboard(value && value.paths.length > 0 ? value : null);
    }, []);

    useEffect(() => {
      void refreshExternalClipboard();
      const onWindowFocus = () => void refreshExternalClipboard();
      window.addEventListener("focus", onWindowFocus);
      return () => window.removeEventListener("focus", onWindowFocus);
    }, [refreshExternalClipboard]);

    /** 将文件路径转换为当前文件树内部可执行的父目录。 */
    const parentPath = useCallback((path: string): string => {
      const index = path.lastIndexOf("/");
      return index > 0 ? path.slice(0, index) : path;
    }, []);

    /** 判断应用内剪切板内容是否全部为文件。 */
    const detectClipboardKind = useCallback(async (paths: string[]) => {
      const stats = await Promise.all(
        paths.map((path) =>
          invoke<{ kind: "file" | "dir" | "symlink" }>("fs_stat", {
            path,
            workspace: currentWorkspaceEnv(),
          }).catch(() => null),
        ),
      );
      if (stats.every((stat) => stat?.kind === "file")) return "files";
      if (stats.every((stat) => stat?.kind === "dir")) return "directories";
      return "mixed";
    }, []);

    /** 将选中路径放入应用内复制剪切板，不写入系统文本剪贴板。 */
    const copyPaths = useCallback(
      async (paths: string[]) => {
        const uniquePaths = [...new Set(paths)];
        if (uniquePaths.length === 0) return;
        const kind = await detectClipboardKind(uniquePaths);
        transfer.clear();
        setClipboard({ paths: uniquePaths, mode: "copy", kind });
        toast.success(`已复制 ${uniquePaths.length} 项`);
      },
      [detectClipboardKind, transfer.clear],
    );

    /** 将选中路径放入应用内剪切剪贴板。 */
    const cutPaths = useCallback(
      async (paths: string[]) => {
        const uniquePaths = [...new Set(paths)];
        if (uniquePaths.length === 0) return;
        const kind = await detectClipboardKind(uniquePaths);
        transfer.clear();
        setClipboard({ paths: uniquePaths, mode: "move", kind });
        toast.success(`已剪切 ${uniquePaths.length} 项`);
      },
      [detectClipboardKind, transfer.clear],
    );

    /** 将复制、剪切和拖拽统一提交到后台迁移任务。 */
    const startTransfer = useCallback(
      (sources: string[], toDir: string, copy: boolean) => {
        void transfer.start(sources, toDir, copy ? "copy" : "move");
      },
      [transfer.start],
    );

    /** 处理系统文件拖入，统一作为复制任务执行。 */
    const startExternalCopy = useCallback(
      (sources: string[], toDir: string) => {
        startTransfer(sources, toDir, true);
      },
      [startTransfer],
    );

    /** 将外部拖入的目录直接登记为新的工作区根目录。 */
    const addDroppedRoots = useCallback(
      (paths: string[]) => {
        for (const path of paths) onAddRoot(path.replace(/\\/g, "/"));
      },
      [onAddRoot],
    );

    useWorkspaceFolderDrop({ onAddRoot: addDroppedRoots });

    /** 删除当前右键选中的文件或目录，并同步编辑器路径状态。 */
    const deletePaths = useCallback(
      async (paths: string[]) => {
        for (const path of paths) {
          try {
            await invoke("fs_delete", {
              path,
              workspace: currentWorkspaceEnv(),
            });
            onPathDeleted?.(path);
            const parent = parentPath(path);
            for (const [root, tree] of treeRefs.current) {
              if (parent === root || parent.startsWith(`${root}/`)) {
                tree.refreshPath(parent);
                break;
              }
            }
          } catch (error) {
            toast.error(`删除失败：${String(error)}`);
          }
        }
        setSelectedPaths([]);
      },
      [onPathDeleted, parentPath],
    );

    /** 通过 Ctrl+V 将应用内或系统文件剪贴板迁移到当前选中的目录。 */
    const pasteClipboard = useCallback(
      async (targetDirectory?: string) => {
        let pending = clipboard
          ? { paths: clipboard.paths, mode: clipboard.mode }
          : externalClipboard;
        if (!pending) {
          pending = await invoke<ExternalFileClipboard | null>(
            "fs_get_file_clipboard",
          ).catch(() => null);
          setExternalClipboard(
            pending && pending.paths.length > 0 ? pending : null,
          );
        }
        if (!pending || pending.paths.length === 0) return;
        const selected = selectedPaths[selectedPaths.length - 1];
        const destination =
          targetDirectory ?? selected ?? activeRoot ?? roots[0];
        if (!destination) return;
        try {
          let toDir = targetDirectory;
          if (!toDir) {
            const stat = await invoke<{ kind: "file" | "dir" | "symlink" }>(
              "fs_stat",
              { path: destination, workspace: currentWorkspaceEnv() },
            );
            toDir = stat.kind === "dir" ? destination : parentPath(destination);
          }
          const result = await transfer.start(
            pending.paths,
            toDir,
            pending.mode === "copy" ? "copy" : "move",
          );
          if (pending.mode === "move" && result?.status === "completed") {
            setClipboard(null);
            setExternalClipboard(null);
          }
        } catch (error) {
          toast.error(`迁移启动失败：${String(error)}`);
        }
      },
      [
        activeRoot,
        clipboard,
        externalClipboard,
        parentPath,
        roots,
        selectedPaths,
        transfer.start,
      ],
    );

    const pasteAvailable = clipboard !== null || externalClipboard !== null;

    /** 仅在文件树获得焦点时接管复制、剪切、粘贴快捷键。 */
    const handleExplorerKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (
          target.closest("input, textarea, [contenteditable='true']") ||
          !(event.ctrlKey || event.metaKey)
        ) {
          return;
        }
        const key = event.key.toLowerCase();
        if (key === "c" && selectedPaths.length > 0) {
          event.preventDefault();
          copyPaths(selectedPaths);
        } else if (key === "x" && selectedPaths.length > 0) {
          event.preventDefault();
          cutPaths(selectedPaths);
        } else if (key === "v" && pasteAvailable) {
          event.preventDefault();
          void pasteClipboard();
        }
      },
      [copyPaths, cutPaths, pasteAvailable, pasteClipboard, selectedPaths],
    );

    useEffect(() => {
      const current = transfer.event;
      if (
        !current ||
        (current.status !== "completed" &&
          current.status !== "failed" &&
          current.status !== "cancelled") ||
        refreshedTransferIds.current.has(current.id)
      ) {
        return;
      }
      refreshedTransferIds.current.add(current.id);
      for (const tree of treeRefs.current.values()) tree.refresh();
    }, [transfer.event]);

    /** 直接打开系统目录选择器并把所选目录加入工作区。 */
    const requestAddFolder = useCallback(() => {
      void open({
        directory: true,
        multiple: false,
        title: t("Select folder"),
      })
        .then((result) => {
          if (typeof result === "string") onAddRoot(result.replace(/\\/g, "/"));
        })
        .catch((cause) => {
          console.error("[Codev] folder picker failed:", cause);
        });
    }, [onAddRoot, t]);

    /** 更新整个侧栏共享的 Ctrl/⌘ 多选路径集合。 */
    const selectPath = useCallback((path: string, multi: boolean) => {
      setSelectedPaths((paths) => {
        if (!multi) return [path];
        return paths.includes(path)
          ? paths.filter((item) => item !== path)
          : [...paths, path];
      });
    }, []);

    /** 移除项目根目录时同步清理侧栏中的选中路径。 */
    const removeRoot = useCallback(
      (root: string) => {
        setSelectedPaths((paths) =>
          paths.filter((path) => path !== root && !path.startsWith(`${root}/`)),
        );
        onRemoveRoot(root);
      },
      [onRemoveRoot],
    );

    const getActiveTree = useCallback((): RootTreeHandle | null => {
      if (activeRoot) return treeRefs.current.get(activeRoot) ?? null;
      return null;
    }, [activeRoot]);

    /** 将搜索命中的目录路由到拥有它的工作区根树。 */
    const revealSearchDirectory = useCallback(
      (path: string) => {
        const target = path.replace(/\\/g, "/").replace(/\/+$/, "");
        let owner: string | null = null;
        for (const root of roots) {
          const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
          if (
            (target === normalized || target.startsWith(`${normalized}/`)) &&
            (!owner || normalized.length > owner.length)
          ) {
            owner = root;
          }
        }
        if (owner) treeRefs.current.get(owner)?.revealPath(path);
      },
      [roots],
    );

    /** 在当前项目根打开文件搜索。 */
    const focusActiveSearch = useCallback(() => {
      getActiveTree()?.focusSearch();
    }, [getActiveTree]);

    /** 在当前项目根创建文件。 */
    const createActiveFile = useCallback(() => {
      getActiveTree()?.createFile();
    }, [getActiveTree]);

    /** 在当前项目根创建文件夹。 */
    const createActiveFolder = useCallback(() => {
      getActiveTree()?.createFolder();
    }, [getActiveTree]);

    /** 刷新当前项目根的文件树。 */
    const refreshActiveRoot = useCallback(() => {
      getActiveTree()?.refresh();
    }, [getActiveTree]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          getActiveTree()?.focus() ?? containerRef.current?.focus();
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
        focusSearch: () => getActiveTree()?.focusSearch(),
      }),
      [getActiveTree],
    );

    return (
      <div
        ref={containerRef}
        className="flex h-full flex-col outline-none"
        tabIndex={0}
        role="tree"
        onKeyDown={handleExplorerKeyDown}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2"
              data-workspace-folder-drop=""
            >
              <span className="flex min-w-0 flex-1 items-center truncate text-xs font-medium text-foreground/80">
                {t("Workspace")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-35"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  focusActiveSearch();
                }}
                disabled={!activeRoot}
                title={t("Search files")}
                aria-label={t("Search files")}
              >
                <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-35"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  createActiveFile();
                }}
                disabled={!activeRoot}
                title={t("New file")}
                aria-label={t("New file")}
              >
                <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-35"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  createActiveFolder();
                }}
                disabled={!activeRoot}
                title={t("New folder")}
                aria-label={t("New folder")}
              >
                <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground disabled:opacity-35"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  refreshActiveRoot();
                }}
                disabled={!activeRoot}
                title={t("Refresh")}
                aria-label={t("Refresh")}
              >
                <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  requestAddFolder();
                }}
                title={t("Add folder to workspace")}
                aria-label={t("Add folder to workspace")}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
              </Button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className={COMPACT_CONTENT}>
            {pasteAvailable && activeRoot ? (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void pasteClipboard(activeRoot)}
              >
                {t("Paste")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={requestAddFolder}
            >
              {t("Add folder to workspace")}
            </ContextMenuItem>
            {roots.length > 0 ? (
              <>
                <ContextMenuSeparator className="my-0.5" />
                {roots.map((root) => (
                  <ContextMenuItem
                    key={`copy:${root}`}
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(root)}
                  >
                    {t("Copy Path")} · {basename(root)}
                  </ContextMenuItem>
                ))}
                {roots.map((root) => (
                  <ContextMenuItem
                    key={`remove:${root}`}
                    className={COMPACT_ITEM}
                    onSelect={() => removeRoot(root)}
                  >
                    {t("Remove from workspace")} · {basename(root)}
                  </ContextMenuItem>
                ))}
              </>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>

        {roots.length === 0 ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
                data-workspace-folder-drop=""
              >
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={24}
                  strokeWidth={1.5}
                  className="text-muted-foreground"
                />
                <div className="text-xs text-muted-foreground">
                  {t("No folders in workspace")}
                </div>
                <div className="text-[11px] text-muted-foreground/70">
                  {t("Choose a project folder to add to the file tree.")}
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className={COMPACT_CONTENT}>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={requestAddFolder}
              >
                {t("Add folder to workspace")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <EmptyExplorerContextMenu
            onAddFolder={requestAddFolder}
            onPaste={
              pasteAvailable && activeRoot
                ? () => void pasteClipboard(activeRoot)
                : undefined
            }
          >
            <div
              className="min-h-0 min-w-0 flex-1"
              data-explorer-empty=""
            >
              <ScrollArea className="h-full min-h-0 min-w-0">
                <div className="min-w-0">
                  {roots.map((root) => (
                    <RootSection
                      key={root}
                      root={root}
                      active={root === activeRoot}
                      onActivate={() => onSetActiveRoot(root)}
                      onRemove={() => removeRoot(root)}
                      onCopy={() => void copyToClipboard(root)}
                      onAddFolder={requestAddFolder}
                      onOpenTerminal={
                        treeProps.onRevealInTerminal
                          ? () => treeProps.onRevealInTerminal?.(root)
                          : undefined
                      }
                      onPaste={
                        pasteAvailable
                          ? () => void pasteClipboard(root)
                          : undefined
                      }
                    >
                      <RootTree
                        ref={(h) => {
                          if (h) treeRefs.current.set(root, h);
                          else treeRefs.current.delete(root);
                        }}
                        rootPath={root}
                        onAddAsRoot={onAddRoot}
                        onRequestAddRoot={requestAddFolder}
                        selectedPaths={selectedPaths}
                        onSelectPath={selectPath}
                        onActivateRoot={() => onSetActiveRoot(root)}
                        showToolbar={false}
                        {...treeProps}
                        onRevealDirectory={revealSearchDirectory}
                        searchRoots={roots}
                        onTransfer={startTransfer}
                        onExternalCopy={startExternalCopy}
                        onCopyPaths={copyPaths}
                        onCutPaths={cutPaths}
                        onDeletePaths={deletePaths}
                        clipboardAvailable={pasteAvailable}
                        onPasteTo={(path) => void pasteClipboard(path)}
                        sharedScroll
                      />
                    </RootSection>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </EmptyExplorerContextMenu>
        )}
        <ExplorerStatusBar
          transfer={transfer.event}
          selectedMeta={selectedMeta}
          clipboard={
            clipboard
              ? { mode: clipboard.mode, count: clipboard.paths.length }
              : null
          }
          onCancel={() => void transfer.cancel()}
          onUndo={() => void transfer.undo()}
          onClear={transfer.clear}
        />
      </div>
    );
  }),
);
