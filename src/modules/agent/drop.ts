import {
  addPathAttachments,
  isImagePath,
  readPathImage,
} from "@/modules/plugins/pi-agent/piAttachments";
import type { ExplorerPathDropTarget } from "@/modules/explorer/lib/useExplorerDnd";
import { useEffect } from "react";
import { useAgentStore } from "./store";

async function detectKind(path: string): Promise<"file" | "dir"> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const stat = await invoke<{ isDir?: boolean; is_dir?: boolean }>(
      "fs_stat",
      { path },
    );
    if (stat?.isDir || stat?.is_dir) return "dir";
    return "file";
  } catch {
    return /[/\\]$/.test(path) || !path.split(/[/\\]/).pop()?.includes(".")
      ? "dir"
      : "file";
  }
}

async function insertDroppedPaths(node: HTMLElement, paths: string[]) {
  const id = node.dataset.agentComposer;
  if (!id || !paths.length) return;
  const state = useAgentStore.getState();
  const current = state.drafts[id] ?? { text: "", images: [], files: [] };
  const supportsImages = !!state.views[id]?.capabilities.supportsImages;
  const nextImages = [...current.images];
  const fileEntries: Array<{ path: string; kind: "file" | "dir" }> = [];

  for (const raw of paths) {
    const clean = raw.trim();
    if (!clean) continue;
    if (supportsImages && isImagePath(clean) && nextImages.length < 4) {
      try {
        const img = await readPathImage(clean);
        nextImages.push(img);
        continue;
      } catch {
        /* fallback to file chip if image read fails */
      }
    }
    const kind = await detectKind(clean);
    fileEntries.push({ path: clean, kind });
  }

  const nextFiles = addPathAttachments(current.files ?? [], fileEntries);
  state.setDraft(id, { images: nextImages, files: nextFiles });
  node.querySelector("textarea")?.focus();
}

function insertPaths(node: HTMLElement, paths: string[]) {
  void insertDroppedPaths(node, paths);
}

function composer(x: number, y: number): HTMLElement | null {
  const ratio =
    x > window.innerWidth || y > window.innerHeight
      ? window.devicePixelRatio || 1
      : 1;
  return (
    document
      .elementFromPoint(x / ratio, y / ratio)
      ?.closest<HTMLElement>("[data-agent-composer]") ?? null
  );
}
function hover(node: HTMLElement | null) {
  for (const old of document.querySelectorAll(
    "[data-agent-composer].agent-drop-hover",
  ))
    if (old !== node) old.classList.remove("agent-drop-hover");
  node?.classList.add("agent-drop-hover");
}
export function createAgentComposerPathDropTarget(): ExplorerPathDropTarget {
  return {
    updateTarget(x, y) {
      const node = composer(x, y);
      hover(node);
      return !!node;
    },
    dropPath(path, x, y) {
      const node = composer(x, y);
      hover(null);
      if (!node) return false;
      insertPaths(node, [path]);
      return true;
    },
    clearTarget() {
      hover(null);
    },
  };
}
export function composeExplorerPathDropTargets(
  ...targets: Array<ExplorerPathDropTarget | undefined>
): ExplorerPathDropTarget {
  const list = targets.filter(
    (target): target is ExplorerPathDropTarget => !!target,
  );
  return {
    updateTarget(x, y) {
      let hit = false;
      for (const target of list) if (target.updateTarget(x, y)) hit = true;
      return hit;
    },
    dropPath(path, x, y) {
      return list.some((target) => target.dropPath(path, x, y));
    },
    clearTarget() {
      for (const target of list) target.clearTarget();
    },
  };
}
export function useNativeAgentDrop(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "leave") {
            hover(null);
            return;
          }
          if (
            payload.type !== "enter" &&
            payload.type !== "over" &&
            payload.type !== "drop"
          )
            return;
          const node = composer(payload.position.x, payload.position.y);
          if (payload.type === "drop") {
            hover(null);
            if (node) insertPaths(node, payload.paths);
          } else hover(node);
        }),
      )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((e) => console.error("Agent 文件拖入监听失败", e));
    return () => {
      disposed = true;
      stop?.();
      hover(null);
    };
  }, [enabled]);
}
