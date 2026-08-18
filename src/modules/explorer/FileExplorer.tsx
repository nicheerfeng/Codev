import { Button } from "@/components/ui/button";
import { Folder01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
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

type Props = Omit<RootTreeProps, "rootPath"> & {
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

function RootSection({
  root,
  active,
  onActivate,
  onRemove,
  children,
}: {
  root: string;
  active: boolean;
  onActivate: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        open && "flex-1",
      )}
    >
      <div
        className={cn(
          "flex h-7 shrink-0 cursor-pointer items-center gap-1 border-b border-border/60 px-2 text-xs font-medium select-none",
          active
            ? "bg-accent/60 text-accent-foreground"
            : "text-foreground/80 hover:bg-muted/50",
        )}
        onClick={onActivate}
        title={root}
      >
        <button
          type="button"
          className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-label={open ? "Collapse" : "Expand"}
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
        <span className="min-w-0 flex-1 truncate">{basename(root) || root}</span>
        <button
          type="button"
          className="size-4 shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove root"
          title="Remove from workspace"
        >
          <span className="inline-block text-[11px] leading-4">×</span>
        </button>
      </div>
      {open && <div className="min-h-0 flex-1">{children}</div>}
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
    const [drives, setDrives] = useState<string[]>([]);
    const [browsePath, setBrowsePath] = useState<string | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [addValue, setAddValue] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const treeRefs = useRef<Map<string, RootTreeHandle>>(new Map());
    const addInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (addOpen) addInputRef.current?.focus();
    }, [addOpen]);

    useEffect(() => {
      let cancelled = false;
      void invoke<string[]>("fs_list_drives")
        .then((d) => {
          if (!cancelled) setDrives(d);
        })
        .catch(() => {
          /* non-fatal: no drive strip */
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const getActiveTree = useCallback((): RootTreeHandle | null => {
      if (browsePath) return treeRefs.current.get("__browse") ?? null;
      if (activeRoot) return treeRefs.current.get(activeRoot) ?? null;
      return null;
    }, [browsePath, activeRoot]);

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

    const commitAdd = () => {
      const path = addValue.trim();
      if (path) onAddRoot(path);
      setAddValue("");
      setAddOpen(false);
    };

    const showDrives = drives.length > 1;

    return (
      <div
        ref={containerRef}
        className="flex h-full flex-col outline-none"
        tabIndex={0}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span className="flex min-w-0 flex-1 items-center truncate text-xs font-medium text-foreground/80">
            <HugeiconsIcon
              icon={Folder01Icon}
              size={14}
              strokeWidth={1.5}
              className="mx-1 shrink-0 text-muted-foreground"
            />
            Workspace
          </span>
          {!browsePath && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setAddOpen((v) => !v);
                setAddValue("");
              }}
              title="Add folder to workspace"
              aria-label="Add folder to workspace"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
            </Button>
          )}
        </div>

        {addOpen && (
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
            <input
              ref={addInputRef}
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAdd();
                if (e.key === "Escape") {
                  setAddOpen(false);
                  setAddValue("");
                }
              }}
              placeholder="Enter folder path, e.g. D:/projects"
              className="h-6 min-w-0 flex-1 rounded-sm border border-border/60 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={commitAdd}
            >
              Add
            </Button>
          </div>
        )}

        {showDrives && !browsePath && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
            {drives.map((d) => (
              <button
                type="button"
                key={d}
                className={cn(
                  "h-5 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
                  activeRoot === d && "bg-accent/60 text-accent-foreground",
                )}
                onClick={() => setBrowsePath(d)}
                title={d}
              >
                {d.replace(/\/$/, "")}
              </button>
            ))}
          </div>
        )}

        {browsePath ? (
          <>
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => setBrowsePath(null)}
                title="Back to workspace roots"
                aria-label="Back"
              >
                ←
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={browsePath}>
                {browsePath}
              </span>
            </div>
            <RootTree
              key="__browse"
              ref={(h) => {
                if (h) treeRefs.current.set("__browse", h);
                else treeRefs.current.delete("__browse");
              }}
              rootPath={browsePath}
              onAddAsRoot={onAddRoot}
              {...treeProps}
            />
          </>
        ) : roots.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <HugeiconsIcon
              icon={Folder01Icon}
              size={24}
              strokeWidth={1.5}
              className="text-muted-foreground"
            />
            <div className="text-xs text-muted-foreground">
              No folders in workspace
            </div>
            <div className="text-[11px] text-muted-foreground/70">
              {showDrives
                ? "Pick a drive above to browse, or add a folder path."
                : "Add a folder path above to browse it."}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {roots.map((root) => (
              <RootSection
                key={root}
                root={root}
                active={root === activeRoot}
                onActivate={() => onSetActiveRoot(root)}
                onRemove={() => onRemoveRoot(root)}
              >
                <RootTree
                  ref={(h) => {
                    if (h) treeRefs.current.set(root, h);
                    else treeRefs.current.delete(root);
                  }}
                  rootPath={root}
                  onAddAsRoot={onAddRoot}
                  {...treeProps}
                />
              </RootSection>
            ))}
          </div>
        )}
      </div>
    );
  }),
);
