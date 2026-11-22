import type { ExplorerPathDropTarget } from "@/modules/explorer/lib/useExplorerDnd";
import { createNativeFileDragGate } from "@/lib/nativeFileDrag";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

type AntigravityComposerDropDeps = {
  active: () => boolean;
  onDrop: (paths: string[], key?: string) => void;
  onHover?: (hover: boolean, key?: string) => void;
};

/** 取指针下的 Antigravity 输入区，兼容 WebView 物理坐标换算后的客户端坐标。 */
function composerAtPoint(clientX: number, clientY: number): Element | null {
  return (
    document
      .elementFromPoint(clientX, clientY)
      ?.closest("[data-antigravity-composer-drop]") ?? null
  );
}

function composerKeyAtPoint(
  clientX: number,
  clientY: number,
): string | undefined {
  return composerAtPoint(clientX, clientY)?.closest<HTMLElement>(
    "[data-antigravity-key]",
  )?.dataset.antigravityKey;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

/** 文件树 pointer 拖到输入区时把路径写进草稿。 */
export function createAntigravityComposerPathDropTarget(
  deps: AntigravityComposerDropDeps,
): ExplorerPathDropTarget {
  return {
    updateTarget(clientX, clientY) {
      const hit = deps.active() && composerAtPoint(clientX, clientY);
      deps.onHover?.(Boolean(hit), composerKeyAtPoint(clientX, clientY));
      return Boolean(hit);
    },
    dropPath(path, clientX, clientY) {
      deps.onHover?.(false);
      if (!deps.active() || !composerAtPoint(clientX, clientY)) return false;
      deps.onDrop(
        [normalizePath(path)],
        composerKeyAtPoint(clientX, clientY),
      );
      return true;
    },
    clearTarget() {
      deps.onHover?.(false);
    },
  };
}

/** 系统拖入窗口且落在输入区时，同样只写入路径，不额外复制文件。 */
export function useAntigravityComposerNativeDrop(
  deps: AntigravityComposerDropDeps,
): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const gate = createNativeFileDragGate();
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        const current = depsRef.current;
        const phase = gate.phase(payload);
        const point =
          "position" in payload
            ? {
                x: payload.position.x / window.devicePixelRatio,
                y: payload.position.y / window.devicePixelRatio,
              }
            : null;
        if (phase === "ignore") return;
        if (
          phase === "hover" &&
          point &&
          (payload.type === "enter" || payload.type === "over")
        ) {
          const hit = current.active() && composerAtPoint(point.x, point.y);
          current.onHover?.(Boolean(hit), composerKeyAtPoint(point.x, point.y));
          return;
        }
        if (phase === "leave") {
          current.onHover?.(false);
          return;
        }
        if (phase !== "drop" || payload.type !== "drop" || !point) return;
        current.onHover?.(false);
        if (!current.active() || !composerAtPoint(point.x, point.y)) return;
        current.onDrop(
          payload.paths.map(normalizePath),
          composerKeyAtPoint(point.x, point.y),
        );
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[Codev] antigravity composer drop listen failed:", error),
      );
    return () => {
      disposed = true;
      depsRef.current.onHover?.(false);
      unlisten?.();
    };
  }, []);
}
