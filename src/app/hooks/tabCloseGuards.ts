import type { CloseTabsPlan } from "@/modules/tabs";

export type CloseManyKind = "right" | "other";

export type CloseManyHazards = {
  busyLeafIds: number[];
};

export type CloseManyPending = CloseManyHazards & {
  kind: CloseManyKind;
  anchorId: number;
  plan: CloseTabsPlan;
};

export function hasCloseManyHazards(hazards: CloseManyHazards): boolean {
  return hazards.busyLeafIds.length > 0;
}

export function hasNewCloseManyHazards(
  acknowledged: CloseManyHazards,
  current: CloseManyHazards,
): boolean {
  const busy = new Set(acknowledged.busyLeafIds);
  return current.busyLeafIds.some((id) => !busy.has(id));
}

export type CloseHazardSnapshot = {
  leafIds: number[];
};

const MAX_HAZARD_PASSES = 3;

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Busy detection costs one IPC per leaf, so opting out skips it outright rather
 * than running it and discarding the answer. File buffers are saved by the
 * close workflow separately from this terminal-process check.
 *
 * Leaves can appear or vanish while the checks are in flight, so re-snapshot
 * until the set is stable, then fall back to assuming every leaf is busy.
 */
export async function evaluateCloseHazards(
  capture: () => CloseHazardSnapshot,
  isBusy: (leafId: number) => Promise<boolean>,
  confirmRunningTerminal: boolean,
): Promise<CloseManyHazards> {
  if (!confirmRunningTerminal) {
    return { busyLeafIds: [] };
  }
  let checkedLeafIds = capture().leafIds;
  for (let pass = 0; pass < MAX_HAZARD_PASSES; pass += 1) {
    const checks = await Promise.all(checkedLeafIds.map(isBusy));
    const latest = capture();
    if (sameIds(checkedLeafIds, latest.leafIds)) {
      return {
        busyLeafIds: checkedLeafIds.filter((_, index) => checks[index]),
      };
    }
    checkedLeafIds = latest.leafIds;
  }
  const latest = capture();
  return { busyLeafIds: latest.leafIds };
}
