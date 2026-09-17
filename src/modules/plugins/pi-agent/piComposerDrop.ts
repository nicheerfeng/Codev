import type { ExplorerPathDropTarget } from "@/modules/explorer/lib/useExplorerDnd";
import { createNativeFileDragGate } from "@/lib/nativeFileDrag";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

export type PiComposerDropKind = "file" | "dir";

type PiComposerDropDeps = {
  active: () => boolean;
  onDrop: (items: Array<{ path: string; kind: PiComposerDropKind }>) => void;
  onHover?: (active: boolean) => void;
};

/** 判断指针是否落在 Pi 输入附件区。 */
export function composerAtPoint(clientX: number, clientY: number): boolean {
  let x = clientX;
  let y = clientY;
  if (clientX > window.innerWidth || clientY > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    x = clientX / dpr;
    y = clientY / dpr;
  }
  return (
    document.elementFromPoint(x, y)?.closest("[data-pi-composer-drop]") != null
  );
}

/** 文件树 pointer 拖拽落到 Pi 输入区时挂路径芯片。 */
export function createPiComposerPathDropTarget(
  deps: PiComposerDropDeps,
): ExplorerPathDropTarget {
  return {
    updateTarget(clientX, clientY) {
      const hit = deps.active() && composerAtPoint(clientX, clientY);
      deps.onHover?.(hit);
      return hit;
    },
    dropPath(path, clientX, clientY) {
      deps.onHover?.(false);
      if (!deps.active() || !composerAtPoint(clientX, clientY)) return false;
      const normalized =
        path.replace(/\\/g, "/").replace(/\/+$/, "") ||
        path.replace(/\\/g, "/");
      void invoke<{ kind: "file" | "dir" | "symlink" }>("fs_stat", {
        path: normalized,
        workspace: currentWorkspaceEnv(),
      })
        .then((stat) => {
          deps.onDrop([
            {
              path: normalized,
              kind: stat.kind === "dir" ? "dir" : "file",
            },
          ]);
        })
        .catch(() => {
          deps.onDrop([{ path: normalized, kind: "file" }]);
        });
      return true;
    },
    clearTarget() {
      deps.onHover?.(false);
    },
  };
}

/** 串联终端和 Pi 两个落点，互不抢对方命中。 */
export function composeExplorerPathDropTargets(
  ...targets: Array<ExplorerPathDropTarget | undefined>
): ExplorerPathDropTarget {
  const list = targets.filter((item): item is ExplorerPathDropTarget => !!item);
  return {
    updateTarget(clientX, clientY) {
      let hit = false;
      for (const target of list) {
        if (target.updateTarget(clientX, clientY)) hit = true;
      }
      return hit;
    },
    dropPath(path, clientX, clientY) {
      for (const target of list) {
        if (target.dropPath(path, clientX, clientY)) return true;
      }
      return false;
    },
    clearTarget() {
      for (const target of list) target.clearTarget();
    },
  };
}

/** 系统拖到窗口且落在 Pi 输入区时，按文件/目录芯片接入。 */
export function usePiComposerNativeDrop(deps: PiComposerDropDeps): void {
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
        if (phase === "ignore") return;
        if (
          phase === "hover" &&
          (payload.type === "enter" || payload.type === "over")
        ) {
          current.onHover?.(
            current.active() &&
              composerAtPoint(payload.position.x, payload.position.y),
          );
          return;
        }
        if (phase === "leave") {
          current.onHover?.(false);
          return;
        }
        if (phase !== "drop" || payload.type !== "drop") return;
        current.onHover?.(false);
        if (
          !current.active() ||
          !composerAtPoint(payload.position.x, payload.position.y)
        ) {
          return;
        }
        void Promise.all(
          payload.paths.map(async (raw) => {
            const path = raw.replace(/\\/g, "/");
            const stat = await invoke<{ kind: "file" | "dir" | "symlink" }>(
              "fs_stat",
              { path, workspace: currentWorkspaceEnv() },
            ).catch(() => null);
            if (stat?.kind === "dir") return { path, kind: "dir" as const };
            if (stat?.kind === "file") return { path, kind: "file" as const };
            return null;
          }),
        ).then((items) => {
          if (disposed) return;
          const next = items.filter(
            (item): item is { path: string; kind: PiComposerDropKind } =>
              !!item,
          );
          if (next.length) depsRef.current.onDrop(next);
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[Codev] pi composer drag-drop listen failed:", error),
      );
    return () => {
      disposed = true;
      depsRef.current.onHover?.(false);
      unlisten?.();
    };
  }, []);
}
