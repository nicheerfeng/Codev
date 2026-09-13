import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";

type ReorderAttrs = HTMLAttributes<HTMLDivElement> & {
  "data-pi-reorder": PiReorderKind;
  "data-pi-key": string;
  "data-pi-group": string;
};

export type PiReorderKind = "project" | "session";

/** 为 Pi 项目和 session 提供 pointer 捕获排序，避开 WebView2 的 HTML5 拖放。 */
export function usePiSidebarReorder(
  onMove: (
    kind: PiReorderKind,
    source: string,
    gap: number,
    group: string,
  ) => void,
) {
  const drag = useRef<{
    kind: PiReorderKind;
    source: string;
    group: string;
    pointerId: number;
    startY: number;
    target: HTMLElement;
    active: boolean;
    gap: number | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState<{
    kind: PiReorderKind;
    source: string;
    group: string;
    gap: number | null;
  } | null>(null);

  const cancel = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
    setPosition(null);
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        suppressClick.current = drag.current.active;
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  const itemProps = (
    kind: PiReorderKind,
    source: string,
    group: string,
  ): ReorderAttrs => ({
    "data-pi-reorder": kind,
    "data-pi-key": source,
    "data-pi-group": group,
    onDragStart: (event) => event.preventDefault(),
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
      suppressClick.current = false;
      drag.current = {
        kind,
        source,
        group,
        pointerId: event.pointerId,
        startY: event.clientY,
        target: event.currentTarget,
        active: false,
        gap: null,
      };
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active && Math.abs(event.clientY - current.startY) < 4)
        return;
      if (!current.active) {
        current.active = true;
        current.target.setPointerCapture(current.pointerId);
        document.body.style.userSelect = "none";
      }
      event.preventDefault();
      const selector = `[data-pi-reorder="${current.kind}"]`;
      const headers = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      ).filter((node) => node.dataset.piGroup === current.group);
      const index = headers.findIndex((header) => {
        const rect = header.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      current.gap = index < 0 ? headers.length : index;
      setPosition({
        kind: current.kind,
        source: current.source,
        group: current.group,
        gap: current.gap,
      });
    },
    onPointerUp: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      suppressClick.current = current.active;
      cancel();
      if (current.active && current.gap !== null) {
        onMove(current.kind, current.source, current.gap, current.group);
      }
    },
    onPointerCancel: cancel,
    onLostPointerCapture: () => {
      if (drag.current) cancel();
    },
    onClickCapture: (event) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return { position, itemProps };
}
