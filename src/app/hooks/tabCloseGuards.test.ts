import { describe, expect, it, vi } from "vitest";
import {
  type CloseHazardSnapshot,
  type CloseManyHazards,
  evaluateCloseHazards,
  hasCloseManyHazards,
  hasNewCloseManyHazards,
} from "./tabCloseGuards";

function hazards(busyLeafIds: number[] = []): CloseManyHazards {
  return { busyLeafIds };
}

function snapshots(
  ...frames: CloseHazardSnapshot[]
): () => CloseHazardSnapshot {
  let index = 0;
  return () => frames[Math.min(index++, frames.length - 1)];
}

describe("close-many hazards", () => {
  it("requires a guard only for busy terminal leaves", () => {
    expect(hasCloseManyHazards(hazards())).toBe(false);
    expect(hasCloseManyHazards(hazards([20]))).toBe(true);
  });

  it("accepts confirmation when the acknowledged hazards are unchanged", () => {
    const acknowledged = hazards([20]);
    expect(hasNewCloseManyHazards(acknowledged, hazards([20]))).toBe(false);
  });

  it("accepts confirmation when acknowledged hazards have cleared", () => {
    const acknowledged = hazards([20, 30]);
    expect(hasNewCloseManyHazards(acknowledged, hazards([30]))).toBe(false);
  });

  it("requires another confirmation for a newly busy terminal leaf", () => {
    expect(hasNewCloseManyHazards(hazards([20]), hazards([20, 30]))).toBe(true);
  });
});

describe("evaluateCloseHazards", () => {
  const snapshot = { leafIds: [20, 30] };

  it("reports only the leaves that are actually busy", async () => {
    const isBusy = vi.fn(async (id: number) => id === 30);
    await expect(
      evaluateCloseHazards(() => snapshot, isBusy, true),
    ).resolves.toEqual(hazards([30]));
  });

  it("skips foreground-process IPC when the user opted out", async () => {
    const isBusy = vi.fn(async () => true);
    await expect(
      evaluateCloseHazards(() => snapshot, isBusy, false),
    ).resolves.toEqual(hazards([]));
    expect(isBusy).not.toHaveBeenCalled();
  });

  it("does not inspect file dirtiness when checking close hazards", async () => {
    await expect(
      evaluateCloseHazards(
        () => ({ leafIds: [20] }),
        async () => true,
        false,
      ),
    ).resolves.toEqual(hazards([]));
  });

  it("re-checks when the leaf set changes mid-flight", async () => {
    const capture = snapshots(
      { leafIds: [20] },
      { leafIds: [20, 30] },
      { leafIds: [20, 30] },
    );
    await expect(evaluateCloseHazards(capture, async (id) => id === 30, true))
      .resolves.toEqual(hazards([30]));
  });

  it("assumes every leaf is busy when the set never settles", async () => {
    let last = 0;
    const capture = () => {
      last += 10;
      return { leafIds: [last] };
    };
    const result = await evaluateCloseHazards(capture, async () => false, true);
    expect(result).toEqual(hazards([last]));
  });
});
