import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

type Options = {
  onAddRoot: (paths: string[]) => void;
};

// 把 Tauri 的物理拖放坐标转换为当前 WebView 的逻辑坐标。
function logicalPoint(x: number, y: number): { x: number; y: number } {
  if (x <= window.innerWidth && y <= window.innerHeight) return { x, y };
  const dpr = window.devicePixelRatio || 1;
  return { x: x / dpr, y: y / dpr };
}

// 判断拖放位置是否属于工作区工具栏或无根目录空白区。
function isWorkspaceFolderTarget(x: number, y: number): boolean {
  const point = logicalPoint(x, y);
  const element = document.elementFromPoint(point.x, point.y);
  return (
    element?.closest("[data-workspace-folder-drop], [data-explorer-empty]") !=
    null
  );
}

/** 接收外部文件夹并直接加入工作区，不与文件树内部复制逻辑混用。 */
export function useWorkspaceFolderDrop({ onAddRoot }: Options): void {
  const onAddRootRef = useRef(onAddRoot);
  onAddRootRef.current = onAddRoot;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type !== "drop" || payload.paths.length === 0) return;
        if (!isWorkspaceFolderTarget(payload.position.x, payload.position.y))
          return;

        void Promise.all(
          payload.paths.map(async (rawPath) => {
            const path = rawPath.replace(/\\/g, "/");
            const stat = await invoke<{ kind: "file" | "dir" | "symlink" }>(
              "fs_stat",
              { path },
            ).catch(() => null);
            return stat?.kind === "dir" ? path : null;
          }),
        ).then((paths) => {
          if (disposed) return;
          const folders = paths.filter((path): path is string => path != null);
          if (folders.length > 0) onAddRootRef.current(folders);
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[terax] workspace folder drop failed:", error),
      );

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
