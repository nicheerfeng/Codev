import { describe, expect, it } from "vitest";
import { shouldPersistTerminalWidth } from "./useTerminalPanelLayout";

describe("shouldPersistTerminalWidth", () => {
  it("accepts only positive user-driven widths", () => {
    expect(shouldPersistTerminalWidth(640, true)).toBe(true);
    expect(shouldPersistTerminalWidth(640, false)).toBe(false);
    expect(shouldPersistTerminalWidth(0, true)).toBe(false);
  });
});
