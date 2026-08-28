import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type ExplorerPathDropTarget = {
  updateTarget: (clientX: number, clientY: number) => boolean;
  dropPath: (path: string, clientX: number, clientY: number) => boolean;
  clearTarget: () => void;
};

type Options = {
  rootPath: string;
  isDir: (path: string) => boolean | undefined;
  selectedPaths?: string[];
  onMove: (sources: string[], toDir: string, copy: boolean) => void;
  pathDropTarget?: ExplorerPathDropTarget;
};

const THRESHOLD = 5;

/** 返回拖拽路径的父目录，供文件落点回退使用。 */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

/** 解析文件树拖拽最终落点，文件落点转换为其父目录。 */
export function resolveExplorerMoveTarget(
  source: string,
  rootPath: string,
  hoveredPath: string | null,
  insideExplorer: boolean,
  isDir: (path: string) => boolean | undefined,
): string | null {
  if (!insideExplorer) return null;
  const target = hoveredPath
    ? isDir(hoveredPath)
      ? hoveredPath
      : parentDir(hoveredPath)
    : rootPath;
  if (
    target === source ||
    target.startsWith(`${source}/`) ||
    parentDir(source) === target
  ) {
    return null;
  }
  return target;
}

/** 提交一次单项或多项拖拽，并区分移动与 Ctrl/⌘ 拷贝。 */
export function finishExplorerDrag(
  commit: boolean,
  source: string,
  sourcePaths: string[],
  copy: boolean,
  clientX: number,
  clientY: number,
  moveTarget: string | null,
  pathDropTarget: ExplorerPathDropTarget | undefined,
  onMove: (sources: string[], toDir: string, copy: boolean) => void,
): void {
  const handledByPathTarget =
    commit && (pathDropTarget?.dropPath(source, clientX, clientY) ?? false);
  if (commit && !handledByPathTarget && moveTarget) {
    onMove(sourcePaths, moveTarget, copy);
  }
  pathDropTarget?.clearTarget();
}

/** 管理文件树内部拖拽、多选拖拽、跨根目录落点和 Ctrl 拷贝。 */
export function useExplorerDnd({
  rootPath,
  isDir,
  selectedPaths = [],
  onMove,
  pathDropTarget,
}: Options) {
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);

  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const dropTargetRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const optsRef = useRef({
    rootPath,
    isDir,
    selectedPaths,
    onMove,
    pathDropTarget,
  });
  optsRef.current = { rootPath, isDir, selectedPaths, onMove, pathDropTarget };

  const placeGhost = useCallback((x: number, y: number) => {
    lastPosRef.current = { x, y };
    const ghost = ghostElRef.current;
    if (ghost) {
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y + 8}px`;
    }
  }, []);

  const ghostRef = useCallback(
    (element: HTMLDivElement | null) => {
      ghostElRef.current = element;
      if (element) placeGhost(lastPosRef.current.x, lastPosRef.current.y);
    },
    [placeGhost],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-fs-path]",
      );
      const source = row?.getAttribute("data-fs-path");
      if (!source) return;
      const selected = optsRef.current.selectedPaths;
      const sources = selected.includes(source) ? [...selected] : [source];
      const name = source.slice(source.lastIndexOf("/") + 1);
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let copy = event.ctrlKey || event.metaKey;

      const move = (nextEvent: PointerEvent) => {
        if (!active) {
          if (
            Math.hypot(nextEvent.clientX - startX, nextEvent.clientY - startY) <
            THRESHOLD
          )
            return;
          active = true;
          lastPosRef.current = { x: nextEvent.clientX, y: nextEvent.clientY };
          setDragLabel(
            sources.length > 1 ? `${name} + ${sources.length - 1}` : name,
          );
        }
        copy = nextEvent.ctrlKey || nextEvent.metaKey;
        placeGhost(nextEvent.clientX, nextEvent.clientY);
        const { rootPath, isDir, pathDropTarget } = optsRef.current;
        const element = document.elementFromPoint(
          nextEvent.clientX,
          nextEvent.clientY,
        );
        const terminalTargeted =
          pathDropTarget?.updateTarget(nextEvent.clientX, nextEvent.clientY) ??
          false;
        const hit = element?.closest<HTMLElement>("[data-fs-path]");
        const hoveredPath = hit?.getAttribute("data-fs-path");
        const hoveredIsDir = hoveredPath
          ? (isDir(hoveredPath) ?? hit?.dataset.fsKind === "dir")
          : undefined;
        const valid = terminalTargeted
          ? null
          : resolveExplorerMoveTarget(
              source,
              rootPath,
              hoveredPath ?? null,
              element?.closest("[data-explorer-drop]") != null,
              (path) => (path === hoveredPath ? hoveredIsDir : isDir(path)),
            );
        const safeTarget =
          valid &&
          sources.some(
            (candidate) =>
              valid === candidate || valid.startsWith(`${candidate}/`),
          )
            ? null
            : valid;
        if (dropTargetRef.current !== safeTarget) {
          dropTargetRef.current = safeTarget;
          setDropTargetDir(safeTarget);
        }
      };

      const detach = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        cleanupRef.current = null;
      };

      const end = (commit: boolean) => {
        detach();
        if (!active) return;
        const { x, y } = lastPosRef.current;
        finishExplorerDrag(
          commit,
          source,
          sources,
          copy,
          x,
          y,
          dropTargetRef.current,
          optsRef.current.pathDropTarget,
          optsRef.current.onMove,
        );
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        dropTargetRef.current = null;
        setDragLabel(null);
        setDropTargetDir(null);
      };

      const up = () => end(true);
      const cancel = () => end(false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      cleanupRef.current = detach;
    },
    [placeGhost],
  );

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      optsRef.current.pathDropTarget?.clearTarget();
    },
    [],
  );

  return { ghostRef, dragLabel, dropTargetDir, onPointerDown, onClickCapture };
}
