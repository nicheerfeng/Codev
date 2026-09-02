import { describe, expect, it } from "vitest";
import { tabWheelDelta } from "./tabScroll";

describe("tabWheelDelta", () => {
  it("maps a vertical mouse wheel to horizontal pixels", () => {
    expect(tabWheelDelta(0, 120, 0, 800)).toBe(120);
  });

  it("keeps the dominant horizontal touchpad delta", () => {
    expect(tabWheelDelta(-48, 12, 0, 800)).toBe(-48);
  });

  it("converts line and page wheel modes", () => {
    expect(tabWheelDelta(0, 3, 1, 800)).toBe(48);
    expect(tabWheelDelta(0, 1, 2, 800)).toBe(800);
  });
});
