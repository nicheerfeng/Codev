import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { buildCommitGraphLayout } from "@/modules/vcs/CommitGraph";
import { CommitGraphRailCell, RefBadgeList } from "@/modules/vcs/CommitGraphSvg";
import {
  entryIndicator,
  findSnapshotForPath,
  useVcsStore,
} from "@/modules/vcs/store";
import {
  normalizeVcsPath,
  parseVcsError,
  type VcsBranch,
  type VcsCommit,
  type VcsCommitDetail,
  type VcsEntry,
  type VcsStashEntry,
  type VcsWorktree,
} from "@/modules/vcs/types";
import { VcsDoctorModal } from "@/modules/vcs/VcsDoctorModal";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  GitBranchIcon,
  Refresh01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type VcsTab = "changes" | "history" | "branches";

const EMPTY_BRANCHES: VcsBranch[] = [];
const EMPTY_COMMITS: VcsCommit[] = [];
const EMPTY_WORKTREES: VcsWorktree[] = [];
const EMPTY_STASHES: VcsStashEntry[] = [];

export type OpenVcsDiffInput = {
  repoRoot: string;
  path: string;
  diff: string;
  staged?: boolean;
  conflict?: boolean;
  commitHash?: string;
};

/** 重构后的 3 标签 Git 工作台：更改 / 历史提交图 / 分支与工作区（可在弹窗或侧栏渲染）。 */
export function VcsPanel({
  root,
  onBack,
  hideBackButton = false,
  onOpenDiff,
  onOpenHistory,
  onSwitchWorkspaceRoot,
}: {
  root: string | null;
  onBack?: () => void;
  hideBackButton?: boolean;
  onOpenDiff: (input: OpenVcsDiffInput) => void;
  onOpenHistory: (input: { repoRoot: string; commits: VcsCommit[] }) => void;
  onSwitchWorkspaceRoot?: (cwd: string) => void;
}) {
  const snapshot = useVcsStore((s) => findSnapshotForPath(s.snapshots, root));
  const repoKey = snapshot
    ? normalizeVcsPath(snapshot.worktreeRoot)
    : root
      ? normalizeVcsPath(root)
      : "";
  const branches = useVcsStore((s) =>
    repoKey ? (s.branches[repoKey] ?? EMPTY_BRANCHES) : EMPTY_BRANCHES,
  );
  const commits = useVcsStore((s) =>
    repoKey ? (s.commits[repoKey] ?? EMPTY_COMMITS) : EMPTY_COMMITS,
  );
  const worktrees = useVcsStore((s) =>
    repoKey ? (s.worktrees[repoKey] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES,
  );
  const stashes = useVcsStore((s) =>
    repoKey ? (s.stashes[repoKey] ?? EMPTY_STASHES) : EMPTY_STASHES,
  );

  const refreshSnapshot = useVcsStore((s) => s.refreshSnapshot);
  const initRepo = useVcsStore((s) => s.initRepo);
  const stage = useVcsStore((s) => s.stage);
  const stageAll = useVcsStore((s) => s.stageAll);
  const discard = useVcsStore((s) => s.discard);
  const commit = useVcsStore((s) => s.commit);
  const aiCommit = useVcsStore((s) => s.aiCommit);
  const fetchRemote = useVcsStore((s) => s.fetch);
  const pullRemote = useVcsStore((s) => s.pull);
  const pushRemote = useVcsStore((s) => s.push);
  const loadBranches = useVcsStore((s) => s.loadBranches);
  const loadLog = useVcsStore((s) => s.loadLog);
  const loadCommitDetail = useVcsStore((s) => s.loadCommitDetail);
  const loadStashes = useVcsStore((s) => s.loadStashes);
  const loadWorktrees = useVcsStore((s) => s.loadWorktrees);
  const checkout = useVcsStore((s) => s.checkout);
  const createBranch = useVcsStore((s) => s.createBranch);
  const deleteBranch = useVcsStore((s) => s.deleteBranch);
  const merge = useVcsStore((s) => s.merge);
  const continueOp = useVcsStore((s) => s.continueOp);
  const abortOp = useVcsStore((s) => s.abortOp);
  const stashPush = useVcsStore((s) => s.stashPush);
  const stashApply = useVcsStore((s) => s.stashApply);
  const stashDrop = useVcsStore((s) => s.stashDrop);
  const worktreeAdd = useVcsStore((s) => s.worktreeAdd);
  const worktreeRemove = useVcsStore((s) => s.worktreeRemove);

  const [tab, setTab] = useState<VcsTab>("changes");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ code: string | null; message: string } | null>(null);
  const [confirmDiscardPath, setConfirmDiscardPath] = useState<string | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);

  // History state
  const [allBranches, setAllBranches] = useState(true);
  const [historyQuery, setHistoryQuery] = useState("");
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<VcsCommitDetail | null>(null);

  // Branches & worktree state
  const [newBranchName, setNewBranchName] = useState("");
  const [createAsWorktree, setCreateAsWorktree] = useState(false);
  const [stashMsg, setStashMsg] = useState("");

  const repoRoot = snapshot?.worktreeRoot ?? root;

  const runAction = useCallback(
    async (fn: () => Promise<void>, successToast?: string) => {
      setBusy(true);
      setErrorBanner(null);
      try {
        await fn();
        if (successToast) toast.success(successToast);
      } catch (err) {
        const parsed = parseVcsError(err);
        setErrorBanner(parsed);
        toast.error(parsed.message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!root) return;
    void refreshSnapshot(root).catch(() => undefined);
  }, [root, refreshSnapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const r = snapshot.worktreeRoot;
    if (tab === "history") {
      void loadLog(r, { all: allBranches, limit: 80, search: historyQuery.trim() || undefined }).catch(
        () => undefined,
      );
    } else if (tab === "branches") {
      void Promise.all([loadBranches(r), loadWorktrees(r), loadStashes(r)]).catch(() => undefined);
    }
  }, [snapshot?.worktreeRoot, snapshot?.snapshotId, tab, allBranches]);

  useEffect(() => {
    if (!repoRoot || !selectedCommitHash) {
      setCommitDetail(null);
      return;
    }
    void loadCommitDetail(repoRoot, selectedCommitHash)
      .then(setCommitDetail)
      .catch(() => setCommitDetail(null));
  }, [loadCommitDetail, repoRoot, selectedCommitHash]);

  const conflicts = useMemo(
    () => snapshot?.entries.filter((e) => e.conflicted) ?? [],
    [snapshot],
  );
  const staged = useMemo(
    () => snapshot?.entries.filter((e) => e.staged && !e.conflicted) ?? [],
    [snapshot],
  );
  const changes = useMemo(
    () => snapshot?.entries.filter((e) => (e.unstaged || e.untracked) && !e.conflicted) ?? [],
    [snapshot],
  );

  const graphLayout = useMemo(() => buildCommitGraphLayout(commits), [commits]);

  const openFileDiff = (entry: VcsEntry, isStaged: boolean) => {
    if (!repoRoot) return;
    onOpenDiff({
      repoRoot,
      path: entry.path,
      diff: "",
      staged: isStaged,
      conflict: entry.conflicted,
    });
  };

  const handleGenerateAiMessage = async () => {
    if (!repoRoot) return;
    setAiBusy(true);
    try {
      const generated = await aiCommit(repoRoot);
      setMessage(generated);
    } catch (error) {
      toast.error(parseVcsError(error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const handleCommit = async (alsoPush: boolean) => {
    if (!repoRoot) return;
    if (!message.trim()) {
      toast.error("请输入提交说明");
      return;
    }
    if (staged.length === 0 && !amend) {
      // Auto stage working changes when staged is empty? Wait: prompt explicitly or auto-stage tracked!
      toast.info("暂存区为空，请先点击文件右侧 + 暂存更改");
      return;
    }
    await runAction(
      async () => {
        await commit(repoRoot, message.trim(), {
          amend,
          push: alsoPush,
          setUpstream: alsoPush && !snapshot?.upstream,
        });
        setMessage("");
        setAmend(false);
      },
      alsoPush ? "已提交并推送到远端" : "已创建本地提交",
    );
  };

  const renderEntryRow = (entry: VcsEntry, isStagedList: boolean) => {
    const ind = entryIndicator(entry);
    const isConfirming = confirmDiscardPath === `${isStagedList ? "s" : "w"}:${entry.path}`;
    return (
      <div
        key={`${isStagedList ? "staged" : "work"}:${entry.path}`}
        className="group flex h-6.5 items-center gap-1.5 rounded px-1.5 text-[11px] hover:bg-muted/70"
      >
        <span
          className={cn(
            "w-3 shrink-0 font-mono text-[10px] font-semibold",
            ind.tone === "conflict"
              ? "text-red-400"
              : ind.tone === "added" || ind.tone === "untracked"
                ? "text-emerald-400"
                : ind.tone === "deleted"
                  ? "text-rose-400"
                  : "text-amber-300",
          )}
        >
          {ind.code}
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-foreground/90 hover:text-foreground"
          onClick={() => openFileDiff(entry, isStagedList)}
          title={entry.path}
        >
          {entry.path}
        </button>
        {!entry.conflicted && repoRoot && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
            {!isStagedList && (
              isConfirming ? (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded bg-destructive/20 px-1 py-0.5 text-[10px] text-destructive hover:bg-destructive/30"
                  onClick={() => {
                    setConfirmDiscardPath(null);
                    void runAction(() => discard(repoRoot, [entry.path]), "已还原文件修改");
                  }}
                >
                  确认丢弃
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-rose-400"
                  title="还原/丢弃修改"
                  onClick={() => setConfirmDiscardPath(`w:${entry.path}`)}
                >
                  ↺
                </button>
              )
            )}
            <button
              type="button"
              disabled={busy}
              className="rounded px-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title={isStagedList ? "取消暂存" : "暂存"}
              onClick={() =>
                void runAction(() => stage(repoRoot, [entry.path], !isStagedList))
              }
            >
              {isStagedList ? "−" : "+"}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {!hideBackButton && onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="返回文件树"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={12} />
            <span>文件</span>
          </button>
        )}
        <div className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium text-foreground">
          {snapshot ? snapshot.repoName : "Git 工作台"}
        </div>
        {snapshot && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction(() => fetchRemote(snapshot.worktreeRoot, true), "已完成 Fetch")}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Fetch 远端状态"
            >
              <HugeiconsIcon icon={Refresh01Icon} size={12} />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction(() => pullRemote(snapshot.worktreeRoot), "已完成 Pull")}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Pull 拉取"
            >
              <HugeiconsIcon icon={ArrowDown01Icon} size={11} />
              {snapshot.behind > 0 && <span>{snapshot.behind}</span>}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runAction(
                  () => pushRemote(snapshot.worktreeRoot, !snapshot.upstream),
                  "已推送到远端",
                )
              }
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Push 推送"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={11} />
              {snapshot.ahead > 0 && <span>{snapshot.ahead}</span>}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setDoctorOpen(true)}
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Git 环境体检与分支图指南"
        >
          体检
        </button>
      </header>

      {!root ? (
        <div className="p-4 text-[11px] text-muted-foreground">
          请先在文件树中打开或添加一个项目文件夹。
        </div>
      ) : !snapshot ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          <HugeiconsIcon icon={GitBranchIcon} size={24} className="text-muted-foreground" />
          <div className="space-y-1">
            <div className="font-medium text-foreground">当前目录还不是 Git 仓库</div>
            <div className="text-[11px] text-muted-foreground">
              {root}
            </div>
          </div>
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={busy}
            onClick={() =>
              void runAction(async () => {
                await initRepo(root, "main");
              }, "已初始化 Git 仓库 (main)")
            }
          >
            初始化 Git 仓库 (main)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() => setDoctorOpen(true)}
          >
            先运行 Git 环境体检
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 bg-muted/20 px-2.5 py-1 text-[10.5px]">
            <div className="flex min-w-0 items-center gap-1.5">
              <HugeiconsIcon icon={GitBranchIcon} size={11} className="shrink-0 text-primary" />
              <span className="truncate font-medium text-foreground">
                {snapshot.branch}
              </span>
              {snapshot.isWorktree && (
                <span className="rounded bg-purple-500/15 px-1 text-[9.5px] text-purple-300">
                  WT
                </span>
              )}
              {snapshot.detached && (
                <button
                  type="button"
                  onClick={() => setTab("branches")}
                  className="rounded bg-amber-500/20 px-1 text-[9.5px] text-amber-300"
                >
                  游离指针
                </button>
              )}
            </div>
            <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
              {snapshot.upstream ?? "未关联远端"}
            </span>
          </div>

          {errorBanner && (
            <div className="flex items-start justify-between gap-2 border-b border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[10.5px] text-destructive">
              <div className="flex min-w-0 items-start gap-1.5">
                <HugeiconsIcon icon={Alert02Icon} size={12} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{errorBanner.message}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {errorBanner.code === "MissingAuthorIdentity" && (
                  <button
                    type="button"
                    className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] hover:bg-destructive/30"
                    onClick={() => setDoctorOpen(true)}
                  >
                    去配置
                  </button>
                )}
                {errorBanner.code === "NonFastForward" && (
                  <button
                    type="button"
                    className="rounded bg-destructive/20 px-1.5 py-0.5 text-[10px] hover:bg-destructive/30"
                    onClick={() => void runAction(() => pullRemote(snapshot.worktreeRoot, true))}
                  >
                    Pull --rebase
                  </button>
                )}
                <button
                  type="button"
                  className="opacity-70 hover:opacity-100"
                  onClick={() => setErrorBanner(null)}
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {["Merging", "Rebasing", "CherryPicking", "Reverting"].includes(snapshot.repoState) && (
            <div className="flex shrink-0 items-center justify-between border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              <span>状态：{snapshot.repoState}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-5 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() => void runAction(() => continueOp(snapshot.worktreeRoot), "已继续完成操作")}
                >
                  继续
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-2 text-[10px] text-rose-300"
                  disabled={busy}
                  onClick={() => void runAction(() => abortOp(snapshot.worktreeRoot), "已中止操作")}
                >
                  中止
                </Button>
              </div>
            </div>
          )}

          <div className="grid shrink-0 grid-cols-3 border-b border-border/60 p-1 text-[11px]">
            {(
              [
                ["changes", `更改 (${conflicts.length + staged.length + changes.length})`],
                ["history", "历史"],
                ["branches", "分支与工作区"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "rounded-sm py-1 text-center font-medium transition-colors",
                  tab === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "changes" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="space-y-1.5 border-b border-border/60 p-2">
                <div className="relative">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="输入提交说明（Ctrl+Enter 提交）…"
                    rows={3}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleCommit(false);
                      }
                    }}
                    className="w-full resize-none rounded border border-border/70 bg-background/60 p-2 pr-7 text-[11px] outline-none focus:border-primary/60"
                  />
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => void handleGenerateAiMessage()}
                    title="由独立 Agent 根据变更生成提交信息"
                    className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40"
                  >
                    <HugeiconsIcon
                      icon={SparklesIcon}
                      size={12}
                      className={aiBusy ? "animate-pulse text-primary" : ""}
                    />
                  </button>
                </div>
                <div className="flex items-center justify-between gap-1.5">
                  <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={amend}
                      onChange={(e) => setAmend(e.target.checked)}
                      className="size-3 rounded"
                    />
                    追加上次提交 (--amend)
                  </label>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      className="h-6 px-2.5 text-[10.5px]"
                      disabled={busy}
                      onClick={() => void handleCommit(false)}
                    >
                      提交
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10.5px]"
                      disabled={busy}
                      onClick={() => void handleCommit(true)}
                    >
                      提交并推送
                    </Button>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1.5">
                {conflicts.length > 0 && (
                  <section className="space-y-0.5 rounded border border-destructive/40 bg-destructive/5 p-1">
                    <div className="px-1 text-[10px] font-semibold text-destructive">
                      合并冲突（{conflicts.length}）— 点击打开三路合并
                    </div>
                    {conflicts.map((entry) => renderEntryRow(entry, false))}
                  </section>
                )}

                <section className="space-y-0.5">
                  <div className="flex items-center justify-between px-1 text-[10px] font-medium text-muted-foreground">
                    <span>已暂存更改（{staged.length}）</span>
                    {staged.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(() => stageAll(snapshot.worktreeRoot, false))}
                        className="hover:text-foreground"
                      >
                        全部取消 −
                      </button>
                    )}
                  </div>
                  {staged.map((entry) => renderEntryRow(entry, true))}
                </section>

                <section className="space-y-0.5">
                  <div className="flex items-center justify-between px-1 text-[10px] font-medium text-muted-foreground">
                    <span>工作区更改（{changes.length}）</span>
                    {changes.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void runAction(() => stageAll(snapshot.worktreeRoot, true))}
                        className="hover:text-foreground"
                      >
                        全部暂存 +
                      </button>
                    )}
                  </div>
                  {changes.length === 0 && staged.length === 0 && conflicts.length === 0 ? (
                    <div className="flex items-center gap-1.5 px-2 py-4 text-[11px] text-muted-foreground">
                      <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} className="text-emerald-400" />
                      工作区干净，暂无未提交改动
                    </div>
                  ) : (
                    changes.map((entry) => renderEntryRow(entry, false))
                  )}
                </section>
              </div>
            </div>
          )}

          {tab === "history" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-1 border-b border-border/50 p-1.5">
                <Input
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void loadLog(snapshot.worktreeRoot, {
                        all: allBranches,
                        limit: 80,
                        search: historyQuery.trim() || undefined,
                      });
                    }
                  }}
                  placeholder="搜索历史…"
                  className="h-6 flex-1 text-[10.5px]"
                />
                <button
                  type="button"
                  onClick={() => setAllBranches((v) => !v)}
                  className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {allBranches ? "全分支" : "当前分支"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenHistory({ repoRoot: snapshot.worktreeRoot, commits })
                  }
                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-accent"
                  title="在主区打开完整 Commit Graph"
                >
                  大图
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border/30">
                {graphLayout.rows.map((row) => {
                  const selected = selectedCommitHash === row.commit.hash;
                  return (
                    <div key={row.commit.hash} className="flex flex-col">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedCommitHash(selected ? null : row.commit.hash)
                        }
                        className={cn(
                          "flex w-full items-center gap-1.5 px-1.5 py-1 text-left hover:bg-muted/60",
                          selected && "bg-primary/10",
                        )}
                      >
                        <CommitGraphRailCell layout={row} maxLanes={graphLayout.maxLanes} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="truncate text-[11px] font-medium text-foreground">
                              {row.commit.subject}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[9.5px] text-muted-foreground">
                            <span className="font-mono">{row.commit.shortHash}</span>
                            <span>{row.commit.author}</span>
                            <span>· {row.commit.dateDisplay}</span>
                          </div>
                          <RefBadgeList refs={row.commit.refs} compact />
                        </div>
                      </button>
                      {selected && commitDetail?.commit.hash === row.commit.hash && (
                        <div className="space-y-1 border-t border-border/40 bg-background/50 px-3 py-1.5 text-[10.5px]">
                          {commitDetail.files.map((f) => (
                            <button
                              key={f.path}
                              type="button"
                              onClick={() =>
                                onOpenDiff({
                                  repoRoot: snapshot.worktreeRoot,
                                  path: f.path,
                                  diff: "",
                                  commitHash: row.commit.hash,
                                })
                              }
                              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted"
                            >
                              <span className="w-3 font-mono text-amber-300">{f.status}</span>
                              <span className="min-w-0 flex-1 truncate">{f.path}</span>
                              <span className="font-mono text-emerald-400">+{f.additions}</span>
                              <span className="font-mono text-rose-400">-{f.deletions}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "branches" && (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2 text-[11px]">
              <section className="space-y-1.5 rounded border border-border/60 bg-background/40 p-2">
                <div className="text-[10.5px] font-medium text-foreground">新建分支或并行 Worktree</div>
                <div className="flex items-center gap-1">
                  <Input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="例如：feat/new-ui"
                    className="h-6 flex-1 text-[10.5px]"
                  />
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10.5px]"
                    disabled={busy || !newBranchName.trim()}
                    onClick={() => {
                      const target = newBranchName.trim();
                      if (createAsWorktree) {
                        void runAction(async () => {
                          const created = await worktreeAdd(snapshot.worktreeRoot, target, {
                            createBranch: true,
                          });
                          setNewBranchName("");
                          onSwitchWorkspaceRoot?.(created.worktree.path);
                        }, `已创建并打开 Worktree (${target})`);
                      } else {
                        void runAction(async () => {
                          await createBranch(snapshot.worktreeRoot, target, undefined, true);
                          setNewBranchName("");
                        }, `已创建并切换到 ${target}`);
                      }
                    }}
                  >
                    创建
                  </Button>
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={createAsWorktree}
                    onChange={(e) => setCreateAsWorktree(e.target.checked)}
                    className="size-3"
                  />
                  同时建立独立隔离 Worktree 目录（推荐用于并行开发）
                </label>
              </section>

              <section className="space-y-1">
                <div className="px-1 text-[10px] font-semibold text-muted-foreground">
                  Worktree 工作树（{worktrees.length}）
                </div>
                {worktrees.map((wt) => (
                  <div
                    key={wt.path}
                    className="flex items-center justify-between gap-1.5 rounded border border-border/50 bg-background/30 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-medium">
                          {wt.branch ?? wt.headOid}
                        </span>
                        {wt.isMain && (
                          <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                            主干
                          </span>
                        )}
                        {wt.sessionIds.length > 0 && (
                          <span className="rounded bg-primary/15 px-1 text-[9px] text-primary">
                            {wt.sessionIds.length} 个 Agent
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[9.5px] text-muted-foreground" title={wt.path}>
                        {wt.path}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {onSwitchWorkspaceRoot && (
                        <button
                          type="button"
                          onClick={() => onSwitchWorkspaceRoot(wt.path)}
                          className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-muted"
                        >
                          切过去
                        </button>
                      )}
                      {!wt.isMain && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void runAction(
                              () => worktreeRemove(snapshot.worktreeRoot, wt.path, false),
                              "已移除 Worktree",
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[10px] text-rose-400 hover:bg-destructive/15"
                        >
                          清理
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>

              <section className="space-y-1">
                <div className="px-1 text-[10px] font-semibold text-muted-foreground">
                  本地与远端分支（{branches.length}）
                </div>
                <div className="space-y-0.5">
                  {branches.map((b) => (
                    <div
                      key={b.fullName}
                      className={cn(
                        "group flex items-center justify-between gap-1 rounded px-1.5 py-1 hover:bg-muted/60",
                        b.isCurrent && "bg-primary/10",
                      )}
                    >
                      <button
                        type="button"
                        disabled={busy || b.isCurrent}
                        onClick={() =>
                          void runAction(
                            () =>
                              checkout(
                                snapshot.worktreeRoot,
                                b.isRemote ? b.name.replace(/^[^/]+\//, "") : b.name,
                              ),
                            `已切换到 ${b.name}`,
                          )
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span
                          className={cn(
                            "truncate",
                            b.isCurrent ? "font-semibold text-primary" : "text-foreground/90",
                          )}
                        >
                          {b.name}
                        </span>
                        {b.worktreePath && !b.isCurrent && (
                          <span className="rounded bg-purple-500/15 px-1 text-[9px] text-purple-300">
                            WT
                          </span>
                        )}
                        {(b.ahead > 0 || b.behind > 0) && (
                          <span className="text-[9.5px] text-muted-foreground">
                            {b.ahead > 0 ? `↑${b.ahead}` : ""}
                            {b.behind > 0 ? `↓${b.behind}` : ""}
                          </span>
                        )}
                      </button>
                      {!b.isCurrent && (
                        <div className="hidden shrink-0 items-center gap-1 group-hover:flex">
                          <button
                            type="button"
                            onClick={() =>
                              void runAction(
                                () => merge(snapshot.worktreeRoot, b.name),
                                `已将 ${b.name} 合并到当前分支`,
                              )
                            }
                            className="rounded px-1 text-[10px] text-sky-300 hover:bg-muted"
                          >
                            Merge
                          </button>
                          {!b.isRemote && (
                            <button
                              type="button"
                              onClick={() =>
                                void runAction(
                                  () => deleteBranch(snapshot.worktreeRoot, b.name, false, false),
                                  `已删除分支 ${b.name}`,
                                )
                              }
                              className="rounded px-1 text-[10px] text-rose-400 hover:bg-muted"
                            >
                              删
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-1.5">
                <div className="flex items-center justify-between px-1 text-[10px] font-semibold text-muted-foreground">
                  <span>暂存栈 Stash（{stashes.length}）</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    value={stashMsg}
                    onChange={(e) => setStashMsg(e.target.value)}
                    placeholder="Stash 备注（可选）…"
                    className="h-6 flex-1 text-[10.5px]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        await stashPush(snapshot.worktreeRoot, stashMsg.trim() || undefined, true);
                        setStashMsg("");
                      }, "已存入 Stash 暂存栈")
                    }
                  >
                    暂存工作区
                  </Button>
                </div>
                {stashes.map((st) => (
                  <div
                    key={st.refName}
                    className="flex items-center justify-between gap-1.5 rounded border border-border/40 px-2 py-1"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[10.5px]">{st.message}</div>
                      <div className="text-[9.5px] text-muted-foreground">
                        {st.refName} · {st.dateDisplay}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            () => stashApply(snapshot.worktreeRoot, st.index, true),
                            "已恢复并弹出 Stash",
                          )
                        }
                        className="rounded px-1 text-[10px] text-emerald-400 hover:bg-muted"
                      >
                        Pop
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void runAction(
                            () => stashDrop(snapshot.worktreeRoot, st.index),
                            "已移除 Stash",
                          )
                        }
                        className="rounded px-1 text-[10px] text-rose-400 hover:bg-muted"
                      >
                        丢弃
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            </div>
          )}
        </>
      )}

      <VcsDoctorModal
        root={root}
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
      />
    </div>
  );
}
