import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { mergeConflictAcceptBoth, parseUnifiedHunks } from "@/modules/vcs/hunks";
import { useVcsStore } from "@/modules/vcs/store";
import type { VcsConflictVersions, VcsDiffPayload } from "@/modules/vcs/types";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** 专业 VCS Diff 与三路冲突解决主区视图（基于 @codemirror/merge）。 */
export function VcsDiffView({
  repoRoot,
  path,
  diff,
  staged = false,
  conflict = false,
  commitHash,
}: {
  repoRoot: string;
  path: string;
  diff: string;
  staged?: boolean;
  conflict?: boolean;
  commitHash?: string;
}) {
  const theme = useEditorThemeExt();
  const [payload, setPayload] = useState<VcsDiffPayload | null>(null);
  const [conflictData, setConflictData] = useState<VcsConflictVersions | null>(null);
  const [resolvedText, setResolvedText] = useState("");
  const [viewMode, setViewMode] = useState<"side-by-side" | "unified">("side-by-side");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const mergeHostRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  const loadDiff = useVcsStore((s) => s.loadDiff);
  const loadCommitFileDiff = useVcsStore((s) => s.loadCommitFileDiff);
  const loadConflictVersions = useVcsStore((s) => s.loadConflictVersions);
  const applyHunk = useVcsStore((s) => s.applyHunk);
  const resolveConflict = useVcsStore((s) => s.resolveConflict);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (conflict) {
        const res = await loadConflictVersions(repoRoot, path);
        setConflictData(res);
        setResolvedText(res.working);
        setPayload(null);
      } else if (commitHash) {
        const res = await loadCommitFileDiff(repoRoot, commitHash, path);
        setPayload(res);
        setConflictData(null);
      } else {
        const res = await loadDiff(repoRoot, path, staged);
        setPayload(res);
        setConflictData(null);
      }
    } catch {
      // Fallback gracefully to inline diff string if provided (e.g. legacy caller / mock)
      if (diff) {
        setPayload({
          path,
          originalLabel: "基准",
          modifiedLabel: "当前",
          original: "",
          modified: "",
          unified: diff,
          truncated: false,
          binary: false,
        });
      }
    } finally {
      setLoading(false);
    }
  }, [conflict, commitHash, diff, loadCommitFileDiff, loadConflictVersions, loadDiff, path, repoRoot, staged]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const parsedHunks = useMemo(
    () => parseUnifiedHunks(payload?.unified || diff),
    [diff, payload?.unified],
  );

  // Render Side-by-Side MergeView directly inside mergeHostRef
  useEffect(() => {
    const container = mergeHostRef.current;
    if (!container || conflict || viewMode !== "side-by-side" || !payload || payload.binary) {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
      return;
    }
    mergeViewRef.current?.destroy();
    const shared = buildSharedExtensions();
    const readOnlyExt = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    mergeViewRef.current = new MergeView({
      a: {
        doc: payload.original,
        extensions: [...shared, ...readOnlyExt, theme],
      },
      b: {
        doc: payload.modified,
        extensions: [...shared, ...readOnlyExt, theme],
      },
      parent: container,
      collapseUnchanged: { margin: 3, minSize: 4 },
      gutter: true,
      highlightChanges: true,
    });
    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
  }, [conflict, payload, theme, viewMode]);

  const unifiedExtensions = useMemo(() => {
    if (!payload) return [EditorState.readOnly.of(true)];
    return [
      ...buildSharedExtensions(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      unifiedMergeView({
        original: payload.original,
        highlightChanges: true,
        gutter: true,
        mergeControls: false,
      }),
    ];
  }, [payload]);

  const handleHunk = async (hunkPatch: string, action: "stage" | "unstage" | "discard") => {
    setBusy(true);
    try {
      if (action === "stage") {
        await applyHunk(repoRoot, hunkPatch, true, false);
      } else if (action === "unstage") {
        await applyHunk(repoRoot, hunkPatch, true, true);
      } else {
        await applyHunk(repoRoot, hunkPatch, false, true);
      }
      toast.success(
        action === "stage"
          ? "已暂存选中代码块"
          : action === "unstage"
            ? "已取消暂存该代码块"
            : "已还原该代码块修改",
      );
      await reload();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleResolveConflict = async (strategy: "ours" | "theirs" | "custom") => {
    setBusy(true);
    try {
      await resolveConflict(
        repoRoot,
        path,
        strategy,
        strategy === "custom" ? resolvedText : undefined,
      );
      toast.success("冲突已解决并暂存");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  if (conflict && conflictData) {
    return (
      <div className="flex h-full flex-col bg-card">
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              三路冲突合并
            </span>
            <span className="truncate font-mono text-[11px]">{path}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              disabled={busy}
              onClick={() => void handleResolveConflict("ours")}
            >
              全部采用当前 (Ours)
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              disabled={busy}
              onClick={() => void handleResolveConflict("theirs")}
            >
              全部采用传入 (Theirs)
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              disabled={busy}
              onClick={() =>
                setResolvedText(
                  mergeConflictAcceptBoth(conflictData.ours, conflictData.theirs),
                )
              }
            >
              保留双方内容
            </Button>
            <Button
              size="sm"
              className="h-6 text-[11px]"
              disabled={busy}
              onClick={() => void handleResolveConflict("custom")}
            >
              保存结果并标记解决
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-px bg-border/60">
          <div className="flex min-h-0 flex-col bg-card">
            <div className="border-b border-border/50 px-2.5 py-1 text-[10px] font-medium text-sky-400">
              {conflictData.oursLabel}
            </div>
            <CodeMirror
              value={conflictData.ours}
              editable={false}
              theme={theme}
              height="100%"
              className="min-h-0 flex-1 overflow-auto text-[12px]"
            />
          </div>
          <div className="flex min-h-0 flex-col bg-card">
            <div className="border-b border-border/50 px-2.5 py-1 text-[10px] font-medium text-emerald-400">
              {conflictData.theirsLabel}
            </div>
            <CodeMirror
              value={conflictData.theirs}
              editable={false}
              theme={theme}
              height="100%"
              className="min-h-0 flex-1 overflow-auto text-[12px]"
            />
          </div>
          <div className="col-span-2 flex min-h-0 flex-col bg-card">
            <div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1 text-[10px]">
              <span className="font-medium text-amber-300">
                合并结果工作区（可直接手改后点右上角保存标记解决）
              </span>
              <span className="text-muted-foreground">共同祖先 Base：{conflictData.base.split("\n").length} 行</span>
            </div>
            <CodeMirror
              value={resolvedText}
              onChange={setResolvedText}
              theme={theme}
              height="100%"
              className="min-h-0 flex-1 overflow-auto text-[12px]"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {commitHash
              ? `提交 ${commitHash.slice(0, 7)}`
              : staged
                ? "暂存区 Diff"
                : "工作区 Diff"}
          </span>
          <span className="truncate font-mono text-[11px]">{path}</span>
          {payload?.truncated && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
              文件较大，仅展示前 2 MiB
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setViewMode("side-by-side")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px]",
              viewMode === "side-by-side"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            并排对比
          </button>
          <button
            type="button"
            onClick={() => setViewMode("unified")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px]",
              viewMode === "unified"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            内联对比
          </button>
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

      {!commitHash && parsedHunks.hunks.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/50 bg-muted/20 px-3 py-1">
          <span className="shrink-0 text-[10px] text-muted-foreground">代码块级操作：</span>
          {parsedHunks.hunks.map((hunk, i) => (
            <div
              key={hunk.id}
              className="flex shrink-0 items-center gap-1 rounded border border-border/60 bg-card px-1.5 py-0.5 text-[10px]"
            >
              <span className="font-mono text-muted-foreground">
                #{i + 1} (+{hunk.additions}/-{hunk.deletions})
              </span>
              {!staged ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    className="text-emerald-400 hover:underline disabled:opacity-40"
                    onClick={() => void handleHunk(hunk.patch, "stage")}
                  >
                    暂存块
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="text-rose-400 hover:underline disabled:opacity-40"
                    onClick={() => void handleHunk(hunk.patch, "discard")}
                  >
                    丢弃块
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  className="text-amber-300 hover:underline disabled:opacity-40"
                  onClick={() => void handleHunk(hunk.patch, "unstage")}
                >
                  取消暂存块
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {payload?.binary ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            当前文件为二进制内容，无法文本对照预览。
          </div>
        ) : viewMode === "side-by-side" ? (
          <div
            ref={mergeHostRef}
            className="codev-vcs-merge h-full min-h-0 [&_.cm-mergeView]:h-full [&_.cm-mergeViewEditors]:min-h-full [&_.cm-editor]:text-[12px]"
          />
        ) : payload ? (
          <CodeMirror
            value={payload.modified}
            theme={theme}
            extensions={unifiedExtensions}
            height="100%"
            className="h-full min-h-0 text-[12px]"
          />
        ) : (
          <pre className="p-3 font-mono text-[11px] text-muted-foreground">
            {diff || (loading ? "正在加载差异…" : "暂无可对比差异")}
          </pre>
        )}
      </div>
    </div>
  );
}
