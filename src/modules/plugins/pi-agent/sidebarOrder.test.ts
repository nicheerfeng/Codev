import { describe, expect, it } from "vitest";
import { applySavedOrder, mergeOrder, moveByGap } from "./sidebarOrder";

describe("pi sidebar order", () => {
  const projects = ["D:/Work/A", "D:/Work/B", "D:/Work/C"];

  it("puts known items first and appends unseen items", () => {
    expect(applySavedOrder(projects, ["d:/work/c", "D:/Work/A"])).toEqual([
      "D:/Work/C",
      "D:/Work/A",
      "D:/Work/B",
    ]);
  });

  it("moves an item by gap without losing siblings", () => {
    expect(moveByGap(projects, "D:/Work/A", 3)).toEqual([
      "D:/Work/B",
      "D:/Work/C",
      "D:/Work/A",
    ]);
    expect(moveByGap(projects, "D:/Work/C", 0)).toEqual([
      "D:/Work/C",
      "D:/Work/A",
      "D:/Work/B",
    ]);
    expect(moveByGap(projects, "D:/Work/B", 1)).toBe(projects);
  });

  it("keeps saved items from other groups after a visible reorder", () => {
    expect(
      mergeOrder(
        ["D:/Hidden", "D:/Work/A", "D:/Work/B"],
        ["D:/Work/B", "D:/Work/A"],
      ),
    ).toEqual(["D:/Work/B", "D:/Work/A", "D:/Hidden"]);
  });
});
