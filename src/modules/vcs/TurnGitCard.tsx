import { Button } from "@/components/ui/button";
import { useVcsStore } from "@/modules/vcs/store";
import { parseVcsError, type VcsTurnDiffSummary } from "@/modules/vcs/types";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { toast } from "sonner";

/** 展示由宿主记录的本轮真实 Git 改动快照，并支持审阅 Diff、撤销与 AI 生成提交。 */
export function TurnGitCard({
  sessionId,
  summary,
  mobile = false,
  onOpenDiff,
}: {
  sessionId: string;
  summary: VcsTurnDiffSummary | null;
  mobile?: boolean;
  onOpenDiff?: (path: string, diff: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const revertTurnChanges = useVcsStore((s) => s.revertTurnChanges);
  const stage = useVcsStore((s) => s.stage);
  const aiCommit = useVcsStore((s) => s.aiCommit);
  const commit = useVcsStore((s) => s.commit);

  if (
    !summary ||
    (summary.changedFiles.length === 0 && summary.newCommits === 0)
  ) {
    return null;
  }

  const handleRevert = async () => {
    setBusy(true);
    try {
      await revertTurnChanges(sessionId);
      toast.success("已撤销本轮工作区改动");
    } catch (error) {
      toast.error(parseVcsError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAiCommit = async () => {
    if (!summary.changedFiles.length) return;
    setBusy(true);
    try {
      await stage(
        summary.worktreeRoot,
        summary.changedFiles.map((f) => f.path),
        true,
      );
      const msg = await aiCommit(summary.worktreeRoot);
      await commit(summary.worktreeRoot, msg);
      toast.success(`已提交：${msg}`);
    } catch (error) {
      toast.error(parseVcsError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="my-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-[11px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 select-none">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <HugeiconsIcon icon={GitBranchIcon} size={12} className="shrink-0 text-primary" />
          <span className="truncate">
            Git 基线改动 ({summary.branch}) · {summary.changedFiles.length} 个文件
            {summary.newCommits > 0 ? ` · +${summary.newCommits} 提交` : ""}
          </span>
        </span>
        {!mobile && (
          <span
            className="flex shrink-0 items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {summary.newCommits === 0 && summary.changedFiles.length > 0 && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-rose-400 hover:bg-destructive/15"
                  disabled={busy}
                  onClick={() => void handleRevert()}
                >
                  撤销本轮
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={busy}
                  onClick={() => void handleAiCommit()}
                >
                  AI 暂存提交
                </Button>
              </>
            )}
          </span>
        )}
      </summary>

      <div className="mt-1.5 space-y-0.5 border-t border-border/50 pt-1.5">
        {summary.changedFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() =>
              onOpenDiff?.(`${summary.worktreeRoot}/${file.path}`, "")
            }
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10.5px] hover:bg-muted"
          >
            <span className="w-5 shrink-0 font-mono text-[10px] text-amber-300">
              {file.status}
            </span>
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            {file.staged && (
              <span className="rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-300">
                已暂存
              </span>
            )}
          </button>
        ))}
      </div>
    </details>
  );
}
