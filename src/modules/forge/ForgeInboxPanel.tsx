import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/modules/agent/store";
import { findSnapshotForPath, useVcsStore } from "@/modules/vcs/store";
import { ForgeMarkdown, parseGithubRepoFromRemote } from "./ForgeMarkdown";
import { forgeCommentsCacheKey, useForgeStore } from "./store";
import {
  normalizeVcsPath,
  type ForgeCheckRun,
  type ForgeComment,
  type ForgeIssue,
  type ForgePrFile,
  type ForgePullRequest,
  type ForgeRepoOption,
  type ForgeTarget,
} from "@/modules/vcs/types";
import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  GitBranchIcon,
  Notification01Icon,
  Refresh01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type InboxTab = "notifications" | "issues" | "pulls";

/** 右侧 Dock 的 Git 管理与通知收件箱（支持个人多仓库切换、Issue/PR 审阅、CI 检查及一键派单给 Agent Worktree）。 */
export function ForgeInboxPanel({
  workspaceRoots,
  activeRoot,
  onAddWorkspaceRoot,
  onFocusAgentTab,
}: {
  workspaceRoots: string[];
  activeRoot?: string | null;
  onAddWorkspaceRoot?: (cwd: string) => void;
  onFocusAgentTab?: () => void;
}) {
  const targetRoot = activeRoot || workspaceRoots[0] || "";
  const snapshots = useVcsStore((s) => s.snapshots);
  const snapshot = useMemo(
    () => findSnapshotForPath(snapshots, targetRoot),
    [snapshots, targetRoot],
  );
  const inboxes = useForgeStore((s) => s.inboxes);
  const forgeRepos = useForgeStore((s) => s.forgeRepos);
  const forgeAuth = useForgeStore((s) => s.forgeAuth);
  const activeInboxRepo = useForgeStore((s) => s.activeInboxRepo);
  const setActiveInboxRepo = useForgeStore((s) => s.setActiveInboxRepo);

  const refreshSnapshot = useVcsStore((s) => s.refreshSnapshot);
  const hydrateForgeCache = useForgeStore((s) => s.hydrateForgeCache);
  const loadForgeRepos = useForgeStore((s) => s.loadForgeRepos);
  const fetchInbox = useForgeStore((s) => s.fetchInbox);
  const syncForge = useForgeStore((s) => s.syncForge);
  const fetchComments = useForgeStore((s) => s.fetchComments);
  const fetchPrChecks = useForgeStore((s) => s.fetchPrChecks);
  const fetchPrFiles = useForgeStore((s) => s.fetchPrFiles);
  const createComment = useForgeStore((s) => s.createComment);
  const createIssue = useForgeStore((s) => s.createIssue);
  const setIssueState = useForgeStore((s) => s.setIssueState);
  const mergePr = useForgeStore((s) => s.mergePr);
  const markNotificationRead = useForgeStore((s) => s.markNotificationRead);
  const setForgePat = useForgeStore((s) => s.setForgePat);
  const dispatchIssueToAgent = useForgeStore((s) => s.dispatchIssueToAgent);

  const [tab, setTab] = useState<InboxTab>("notifications");
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const [syncing, setSyncing] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [prDetailsLoading, setPrDetailsLoading] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const [patOpen, setPatOpen] = useState(false);
  const [patInput, setPatInput] = useState("");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");

  const [selectedIssue, setSelectedIssue] = useState<ForgeIssue | null>(null);
  const [selectedPr, setSelectedPr] = useState<ForgePullRequest | null>(null);
  const [comments, setComments] = useState<ForgeComment[]>([]);
  const [checks, setChecks] = useState<ForgeCheckRun[]>([]);
  const [prFiles, setPrFiles] = useState<ForgePrFile[]>([]);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmMergePr, setConfirmMergePr] = useState<number | null>(null);

  const repoOptions = useMemo<ForgeRepoOption[]>(() => {
    const byKey = new Map<string, ForgeRepoOption>();
    for (const r of forgeRepos) {
      byKey.set(r.fullName.toLowerCase(), r);
    }
    for (const snap of Object.values(snapshots)) {
      const originUrl =
        snap.remotes.find((r) => r.name === "origin")?.fetchUrl ??
        snap.remotes[0]?.fetchUrl ??
        "";
      const parsed = parseGithubRepoFromRemote(originUrl);
      if (!parsed) continue;
      const key = parsed.toLowerCase();
      const existing = byKey.get(key);
      const [owner = "", repo = ""] = parsed.split("/");
      if (existing) {
        if (!existing.localRoot) {
          byKey.set(key, { ...existing, localRoot: snap.worktreeRoot });
        }
      } else {
        byKey.set(key, {
          fullName: parsed,
          owner,
          repo,
          host: "github.com",
          private: false,
          openIssuesCount: 0,
          updatedAt: "",
          localRoot: snap.worktreeRoot,
        });
      }
    }
    for (const inbox of Object.values(inboxes)) {
      if (!inbox.repo?.fullName) continue;
      const key = inbox.repo.fullName.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, {
          fullName: inbox.repo.fullName,
          owner: inbox.repo.owner,
          repo: inbox.repo.repo,
          host: inbox.repo.host,
          private: false,
          openIssuesCount: inbox.issues.length,
          updatedAt: "",
        });
      }
    }
    return Array.from(byKey.values());
  }, [forgeRepos, snapshots, inboxes]);

  const activeSnapRepoName = useMemo(() => {
    const originUrl =
      snapshot?.remotes.find((r) => r.name === "origin")?.fetchUrl ??
      snapshot?.remotes[0]?.fetchUrl ??
      "";
    return parseGithubRepoFromRemote(originUrl);
  }, [snapshot]);

  const selectedRepoFullName =
    activeInboxRepo ??
    activeSnapRepoName ??
    repoOptions[0]?.fullName ??
    null;

  const selectedOption = useMemo(
    () =>
      selectedRepoFullName
        ? (repoOptions.find(
            (r) => r.fullName.toLowerCase() === selectedRepoFullName.toLowerCase(),
          ) ?? null)
        : null,
    [repoOptions, selectedRepoFullName],
  );

  const localDispatchRoot = useMemo(() => {
    if (selectedOption?.localRoot) return selectedOption.localRoot;
    if (!selectedRepoFullName) return "";
    const targetLower = selectedRepoFullName.toLowerCase();
    for (const snap of Object.values(snapshots)) {
      const originUrl =
        snap.remotes.find((r) => r.name === "origin")?.fetchUrl ??
        snap.remotes[0]?.fetchUrl ??
        "";
      const parsed = parseGithubRepoFromRemote(originUrl);
      if (parsed?.toLowerCase() === targetLower) return snap.worktreeRoot;
    }
    return "";
  }, [selectedOption, selectedRepoFullName, snapshots]);

  const forgeTarget = useMemo<ForgeTarget | null>(() => {
    if (selectedRepoFullName) {
      return {
        repoFullName: selectedRepoFullName,
        host: selectedOption?.host,
        root: localDispatchRoot || (targetRoot || undefined),
      };
    }
    return targetRoot ? { root: targetRoot } : null;
  }, [selectedRepoFullName, selectedOption?.host, localDispatchRoot, targetRoot]);

  // Match active inbox by selected repo, active workspace remote, or first cached inbox
  const matchedInbox = useMemo(() => {
    if (selectedRepoFullName) {
      const direct = inboxes[selectedRepoFullName];
      if (direct) return direct;
      const lower = selectedRepoFullName.toLowerCase();
      const hit = Object.values(inboxes).find(
        (b) => b.repo?.fullName.toLowerCase() === lower,
      );
      if (hit) return hit;
      return null;
    }
    if (activeSnapRepoName) {
      const lower = activeSnapRepoName.toLowerCase();
      const found = Object.values(inboxes).find(
        (b) => b.repo?.fullName.toLowerCase() === lower,
      );
      if (found) return found;
    }
    return Object.values(inboxes)[0] ?? null;
  }, [inboxes, selectedRepoFullName, activeSnapRepoName]);

  const rootsKey = workspaceRoots.join("\n");

  const refreshReposList = useCallback(async () => {
    setReposLoading(true);
    try {
      await loadForgeRepos(workspaceRoots);
    } catch {
      // 忽略拉取仓库列表失败，留待后续重试或提示
    } finally {
      setReposLoading(false);
    }
  }, [loadForgeRepos, workspaceRoots]);

  const reload = useCallback(
    async (force = false) => {
      setSyncing(true);
      try {
        if (targetRoot) {
          await refreshSnapshot(targetRoot).catch(() => undefined);
        }
        if (force || forgeRepos.length === 0) {
          await refreshReposList();
        }
        if (!forgeTarget) return;
        if (force) await syncForge(forgeTarget, stateFilter);
        else await fetchInbox(forgeTarget, stateFilter);
      } catch (err) {
        toast.error(String(err));
      } finally {
        setSyncing(false);
      }
    },
    [
      fetchInbox,
      forgeRepos.length,
      forgeTarget,
      refreshReposList,
      refreshSnapshot,
      stateFilter,
      syncForge,
      targetRoot,
    ],
  );

  useEffect(() => {
    hydrateForgeCache();
  }, [hydrateForgeCache]);

  useEffect(() => {
    void refreshReposList();
  }, [rootsKey, refreshReposList]);

  useEffect(() => {
    if (!forgeTarget) return;
    void reload(false);
  }, [selectedRepoFullName, targetRoot, stateFilter]);

  useEffect(() => {
    const num = selectedIssue?.number ?? selectedPr?.number;
    if (!forgeTarget || !num) {
      setComments([]);
      setChecks([]);
      setPrFiles([]);
      setDetailLoading(false);
      setPrDetailsLoading(false);
      return;
    }
    let cancelled = false;
    const cacheKey = forgeCommentsCacheKey(forgeTarget, num);
    const cachedComments = useForgeStore.getState().forgeComments[cacheKey];
    setComments(cachedComments ?? []);
    setDetailLoading(true);
    void fetchComments(forgeTarget, num)
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch(() => {
        if (!cancelled && !cachedComments) setComments([]);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    if (selectedPr) {
      setPrDetailsLoading(true);
      void Promise.allSettled([
        fetchPrChecks(forgeTarget, selectedPr.headSha).then((list) => {
          if (!cancelled) setChecks(list);
        }),
        fetchPrFiles(forgeTarget, selectedPr.number).then((list) => {
          if (!cancelled) setPrFiles(list);
        }),
      ]).finally(() => {
        if (!cancelled) setPrDetailsLoading(false);
      });
    } else {
      setChecks([]);
      setPrFiles([]);
      setPrDetailsLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [fetchComments, fetchPrChecks, fetchPrFiles, forgeTarget, selectedIssue, selectedPr]);

  const handleSelectRepo = (fullName: string) => {
    setActiveInboxRepo(fullName);
    setSelectedIssue(null);
    setSelectedPr(null);
    setConfirmMergePr(null);
    setRepoPickerOpen(false);
    setRepoQuery("");
  };

  const handleDispatch = async (opts: {
    kind: "issue" | "pr";
    number: number;
    title: string;
    body?: string;
    htmlUrl?: string;
  }) => {
    if (!localDispatchRoot) {
      toast.info("请先将该仓库的本地目录添加到左侧工作区，即可派单 Agent Worktree");
      return;
    }
    setBusy(true);
    try {
      const res = await dispatchIssueToAgent(localDispatchRoot, {
        ...opts,
        harnessId: useAgentStore.getState().harnessId,
      });
      onAddWorkspaceRoot?.(res.workspace.cwd);
      const store = useAgentStore.getState();
      await store.addWorkspace(res.workspace.cwd);
      await store.select(res.session.id);
      store.setDraft(res.session.id, { text: res.initialPrompt });
      onFocusAgentTab?.();
      toast.success(`已为 #${opts.number} 创建独立 Worktree 并预填 Agent 任务`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSavePat = async () => {
    setBusy(true);
    try {
      await setForgePat(patInput.trim());
      setPatInput("");
      setPatOpen(false);
      await loadForgeRepos(workspaceRoots).catch(() => undefined);
      await reload(true);
      toast.success("已更新 GitHub PAT 凭据");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReply = async () => {
    const num = selectedIssue?.number ?? selectedPr?.number;
    if (!forgeTarget || !num || !replyText.trim()) return;
    setBusy(true);
    try {
      const created = await createComment(forgeTarget, num, replyText.trim());
      setComments((prev) => [...prev, created]);
      setReplyText("");
      toast.success("已发布评论");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateIssue = async () => {
    if (!forgeTarget || !newIssueTitle.trim()) return;
    setBusy(true);
    try {
      const created = await createIssue(
        forgeTarget,
        newIssueTitle.trim(),
        newIssueBody.trim(),
      );
      setNewIssueOpen(false);
      setNewIssueTitle("");
      setNewIssueBody("");
      setSelectedIssue(created);
      setTab("issues");
      await reload(true);
      toast.success(`已创建 Issue #${created.number}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setBusy(false);
    }
  };

  const openExternal = (url: string) => {
    if (url) void openUrl(url).catch(() => undefined);
  };

  const filteredRepos = useMemo(() => {
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repoOptions;
    return repoOptions.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repoOptions, repoQuery]);

  const manualRepoCandidate = useMemo(() => {
    const raw = repoQuery.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) return null;
    if (repoOptions.some((r) => r.fullName.toLowerCase() === raw.toLowerCase())) {
      return null;
    }
    return raw;
  }, [repoQuery, repoOptions]);

  const notifications = matchedInbox?.notifications ?? [];
  const issues = matchedInbox?.issues ?? [];
  const pulls = matchedInbox?.pulls ?? [];
  const auth = matchedInbox?.auth ?? forgeAuth ?? Object.values(inboxes)[0]?.auth;
  const displayRepoTitle =
    matchedInbox?.repo?.fullName ?? selectedRepoFullName ?? "选择 GitHub 仓库";

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <HugeiconsIcon icon={Notification01Icon} size={13} className="shrink-0 text-primary" />
          <Popover open={repoPickerOpen} onOpenChange={setRepoPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-left font-medium text-foreground transition-colors hover:bg-muted"
                title="切换个人或工作区 GitHub 仓库"
              >
                <span className="truncate">{displayRepoTitle}</span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-2 p-2 text-xs">
              <div className="flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={repoQuery}
                  onChange={(e) => setRepoQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const pick = manualRepoCandidate ?? filteredRepos[0]?.fullName;
                      if (pick) handleSelectRepo(pick);
                    }
                  }}
                  placeholder="搜索仓库或输入 owner/repo…"
                  className="h-7 flex-1 text-[11px]"
                />
                <button
                  type="button"
                  disabled={reposLoading}
                  onClick={() => void refreshReposList()}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  title="刷新个人仓库列表"
                >
                  <HugeiconsIcon
                    icon={Refresh01Icon}
                    size={12}
                    className={reposLoading ? "animate-spin" : ""}
                  />
                </button>
              </div>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {manualRepoCandidate && (
                  <button
                    type="button"
                    onClick={() => handleSelectRepo(manualRepoCandidate)}
                    className="flex w-full items-center justify-between rounded bg-primary/10 px-2 py-1.5 text-left text-[11px] text-primary hover:bg-primary/20"
                  >
                    <span className="truncate">切换到 {manualRepoCandidate}</span>
                    <span className="shrink-0 text-[10px]">回车/点击</span>
                  </button>
                )}
                {filteredRepos.length === 0 && !manualRepoCandidate ? (
                  reposLoading ? (
                    <div className="space-y-1.5 px-1 py-1.5">
                      {[1, 2, 3, 4].map((idx) => (
                        <div
                          key={idx}
                          className="h-6 animate-pulse rounded bg-muted/60"
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                      {auth?.authenticated
                        ? "未找到匹配的仓库，可输入 owner/repo 直接访问"
                        : "配置 PAT 或登录 gh CLI 后可拉取你的全部个人仓库"}
                    </div>
                  )
                ) : (
                  filteredRepos.map((item) => {
                    const isCurrent =
                      selectedRepoFullName?.toLowerCase() ===
                      item.fullName.toLowerCase();
                    const cachedUnread =
                      inboxes[item.fullName]?.unreadCount ?? 0;
                    return (
                      <button
                        key={item.fullName}
                        type="button"
                        onClick={() => handleSelectRepo(item.fullName)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-muted",
                          isCurrent && "bg-primary/12 font-medium text-primary",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {item.fullName}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-[9.5px]">
                          {item.localRoot && (
                            <span className="rounded bg-emerald-500/15 px-1 text-emerald-300">
                              本地
                            </span>
                          )}
                          {item.private && (
                            <span className="rounded bg-muted px-1 text-muted-foreground">
                              私有
                            </span>
                          )}
                          {cachedUnread > 0 && (
                            <span className="rounded-full bg-primary/20 px-1 text-primary">
                              {cachedUnread}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
          {matchedInbox && matchedInbox.unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {matchedInbox.unreadCount} 未读
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPatOpen((v) => !v)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              auth?.authenticated
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-amber-500/15 text-amber-300",
            )}
            title="点击配置或切换 GitHub PAT（默认会自动尝试本机 gh CLI）"
          >
            {auth?.authenticated
              ? `${auth.login ?? auth.source}`
              : "未授权 · 配 PAT"}
          </button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10.5px]"
            disabled={!forgeTarget}
            onClick={() => setNewIssueOpen((v) => !v)}
          >
            + 新 Issue
          </Button>
          <button
            type="button"
            disabled={syncing || !forgeTarget}
            onClick={() => void reload(true)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            title="立即同步 GitHub 收件箱"
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              size={13}
              className={syncing ? "animate-spin" : ""}
            />
          </button>
        </div>
      </header>

      {patOpen && (
        <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/30 px-3 py-2">
          <Input
            type="password"
            value={patInput}
            onChange={(e) => setPatInput(e.target.value)}
            placeholder="输入 GitHub Personal Access Token（留空保存即清除）…"
            className="h-7 flex-1 text-[11px]"
          />
          <Button size="sm" className="h-7 text-[11px]" disabled={busy} onClick={() => void handleSavePat()}>
            保存 PAT
          </Button>
        </div>
      )}

      {newIssueOpen && (
        <div className="space-y-1.5 border-b border-border/60 bg-muted/20 p-3">
          <Input
            value={newIssueTitle}
            onChange={(e) => setNewIssueTitle(e.target.value)}
            placeholder="Issue 标题…"
            className="h-7 text-[11px]"
          />
          <textarea
            value={newIssueBody}
            onChange={(e) => setNewIssueBody(e.target.value)}
            rows={3}
            placeholder="Issue 详情正文…"
            className="w-full resize-none rounded border border-border/70 bg-background/60 p-2 text-[11px] outline-none"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 text-[10.5px]" onClick={() => setNewIssueOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-6 text-[10.5px]" disabled={busy || !newIssueTitle.trim()} onClick={() => void handleCreateIssue()}>
              提交 Issue
            </Button>
          </div>
        </div>
      )}

      {syncing && (
        <div
          aria-hidden="true"
          className="h-[2px] w-full shrink-0 overflow-hidden bg-primary/10"
        >
          <div className="forge-indeterminate-bar h-full rounded-full bg-primary/80" />
        </div>
      )}

      {matchedInbox?.error && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10.5px] text-amber-200">
          <HugeiconsIcon icon={Alert02Icon} size={12} className="shrink-0" />
          <span className="truncate">{matchedInbox.error}</span>
        </div>
      )}

      {!forgeTarget ? (
        <div className="p-4 text-[11px] text-muted-foreground">
          请先打开工作区，或在左上角下拉框选择 / 输入个人 GitHub 仓库（如 owner/repo）。
        </div>
      ) : !matchedInbox?.repo ? (
        syncing ? (
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={13}
                className="shrink-0 animate-spin text-primary"
              />
              <span className="text-foreground/90">
                正在同步 {selectedRepoFullName ?? "GitHub 仓库"} 数据…
              </span>
            </div>
            <div className="space-y-2">
              {[76, 62, 84, 58, 70].map((w, idx) => (
                <div
                  key={idx}
                  className="animate-pulse space-y-1.5 rounded border border-border/40 bg-background/40 p-2.5"
                >
                  <div
                    className="h-3 rounded bg-muted/70"
                    style={{ width: `${w}%` }}
                  />
                  <div className="h-2.5 w-1/3 rounded bg-muted/50" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <HugeiconsIcon icon={GitBranchIcon} size={22} />
            <div className="text-foreground">尚未选中可用的 GitHub 仓库</div>
            <div className="text-[11px]">
              {targetRoot
                ? `当前工作区（${normalizeVcsPath(targetRoot)}）暂未配置 GitHub 远程，或请点击左上角切换个人 GitHub 仓库。`
                : "请点击左上角下拉框选择个人 GitHub 仓库。"}
            </div>
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1">
            <div className="flex items-center gap-1 text-[11px]">
              {(
                [
                  ["notifications", `通知 (${notifications.length})`],
                  ["issues", `Issues (${issues.length})`],
                  ["pulls", `PR (${pulls.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTab(id);
                    setSelectedIssue(null);
                    setSelectedPr(null);
                  }}
                  className={cn(
                    "rounded px-2 py-1 font-medium",
                    tab === id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab !== "notifications" && (
              <div className="flex items-center gap-0.5 text-[10px]">
                {(["open", "closed", "all"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStateFilter(s)}
                    className={cn(
                      "rounded px-1.5 py-0.5 uppercase",
                      stateFilter === s
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div
              className={cn(
                "min-w-0 flex-1 overflow-y-auto divide-y divide-border/40",
                (selectedIssue || selectedPr) && "hidden max-w-[44%] border-r border-border/60 md:block",
              )}
            >
              {tab === "notifications" &&
                (notifications.length === 0 ? (
                  <div className="p-4 text-[11px] text-muted-foreground">
                    {auth?.authenticated
                      ? "暂无通知，一切干净！"
                      : "需要配置 GitHub PAT 或登录 `gh` CLI 才可拉取账号通知流。"}
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      className={cn(
                        "flex items-start justify-between gap-2 px-3 py-2 hover:bg-muted/50",
                        n.unread && "bg-primary/5",
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          if (n.unread && forgeTarget) {
                            void markNotificationRead(forgeTarget, n.id).catch(
                              () => undefined,
                            );
                          }
                          if (n.subjectType === "Issue" && n.number) {
                            const hit = issues.find((i) => i.number === n.number);
                            if (hit) {
                              setTab("issues");
                              setSelectedIssue(hit);
                              return;
                            }
                          }
                          if (n.subjectType === "PullRequest" && n.number) {
                            const hit = pulls.find((p) => p.number === n.number);
                            if (hit) {
                              setTab("pulls");
                              setSelectedPr(hit);
                              return;
                            }
                          }
                          openExternal(n.htmlUrl);
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          {n.unread && (
                            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                          )}
                          <span className="rounded bg-muted px-1 text-[9.5px] text-muted-foreground">
                            {n.reason}
                          </span>
                          <span className="truncate font-medium text-foreground">
                            {n.title}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {n.subjectType} {n.number ? `#${n.number}` : ""} ·{" "}
                          {n.updatedAt.slice(0, 10)}
                        </div>
                      </button>
                      {n.unread && (
                        <button
                          type="button"
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() =>
                            forgeTarget && void markNotificationRead(forgeTarget, n.id)
                          }
                        >
                          已读
                        </button>
                      )}
                    </div>
                  ))
                ))}

              {tab === "issues" &&
                (issues.length === 0 ? (
                  <div className="p-4 text-[11px] text-muted-foreground">
                    暂无匹配的 Issues。
                  </div>
                ) : (
                  issues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      onClick={() => {
                        setSelectedPr(null);
                        setSelectedIssue(issue);
                      }}
                      className={cn(
                        "flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-muted/50",
                        selectedIssue?.id === issue.id && "bg-primary/10",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          #{issue.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {issue.title}
                        </span>
                        {issue.isAssignedToMe && (
                          <span className="rounded bg-primary/15 px-1 text-[9px] text-primary">
                            指派给我
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                        <span>@{issue.author}</span>
                        <span>· {issue.commentsCount} 评论</span>
                        {issue.labels.slice(0, 3).map((l) => (
                          <span
                            key={l.name}
                            className="rounded border border-border/60 px-1 text-[9px]"
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    </button>
                  ))
                ))}

              {tab === "pulls" &&
                (pulls.length === 0 ? (
                  <div className="p-4 text-[11px] text-muted-foreground">
                    暂无匹配的 Pull Requests。
                  </div>
                ) : (
                  pulls.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => {
                        setSelectedIssue(null);
                        setSelectedPr(pr);
                      }}
                      className={cn(
                        "flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-muted/50",
                        selectedPr?.id === pr.id && "bg-primary/10",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            pr.checksStatus === "success"
                              ? "bg-emerald-400"
                              : pr.checksStatus === "failure"
                                ? "bg-rose-400"
                                : pr.checksStatus === "pending"
                                  ? "bg-amber-400"
                                  : "bg-muted-foreground/50",
                          )}
                          title={`Checks: ${pr.checksStatus}`}
                        />
                        <span className="font-mono text-[10px] text-muted-foreground">
                          #{pr.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {pr.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="truncate font-mono">
                          {pr.headRef} → {pr.baseRef}
                        </span>
                        <span>· @{pr.author}</span>
                      </div>
                    </button>
                  ))
                ))}
            </div>

            {(selectedIssue || selectedPr) && (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background/30">
                <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-foreground">
                      #{(selectedIssue ?? selectedPr)!.number}{" "}
                      {(selectedIssue ?? selectedPr)!.title}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      @{(selectedIssue ?? selectedPr)!.author} · 状态：
                      {(selectedIssue ?? selectedPr)!.state}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      className="h-6 gap-1 px-2 text-[10px]"
                      disabled={busy || !localDispatchRoot}
                      title={
                        localDispatchRoot
                          ? "基于本地工作区新建独立 Worktree 并派单 Agent"
                          : "该仓库尚未添加到左侧工作区，暂不能直接派单 Agent Worktree"
                      }
                      onClick={() => {
                        const target = (selectedIssue ?? selectedPr)!;
                        void handleDispatch({
                          kind: selectedPr ? "pr" : "issue",
                          number: target.number,
                          title: target.title,
                          body: target.body,
                          htmlUrl: target.htmlUrl,
                        });
                      }}
                    >
                      <HugeiconsIcon icon={SparklesIcon} size={11} />
                      派单 Agent Worktree
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() =>
                        openExternal((selectedIssue ?? selectedPr)!.htmlUrl)
                      }
                    >
                      网页
                    </Button>
                    <button
                      type="button"
                      className="rounded px-1 text-muted-foreground hover:text-foreground md:hidden"
                      onClick={() => {
                        setSelectedIssue(null);
                        setSelectedPr(null);
                      }}
                    >
                      返回
                    </button>
                  </div>
                </div>

                <div className="reader-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px]">
                  {(selectedIssue ?? selectedPr)!.body && (
                    <div className="rounded border border-border/50 bg-card/70 p-3 text-foreground/90">
                      <ForgeMarkdown content={(selectedIssue ?? selectedPr)!.body} />
                    </div>
                  )}

                  {selectedIssue && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px]"
                        disabled={busy || !forgeTarget}
                        onClick={() =>
                          forgeTarget &&
                          void setIssueState(
                            forgeTarget,
                            selectedIssue.number,
                            selectedIssue.state === "open" ? "closed" : "open",
                          )
                            .then(() => reload(true))
                            .catch((e) => toast.error(String(e)))
                        }
                      >
                        {selectedIssue.state === "open"
                          ? "关闭 Issue"
                          : "重新打开 Issue"}
                      </Button>
                    </div>
                  )}

                  {selectedPr && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {confirmMergePr === selectedPr.number ? (
                          <Button
                            size="sm"
                            className="h-6 bg-emerald-600 text-[10px] hover:bg-emerald-500"
                            disabled={busy || !forgeTarget}
                            onClick={() => {
                              setConfirmMergePr(null);
                              if (!forgeTarget) return;
                              void mergePr(forgeTarget, selectedPr.number, "squash")
                                .then(() => {
                                  toast.success(`已 Squash Merge PR #${selectedPr.number}`);
                                  void reload(true);
                                })
                                .catch((e) => toast.error(String(e)));
                            }}
                          >
                            再次点击确认 Squash Merge
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px]"
                            disabled={busy || selectedPr.state !== "open"}
                            onClick={() => setConfirmMergePr(selectedPr.number)}
                          >
                            合并 PR (Squash)
                          </Button>
                        )}
                      </div>

                      {prDetailsLoading && checks.length === 0 && prFiles.length === 0 && (
                        <div className="flex items-center gap-1.5 rounded border border-border/50 bg-card/40 px-2.5 py-2 text-[10.5px] text-muted-foreground">
                          <HugeiconsIcon icon={Refresh01Icon} size={11} className="animate-spin text-primary" />
                          <span>正在加载 PR 检查与变更文件…</span>
                        </div>
                      )}

                      {checks.length > 0 && (
                        <div className="space-y-1 rounded border border-border/50 p-2">
                          <div className="text-[10px] font-medium text-muted-foreground">
                            CI Checks（{checks.length}）
                          </div>
                          {checks.map((c) => (
                            <div
                              key={c.id}
                              className="flex items-center justify-between gap-2 text-[10.5px]"
                            >
                              <span className="flex min-w-0 items-center gap-1">
                                <HugeiconsIcon
                                  icon={
                                    c.conclusion === "success"
                                      ? CheckmarkCircle02Icon
                                      : Alert02Icon
                                  }
                                  size={11}
                                  className={
                                    c.conclusion === "success"
                                      ? "text-emerald-400"
                                      : c.conclusion === "failure"
                                        ? "text-rose-400"
                                        : "text-amber-300"
                                  }
                                />
                                <span className="truncate">{c.name}</span>
                              </span>
                              <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                                {c.conclusion ?? c.status}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {prFiles.length > 0 && (
                        <div className="space-y-1 rounded border border-border/50 p-2">
                          <div className="text-[10px] font-medium text-muted-foreground">
                            变更文件（{prFiles.length}）
                          </div>
                          {prFiles.slice(0, 20).map((f) => (
                            <div
                              key={f.filename}
                              className="flex items-center justify-between gap-2 text-[10.5px]"
                            >
                              <span className="truncate font-mono">{f.filename}</span>
                              <span className="shrink-0 font-mono text-[10px]">
                                <span className="text-emerald-400">+{f.additions}</span>{" "}
                                <span className="text-rose-400">-{f.deletions}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-medium text-muted-foreground">
                      <span>评论动态（{comments.length}）</span>
                      {detailLoading && (
                        <span className="inline-flex items-center gap-1 text-primary">
                          <HugeiconsIcon icon={Refresh01Icon} size={10} className="animate-spin" />
                          <span>同步中…</span>
                        </span>
                      )}
                    </div>
                    {detailLoading && comments.length === 0 ? (
                      <div className="space-y-2">
                        {[1, 2].map((idx) => (
                          <div
                            key={idx}
                            className="animate-pulse space-y-2 rounded border border-border/50 bg-card/50 p-2.5"
                          >
                            <div className="flex justify-between">
                              <div className="h-2.5 w-20 rounded bg-muted/70" />
                              <div className="h-2.5 w-16 rounded bg-muted/50" />
                            </div>
                            <div className="h-3 w-4/5 rounded bg-muted/60" />
                            <div className="h-3 w-2/3 rounded bg-muted/50" />
                          </div>
                        ))}
                      </div>
                    ) : comments.length === 0 ? (
                      <div className="rounded border border-border/40 bg-card/30 px-2.5 py-2 text-[10.5px] text-muted-foreground">
                        暂无评论动态
                      </div>
                    ) : (
                      comments.map((c) => (
                        <div
                          key={c.id}
                          className="rounded border border-border/50 bg-card/50 p-2.5"
                        >
                          <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground/90">@{c.author}</span>
                            <span>{c.createdAt.slice(0, 10)}</span>
                          </div>
                          <div className="text-foreground/85">
                            <ForgeMarkdown content={c.body} />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 p-2">
                  <Input
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleReply();
                      }
                    }}
                    placeholder="回复评论（回车发送）…"
                    className="h-7 flex-1 text-[11px]"
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={busy || !replyText.trim()}
                    onClick={() => void handleReply()}
                  >
                    发送
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
