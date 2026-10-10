import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useGitStatus } from "./useGitStatus";

export function RootGitButton({
  root,
  onOpen,
}: {
  root: string;
  onOpen: (root: string) => void;
}) {
  const { snapshot, error, loading, refresh } = useGitStatus(root);
  if ((!snapshot || snapshot.empty) && !error) return null;
  const title = error
    ? `Git 检查失败：${error}；点击重试`
    : `Git · ${snapshot?.repo.branch} · ${snapshot?.repo.changes ?? 0} 个改动`;
  return (
    <button
      type="button"
      data-root-git=""
      disabled={!!error && loading}
      className={`flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring ${error ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
      title={title}
      aria-label={
        error ? "重试 Git 检查" : `打开 ${snapshot?.repo.name} 的 Git`
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (error) void refresh();
        else onOpen(root);
      }}
    >
      <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.5} />
    </button>
  );
}
