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
  const initialWeights = () =>
    rowIndexes.map((indexes) => Array.from({ length: indexes.length }, () => 1));
  const [weights, setWeights] = useState(initialWeights);
  const weightsRef = useRef(weights);
  useLayoutEffect(() => {
    const next = initialWeights();
    weightsRef.current = next;
    setWeights(next);
  }, [topology]);
  const minWidth = Math.max(1, ...rowIndexes.map((indexes) => indexes.length)) * MIN_VIEWPORT_WIDTH;

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

  return (
    <div className={`h-full min-h-0 min-w-0 overflow-auto ${className}`}>
      <div
        ref={gridRef}
        data-resizable-viewport-grid=""
        className="relative h-full min-h-0"
        style={{ minWidth: columns > 1 ? `${minWidth}px` : undefined }}
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
          const total = rowWeights.reduce((sum, part) => sum + part, 0) || indexes.length;
          const start = rowWeights
            .slice(0, ordinal)
            .reduce((sum, part) => sum + part, 0);
          const width = rowWeights[ordinal] ?? 1;
          return cloneElement(child, {
            style: {
              ...child.props.style,
              position: "absolute",
              left: `${(start / total) * 100}%`,
              top: `${(position.row / rows) * 100}%`,
              width: `${(width / total) * 100}%`,
              height: `${100 / rows}%`,
            },
            "aria-hidden": false,
          });
        })}
        {rowIndexes.flatMap((indexes, row) => {
          const rowWeights = weights[row] ?? [];
          const total = rowWeights.reduce((sum, part) => sum + part, 0) || indexes.length;
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
                  top: `${(row / rows) * 100}%`,
                  height: `${100 / rows}%`,
                }}
                onPointerDown={(event) => startResize(row, boundary, event)}
              >
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary" />
              </button>
            );
          });
        })}
      </div>
    </div>
  );
}
