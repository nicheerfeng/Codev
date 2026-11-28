import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "./lib/contextActions";
import { currentWorkspaceEnv } from "@/modules/workspace";

type InitialProperties = {
  path: string;
  name: string;
  parent: string;
  kind: "file" | "dir" | "symlink-file" | "symlink-dir" | string;
  size: number;
  readonly: boolean;
  createdAt?: number | null;
  modifiedAt?: number | null;
  accessedAt?: number | null;
  linkTarget?: string | null;
  needsScan: boolean;
};

type ProgressPayload = {
  requestId: string;
  totalBytes: number;
  fileCount: number;
  dirCount: number;
  skippedCount: number;
  done: boolean;
  cancelled: boolean;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const formatted =
    idx === 0 ? `${Math.round(value)}` : value.toFixed(value >= 100 ? 1 : 2);
  return `${formatted} ${units[idx]}（${bytes.toLocaleString()} 字节）`;
}

function formatTime(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "dir":
      return "文件夹";
    case "file":
      return "文件";
    case "symlink-dir":
      return "符号链接（文件夹）";
    case "symlink-file":
      return "符号链接（文件）";
    default:
      return kind;
  }
}

export function ExplorerPropertiesDialog({
  path,
  onClose,
}: {
  path: string | null;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<InitialProperties | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setInfo(null);
      setProgress(null);
      setError(null);
      return;
    }

    let disposed = false;
    const requestId = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestId.current = requestId;
    setInfo(null);
    setProgress(null);
    setError(null);

    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        unlisten = await listen<ProgressPayload>(
          "fs:properties-progress",
          (event) => {
            if (disposed || event.payload.requestId !== requestId) return;
            setProgress(event.payload);
          },
        );
        const initial = await invoke<InitialProperties>(
          "fs_properties_inspect",
          {
            path,
            workspace: currentWorkspaceEnv(),
          },
        );
        if (disposed) return;
        setInfo(initial);
        if (initial.needsScan) {
          setProgress({
            requestId,
            totalBytes: 0,
            fileCount: 0,
            dirCount: 0,
            skippedCount: 0,
            done: false,
            cancelled: false,
          });
          await invoke("fs_properties_scan_start", {
            requestId,
            path,
            workspace: currentWorkspaceEnv(),
          });
        }
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      if (activeRequestId.current === requestId) {
        activeRequestId.current = null;
      }
      void invoke("fs_properties_scan_cancel", { requestId }).catch(() => {});
    };
  }, [path]);

  const scanning = Boolean(info?.needsScan && progress && !progress.done);
  const displayBytes = info?.needsScan
    ? (progress?.totalBytes ?? 0)
    : (info?.size ?? 0);

  return (
    <Dialog open={Boolean(path)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md gap-3 p-4 text-xs">
        <DialogHeader className="gap-1">
          <DialogTitle className="truncate pr-6 text-sm font-semibold">
            {info?.name ?? "属性"}
          </DialogTitle>
        </DialogHeader>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            读取属性失败：{error}
          </div>
        ) : !info ? (
          <div className="py-6 text-center text-muted-foreground">
            正在读取基础信息…
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-[12px]">
              <span className="text-muted-foreground">类型</span>
              <span className="text-foreground">{kindLabel(info.kind)}</span>

              <span className="text-muted-foreground">位置</span>
              <span className="break-all font-mono text-[11px] text-foreground/90">
                {info.parent || info.path}
              </span>

              <span className="text-muted-foreground">完整路径</span>
              <span className="break-all font-mono text-[11px] text-foreground/90">
                {info.path}
              </span>

              <span className="text-muted-foreground">大小</span>
              <div className="flex flex-wrap items-center gap-1.5 text-foreground">
                <span>{formatBytes(displayBytes)}</span>
                {scanning ? (
                  <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                    <span className="inline-block size-2 animate-spin rounded-full border border-current border-t-transparent" />
                    递增统计中…
                  </span>
                ) : null}
              </div>

              {info.needsScan && progress ? (
                <>
                  <span className="text-muted-foreground">包含</span>
                  <div className="flex flex-wrap items-center gap-2 text-foreground">
                    <span>
                      {progress.fileCount.toLocaleString()} 个文件，
                      {progress.dirCount.toLocaleString()} 个文件夹
                    </span>
                    {progress.skippedCount > 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        （跳过 {progress.skippedCount} 个无权限项）
                      </span>
                    ) : null}
                    {progress.cancelled ? (
                      <span className="text-[11px] text-amber-500">
                        已停止统计
                      </span>
                    ) : null}
                  </div>
                </>
              ) : null}

              {info.linkTarget ? (
                <>
                  <span className="text-muted-foreground">链接目标</span>
                  <span className="break-all font-mono text-[11px] text-foreground/90">
                    {info.linkTarget}
                  </span>
                </>
              ) : null}

              <span className="text-muted-foreground">只读</span>
              <span className="text-foreground">
                {info.readonly ? "是" : "否"}
              </span>

              <span className="text-muted-foreground">创建时间</span>
              <span className="text-foreground">
                {formatTime(info.createdAt)}
              </span>

              <span className="text-muted-foreground">修改时间</span>
              <span className="text-foreground">
                {formatTime(info.modifiedAt)}
              </span>

              <span className="text-muted-foreground">访问时间</span>
              <span className="text-foreground">
                {formatTime(info.accessedAt)}
              </span>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
              {scanning && activeRequestId.current ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => {
                    const id = activeRequestId.current;
                    if (id) {
                      void invoke("fs_properties_scan_cancel", {
                        requestId: id,
                      }).catch(() => {});
                    }
                  }}
                >
                  停止统计
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => {
                  void copyToClipboard(info.path);
                  toast.success("已复制路径");
                }}
              >
                复制路径
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-[11px]"
                onClick={() =>
                  void revealItemInDir(info.path).catch((err) =>
                    toast.error("打开所在位置失败", {
                      description: String(err),
                    }),
                  )
                }
              >
                在资源管理器中显示
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
