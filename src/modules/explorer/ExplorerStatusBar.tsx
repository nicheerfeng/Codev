import type { TransferEvent } from "./lib/useFileTransfer";
import type { SelectedFileMeta } from "./lib/useSelectedFileMeta";
import { formatFileSize, formatModifiedTime } from "./lib/useSelectedFileMeta";

type Props = {
  transfer: TransferEvent | null;
  selectedMeta: SelectedFileMeta | null;
  onCancel: () => void;
  onUndo: () => void;
  onClear: () => void;
};

/** 提取迁移状态栏中用于展示的最后一级名称。 */
function basename(path: string | null): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 将字节或条目进度转换为 0 到 100 的整数百分比。 */
function progressOf(transfer: TransferEvent): number | null {
  if (transfer.totalBytes > 0) {
    return Math.min(
      100,
      Math.round((transfer.doneBytes / transfer.totalBytes) * 100),
    );
  }
  if (transfer.totalItems > 0) {
    return Math.min(
      100,
      Math.round((transfer.doneItems / transfer.totalItems) * 100),
    );
  }
  return null;
}

/** 渲染迁移进度、停止撤销按钮和选中文件元信息底栏。 */
export function ExplorerStatusBar({
  transfer,
  selectedMeta,
  onCancel,
  onUndo,
  onClear,
}: Props) {
  const active =
    transfer?.status === "preparing" ||
    transfer?.status === "running" ||
    transfer?.status === "cancelling";
  const percent = transfer ? progressOf(transfer) : null;
  const metadata = selectedMeta
    ? `${selectedMeta.count} 项 · ${selectedMeta.fileCount} 个文件 · ${formatFileSize(selectedMeta.countedBytes)} · 最新 ${formatModifiedTime(selectedMeta.latestMtime)}${selectedMeta.skippedLargeCount ? ` · ${selectedMeta.skippedLargeCount} 个大文件未统计` : ""}`
    : "就绪";

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border/60 px-2 text-[10px] text-muted-foreground">
      <div
        className="min-w-0 flex-1 truncate"
        title={transfer?.currentPath ?? undefined}
      >
        {active ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-foreground">
              {transfer.status === "preparing"
                ? "准备迁移"
                : transfer.status === "cancelling"
                  ? "正在停止"
                  : `迁移 ${percent == null ? "…" : `${percent}%`}`}
            </span>
            <span className="truncate">{basename(transfer.currentPath)}</span>
          </span>
        ) : transfer?.status === "failed" ? (
          <span className="truncate text-destructive">
            迁移失败：{transfer.error?.message ?? "未知错误"}
          </span>
        ) : transfer?.status === "cancelled" ? (
          <span className="text-amber-500">迁移已停止</span>
        ) : transfer?.status === "completed" ? (
          <span className="text-foreground">迁移完成</span>
        ) : (
          <span
            title={
              selectedMeta?.skippedLargeCount
                ? "超过 100 MB 的文件未计入总大小"
                : undefined
            }
          >
            {metadata}
          </span>
        )}
      </div>
      {active ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent"
          onClick={onCancel}
          disabled={transfer.status === "cancelling"}
        >
          {transfer.status === "cancelling" ? "停止中" : "停止"}
        </button>
      ) : transfer?.status === "completed" && transfer.canUndo ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-accent"
          onClick={onUndo}
        >
          撤销
        </button>
      ) : transfer && transfer.status !== "preparing" ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-accent"
          onClick={onClear}
          aria-label="清除迁移提示"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
