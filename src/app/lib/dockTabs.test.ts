import { describe, expect, it } from "vitest";
import { reorderDockTabsAtGap, type DockTab } from "./dockTabs";

const all: DockTab[] = ["terminal", "json", "diff", "pi"];

describe("reorderDockTabsAtGap", () => {
  it("moves the first visible tab after the last visible tab", () => {
    expect(
      reorderDockTabsAtGap(all, ["terminal", "pi"], "terminal", 2),
    ).toEqual(["json", "diff", "pi", "terminal"]);
  });

  it("moves the last visible tab before the first visible tab", () => {
    expect(reorderDockTabsAtGap(all, ["terminal", "pi"], "pi", 0)).toEqual([
      "pi",
      "terminal",
      "json",
      "diff",
    ]);
  });

  it("keeps hidden plugin tabs in the stored order", () => {
    expect(
      reorderDockTabsAtGap(all, ["terminal", "json", "pi"], "pi", 1),
    ).toEqual(["terminal", "pi", "json", "diff"]);
  });

  it("ignores a source that is not currently visible", () => {
    expect(reorderDockTabsAtGap(all, ["terminal", "pi"], "json", 1)).toEqual(
      all,
    );
  });
});
