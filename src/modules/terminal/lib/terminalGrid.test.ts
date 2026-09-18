import { describe, expect, it } from "vitest";
import { terminalGrid } from "./terminalGrid";

describe("terminal grid", () => {
  it.each([1, 2, 3, 4, 5, 6])("lays out %i views within the grid", (count) => {
    const grid = terminalGrid([1, 2, 3, 4, 5, 6], 1, count);
    expect(grid.visibleIds).toHaveLength(count);
    expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(count);
  });
  it("replaces the last viewport for an existing hidden terminal without paging", () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    expect(terminalGrid(ids, 2, 6).visibleIds).toEqual(
      terminalGrid(ids, 5, 6).visibleIds,
    );
    expect(terminalGrid(ids, 7, 6)).toMatchObject({
      visibleIds: [1, 2, 3, 4, 5, 7],
    });
  });
  it("never displays more than six or creates missing sessions", () => {
    expect(terminalGrid([1, 2, 3, 4, 5, 6, 7], 1, 7).visibleIds).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(terminalGrid([1, 2], 1, 6).visibleIds).toEqual([1, 2]);
  });
  it("uses the new order and recovers when the active tab is removed", () => {
    expect(terminalGrid([3, 1, 2], 1, 2).visibleIds).toEqual([3, 1]);
    expect(terminalGrid([1, 2], 3, 2).visibleIds).toEqual([1, 2]);
    expect(terminalGrid([], -1, 6).visibleIds).toEqual([]);
  });
});
