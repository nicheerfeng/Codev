import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  parseMarkdownHeadings,
  type MarkdownHeading,
} from "./markdownHeadings";

const DEFAULT_RIGHT = 24;
const DEFAULT_TOP = 40;
const EDGE = 8;

type Layout = { right: number; top: number };

const layoutCache = new Map<string, Layout>();

type Props = {
  path: string;
  source?: string;
  viewportRef: RefObject<HTMLElement | null>;
  onJump: (heading: MarkdownHeading, index: number) => void;
};

function clampLayout(
  layout: Layout,
  viewport: HTMLElement,
  box: { width: number; height: number },
): Layout {
  const maxRight = Math.max(EDGE, viewport.clientWidth - box.width - EDGE);
  const maxTop = Math.max(EDGE, viewport.clientHeight - box.height - EDGE);
  return {
    right: Math.min(maxRight, Math.max(EDGE, layout.right)),
    top: Math.min(maxTop, Math.max(EDGE, layout.top)),
  };
}

/** 紧凑可拖目录，锚定阅读区右上角，拉伸视口时始终夹在当前阅读器内。 */
export function MarkdownToc({ path, source, viewportRef, onJump }: Props) {
  const [loaded, setLoaded] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (source != null) return;
    let cancelled = false;
    void invoke<{ kind: string; content?: string }>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }).then((result) => {
      if (!cancelled && result.kind === "text" && result.content)
        setLoaded(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [path, source]);
  const headings = parseMarkdownHeadings(source ?? loaded);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<Layout>(
    () => layoutCache.get(path) ?? { right: DEFAULT_RIGHT, top: DEFAULT_TOP },
  );
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originRight: number;
    originTop: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setLayout(
      layoutCache.get(path) ?? { right: DEFAULT_RIGHT, top: DEFAULT_TOP },
    );
    setOpen(false);
  }, [path]);

  useEffect(() => {
    layoutCache.set(path, layout);
  }, [layout, path]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sync = () => {
      const box = boxRef.current;
      if (!box) return;
      setLayout((current) => {
        const next = clampLayout(current, viewport, {
          width: box.offsetWidth,
          height: box.offsetHeight,
        });
        return next.right === current.right && next.top === current.top
          ? current
          : next;
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [open, path, viewportRef]);

  if (headings.length === 0) return null;

  return (
    <div
      ref={boxRef}
      className="absolute z-20 max-w-48 min-w-0 overflow-hidden rounded-md border border-border/60 bg-card/90 text-[11px] shadow-sm backdrop-blur"
      style={{ top: layout.top, right: layout.right }}
    >
      <button
        type="button"
        className="flex w-full cursor-grab items-center gap-1 px-2 py-1.5 text-left text-muted-foreground hover:text-foreground active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const viewport = viewportRef.current;
          const box = boxRef.current;
          if (!viewport || !box) return;
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originRight: layout.right,
            originTop: layout.top,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const dx = event.clientX - current.startX;
          const dy = event.clientY - current.startY;
          if (!current.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          current.moved = true;
          const viewport = viewportRef.current;
          const box = boxRef.current;
          if (!viewport || !box) return;
          setLayout(
            clampLayout(
              {
                right: current.originRight - dx,
                top: current.originTop + dy,
              },
              viewport,
              { width: box.offsetWidth, height: box.offsetHeight },
            ),
          );
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          if (!current.moved) setOpen((value) => !value);
        }}
      >
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={11}
        />
        <span className="truncate">目录</span>
        <span className="ml-auto tabular-nums text-[10px] opacity-70">
          {headings.length}
        </span>
      </button>
      {open && (
        <div className="reader-scrollbar max-h-[40vh] overflow-auto border-t border-border/50 py-1">
          {headings.map((heading, index) => (
            <button
              key={`${heading.line}:${heading.text}`}
              type="button"
              className={cn(
                "block w-full truncate py-0.5 pr-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              style={{ paddingLeft: 8 + (heading.level - 1) * 8 }}
              title={heading.text}
              onClick={() => onJump(heading, index)}
            >
              {heading.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
