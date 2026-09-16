import { describe, expect, it, vi } from "vitest";
import { composeExplorerPathDropTargets } from "./piComposerDrop";

describe("pi composer path drop", () => {
  it("lets the first matching target consume the drop", () => {
    const missed = {
      updateTarget: vi.fn(() => false),
      dropPath: vi.fn(() => false),
      clearTarget: vi.fn(),
    };
    const hit = {
      updateTarget: vi.fn(() => true),
      dropPath: vi.fn(() => true),
      clearTarget: vi.fn(),
    };
    const composed = composeExplorerPathDropTargets(missed, hit);
    expect(composed.updateTarget(1, 2)).toBe(true);
    expect(composed.dropPath("D:/a.py", 1, 2)).toBe(true);
    expect(hit.dropPath).toHaveBeenCalledWith("D:/a.py", 1, 2);
    composed.clearTarget();
    expect(missed.clearTarget).toHaveBeenCalledOnce();
    expect(hit.clearTarget).toHaveBeenCalledOnce();
  });
});
