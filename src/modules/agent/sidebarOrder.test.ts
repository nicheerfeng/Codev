import { describe, expect, it } from "vitest";
import { moveDisplayedItem, promoteLiveOrder } from "./sidebarOrder";

describe("侧栏活跃排序", () => {
  it("开始运行时写入最前，结束后保持该位置", () => {
    const saved = ["a", "b", "c", "d", "e", "running", "waiting"];
    const promoted = promoteLiveOrder(saved, ["running", "waiting"]);
    expect(promoted.slice(0, 5)).toEqual(["running", "waiting", "a", "b", "c"]);
    expect(promoteLiveOrder(promoted, [])).toEqual(promoted);
  });
  it("拖拽只移动目标项，不把临时上浮顺序写回", () => {
    const base = ["a", "b", "c", "running", "hidden"];
    const visible = ["running", "a", "b", "c"];
    expect(moveDisplayedItem(base, visible, "c", 2)).toEqual([
      "a",
      "c",
      "b",
      "running",
      "hidden",
    ]);
    expect(moveDisplayedItem(base, visible, "a", 4)).toEqual([
      "b",
      "c",
      "a",
      "running",
      "hidden",
    ]);
  });
  it("原位释放不修改保存顺序", () => {
    const base = ["a", "b", "running"];
    expect(moveDisplayedItem(base, ["running", "a", "b"], "running", 1)).toBe(
      base,
    );
  });
});
