import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import { InlineInput } from "./InlineInput";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import type { FileVcsIndicator, VcsBadgeTone } from "@/modules/vcs/store";

const TREE_BASE_INDENT = 12;
const TREE_DEPTH_INDENT = 12;

const VCS_TEXT_TONE: Record<VcsBadgeTone, string> = {
  modified: "text-amber-300",
  added: "text-emerald-400",
  deleted: "text-rose-400 line-through opacity-80",
  untracked: "text-sky-300",
  conflict: "text-red-400 font-medium",
};

const VCS_BADGE_TONE: Record<VcsBadgeTone, string> = {
  modified: "text-amber-400",
  added: "text-emerald-400",
  deleted: "text-rose-400",
  untracked: "text-sky-400",
  conflict: "text-red-400 font-bold",
};

export type RowActions = {
  toggle: (path: string) => void;
  beginRename: (path: string) => void;
  commitRename: (newName: string) => void | Promise<void>;
  cancelRename: () => void;
};

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  actions: RowActions;
  renameInProgress: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  isDropTarget?: boolean;
  vcsBadge?: FileVcsIndicator | null;
  vcsDirTone?: VcsBadgeTone | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string, multi: boolean) => void;
};

/** 渲染文件树条目并处理单选、多选、展开和重命名。 */
function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    actions,
    renameInProgress,
    isSelected,
    isRenaming,
    isDropTarget = false,
    vcsBadge = null,
    vcsDirTone = null,
    onOpenFile,
    onSelectPath,
  } = props;

  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  const paddingLeft = TREE_BASE_INDENT + depth * TREE_DEPTH_INDENT;

  if (isRenaming) {
    return (
      <div
        className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
        style={{ paddingLeft }}
      >
        <span className="size-3.5 shrink-0" />
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-4 shrink-0" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <InlineInput
          initial={name}
          onCommit={actions.commitRename}
          onCancel={actions.cancelRename}
        />
      </div>
    );
  }

  /** 处理文件树普通点击与 Ctrl/⌘ 多选点击。 */
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (renameInProgress) return;
    const multi = e.ctrlKey || e.metaKey;
    onSelectPath(path, multi);
    if (multi) return;
    if (isDir) actions.toggle(path);
    else onOpenFile(path);
  };

  return (
    <button
      type="button"
      data-fs-path={path}
      data-fs-kind={isDir ? "dir" : "file"}
      onClick={handleClick}
      onDoubleClick={() => actions.beginRename(path)}
      className={cn(
        "group relative flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm border border-transparent px-1.5 text-left text-[13px] transition-colors hover:bg-accent/70",
        isSelected &&
          "border-primary/35 bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_10%,transparent)] hover:bg-primary/16",
        isDropTarget && "bg-primary/10 ring-1 ring-inset ring-primary/60",
      )}
      style={{ paddingLeft }}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {isDir ? (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2.25}
            className={cn("transition-transform", isExpanded && "rotate-90")}
          />
        ) : null}
      </span>
      {isSelected && (
        <span className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-primary" />
      )}
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-4 shrink-0" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          vcsBadge ? VCS_TEXT_TONE[vcsBadge.tone] : vcsDirTone ? VCS_TEXT_TONE[vcsDirTone] : "",
        )}
      >
        {name}
      </span>
      {vcsBadge ? (
        <span
          className={cn(
            "ml-1 shrink-0 font-mono text-[10px] leading-none",
            VCS_BADGE_TONE[vcsBadge.tone],
          )}
          title={vcsBadge.staged ? "已暂存" : "未暂存"}
        >
          {vcsBadge.code}
        </span>
      ) : vcsDirTone ? (
        <span
          aria-hidden="true"
          className={cn(
            "ml-1 size-1.5 shrink-0 rounded-full",
            vcsDirTone === "conflict"
              ? "bg-red-400"
              : vcsDirTone === "added" || vcsDirTone === "untracked"
                ? "bg-emerald-400/80"
                : "bg-amber-400/80",
          )}
        />
      ) : null}
    </button>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: PendingRowProps) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{
        paddingLeft: TREE_BASE_INDENT + depth * TREE_DEPTH_INDENT,
      }}
    >
      <span className="size-3.5 shrink-0" />
      <img
        src={
          kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")
        }
        alt=""
        className="size-4 shrink-0 opacity-70"
      />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{
        paddingLeft: TREE_BASE_INDENT + depth * TREE_DEPTH_INDENT + 18,
      }}
    >
      {message}
    </div>
  );
}
