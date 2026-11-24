import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVcsStore } from "@/modules/vcs/store";
import { normalizeVcsPath, type VcsCommit } from "@/modules/vcs/types";
import { type OpenVcsDiffInput, VcsPanel } from "@/modules/vcs/VcsPanel";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** 多根工作区统一弹出的 Git 模态工作台（不切换左侧文件树）。 */
export function VcsModal({
  open,
  onOpenChange,
  workspaceRoots,
  initialRoot,
  onOpenDiff,
  onOpenHistory,
  onSwitchWorkspaceRoot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceRoots: string[];
  initialRoot: string | null;
  onOpenDiff: (input: OpenVcsDiffInput) => void;
  onOpenHistory: (input: { repoRoot: string; commits: VcsCommit[] }) => void;
  onSwitchWorkspaceRoot?: (cwd: string) => void;
}) {
  const snapshots = useVcsStore((s) => s.snapshots);

  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ path: string; label: string; branch?: string }> = [];
    for (const root of workspaceRoots) {
      const key = normalizeVcsPath(root);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const snap = Object.values(snapshots).find((s) => {
        const sr = normalizeVcsPath(s.worktreeRoot);
        return key === sr || key.startsWith(`${sr}/`);
      });
      list.push({
        path: root,
        label: folderLabel(root),
        branch: snap?.branch,
      });
    }
    if (initialRoot) {
      const key = normalizeVcsPath(initialRoot);
      if (key && !seen.has(key)) {
        seen.add(key);
        list.unshift({
          path: initialRoot,
          label: folderLabel(initialRoot),
        });
      }
    }
    return list;
  }, [workspaceRoots, snapshots, initialRoot]);

  const [selectedRoot, setSelectedRoot] = useState<string | null>(
    initialRoot ?? workspaceRoots[0] ?? null,
  );

  useEffect(() => {
    if (!open) return;
    if (initialRoot) {
      setSelectedRoot(initialRoot);
      return;
    }
    setSelectedRoot((cur) => cur ?? candidates[0]?.path ?? null);
  }, [open, initialRoot, candidates]);

  const activeRepoRoot = selectedRoot ?? candidates[0]?.path ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[78vh] max-h-[760px] w-[min(92vw,760px)] max-w-[min(92vw,760px)]! flex-col gap-0 overflow-hidden rounded-xl border border-border/70 bg-card p-0 sm:max-w-[min(92vw,760px)]">
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 border-b border-border/60 px-3.5 py-2.5 pr-11">
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={15}
            className="shrink-0 text-muted-foreground"
          />
          <DialogTitle className="text-xs font-semibold">Git 工作台</DialogTitle>
          <DialogDescription className="sr-only">
            在弹窗中管理多根目录 Git 仓库、更改、历史和分支，不打断左侧文件树。
          </DialogDescription>
          {candidates.length > 0 && activeRepoRoot && (
            <div className="ml-2 flex min-w-0 flex-1 items-center">
              <Select
                value={activeRepoRoot}
                onValueChange={(value) => setSelectedRoot(value)}
              >
                <SelectTrigger className="h-7 max-w-[320px] text-[11px]">
                  <SelectValue placeholder="选择工作区目录" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((item) => (
                    <SelectItem key={item.path} value={item.path} className="text-[11px]">
                      {item.label}
                      {item.branch ? ` (${item.branch})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelErrorBoundary
            title="Git 工作台"
            onClose={() => onOpenChange(false)}
          >
            <VcsPanel
              key={activeRepoRoot ?? "none"}
              root={activeRepoRoot}
              hideBackButton
              onOpenDiff={(input) => {
                onOpenDiff(input);
                onOpenChange(false);
              }}
              onOpenHistory={(input) => {
                onOpenHistory(input);
                onOpenChange(false);
              }}
              onSwitchWorkspaceRoot={onSwitchWorkspaceRoot}
            />
          </PanelErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
