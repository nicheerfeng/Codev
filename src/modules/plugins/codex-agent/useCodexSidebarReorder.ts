import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";

type ItemAttrs = HTMLAttributes<HTMLDivElement> & {
  "data-codex-reorder": CodexReorderKind;
  "data-codex-key": string;
  "data-codex-group": string;
};

export type CodexReorderKind = "project" | "session";

export type CodexReorderGhost = {
  kind: CodexReorderKind;
  source: string;
  group: string;
  label: string;
  x: number;
  y: number;
  width: number;
};

type DragState = {
  kind: CodexReorderKind;
  source: string;
  group: string;
  label: string;
  pointerId: number;
  startY: number;
  startX: number;
  x: number;
  y: number;
  target: HTMLElement;
  active: boolean;
  gap: number | null;
  width: number;
};

/** 为 Codex 项目和 session 提供整行 pointer 捕获排序，避开 WebView2 的 HTML5 拖放。 */
export function useCodexSidebarReorder(
  onMove: (
    kind: CodexReorderKind,
    source: string,
    gap: number,
    group: string,
  ) => void,
  external?: {
    hover: (
      kind: CodexReorderKind,
      source: string,
      x: number,
      y: number,
    ) => boolean;
    drop: (
      kind: CodexReorderKind,
      source: string,
      x: number,
      y: number,
    ) => boolean;
    clear: () => void;
  },
) {
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState<{
    kind: CodexReorderKind;
    source: string;
    group: string;
    gap: number | null;
  } | null>(null);
  const [ghost, setGhost] = useState<CodexReorderGhost | null>(null);

  const clearVisuals = useCallback(() => {
    setPosition(null);
    setGhost(null);
    document.body.style.userSelect = "";
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const current = drag.current;
      drag.current = null;
      if (current?.target.hasPointerCapture(current.pointerId)) {
        current.target.releasePointerCapture(current.pointerId);
      }
      suppressClick.current = current?.active === true;
      clearVisuals();
      external?.clear();
      if (
        commit &&
        current?.active &&
        external?.drop(current.kind, current.source, current.x, current.y)
      )
        return;
      if (commit && current?.active && current.gap !== null) {
        onMove(current.kind, current.source, current.gap, current.group);
      }
    },
    [clearVisuals, onMove, external],
  );

  const track = useCallback(
    (clientX: number, clientY: number) => {
      const current = drag.current;
      if (!current) return;
      current.x = clientX;
      current.y = clientY;
      if (
        !current.active &&
        Math.hypot(clientX - current.startX, clientY - current.startY) < 6
      )
        return;
      if (!current.active) {
        current.active = true;
        if (!current.target.hasPointerCapture(current.pointerId)) {
          current.target.setPointerCapture(current.pointerId);
        }
        document.body.style.userSelect = "none";
      }
      if (external?.hover(current.kind, current.source, clientX, clientY)) {
        current.gap = null;
        setPosition(null);
        setGhost({ ...current, x: clientX + 12, y: clientY + 12 });
        return;
      }
      const selector = `[data-codex-reorder="${current.kind}"]`;
      const headers = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      ).filter((node) => node.dataset.codexGroup === current.group);
      if (!headers.length) {
        current.gap = null;
        setPosition({
          kind: current.kind,
          source: current.source,
          group: current.group,
          gap: null,
        });
        setGhost(null);
        return;
      }
      const first = headers[0].getBoundingClientRect();
      const last = headers[headers.length - 1].getBoundingClientRect();
      const left = first.left;
      const width = first.width;
      const top = first.top;
      const bottom = last.bottom;
      if (
        clientX < left ||
        clientX > left + width ||
        clientY < top - 12 ||
        clientY > bottom + 12
      ) {
        current.gap = null;
      } else {
        const index = headers.findIndex((header) => {
          const rect = header.getBoundingClientRect();
          return clientY < rect.top + rect.height / 2;
        });
        current.gap = index < 0 ? headers.length : index;
      }
      setPosition({
        kind: current.kind,
        source: current.source,
        group: current.group,
        gap: current.gap,
      });
      const height = Math.max(28, first.height);
      const y = Math.min(bottom - height, Math.max(top, clientY - height / 2));
      setGhost({
        kind: current.kind,
        source: current.source,
        group: current.group,
        label: current.label,
        x: left,
        y,
        width,
      });
    },
    [external],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) finish(false);
    };
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.active) event.preventDefault();
      track(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      finish(true);
    };
    const onCancel = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      finish(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [finish, track]);

  const itemProps = (
    kind: CodexReorderKind,
    source: string,
    group: string,
    label: string,
  ): ItemAttrs => ({
    "data-codex-reorder": kind,
    "data-codex-key": source,
    "data-codex-group": group,
    onDragStart: (event) => event.preventDefault(),
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
      suppressClick.current = false;
      drag.current = {
        kind,
        source,
        group,
        label,
        pointerId: event.pointerId,
        startY: event.clientY,
        startX: event.clientX,
        x: event.clientX,
        y: event.clientY,
        target: event.currentTarget,
        active: false,
        gap: null,
        width: event.currentTarget.getBoundingClientRect().width,
      };
    },
    onLostPointerCapture: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.active && current.target.isConnected) {
        current.target.setPointerCapture(current.pointerId);
        return;
      }
      if (!current.active) finish(false);
    },
    onClickCapture: (event) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return { position, ghost, itemProps };
}
