import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  dockDragGapIndex,
  reorderDockTabsAtGap,
  type DockTab,
} from "../lib/dockTabs";

type DockDrag = {
  pointerId: number;
  startX: number;
  source: DockTab;
  active: boolean;
  target: HTMLElement;
};

/** 用指针捕获重排 Dock 标签，避开 Tauri 窗口对 HTML5 拖放的拦截。 */
export function useDockTabReorder(
  visibleTabs: DockTab[],
  setOrder: (updater: (tabs: DockTab[]) => DockTab[]) => void,
) {
  const headerRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DockDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingTab, setDraggingTab] = useState<DockTab | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.target.hasPointerCapture(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId);
    }
    setDraggingTab(null);
    setDropIndex(null);
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      suppressClickRef.current = dragRef.current.active;
      endDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [endDrag]);

  /** 绑定单个 Dock 标签的指针排序，点击切换仍走原 onClick。 */
  const tabProps = (tab: DockTab) => ({
    "data-dock-tab": tab,
    onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => {
      event.preventDefault();
    },
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      suppressClickRef.current = false;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        source: tab,
        active: false,
        target: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.active) {
        if (Math.abs(event.clientX - drag.startX) < 4) return;
        drag.active = true;
        setDraggingTab(drag.source);
        document.body.style.userSelect = "none";
      }
      event.preventDefault();
      const header = headerRef.current;
      if (header) setDropIndex(dockDragGapIndex(header, event.clientX));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active) {
        const header = headerRef.current;
        const source = drag.source;
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (header) {
          const gap = dockDragGapIndex(header, event.clientX);
          setOrder((tabs) =>
            reorderDockTabsAtGap(tabs, visibleTabs, source, gap),
          );
        }
      }
      endDrag();
    },
    onPointerCancel: () => endDrag(),
    onClickCapture: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  });

  return { headerRef, draggingTab, dropIndex, tabProps };
}
