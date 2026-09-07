import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";

/** 为根标题提供独立的指针排序，不进入文件迁移流程。 */
export function useRootReorder(
  container: RefObject<HTMLDivElement | null>,
  onReorder: (source: string, gap: number) => void | Promise<void>,
) {
  const drag = useRef<{
    source: string; pointerId: number; startY: number;
    target: HTMLElement; active: boolean; gap: number | null;
  } | null>(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState<{ source: string; gap: number | null } | null>(null);

  /** 释放指针捕获并清理排序提示。 */
  const cancel = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
    setPosition(null);
  }, []);

  useEffect(() => {
    /** Escape 取消当前排序。 */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        suppressClick.current = drag.current.active;
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  /** 生成单个根标题的事件，按钮与改名输入框不参与拖动。 */
  const headerProps = (source: string): HTMLAttributes<HTMLDivElement> => ({
    onDragStart: (event) => event.preventDefault(),
    onPointerDown: (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) return;
      suppressClick.current = false;
      drag.current = { source, pointerId: event.pointerId, startY: event.clientY,
        target: event.currentTarget, active: false, gap: null };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active && Math.abs(event.clientY - current.startY) < 4) return;
      current.active = true;
      event.preventDefault();
      const viewport = container.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      const bounds = viewport?.getBoundingClientRect();
      current.gap = null;
      if (
        viewport &&
        bounds &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom
      ) {
        if (event.clientY < bounds.top + 24) viewport.scrollTop -= 16;
        if (event.clientY > bounds.bottom - 24) viewport.scrollTop += 16;
        const headers = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            "[data-root-reorder-header]",
          ) ?? [],
        );
        const index = headers.findIndex((header) => {
          const rect = header.getBoundingClientRect();
          return event.clientY < rect.top + rect.height / 2;
        });
        current.gap = index < 0 ? headers.length : index;
      }
      setPosition({ source: current.source, gap: current.gap });
    },
    onPointerUp: (event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      suppressClick.current = current.active;
      cancel();
      if (current.active && current.gap !== null) {
        void onReorder(current.source, current.gap);
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

  return { position, headerProps };
}
