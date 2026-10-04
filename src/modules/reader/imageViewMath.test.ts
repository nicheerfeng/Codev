import { describe, expect, it } from "vitest";
import {
  clampImageScale,
  nextImageScale,
  zoomImageAroundPoint,
} from "./imageViewMath";

describe("image viewport math", () => {
  it("clamps scale to the fitted 25%–400% range", () => {
    expect(clampImageScale(0.1)).toBe(0.25);
    expect(clampImageScale(8)).toBe(4);
    expect(clampImageScale(1)).toBe(1);
  });

  it("steps scale from the wheel direction", () => {
    expect(nextImageScale(1, -100)).toBe(1.12);
    expect(nextImageScale(1, 100)).toBe(0.88);
    expect(nextImageScale(4, -100)).toBe(4);
    expect(nextImageScale(0.25, 100)).toBe(0.25);
  });

  it("keeps the pointer-anchored point still while zooming", () => {
    const next = zoomImageAroundPoint(1, { x: 0, y: 0 }, 2, { x: 40, y: -20 });
    expect(next.scale).toBe(2);
    expect(next.pan).toEqual({ x: -40, y: 20 });
    const again = zoomImageAroundPoint(next.scale, next.pan, 1, {
      x: 40,
      y: -20,
    });
    expect(again.scale).toBe(1);
    expect(again.pan.x).toBeCloseTo(0);
    expect(again.pan.y).toBeCloseTo(0);
  });
});
