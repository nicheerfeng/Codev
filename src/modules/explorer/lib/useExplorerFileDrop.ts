import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

type Options = {
  rootPath: string | null;
  isDir: (path: string) => boolean | undefined;
  onTransfer: (sources: string[], destDir: string) => void;
};

/** 返回系统拖入文件的父目录。 */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

// Tauri reports the drop point in physical pixels on some platforms; scale down
// only when it overflows the logical viewport (mirrors the terminal drop).
function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  let lx = x;
  let ly = y;
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    lx = x / dpr;
    ly = y / dpr;
  }
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return isDir(p) ? p : parentDir(p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

// Accepts files dropped from the OS onto an explorer folder (copy, not move),
// via Tauri's native drag-drop. One webview-level listener; ignores drops that
// land outside the explorer (the terminal handles its own).
/** 监听系统文件拖入并交给统一迁移任务处理。 */
export function useExplorerFileDrop({ rootPath, isDir, onTransfer }: Options) {
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const optsRef = useRef({ rootPath, isDir, onTransfer });
  optsRef.current = { rootPath, isDir, onTransfer };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        const { rootPath, isDir, onTransfer } = optsRef.current;
        if (p.type === "enter" || p.type === "over") {
          setTargetDir(dirAt(p.position.x, p.position.y, rootPath, isDir));
          return;
        }
        if (p.type === "leave") {
          setTargetDir(null);
          return;
        }
        if (p.type === "drop") {
          const dir = dirAt(p.position.x, p.position.y, rootPath, isDir);
          setTargetDir(null);
          if (!dir || p.paths.length === 0) return;
          onTransfer(p.paths, dir);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[terax] explorer drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTargetDir(null);
      unlisten?.();
    };
  }, []);

  return { externalTargetDir: targetDir };
}
