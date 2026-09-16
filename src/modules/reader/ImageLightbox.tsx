import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "./imageLightboxStore";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SCALE_STEP = 0.12;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function useImageLightboxState() {
  return useSyncExternalStore(
    subscribeImageLightbox,
    getImageLightbox,
    getImageLightbox,
  );
}

/** 全屏图片阅读：contain 铺满，滚轮缩放，放大后指针捕获拖动。 */
export function ImageLightbox() {
  const item = useImageLightboxState();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, [item?.src]);

  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImageLightbox();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item]);

  const zoomBy = useCallback((delta: number) => {
    setScale((current) => {
      const next = clampScale(current + delta);
      if (next <= 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = overlayRef.current;
    if (!node || !item) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [item, zoomBy]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0 || scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx !== 0 || dy !== 0) drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setOffset((current) => ({ x: current.x + dx, y: current.y + dy }));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  if (!item) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={item.alt || "图片预览"}
      onClick={closeImageLightbox}
    >
      <button
        type="button"
        className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
        aria-label="关闭图片预览"
        onClick={(event) => {
          event.stopPropagation();
          closeImageLightbox();
        }}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={16} />
      </button>
      <img
        src={item.src}
        alt={item.alt}
        draggable={false}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="max-h-[96vh] max-w-[96vw] select-none object-contain"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? "grab" : "zoom-in",
        }}
      />
    </div>
  );
}
