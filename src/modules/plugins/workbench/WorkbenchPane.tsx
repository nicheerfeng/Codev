import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  GridViewIcon,
  PlusSignIcon,
  Maximize01Icon,
  Minimize01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ResizableViewportGrid } from "@/components/ResizableViewportGrid";
import { BrowserPane } from "../browser/BrowserPane";
import { sourceKey, useWorkbench, type WorkbenchSource } from "./store";

function SlotBody({
  source,
  shown,
}: {
  source: WorkbenchSource;
  shown: boolean;
}) {
  const key = sourceKey(source);
  const ref = useCallback(
    (node: HTMLDivElement | null) =>
      useWorkbench.getState().setTarget(key, shown ? node : null),
    [key, shown],
  );
  return (
    <div
      ref={ref}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
    />
  );
}

export function WorkbenchPane({ visible }: { visible: boolean }) {
  const { slots, append, remove, swap } = useWorkbench();
  const [width, setWidth] = useState(0);
  const [maximized, setMaximized] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{
    from: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const count = Math.max(1, slots.length);
  const columns =
    count > 4 || (count >= 3 && width >= 1200) ? 3 : Math.min(2, count);
  const zoom =
    maximized !== null && maximized < slots.length ? maximized : null;
  useEffect(() => {
    useWorkbench.setState({ visible });
    return () => useWorkbench.setState({ visible: false, moving: false });
  }, [visible]);
  const topology = slots
    .map((source) => (source ? sourceKey(source) : "empty"))
    .join("|");
  useEffect(() => setMaximized(null), [topology]);
  useEffect(() => {
    const finish = () => useWorkbench.setState({ moving: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, []);
  const addBrowser = () => {
    useWorkbench
      .getState()
      .add({ kind: "browser", id: crypto.randomUUID(), title: "网页" });
    setMaximized(null);
  };
  const startDrag = (event: PointerEvent<HTMLButtonElement>, from: number) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { from, x: event.clientX, y: event.clientY, active: false };
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    if (
      Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6 &&
      !current.active
    )
      return;
    current.active = true;
    useWorkbench.setState({ moving: true });
    const node = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-workbench-slot]");
    setHover(node ? Number(node.dataset.workbenchSlot) : null);
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current?.active) {
      const node = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-workbench-slot]");
      if (node) swap(current.from, Number(node.dataset.workbenchSlot));
    }
    drag.current = null;
    setHover(null);
    useWorkbench.setState({ moving: false });
  };
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest("[data-viewport-resize]"))
          useWorkbench.setState({ moving: true });
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <HugeiconsIcon icon={GridViewIcon} size={15} />
        <span className="flex-1 text-xs">工作台</span>
        <Button variant="ghost" size="xs" onClick={addBrowser}>
          <HugeiconsIcon icon={PlusSignIcon} size={13} />
          网页
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="增加空视口"
          aria-label="增加空视口"
          onClick={append}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} />
        </Button>
        <span className="text-xs text-muted-foreground">{slots.length}/6</span>
      </header>
      <div data-workbench-body="" className="min-h-0 flex-1 overflow-hidden">
        <ResizableViewportGrid
          columns={columns}
          rows={Math.ceil(count / columns)}
          onWidthChange={setWidth}
          positions={Array.from({ length: count }, (_, index) =>
            zoom !== null && index !== zoom
              ? null
              : {
                  column: zoom !== null ? 0 : index % columns,
                  row: zoom !== null ? 0 : Math.floor(index / columns),
                },
          )}
        >
          {(slots.length ? slots : [null]).map((source, index) => (
            <section
              key={source ? sourceKey(source) : `empty-${index}`}
              data-workbench-slot={index}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden border ${hover === index ? "border-primary ring-1 ring-primary" : "border-border"}`}
            >
              <header className="flex h-7 shrink-0 items-center gap-1 bg-muted/30 px-2">
                <button
                  type="button"
                  title="拖动交换视口"
                  className="min-w-0 flex-1 cursor-grab touch-none truncate text-left text-xs"
                  onPointerDown={(event) => startDrag(event, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={finishDrag}
                  onPointerCancel={() => {
                    drag.current = null;
                    setHover(null);
                    useWorkbench.setState({ moving: false });
                  }}
                >
                  {source
                    ? source.kind === "browser"
                      ? source.title
                      : `${source.kind === "terminal" ? "终端" : source.kind === "pi" ? "Pi" : "Codex"} · ${source.title}`
                    : `视口 ${index + 1}`}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={zoom === index ? "还原视口" : "放大视口"}
                  aria-label={zoom === index ? "还原视口" : "放大视口"}
                  onClick={() => setMaximized(zoom === index ? null : index)}
                >
                  <HugeiconsIcon
                    icon={zoom === index ? Minimize01Icon : Maximize01Icon}
                    size={12}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="移除视口，保留会话"
                  aria-label="移除视口"
                  onClick={() => {
                    setMaximized(null);
                    remove(index);
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} />
                </Button>
              </header>
              {source?.kind === "browser" ? (
                <div className="min-h-0 flex-1">
                  <BrowserPane
                    webviewId={source.id}
                    visible={visible && (zoom === null || zoom === index)}
                  />
                </div>
              ) : source ? (
                <SlotBody
                  source={source}
                  shown={visible && (zoom === null || zoom === index)}
                />
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <Button variant="ghost" size="xs" onClick={addBrowser}>
                    <HugeiconsIcon icon={PlusSignIcon} size={13} />
                    网页
                  </Button>
                </div>
              )}
            </section>
          ))}
        </ResizableViewportGrid>
      </div>
    </div>
  );
}
