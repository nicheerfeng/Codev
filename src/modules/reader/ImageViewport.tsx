import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import { ImageContextMenu } from "./ImageContextMenu";
import {
  nextImageScale,
  zoomImageAroundPoint,
  type ImageView,
} from "./imageViewMath";

type Props = {
  src: string;
  alt: string;
  className?: string;
  onBackgroundClick?: () => void;
};

type DragState = {
  id: number;
  x: number;
  y: number;
};

const FITTED: ImageView = { scale: 1, pan: { x: 0, y: 0 } };

/** 适合窗口的图片视口：滚轮定点缩放，指针捕获拖动，双击复位。 */
export function ImageViewport({ src, alt, className, onBackgroundClick }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const backgroundRef = useRef(false);
  const [view, setView] = useState<ImageView>(FITTED);
  const dragRef = useRef<DragState | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    setView(FITTED);
    dragRef.current = null;
    movedRef.current = false;
  }, [src]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      setView((current) => {
        const nextScale = nextImageScale(current.scale, event.deltaY);
        return zoomImageAroundPoint(
          current.scale,
          current.pan,
          nextScale,
          point,
        );
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const reset = useCallback(() => setView(FITTED), []);

  /** 灯箱仅允许从图片内开始拖动，空白单击留给关闭操作。 */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = imageRef.current?.getBoundingClientRect();
    backgroundRef.current = !!onBackgroundClick && !!rect &&
      (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom);
    if (backgroundRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    movedRef.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx !== 0 || dy !== 0) movedRef.current = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setView((current) => ({
      scale: current.scale,
      pan: { x: current.pan.x + dx, y: current.pan.y + dy },
    }));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  const onDoubleClick = () => {
    if (movedRef.current) return;
    reset();
  };

  const grabbing = view.scale !== 1 || view.pan.x !== 0 || view.pan.y !== 0;

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative h-full w-full overflow-hidden",
        grabbing ? "cursor-grab" : "cursor-zoom-in",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onClick={(event) => {
        if (backgroundRef.current && event.target === event.currentTarget)
          onBackgroundClick?.();
        backgroundRef.current = false;
      }}
    >
      <ImageContextMenu src={src}>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        className="absolute top-1/2 left-1/2 max-h-full max-w-full select-none object-contain"
        style={{
          transform: `translate(-50%, -50%) translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.scale})`,
        }}
      />
      </ImageContextMenu>
    </div>
  );
}
