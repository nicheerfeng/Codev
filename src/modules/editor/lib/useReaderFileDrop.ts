import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

export type ReaderFileDropGroup = "primary" | "secondary";
export type ReaderFileDropKind = "file" | "dir";

type ReaderFileDropOptions = {
  onOpen: (
    path: string,
    group: ReaderFileDropGroup,
    kind: ReaderFileDropKind,
  ) => void;
};

/** 将 Tauri 的物理坐标转换为当前 WebView 的逻辑坐标。 */
function logicalPoint(x: number, y: number): { x: number; y: number } {
  if (x <= window.innerWidth && y <= window.innerHeight) return { x, y };
  const dpr = window.devicePixelRatio || 1;
  return { x: x / dpr, y: y / dpr };
}

/** 返回外部文件释放位置对应的中央阅览器分栏。 */
function readerGroupAt(x: number, y: number): ReaderFileDropGroup | null {
  const point = logicalPoint(x, y);
  const element = document.elementFromPoint(point.x, point.y);
  const group = element?.closest<HTMLElement>("[data-editor-group]");
  const value = group?.dataset.editorGroup;
  return value === "primary" || value === "secondary" ? value : null;
}

/** 读取外部拖入文件或目录并交给当前阅览器处理。 */
export function useReaderFileDrop({ onOpen }: ReaderFileDropOptions): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") return;
        if (payload.type === "leave" || payload.paths.length === 0) return;

        const group = readerGroupAt(payload.position.x, payload.position.y);
        if (!group) return;

        void Promise.all(
          payload.paths.map(async (rawPath) => {
            const path = rawPath.replace(/\\/g, "/");
            const stat = await invoke<{ kind: "file" | "dir" | "symlink" }>(
              "fs_stat",
              { path, workspace: currentWorkspaceEnv() },
            ).catch(() => null);
            return stat?.kind === "file" || stat?.kind === "dir"
              ? { path, kind: stat.kind }
              : null;
          }),
        ).then((paths) => {
          if (disposed) return;
          for (const item of paths) {
            if (item) onOpenRef.current(item.path, group, item.kind);
          }
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[Codev] reader drag-drop listen failed:", error),
      );

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
