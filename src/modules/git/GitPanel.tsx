import { useEffect, useRef, useState } from "react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  GitBranchIcon,
  GitCommitIcon,
  MinusSignIcon,
  PlusSignIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  gitCommit,
  gitDiff,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitTracking,
  type GitChange,
  type GitRepo,
  type GitTracking,
} from "./native";
import { invalidateGitStatus, useGitStatus } from "./useGitStatus";

type Props = {
  root: string | null;
  onBack: () => void;
  onOpenDiff: (repo: GitRepo, change: GitChange, diff: string) => void;
  onOpenHistory: (
    repo: GitRepo,
    commits: Awaited<ReturnType<typeof gitLog>>,
  ) => void;
};

const drafts = new Map<string, string>();

function statusTitle(status: string) {
  if (status === "M") return "已修改";
  if (status === "?") return "未跟踪";
  if (status === "D") return "已删除";
  if (status === "A") return "新增";
  if (status === "R") return "重命名";
  if (status === "C") return "复制";
  if (status === "U") return "未合并";
  if (status === "T") return "类型变更";
  return `Git 状态 ${status}`;
}

/** The panel owns one workspace root; discovery and network refresh are separate. */
export function GitPanel({ root, onBack, onOpenDiff, onOpenHistory }: Props) {
  const { snapshot, loading, error: readError, refresh } = useGitStatus(root);
  const [tracking, setTracking] = useState<GitTracking | null>(null);
  const [message, setMessage] = useState(() =>
    root ? (drafts.get(root) ?? "") : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const currentRoot = useRef(root);
  currentRoot.current = root;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setTracking(null);
    if (snapshot && root)
      void gitTracking(root)
        .then((value) => {
          if (active) setTracking(value);
        })
        .catch((failure) => {
          if (active) setError(String(failure));
        });
    return () => {
      active = false;
    };
  }, [root, snapshot]);
  useEffect(() => {
    setMessage(root ? (drafts.get(root) ?? "") : "");
  }, [root]);

  const run = async (
    action: (path: string) => Promise<void>,
    update = true,
  ) => {
    if (!root || locked.current || loading) return;
    const target = root;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action(target);
    } catch (failure) {
      if (mounted.current && currentRoot.current === target)
        setError(String(failure));
    } finally {
      if (update) {
        invalidateGitStatus(target);
        if (mounted.current && currentRoot.current === target) await refresh();
      }
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const openDiff = (change: GitChange) =>
    run(async (path) => {
      if (!snapshot) return;
      const diff = await gitDiff(path, change.path, change.staged);
      if (mounted.current) onOpenDiff(snapshot.repo, change, diff);
    }, false);
  const openHistory = () =>
    run(async (path) => {
      if (!snapshot) return;
      const commits = await gitLog(path);
      if (mounted.current) onOpenHistory(snapshot.repo, commits);
    }, false);
  const changes = snapshot?.changes ?? [];
  const staged = changes.filter((change) => change.staged);
  const unstaged = changes.filter((change) => !change.staged);
  const disabled = busy || loading;

  return (
    <section aria-label="Git 工作区" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-2 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0"
            onClick={onBack}
            title="返回文件树"
            aria-label="返回文件树"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={15} />
          </Button>
          <h2
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={root ?? ""}
          >
            {snapshot?.repo.name ??
              root?.split(/[\\/]/).filter(Boolean).slice(-1)[0] ??
              "Git"}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0"
            disabled={disabled || !root}
            onClick={() => {
              setError("");
              void refresh();
            }}
            title="刷新本地状态"
            aria-label="刷新本地状态"
          >
            {loading ? (
              <Spinner className="size-3.5" />
            ) : (
              <HugeiconsIcon icon={Refresh01Icon} size={14} />
            )}
          </Button>
        </div>
        {root && (
          <p
            className="mt-1 truncate px-1 text-[10px] text-muted-foreground"
            title={root}
          >
            {root}
          </p>
        )}
      </div>
      {snapshot && !snapshot.empty ? (
        <>
          <div className="shrink-0 border-b border-border/60 p-2">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <HugeiconsIcon icon={GitBranchIcon} size={14} />
              <span
                className="min-w-0 flex-1 truncate"
                title={snapshot.repo.branch}
              >
                {snapshot.repo.branch}
              </span>
              {busy && <Spinner className="size-3.5 shrink-0" />}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <p
                className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                title={tracking?.upstream || "没有上游分支"}
              >
                {tracking?.upstream
                  ? `${tracking.upstream} ↑${tracking.ahead} ↓${tracking.behind}`
                  : "没有上游分支"}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
                disabled={disabled}
                onClick={() => void run(gitFetch)}
                title="获取远程引用，不修改工作区"
              >
                <HugeiconsIcon icon={Refresh01Icon} size={12} />
                获取
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
                disabled={disabled || !tracking?.upstream}
                onClick={() => void run(gitPull)}
                title="仅快进拉取"
              >
                <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
                拉取
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
                disabled={disabled}
                onClick={() => void run(gitPush)}
                title="推送当前提交，不强推"
              >
                <HugeiconsIcon icon={ArrowUp01Icon} size={12} />
                推送
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 w-full justify-start text-[11px]"
              disabled={disabled}
              title="查看本地已知提交，不联网"
              onClick={() => void openHistory()}
            >
              Commit Graph
            </Button>
          </div>
          <div className="reader-scrollbar min-h-0 flex-1 overflow-auto py-1">
            <div>
              <div className="flex h-7 items-center gap-1 px-3 text-[11px] text-muted-foreground">
                <span className="flex-1">暂存区</span>
                <span>{staged.length}</span>
                {staged.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    disabled={disabled}
                    title="全部取消暂存"
                    aria-label="全部取消暂存"
                    onClick={() =>
                      void run((path) =>
                        gitStage(
                          path,
                          staged.map((change) => change.path),
                          false,
                        ),
                      )
                    }
                  >
                    <HugeiconsIcon icon={MinusSignIcon} size={12} />
                  </Button>
                )}
              </div>
              <div className="border-b border-border/60 px-2 pb-2">
                <Textarea
                  aria-label="提交说明"
                  placeholder="提交说明"
                  value={message}
                  disabled={busy}
                  className="h-16 resize-none text-xs"
                  onChange={(event) => {
                    setMessage(event.target.value);
                    if (root) drafts.set(root, event.target.value);
                  }}
                />
                <Button
                  className="mt-2 h-7 w-full gap-1.5 text-xs"
                  disabled={disabled || !message.trim() || !staged.length}
                  onClick={() =>
                    void run(async (path) => {
                      await gitCommit(path, message);
                      drafts.delete(path);
                      if (mounted.current) setMessage("");
                    })
                  }
                >
                  <HugeiconsIcon icon={GitCommitIcon} size={14} />
                  提交{staged.length ? ` (${staged.length})` : ""}
                </Button>
              </div>
              {staged.map((change) => (
                <ChangeRow
                  key={`staged:${change.path}`}
                  change={change}
                  staged
                  disabled={disabled}
                  onOpen={() => void openDiff(change)}
                  onToggle={() =>
                    void run((path) => gitStage(path, [change.path], false))
                  }
                />
              ))}
            </div>
            <div>
              <div className="flex h-7 items-center gap-1 px-3 text-[11px] text-muted-foreground">
                <span className="flex-1">工作区</span>
                <span>{unstaged.length}</span>
                {unstaged.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    disabled={disabled}
                    title="全部暂存"
                    aria-label="全部暂存"
                    onClick={() =>
                      void run((path) =>
                        gitStage(
                          path,
                          unstaged.map((change) => change.path),
                          true,
                        ),
                      )
                    }
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={12} />
                  </Button>
                )}
              </div>
              {unstaged.map((change) => (
                <ChangeRow
                  key={`work:${change.path}`}
                  change={change}
                  staged={false}
                  disabled={disabled}
                  onOpen={() => void openDiff(change)}
                  onToggle={() =>
                    void run((path) => gitStage(path, [change.path], true))
                  }
                />
              ))}
            </div>
            {!changes.length && (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                工作区干净
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {loading
            ? "正在读取 Git 状态…"
            : readError
              ? "Git 状态读取失败"
              : snapshot?.empty
                ? "空 Git 仓库"
                : "当前根目录不是 Git 仓库"}
        </p>
      )}
      {(error || readError) && (
        <p
          role="alert"
          className="shrink-0 border-t border-border/60 px-3 py-2 text-[11px] break-words text-destructive"
        >
          {error || readError}
        </p>
      )}
    </section>
  );
}

function ChangeRow({
  change,
  staged,
  disabled,
  onOpen,
  onToggle,
}: {
  change: GitChange;
  staged: boolean;
  disabled: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-1 px-3 hover:bg-accent/50">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-[11px]"
        disabled={disabled}
        title={change.path}
        onClick={onOpen}
      >
        {change.path}
      </button>
      <span
        className={`w-3 shrink-0 text-center text-[10px] ${change.status === "D" ? "text-destructive" : change.status === "M" ? "text-amber-500" : "text-green-500"}`}
        title={statusTitle(change.status)}
      >
        {change.status}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-5 shrink-0"
        disabled={disabled}
        title={staged ? "取消暂存" : "暂存"}
        aria-label={`${staged ? "取消暂存" : "暂存"} ${change.path}`}
        onClick={onToggle}
      >
        <HugeiconsIcon icon={staged ? MinusSignIcon : PlusSignIcon} size={12} />
      </Button>
    </div>
  );
}
