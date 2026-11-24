import type { VcsCommit } from "./types";

const LANE_PALETTE = [
  "#38bdf8", // sky
  "#34d399", // emerald
  "#f59e0b", // amber
  "#c084fc", // purple
  "#fb7185", // rose
  "#22d3ee", // cyan
  "#a3e635", // lime
  "#f472b6", // pink
];

export type GraphEdge = {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  color: string;
  isMerge: boolean;
};

export type GraphRowLayout = {
  commit: VcsCommit;
  row: number;
  lane: number;
  color: string;
  maxLanes: number;
  passThroughLanes: Array<{ lane: number; color: string }>;
  edges: GraphEdge[];
};

/** Compute clean SVG commit graph lane assignments for topological commit lists. */
export function buildCommitGraphLayout(commits: VcsCommit[]): {
  rows: GraphRowLayout[];
  maxLanes: number;
} {
  if (commits.length === 0) return { rows: [], maxLanes: 1 };
  const rowByHash = new Map<string, number>();
  commits.forEach((c, idx) => rowByHash.set(c.hash, idx));

  const activeLanes: Array<string | null> = [];
  const laneColorMap = new Map<number, string>();
  const rows: GraphRowLayout[] = [];
  let maxObservedLanes = 1;

  const colorForLane = (lane: number) => {
    const existing = laneColorMap.get(lane);
    if (existing) return existing;
    const c = LANE_PALETTE[lane % LANE_PALETTE.length];
    laneColorMap.set(lane, c);
    return c;
  };

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row];
    let lane = activeLanes.indexOf(commit.hash);
    if (lane < 0) {
      const free = activeLanes.indexOf(null);
      if (free >= 0) {
        lane = free;
        activeLanes[lane] = commit.hash;
      } else {
        lane = activeLanes.length;
        activeLanes.push(commit.hash);
      }
    }
    const color = colorForLane(lane);

    // Clear duplicate branches pointing to this same hash
    for (let i = 0; i < activeLanes.length; i += 1) {
      if (i !== lane && activeLanes[i] === commit.hash) {
        activeLanes[i] = null;
      }
    }

    const passThroughLanes: Array<{ lane: number; color: string }> = [];
    for (let i = 0; i < activeLanes.length; i += 1) {
      if (i !== lane && activeLanes[i] !== null) {
        passThroughLanes.push({ lane: i, color: colorForLane(i) });
      }
    }

    // Replace current commit slot with first parent (or free if root commit)
    const primaryParent = commit.parents[0];
    if (primaryParent && rowByHash.has(primaryParent)) {
      activeLanes[lane] = primaryParent;
    } else {
      activeLanes[lane] = null;
    }

    const edges: GraphEdge[] = [];
    commit.parents.forEach((parentHash, pIdx) => {
      const toRow = rowByHash.get(parentHash);
      if (toRow === undefined) return;
      let toLane = activeLanes.indexOf(parentHash);
      if (toLane < 0) {
        if (pIdx === 0) {
          toLane = lane;
          activeLanes[toLane] = parentHash;
        } else {
          const free = activeLanes.indexOf(null);
          if (free >= 0) {
            toLane = free;
            activeLanes[toLane] = parentHash;
          } else {
            toLane = activeLanes.length;
            activeLanes.push(parentHash);
          }
        }
      }
      edges.push({
        fromRow: row,
        fromLane: lane,
        toRow,
        toLane,
        color: pIdx === 0 ? color : colorForLane(toLane),
        isMerge: pIdx > 0,
      });
    });

    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
    maxObservedLanes = Math.max(maxObservedLanes, lane + 1, activeLanes.length);

    rows.push({
      commit,
      row,
      lane,
      color,
      maxLanes: maxObservedLanes,
      passThroughLanes,
      edges,
    });
  }

  return { rows, maxLanes: maxObservedLanes };
}
