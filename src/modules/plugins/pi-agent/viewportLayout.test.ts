import { describe, expect, it } from "vitest";
import { placePiSession, MAX_PI_VIEWPORTS } from "./viewportLayout";

describe("Pi viewport assignment", () => {
  it("places into the chosen empty slot without changing other sessions", () => {
    expect(placePiSession(["a", null, "c"], 1, "b")).toEqual(["a", "b", "c"]);
  });
  it("swaps existing sessions instead of displaying duplicates", () => {
    expect(placePiSession(["a", "b", "c"], 2, "a")).toEqual(["c", "b", "a"]);
  });
  it("replaces only the target viewport and preserves the original array", () => {
    const slots = ["a", "b"];
    expect(placePiSession(slots, 0, "c")).toEqual(["c", "b"]);
    expect(slots).toEqual(["a", "b"]);
    expect(placePiSession(slots, 0, null)).toEqual([null, "b"]);
    expect(MAX_PI_VIEWPORTS).toBe(6);
  });
});
