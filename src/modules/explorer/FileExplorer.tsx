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
import { open } from "@tauri-apps/plugin-dialog";
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "./lib/contextActions";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import {
  RootTree,
  type RootTreeHandle,
  type RootTreeProps,
} from "./RootTree";
import { folderIconUrl } from "./lib/iconResolver";

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

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** 为文件树空白区域提供稳定的添加工作区目录菜单。 */
function EmptyExplorerContextMenu({ onAddFolder }: { onAddFolder: () => void }) {
  const t = useT();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="min-h-8 min-w-0 flex-1" data-explorer-empty="" />
      </ContextMenuTrigger>
      <ContextMenuContent className={COMPACT_CONTENT}>
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
  children,
}: {
  root: string;
  active: boolean;
  onActivate: () => void;
  onRemove: () => void;
  onCopy: () => void;
  onAddFolder: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <div className="flex min-w-0 flex-col">
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
          <ContextMenuItem className={COMPACT_ITEM} onSelect={onAddFolder}>
            {t("Add folder to workspace")}
          </ContextMenuItem>
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
      {open ? <div className="min-w-0">{children}</div> : null}
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
    const containerRef = useRef<HTMLDivElement>(null);
    const treeRefs = useRef<Map<string, RootTreeHandle>>(new Map());

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
          console.error("[terax] folder picker failed:", cause);
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
          getActiveTree()?.focus() ??
            containerRef.current?.focus();
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
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
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
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
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
              <ContextMenuItem className={COMPACT_ITEM} onSelect={requestAddFolder}>
                {t("Add folder to workspace")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <div className="min-h-0 min-w-0 flex flex-1 flex-col overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
            {roots.map((root) => (
              <RootSection
                key={root}
                root={root}
                active={root === activeRoot}
                onActivate={() => onSetActiveRoot(root)}
                onRemove={() => removeRoot(root)}
                onCopy={() => void copyToClipboard(root)}
                onAddFolder={requestAddFolder}
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
                  sharedScroll
                />
              </RootSection>
            ))}
            <EmptyExplorerContextMenu onAddFolder={requestAddFolder} />
          </div>
        )}
      </div>
    );
  }),
);
