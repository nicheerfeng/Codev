import type { ExplorerPathDropTarget } from "@/modules/explorer/lib/useExplorerDnd";
import { createNativeFileDragGate } from "@/lib/nativeFileDrag";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";

export type CodexComposerDropKind = "file" | "dir";

type CodexComposerDropDeps = {
  active: () => boolean;
  onDrop: (
    items: Array<{ path: string; kind: CodexComposerDropKind }>,
    threadKey?: string,
  ) => void;
  onHover?: (active: boolean, threadKey?: string) => void;
};

/** 获取指针下的输入附件区，兼容 WebView 物理坐标。 */
function composerElementAtPoint(
  clientX: number,
  clientY: number,
): Element | null {
  return (
    document
      .elementFromPoint(clientX, clientY)
      ?.closest("[data-codex-composer-drop]") ?? null
  );
}

/** 判断指针是否落在 Codex 输入附件区。 */
export function composerAtPoint(x: number, y: number): boolean {
  return composerElementAtPoint(x, y) !== null;
}

/** 在异步读取附件前固定目标会话，后续切换焦点不会改变落点。 */
function composerKeyAtPoint(x: number, y: number): string | undefined {
  return composerElementAtPoint(x, y)?.closest<HTMLElement>(
    "[data-codex-viewport-key]",
  )?.dataset.codexViewportKey;
}

/** 文件树 pointer 拖拽落到 Codex 输入区时挂路径芯片。 */
export function createCodexComposerPathDropTarget(
  deps: CodexComposerDropDeps,
): ExplorerPathDropTarget {
  return {
    updateTarget(clientX, clientY) {
      const hit = deps.active() && composerAtPoint(clientX, clientY);
      deps.onHover?.(hit, composerKeyAtPoint(clientX, clientY));
      return hit;
    },
    dropPath(path, clientX, clientY) {
      deps.onHover?.(false);
      if (!deps.active() || !composerAtPoint(clientX, clientY)) return false;
      const threadKey = composerKeyAtPoint(clientX, clientY);
      const normalized =
        path.replace(/\\/g, "/").replace(/\/+$/, "") ||
        path.replace(/\\/g, "/");
      void invoke<{ kind: "file" | "dir" | "symlink" }>("fs_stat", {
        path: normalized,
        workspace: currentWorkspaceEnv(),
      })
        .then((stat) => {
          deps.onDrop(
            [
              {
                path: normalized,
                kind: stat.kind === "dir" ? "dir" : "file",
              },
            ],
            threadKey,
          );
        })
        .catch(() => {
          deps.onDrop([{ path: normalized, kind: "file" }], threadKey);
        });
      return true;
    },
    clearTarget() {
      deps.onHover?.(false);
    },
  };
}

/** 系统拖到窗口且落在 Codex 输入区时，按文件/目录芯片接入。 */
export function useCodexComposerNativeDrop(deps: CodexComposerDropDeps): void {
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
          current.onHover?.(
            current.active() && composerAtPoint(point.x, point.y),
            composerKeyAtPoint(point.x, point.y),
          );
          return;
        }
        if (phase === "leave") {
          current.onHover?.(false);
          return;
        }
        if (phase !== "drop" || payload.type !== "drop" || !point) return;
        current.onHover?.(false);
        if (!current.active() || !composerAtPoint(point.x, point.y)) {
          return;
        }
        const threadKey = composerKeyAtPoint(point.x, point.y);
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
            (item): item is { path: string; kind: CodexComposerDropKind } =>
              !!item,
          );
          if (next.length) depsRef.current.onDrop(next, threadKey);
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[Codev] codex composer drag-drop listen failed:", error),
      );
    return () => {
      disposed = true;
      depsRef.current.onHover?.(false);
      unlisten?.();
    };
  }, []);
}
