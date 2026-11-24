import type { GraphRowLayout } from "@/modules/vcs/CommitGraph";
import { cn } from "@/lib/utils";

const LANE_WIDTH = 14;
const ROW_HEIGHT = 28;
const PAD_X = 9;

/** 绘制单行提交轨道图，供侧栏历史与主区大图共享复用。 */
export function CommitGraphRailCell({
  layout,
  maxLanes,
  height = ROW_HEIGHT,
}: {
  layout: GraphRowLayout;
  maxLanes: number;
  height?: number;
}) {
  const width = Math.max(20, maxLanes * LANE_WIDTH + 6);
  const cy = height / 2;
  const cx = PAD_X + layout.lane * LANE_WIDTH;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      {layout.passThroughLanes.map((p) => {
        const x = PAD_X + p.lane * LANE_WIDTH;
        return (
          <line
            key={`pass:${p.lane}`}
            x1={x}
            y1={0}
            x2={x}
            y2={height}
            stroke={p.color}
            strokeWidth={1.6}
            strokeOpacity={0.55}
          />
        );
      })}
      {layout.row > 0 && (
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={cy}
          stroke={layout.color}
          strokeWidth={1.75}
          strokeOpacity={0.8}
        />
      )}
      {layout.edges.map((edge, idx) => {
        const tx = PAD_X + edge.toLane * LANE_WIDTH;
        if (edge.toLane === edge.fromLane) {
          return (
            <line
              key={`down:${idx}`}
              x1={cx}
              y1={cy}
              x2={cx}
              y2={height}
              stroke={edge.color}
              strokeWidth={1.75}
              strokeOpacity={0.85}
            />
          );
        }
        return (
          <path
            key={`curve:${idx}`}
            d={`M ${cx} ${cy} C ${cx} ${height * 0.72}, ${tx} ${height * 0.45}, ${tx} ${height}`}
            fill="none"
            stroke={edge.color}
            strokeWidth={1.6}
            strokeOpacity={edge.isMerge ? 0.85 : 0.7}
            strokeDasharray={edge.isMerge ? "3 2" : undefined}
          />
        );
      })}
      <circle
        cx={cx}
        cy={cy}
        r={layout.commit.parents.length > 1 ? 4 : 3.2}
        fill={layout.commit.parents.length > 1 ? "var(--card)" : layout.color}
        stroke={layout.color}
        strokeWidth={1.75}
      />
    </svg>
  );
}

export function RefBadgeList({
  refs,
  compact = false,
}: {
  refs: GraphRowLayout["commit"]["refs"];
  compact?: boolean;
}) {
  if (!refs.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {refs.slice(0, compact ? 2 : 5).map((r) => (
        <span
          key={r.label}
          className={cn(
            "max-w-[130px] truncate rounded px-1 py-0.5 text-[9.5px] font-medium leading-none",
            r.kind === "head"
              ? "bg-primary/20 text-primary ring-1 ring-primary/40"
              : r.kind === "tag"
                ? "bg-amber-500/15 text-amber-300"
                : r.kind === "remote"
                  ? "bg-sky-500/15 text-sky-300"
                  : "bg-emerald-500/15 text-emerald-300",
          )}
          title={r.label}
        >
          {r.label}
        </span>
      ))}
    </div>
  );
}
