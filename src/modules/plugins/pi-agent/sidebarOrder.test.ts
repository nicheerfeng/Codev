import { describe, expect, it } from "vitest";
import {
  adoptOrderIds,
  applySavedOrder,
  mergeOrder,
  moveByGap,
  pinSessionOrder,
  prependOrderId,
} from "./sidebarOrder";

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

  it("pins unseen sessions at the front without reshuffling known ones", () => {
    expect(pinSessionOrder(["s1", "s2"], ["s2", "s3", "s1"])).toEqual([
      "s3",
      "s1",
      "s2",
    ]);
    expect(pinSessionOrder(["s3", "s1", "s2"], ["s2", "s3", "s1"])).toEqual([
      "s3",
      "s1",
      "s2",
    ]);
  });

  it("adopts draft ids onto session files and prepends new threads", () => {
    expect(adoptOrderIds(["draft:a", "s2"], [["draft:a", "s1"]])).toEqual([
      "s1",
      "s2",
    ]);
    expect(prependOrderId(["s1", "s2"], "s3")).toEqual(["s3", "s1", "s2"]);
  });

  it("shows a published fork in the first page before its order is saved", () => {
    const saved = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const visible = [...saved, "fork"];
    const effective = pinSessionOrder(saved, visible);
    expect(applySavedOrder(visible, effective).slice(0, 5)).toEqual([
      "fork",
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("preserves a dragged draft position when its file appears", () => {
    const saved = ["s2", "draft:a", "hidden", "s1"];
    const adopted = adoptOrderIds(saved, [["draft:a", "file:a"]]);
    expect(pinSessionOrder(adopted, ["file:a", "s1", "s2"])).toEqual([
      "s2",
      "file:a",
      "hidden",
      "s1",
    ]);
  });

  it("retains newer creations when a delayed fork completes", () => {
    const afterCreate = prependOrderId(["s2", "s1"], "new");
    const afterFork = prependOrderId(afterCreate, "fork");
    expect(pinSessionOrder(afterFork, ["s1", "s2", "fork"])).toEqual([
      "fork",
      "new",
      "s2",
      "s1",
    ]);
  });
});
