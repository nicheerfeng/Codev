import { describe, expect, it } from "vitest";
import {
  normalizeDockOrder,
  reorderDockTabsAtGap,
  type DockTab,
} from "./dockTabs";

const all: DockTab[] = ["terminal", "json", "diff", "agent", "git-inbox"];

it("restores order including hidden tabs and migrates legacy agent tabs", () => {
  expect(
    normalizeDockOrder(["pi", "pi", "removed", "terminal", "codex", "browser"]),
  ).toEqual(["agent", "terminal", "json", "diff", "git-inbox"]);
  expect(normalizeDockOrder(null)).toEqual(all);
});

describe("reorderDockTabsAtGap", () => {
  it("moves the first visible tab after the last visible tab", () => {
    expect(
      reorderDockTabsAtGap(all, ["terminal", "agent"], "terminal", 2),
    ).toEqual(["json", "diff", "agent", "terminal", "git-inbox"]);
  });
  it("moves the last visible tab before the first visible tab", () => {
    expect(
      reorderDockTabsAtGap(all, ["terminal", "agent"], "agent", 0),
    ).toEqual(["agent", "terminal", "json", "diff", "git-inbox"]);
  });
  it("keeps hidden plugin tabs in the stored order", () => {
    expect(
      reorderDockTabsAtGap(all, ["terminal", "json", "agent"], "agent", 1),
    ).toEqual(["terminal", "agent", "json", "diff", "git-inbox"]);
  });
  it("ignores a source that is not currently visible", () => {
    expect(reorderDockTabsAtGap(all, ["terminal", "agent"], "json", 1)).toEqual(
      all,
    );
  });
});
