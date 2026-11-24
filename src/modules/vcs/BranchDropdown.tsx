import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/modules/agent/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { findSnapshotForPath, useVcsStore } from "@/modules/vcs/store";
import {
  normalizeVcsPath,
  parseVcsError,
  type VcsBranch,
  type VcsWorktree,
} from "@/modules/vcs/types";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const EMPTY_BRANCHES: VcsBranch[] = [];
const EMPTY_WORKTREES: VcsWorktree[] = [];

/** 右侧 Agent 输入框底部集成的轻量分支与 Worktree 控制器。 */
export function BranchDropdown({
  cwd,
  harnessId,
  disabled = false,
}: {
  cwd: string;
  harnessId: string;
  disabled?: boolean;
}) {
  const gitUiEnabled = usePreferencesStore((s) => s.gitUiEnabled);
  const snapshot = useVcsStore((s) =>
    gitUiEnabled ? findSnapshotForPath(s.snapshots, cwd) : null,
  );
  const repoKey = snapshot ? normalizeVcsPath(snapshot.worktreeRoot) : "";
  const branches = useVcsStore((s) =>
    repoKey ? (s.branches[repoKey] ?? EMPTY_BRANCHES) : EMPTY_BRANCHES,
  );
  const worktrees = useVcsStore((s) =>
    repoKey ? (s.worktrees[repoKey] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES,
  );

  const refreshSnapshot = useVcsStore((s) => s.refreshSnapshot);
  const loadBranches = useVcsStore((s) => s.loadBranches);
  const loadWorktrees = useVcsStore((s) => s.loadWorktrees);
  const checkout = useVcsStore((s) => s.checkout);
  const createBranch = useVcsStore((s) => s.createBranch);
  const spawnWorktreeSession = useVcsStore((s) => s.spawnWorktreeSession);
  const pull = useVcsStore((s) => s.pull);
  const push = useVcsStore((s) => s.push);

  const [open, setOpen] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!gitUiEnabled || !cwd) return;
    void refreshSnapshot(cwd).catch(() => undefined);
  }, [gitUiEnabled, cwd, refreshSnapshot]);

  useEffect(() => {
    if (!gitUiEnabled || !open || !snapshot) return;
    void Promise.all([
      loadBranches(snapshot.worktreeRoot),
      loadWorktrees(snapshot.worktreeRoot),
    ]).catch(() => undefined);
  }, [gitUiEnabled, open, snapshot?.worktreeRoot, loadBranches, loadWorktrees]);

  if (!gitUiEnabled || !snapshot) {
    return (
      <div className="agent-composer-note">
        <span title={cwd}>{cwd}</span>
      </div>
    );
  }

  const localBranches = branches.filter((b) => !b.isRemote);

  const handleAction = async (fn: () => Promise<void>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
    } catch (err) {
      toast.error(parseVcsError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-composer-note flex items-center justify-between gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex max-w-[55%] items-center gap-1 rounded px-1 py-0.5 text-[10.5px] transition-colors hover:bg-muted/80",
              snapshot.isWorktree ? "text-purple-300" : "text-muted-foreground hover:text-foreground",
            )}
            title={`${snapshot.worktreeRoot}\n当前分支：${snapshot.branch}`}
          >
            <HugeiconsIcon icon={GitBranchIcon} size={11} className="shrink-0" />
            <span className="truncate">{snapshot.branch}</span>
            {snapshot.isWorktree && (
              <span className="shrink-0 rounded bg-purple-500/20 px-1 text-[9px] text-purple-300">
                WT
              </span>
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" side="top" className="w-80 space-y-2.5 p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {snapshot.repoName} ({snapshot.branch})
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {snapshot.worktreeRoot}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                disabled={busy}
                onClick={() =>
                  void handleAction(() => pull(snapshot.worktreeRoot), "已完成 Pull")
                }
                title="拉取远端"
              >
                <HugeiconsIcon icon={ArrowDown01Icon} size={11} />
                {snapshot.behind > 0 ? snapshot.behind : ""}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                disabled={busy}
                onClick={() =>
                  void handleAction(
                    () => push(snapshot.worktreeRoot, !snapshot.upstream),
                    "已推送",
                  )
                }
                title="推送到远端"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={11} />
                {snapshot.ahead > 0 ? snapshot.ahead : ""}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Input
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              placeholder="输入新分支名（例如 codev/fix-ui）…"
              className="h-7 text-[11px]"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10.5px]"
                disabled={busy || !branchInput.trim()}
                onClick={() =>
                  void handleAction(async () => {
                    const name = branchInput.trim();
                    await createBranch(snapshot.worktreeRoot, name, undefined, true);
                    setBranchInput("");
                    setOpen(false);
                  }, "已新建并切换分支")
                }
              >
                新建当前目录分支
              </Button>
              <Button
                size="sm"
                className="h-6 text-[10.5px]"
                disabled={busy || !branchInput.trim()}
                onClick={() =>
                  void handleAction(async () => {
                    const name = branchInput.trim();
                    const res = await spawnWorktreeSession(snapshot.worktreeRoot, {
                      branch: name,
                      createBranch: true,
                      harnessId,
                      title: `WT · ${name}`,
                    });
                    setBranchInput("");
                    setOpen(false);
                    const store = useAgentStore.getState();
                    await store.addWorkspace(res.workspace.cwd);
                    await store.select(res.session.id);
                  }, "已创建独立 Worktree 并开启新线程")
                }
              >
                新开 Worktree 线程
              </Button>
            </div>
          </div>

          {localBranches.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground">
                切换本地分支
              </div>
              <div className="max-h-36 space-y-0.5 overflow-y-auto">
                {localBranches.map((b) => (
                  <button
                    key={b.fullName}
                    type="button"
                    disabled={busy || b.isCurrent}
                    onClick={() =>
                      void handleAction(async () => {
                        await checkout(snapshot.worktreeRoot, b.name);
                        setOpen(false);
                      }, `已切换到 ${b.name}`)
                    }
                    className={cn(
                      "flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted",
                      b.isCurrent && "bg-primary/10 font-medium text-primary",
                    )}
                  >
                    <span className="truncate">{b.name}</span>
                    {b.worktreePath && !b.isCurrent && (
                      <span className="rounded bg-purple-500/15 px-1 text-[9px] text-purple-300">
                        WT
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {worktrees.length > 1 && (
            <div className="space-y-1 border-t border-border/50 pt-1.5">
              <div className="text-[10px] font-medium text-muted-foreground">
                并行 Worktree（{worktrees.length}）
              </div>
              <div className="max-h-24 space-y-0.5 overflow-y-auto">
                {worktrees.map((wt) => (
                  <div
                    key={wt.path}
                    className="flex items-center justify-between gap-1 text-[10.5px] text-muted-foreground"
                  >
                    <span className="truncate text-foreground/85">
                      {wt.branch ?? wt.headOid}
                    </span>
                    <span className="shrink-0 font-mono text-[9.5px]">
                      {wt.isMain ? "主干" : `${wt.sessionIds.length} 线程`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <span className="min-w-0 truncate text-right opacity-75" title={cwd}>
        {cwd}
      </span>
    </div>
  );
}
