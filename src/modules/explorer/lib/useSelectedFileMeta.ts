import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";

const MAX_COUNTED_FILE_BYTES = 100 * 1024 * 1024;

type FileStat = {
  size: number;
  mtime: number;
  kind: "file" | "dir" | "symlink";
};

export type SelectedFileMeta = {
  count: number;
  fileCount: number;
  directoryCount: number;
  countedBytes: number;
  skippedLargeCount: number;
  latestMtime: number;
};

/** 读取当前阅读文件的轻量元信息，不读取内容也不递归统计目录大小。 */
export function useSelectedFileMeta(
  path: string | null,
): SelectedFileMeta | null {
  const [meta, setMeta] = useState<SelectedFileMeta | null>(null);

  useEffect(() => {
    if (!path) {
      setMeta(null);
      return;
    }
    let alive = true;
    void invoke<FileStat>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .catch(() => null)
      .then((stat) => {
        if (!alive) return;
        if (!stat) {
          setMeta(null);
          return;
        }
        let fileCount = 0;
        let directoryCount = 0;
        let countedBytes = 0;
        let skippedLargeCount = 0;
        let latestMtime = 0;
        latestMtime = stat.mtime;
        if (stat.kind === "dir") directoryCount = 1;
        else {
          fileCount = 1;
          if (stat.size > MAX_COUNTED_FILE_BYTES) skippedLargeCount = 1;
          else countedBytes = stat.size;
        }
        setMeta({
          count: 1,
          fileCount,
          directoryCount,
          countedBytes,
          skippedLargeCount,
          latestMtime,
        });
      });
    return () => {
      alive = false;
    };
  }, [path]);

  return meta;
}

/** 将字节数压缩为底部状态行可读的短格式。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

/** 将最后修改时间格式化为本地短日期时间。 */
export function formatModifiedTime(mtime: number): string {
  if (!mtime) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(mtime));
}
