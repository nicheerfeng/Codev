import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { buildCommitGraphLayout } from "@/modules/vcs/CommitGraph";
import { CommitGraphRailCell, RefBadgeList } from "@/modules/vcs/CommitGraphSvg";
import { useVcsStore } from "@/modules/vcs/store";
import type { VcsCommit, VcsCommitDetail } from "@/modules/vcs/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/** 主区 Commit Graph 与详情审阅工作台。 */
export function VcsHistoryView({
  repoRoot,
  initialCommits = [],
  onOpenDiff,
}: {
  repoRoot: string;
  initialCommits?: VcsCommit[];
  onOpenDiff?: (input: {
    repoRoot: string;
    path: string;
    diff: string;
    commitHash?: string;
  }) => void;
}) {
  const storeCommits = useVcsStore((s) => s.commits[repoRoot.toLowerCase()]);
  const loadLog = useVcsStore((s) => s.loadLog);
  const loadCommitDetail = useVcsStore((s) => s.loadCommitDetail);
  const cherryPick = useVcsStore((s) => s.cherryPick);
  const revertCommit = useVcsStore((s) => s.revertCommit);
  const createBranch = useVcsStore((s) => s.createBranch);

  const [allBranches, setAllBranches] = useState(true);
  const [search, setSearch] = useState("");
  const [commits, setCommits] = useState<VcsCommit[]>(initialCommits);
  const [selectedHash, setSelectedHash] = useState<string | null>(
    initialCommits[0]?.hash ?? null,
  );
  const [detail, setDetail] = useState<VcsCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadLog(repoRoot, {
        all: allBranches,
        limit: 160,
        search: search.trim() || undefined,
      });
      setCommits(next);
      if (next.length > 0 && (!selectedHash || !next.some((c) => c.hash === selectedHash))) {
        setSelectedHash(next[0].hash);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }, [allBranches, loadLog, repoRoot, search, selectedHash]);

  useEffect(() => {
    void reload();
  }, [allBranches]);

  useEffect(() => {
    if (storeCommits && storeCommits.length > 0 && commits.length === 0) {
      setCommits(storeCommits);
    }
  }, [commits.length, storeCommits]);

  useEffect(() => {
    if (!selectedHash) {
      setDetail(null);
      return;
    }
    void loadCommitDetail(repoRoot, selectedHash)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [loadCommitDetail, repoRoot, selectedHash]);

  const layout = useMemo(() => buildCommitGraphLayout(commits), [commits]);

  const handleBranchFromCommit = async (hash: string) => {
    const name = window.prompt("基于该提交创建分支并切换：", `feat/${hash.slice(0, 7)}`);
    if (!name?.trim()) return;
    try {
      await createBranch(repoRoot, name.trim(), hash, true);
      toast.success(`已创建并切换到分支 ${name.trim()}`);
      await reload();
    } catch (error) {
      toast.error(String(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">提交历史与分支图</span>
          <div className="flex items-center rounded border border-border/60 p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => setAllBranches(true)}
              className={cn(
                "rounded-xs px-2 py-0.5",
                allBranches ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              全部分支
            </button>
            <button
              type="button"
              onClick={() => setAllBranches(false)}
              className={cn(
                "rounded-xs px-2 py-0.5",
                !allBranches ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              仅当前分支
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void reload();
            }}
            placeholder="搜索提交信息（回车）…"
            className="h-6 w-48 text-[11px]"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={loading}
            onClick={() => void reload()}
          >
            刷新
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-auto border-r border-border/60">
          {layout.rows.length === 0 ? (
            <div className="p-4 text-muted-foreground">暂无符合条件的提交记录。</div>
          ) : (
            <div className="divide-y divide-border/30">
              {layout.rows.map((row) => {
                const active = row.commit.hash === selectedHash;
                return (
                  <button
                    key={row.commit.hash}
                    type="button"
                    onClick={() => setSelectedHash(row.commit.hash)}
                    className={cn(
                      "flex h-7 w-full items-center gap-2 px-2 text-left text-[11px] hover:bg-muted/60",
                      active && "bg-primary/12 text-foreground",
                    )}
                  >
                    <CommitGraphRailCell layout={row} maxLanes={layout.maxLanes} />
                    <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
                      {row.commit.shortHash}
                    </span>
                    <RefBadgeList refs={row.commit.refs} />
                    <span className="min-w-0 flex-1 truncate">{row.commit.subject}</span>
                    <span className="w-24 shrink-0 truncate text-right text-[10px] text-muted-foreground">
                      {row.commit.author}
                    </span>
                    <span className="w-20 shrink-0 truncate text-right text-[10px] text-muted-foreground">
                      {row.commit.dateDisplay}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="flex w-80 shrink-0 flex-col overflow-hidden bg-background/30">
          {!detail ? (
            <div className="p-4 text-[11px] text-muted-foreground">
              点击左侧提交记录查看详细改动与操作。
            </div>
          ) : (
            <>
              <div className="space-y-2 border-b border-border/60 p-3">
                <div className="font-medium leading-snug text-foreground">
                  {detail.commit.subject}
                </div>
                {detail.commit.body && (
                  <pre className="whitespace-pre-wrap font-sans text-[11px] text-muted-foreground">
                    {detail.commit.body}
                  </pre>
                )}
                <div className="text-[10px] text-muted-foreground">
                  <span className="font-mono">{detail.commit.shortHash}</span> · {detail.commit.author} · {detail.commit.dateDisplay}
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => void handleBranchFromCommit(detail.commit.hash)}
                  >
                    从此新建分支
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() =>
                      void cherryPick(repoRoot, detail.commit.hash)
                        .then(() => toast.success("Cherry-pick 完成"))
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    Cherry-pick
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() =>
                      void revertCommit(repoRoot, detail.commit.hash)
                        .then(() => toast.success("已生成 Revert 提交"))
                        .catch((e) => toast.error(String(e)))
                    }
                  >
                    Revert 回滚
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <div className="mb-1.5 px-1 text-[10px] font-medium text-muted-foreground">
                  变更文件（{detail.files.length}）
                </div>
                <div className="space-y-0.5">
                  {detail.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() =>
                        onOpenDiff?.({
                          repoRoot,
                          path: file.path,
                          diff: "",
                          commitHash: detail.commit.hash,
                        })
                      }
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                    >
                      <span className="w-4 shrink-0 font-mono text-[10px] text-amber-300">
                        {file.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{file.path}</span>
                      <span className="shrink-0 font-mono text-[10px] text-emerald-400">
                        +{file.additions}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-rose-400">
                        -{file.deletions}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
