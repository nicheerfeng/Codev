import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  discoverGitRepos,
  gitCommit,
  gitDiff,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitSnapshot,
  gitTracking,
  gitStage,
  type GitChange,
  type GitRepo,
  type GitSnapshot,
} from "./native";

type Props = {
  roots: string[];
  onOpenDiff: (repo: GitRepo, change: GitChange, diff: string) => void;
  onOpenHistory: (
    repo: GitRepo,
    commits: Awaited<ReturnType<typeof gitLog>>,
  ) => void;
};

const repoCache = new Map<string, GitRepo[]>();

export function GitPanel({ roots, onOpenDiff, onOpenHistory }: Props) {
  const cacheKey = roots.join("\n");
  const cached = repoCache.get(cacheKey);
  const [repos, setRepos] = useState<GitRepo[]>(cached ?? []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(cached?.[0]?.root ?? "");
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tracking, setTracking] = useState<Awaited<
    ReturnType<typeof gitTracking>
  > | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const loadRepos = async (force = false) => {
    if (!force && repoCache.has(cacheKey)) {
      setRepos(repoCache.get(cacheKey) ?? []);
      setLoading(false);
      return;
    }
    const current = ++request.current;
    setLoading(true);
    try {
      const found = await discoverGitRepos(roots);
      if (current !== request.current) return;
      repoCache.set(cacheKey, found);
      setRepos(found);
      setSelected((value) =>
        value && found.some((repo) => repo.root === value)
          ? value
          : (found[0]?.root ?? ""),
      );
      setError("");
    } catch (failure) {
      if (current === request.current) setError(String(failure));
    } finally {
      if (current === request.current) setLoading(false);
    }
  };

  const loadSnapshot = async (root: string) => {
    if (!root) {
      setSnapshot(null);
      return;
    }
    try {
      setSnapshot(await gitSnapshot(root));
      setTracking(await gitTracking(root).catch(() => null));
      setError("");
    } catch (failure) {
      setError(String(failure));
    }
  };

  useEffect(() => {
    void loadRepos();
  }, [roots]);
  useEffect(() => {
    void loadSnapshot(selected);
  }, [selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) =>
      `${repo.name} ${repo.root}`.toLowerCase().includes(needle),
    );
  }, [query, repos]);

  const toggle = async (change: GitChange) => {
    if (!selected) return;
    await gitStage(selected, [change.path], !change.staged);
    await loadSnapshot(selected);
  };
  const commit = async () => {
    if (!selected || !message.trim()) return;
    setBusy(true);
    try {
      await gitCommit(selected, message);
      setMessage("");
      await loadSnapshot(selected);
      await loadRepos();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  const openDiff = async (change: GitChange) => {
    const repo = repos.find((item) => item.root === selected);
    if (!repo) return;
    onOpenDiff(
      repo,
      change,
      await gitDiff(selected, change.path, change.staged),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b border-border/60 p-2">
        <div className="flex items-center gap-1">
          <Input
            value={
              open
                ? query
                : (repos.find((repo) => repo.root === selected)?.name ?? "")
            }
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setOpen(true);
              setQuery(event.target.value);
            }}
            placeholder={loading ? "正在发现 Git 仓库" : "搜索并选择 Git 仓库"}
            className="h-7 text-xs"
          />
          {loading && <Spinner className="size-3.5" />}
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void loadRepos(true)}
          >
            刷新
          </Button>
        </div>
        {open && (
          <div className="absolute inset-x-2 top-10 z-20 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
            {loading && (
              <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-muted-foreground">
                <Spinner className="size-3.5" />
                正在扫描
              </div>
            )}
            {!loading && visible.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                未发现 Git 仓库
              </p>
            )}
            {visible.map((repo) => (
              <button
                key={repo.root}
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  setSelected(repo.root);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="block truncate text-xs">
                  {repo.name}
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {repo.branch} · {repo.changes}
                  </span>
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {repo.root}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {snapshot && (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="提交说明"
            className="h-16 resize-none text-xs"
          />
          {tracking && (
            <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {tracking.upstream
                  ? `${tracking.upstream} ↑${tracking.ahead} ↓${tracking.behind}`
                  : "没有上游分支"}
              </span>
              <Button
                size="sm"
                variant="outline"
                title="下载当前分支的云端新提交，只做快进合并"
                className="h-6 px-2 text-[10px]"
                disabled={!tracking.upstream || busy}
                onClick={() =>
                  void gitPull(selected)
                    .then(() => loadSnapshot(selected))
                    .catch((failure: unknown) => setError(String(failure)))
                }
              >
                拉取
              </Button>
              <Button
                size="sm"
                variant="outline"
                title="把本地已提交的记录上传到当前分支的云端"
                className="h-6 px-2 text-[10px]"
                disabled={busy}
                onClick={() =>
                  void gitPush(selected)
                    .then(() => loadSnapshot(selected))
                    .catch((failure: unknown) => setError(String(failure)))
                }
              >
                推送
              </Button>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            title="获取所有远程分支，并在主区打开提交图"
            className="mt-2 justify-start"
            onClick={() =>
              void (async () => {
                const repo = repos.find((item) => item.root === selected);
                if (!repo) return;
                setBusy(true);
                try {
                  await gitFetch(selected);
                  onOpenHistory(repo, await gitLog(selected));
                  setError("");
                } catch (failure) {
                  setError(String(failure));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Commit Graph
          </Button>
          <div className="mt-3 px-1 text-[10px] font-medium text-muted-foreground">
            CHANGES {snapshot.changes.length}
          </div>
          <Button
            title="把已暂存的改动记录到本地当前分支"
            disabled={busy || !message.trim()}
            onClick={() => void commit()}
          >
            提交
          </Button>
          <div className="reader-scrollbar mt-2 min-h-0 flex-1 overflow-auto">
            {snapshot.changes.length === 0 && (
              <p className="px-1 text-[11px] text-muted-foreground">没有改动</p>
            )}
            {snapshot.changes.map((change) => (
              <div
                key={`${change.staged}:${change.path}`}
                className="flex items-center gap-1 rounded px-1 py-1 hover:bg-accent/40"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-[11px]"
                  onClick={() => void openDiff(change)}
                >
                  <span className="mr-1 text-muted-foreground">
                    {change.status}
                  </span>
                  {change.path}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => void toggle(change)}
                >
                  {change.staged ? "取消暂存" : "暂存"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="border-t border-border/60 px-2 py-1 text-[10px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
