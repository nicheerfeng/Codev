import { describe, expect, it } from "vitest";
import { applyCloseTabsPlan, planCloseTabsToRight, type Tab } from "./useTabs";

function editor(id: number, spaceId = "a"): Tab {
  return {
    id,
    kind: "editor",
    spaceId,
    title: `file-${id}`,
    path: `/file-${id}`,
    dirty: false,
    preview: false,
  };
}

function terminal(id: number, leafId: number, spaceId = "a"): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: leafId },
    activeLeafId: leafId,
  };
}

describe("applyCloseTabsPlan", () => {
  // 合并标签栏按显示顺序关闭跨空间文件，保留自身、左侧及其他分屏。
  it("closes every tab to the right in the visible group across spaces", () => {
    const tabs = [editor(1, "a"), editor(2, "b"), editor(3, "a"), editor(4, "c"), editor(5, "b")];
    const plan = planCloseTabsToRight(tabs, 2, 4, [3, 2, 1, 4]);
    expect(plan.closeIds).toEqual([1, 4]);
    const result = applyCloseTabsPlan(tabs, 2, plan);
    expect(result?.tabs.map((tab) => tab.id)).toEqual([2, 3, 5]);
    expect(result?.nextActiveId).toBe(2);
  });
  it("plans every tab strictly to the right of the anchor", () => {
    const plan = planCloseTabsToRight(
      [editor(1), editor(2), editor(3), editor(4)],
      2,
      2,
    );

    expect(plan.closeIds).toEqual([3, 4]);
    expect(plan.nextActiveId).toBe(2);
  });

  it("closes exactly the planned tabs and returns terminal leaves to dispose", () => {
    const tabs = [terminal(1, 10), terminal(2, 20), editor(3), editor(4)];
    const result = applyCloseTabsPlan(tabs, 1, {
      closeIds: [2, 3],
      nextActiveId: 1,
    });

    expect(result?.tabs.map((tab) => tab.id)).toEqual([1, 4]);
    expect(result?.closeIds).toEqual([2, 3]);
    expect(result?.disposeLeafIds).toEqual([20]);
    expect(result?.nextActiveId).toBe(1);
  });

  it("does not sweep in a tab added after the close range was planned", () => {
    const original = [editor(1), editor(2), editor(3)];
    const plan = planCloseTabsToRight(original, 1, 1);
    const current = [...original, editor(4)];

    expect(
      applyCloseTabsPlan(current, 1, plan)?.tabs.map((tab) => tab.id),
    ).toEqual([1, 4]);
  });

  it("does not close a planned tab that moved to another space", () => {
    const tabs = [editor(1), editor(2), editor(3, "b")];
    const result = applyCloseTabsPlan(tabs, 1, {
      closeIds: [2, 3],
      nextActiveId: 1,
    });

    expect(result?.tabs.map((tab) => tab.id)).toEqual([1, 3]);
    expect(result?.closeIds).toEqual([2]);
  });

  it("falls back to the anchor when the planned active tab is unavailable", () => {
    const result = applyCloseTabsPlan([editor(1), editor(2)], 1, {
      closeIds: [2],
      nextActiveId: 2,
    });

    expect(result?.nextActiveId).toBe(1);
  });

  it("does nothing when the anchor no longer exists", () => {
    expect(
      applyCloseTabsPlan([editor(2)], 1, {
        closeIds: [2],
        nextActiveId: 1,
      }),
    ).toBeNull();
  });
});
