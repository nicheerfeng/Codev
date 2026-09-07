import { describe, expect, it } from "vitest";
import { reorderRoots } from "./reorderRoots";

describe("workspace root order", () => {
  const roots = ["D:/parent", "D:/parent/child", "C:/other"];
  it("moves the first root last without losing nested roots", () => {
    expect(reorderRoots(roots, roots[0], 3)).toEqual([roots[1], roots[2], roots[0]]);
    expect(roots).toEqual(["D:/parent", "D:/parent/child", "C:/other"]);
  });
  it("moves the last root first or into a middle gap", () => {
    expect(reorderRoots(roots, roots[2], 0)).toEqual([roots[2], roots[0], roots[1]]);
    expect(reorderRoots(roots, roots[2], 1)).toEqual([roots[0], roots[2], roots[1]]);
  });
  it("keeps adjacent gaps and missing sources unchanged", () => {
    expect(reorderRoots(roots, roots[1], 1)).toBe(roots);
    expect(reorderRoots(roots, roots[1], 2)).toBe(roots);
    expect(reorderRoots(roots, "missing", 0)).toBe(roots);
  });
});
