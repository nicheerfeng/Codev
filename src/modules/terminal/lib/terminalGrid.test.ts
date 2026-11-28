import { describe, expect, it } from "vitest";
import {
  fillTerminalViewport,
  placeTerminalInViewport,
  terminalGrid,
} from "./terminalGrid";

describe("terminal viewport slots", () => {
  it("keeps new viewports empty and only includes explicitly assigned terminals", () => {
    expect(terminalGrid([11, null, null], 1400)).toMatchObject({
      slots: [11, null, null],
      visibleIds: [11],
      columns: 3,
      rows: 1,
    });
    expect(terminalGrid([11, null, null], 900)).toMatchObject({
      slots: [11, null, null],
      visibleIds: [11],
      columns: 2,
      rows: 2,
    });
    expect(terminalGrid([11, null, null], 600)).toMatchObject({
      slots: [11, null, null],
      visibleIds: [11],
      columns: 1,
      rows: 3,
    });
  });

  it("fills the first empty slot and refuses implicit replacement when full", () => {
    expect(fillTerminalViewport([11, null, 33], 22)).toEqual([11, 22, 33]);
    expect(fillTerminalViewport([11, 22], 33)).toBeNull();
    expect(fillTerminalViewport([11, 22], 22)).toEqual([11, 22]);
  });

  it("replaces the explicit drop target and swaps an already visible terminal", () => {
    expect(placeTerminalInViewport([11, 22, null], 0, 33)).toEqual([
      33,
      22,
      null,
    ]);
    expect(placeTerminalInViewport([11, 22, null], 1, 11)).toEqual([
      22,
      11,
      null,
    ]);
  });

  it("limits layouts to six and computes the existing row arrangement", () => {
    expect(terminalGrid([1, 2, 3, 4, 5, 6, 7], 1400).slots).toHaveLength(6);
    expect(terminalGrid([1, 2, 3, 4], 900).columns).toBe(2);
    expect(terminalGrid([1, 2, 3, 4, 5, 6], 1400).columns).toBe(3);
  });
});
