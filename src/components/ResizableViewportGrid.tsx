import {
  Children,
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const MIN_VIEWPORT_WIDTH = 300;
const MIN_VIEWPORT_HEIGHT = 220;

type Props = {
  children: ReactNode[];
  columns: number;
  rows: number;
  positions: ({ column: number; row: number } | null)[];
  className?: string;
};

/** 按行独立调整视口列宽，并在退出多视口后恢复均分。 */
export function ResizableViewportGrid({
  children,
  columns,
  rows,
  positions,
  className = "",
}: Props) {
  const items = Children.toArray(children);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowIndexes = useMemo(
    () =>
      Array.from({ length: rows }, (_, row) =>
        positions
          .map((position, index) => ({ position, index }))
          .filter((item) => item.position?.row === row)
          .sort((left, right) => left.position!.column - right.position!.column)
          .map((item) => item.index),
      ),
    [positions, rows],
  );
  const topology = rowIndexes.map((indexes) => indexes.length).join(":");
  const initialWeights = useMemo(
    () =>
      rowIndexes.map((indexes) =>
        Array.from({ length: indexes.length }, () => 1),
      ),
    [topology],
  );
  const [weights, setWeights] = useState(initialWeights);
  const weightsRef = useRef(weights);
  const [rowHeights, setRowHeights] = useState(() =>
    Array.from({ length: rows }, () => 1),
  );
  const rowHeightsRef = useRef(rowHeights);
  useLayoutEffect(() => {
    const next = initialWeights.map((row) => [...row]);
    const nextHeights = Array.from({ length: rows }, () => 1);
    weightsRef.current = next;
    rowHeightsRef.current = nextHeights;
    setWeights(next);
    setRowHeights(nextHeights);
  }, [initialWeights, rows]);
  const minWidth =
    Math.max(1, ...rowIndexes.map((indexes) => indexes.length)) *
    MIN_VIEWPORT_WIDTH;
  const minHeight = rows * MIN_VIEWPORT_HEIGHT;
  const totalHeight = rowHeights.reduce((sum, part) => sum + part, 0) || rows;
  const rowTops = rowHeights.map((_, row) =>
    rowHeights.slice(0, row).reduce((sum, part) => sum + part, 0),
  );

  /** 按指定行的局部位置调整相邻两列，保持该行其他列宽不变。 */
  const resizeBoundary = (row: number, boundary: number, clientX: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const bounds = grid.getBoundingClientRect();
    if (!bounds.width) return;
    const current = weightsRef.current[row];
    if (!current || current.length < boundary + 2) return;
    const total = current.reduce((sum, part) => sum + part, 0);
    const preceding = current
      .slice(0, boundary)
      .reduce((sum, part) => sum + part, 0);
    const pair = current[boundary] + current[boundary + 1];
    const minimum = (MIN_VIEWPORT_WIDTH / bounds.width) * total;
    const target = ((clientX - bounds.left) / bounds.width) * total - preceding;
    const left = Math.min(pair - minimum, Math.max(minimum, target));
    const nextRow = [...current];
    nextRow[boundary] = left;
    nextRow[boundary + 1] = pair - left;
    const next = [...weightsRef.current];
    next[row] = nextRow;
    weightsRef.current = next;
    setWeights(next);
  };

  /** 拖动当前行分隔线，仅在多视口组件存活期间保留列宽。 */
  const startResize = (
    row: number,
    boundary: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const handle = event.currentTarget;
    const move = (nextEvent: PointerEvent) =>
      resizeBoundary(row, boundary, nextEvent.clientX);
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish, { once: true });
    handle.addEventListener("pointercancel", finish, { once: true });
    handle.addEventListener("lostpointercapture", finish, { once: true });
  };

  /** 按上下相邻行调整高度，并保留两行各自的最小可操作空间。 */
  const resizeRowBoundary = (boundary: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    const bounds = grid.getBoundingClientRect();
    if (!bounds.height) return;
    const current = rowHeightsRef.current;
    if (current.length < boundary + 2) return;
    const total = current.reduce((sum, part) => sum + part, 0);
    const preceding = current
      .slice(0, boundary)
      .reduce((sum, part) => sum + part, 0);
    const pair = current[boundary] + current[boundary + 1];
    const minimum = (MIN_VIEWPORT_HEIGHT / bounds.height) * total;
    const target = ((clientY - bounds.top) / bounds.height) * total - preceding;
    const upper = Math.min(pair - minimum, Math.max(minimum, target));
    const next = [...current];
    next[boundary] = upper;
    next[boundary + 1] = pair - upper;
    rowHeightsRef.current = next;
    setRowHeights(next);
  };

  /** 拖动整行高度分隔线；变化只影响分隔线两侧的相邻行。 */
  const startRowResize = (
    boundary: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const handle = event.currentTarget;
    const move = (nextEvent: PointerEvent) =>
      resizeRowBoundary(boundary, nextEvent.clientY);
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish, { once: true });
    handle.addEventListener("pointercancel", finish, { once: true });
    handle.addEventListener("lostpointercapture", finish, { once: true });
  };

  return (
    <div className={`h-full min-h-0 min-w-0 overflow-auto ${className}`}>
      <div
        ref={gridRef}
        data-resizable-viewport-grid=""
        className="relative h-full min-h-0"
        style={{
          minWidth: columns > 1 ? `${minWidth}px` : undefined,
          minHeight: rows > 1 ? `${minHeight}px` : undefined,
        }}
      >
        {items.map((child, index) => {
          const position = positions[index];
          if (
            !isValidElement<{
              style?: CSSProperties;
              className?: string;
              "aria-hidden"?: boolean;
            }>(child)
          )
            return child;
          if (!position)
            return cloneElement(child, {
              style: {
                ...child.props.style,
                position: "absolute",
                inset: 0,
                visibility: "hidden",
                pointerEvents: "none",
              },
              "aria-hidden": true,
            });
          const indexes = rowIndexes[position.row] ?? [];
          const ordinal = indexes.indexOf(index);
          const rowWeights = weights[position.row] ?? [];
          const total =
            rowWeights.reduce((sum, part) => sum + part, 0) || indexes.length;
          const start = rowWeights
            .slice(0, ordinal)
            .reduce((sum, part) => sum + part, 0);
          const width = rowWeights[ordinal] ?? 1;
          const top = rowTops[position.row] ?? 0;
          const height = rowHeights[position.row] ?? 1;
          return cloneElement(child, {
            style: {
              ...child.props.style,
              position: "absolute",
              left: `${(start / total) * 100}%`,
              top: `${(top / totalHeight) * 100}%`,
              width: `${(width / total) * 100}%`,
              height: `${(height / totalHeight) * 100}%`,
            },
            "aria-hidden": false,
          });
        })}
        {rowIndexes.flatMap((indexes, row) => {
          const rowWeights = weights[row] ?? [];
          const total =
            rowWeights.reduce((sum, part) => sum + part, 0) || indexes.length;
          return rowWeights.slice(0, -1).map((_, boundary) => {
            const before = rowWeights
              .slice(0, boundary + 1)
              .reduce((sum, part) => sum + part, 0);
            return (
              <button
                key={`row-${row}-divider-${boundary}`}
                type="button"
                aria-label={`调整第 ${row + 1} 行第 ${boundary + 1} 与第 ${boundary + 2} 个视口宽度`}
                title="拖动调整本行视口宽度"
                className="group absolute z-20 w-2 -translate-x-1/2 cursor-col-resize touch-none bg-transparent outline-none"
                style={{
                  left: `${(before / total) * 100}%`,
                  top: `${((rowTops[row] ?? 0) / totalHeight) * 100}%`,
                  height: `${((rowHeights[row] ?? 1) / totalHeight) * 100}%`,
                }}
                onPointerDown={(event) => startResize(row, boundary, event)}
              >
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
              </button>
            );
          });
        })}
        {rowHeights.slice(0, -1).map((_, boundary) => {
          const before = (rowTops[boundary] ?? 0) + rowHeights[boundary];
          return (
            <button
              key={`horizontal-divider-${boundary}`}
              type="button"
              aria-label={`调整第 ${boundary + 1} 行和第 ${boundary + 2} 行的高度`}
              title="拖动调整上下行高度"
              className="group absolute inset-x-0 z-30 h-2 -translate-y-1/2 cursor-row-resize touch-none bg-transparent outline-none"
              style={{ top: `${(before / totalHeight) * 100}%` }}
              onPointerDown={(event) => startRowResize(boundary, event)}
            >
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/70 transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
