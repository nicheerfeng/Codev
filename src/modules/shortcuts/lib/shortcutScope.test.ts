import { describe, expect, it } from "vitest";
import { shouldDisablePaneSwapShortcut } from "@/modules/shortcuts/lib/shortcutScope";

describe("shouldDisablePaneSwapShortcut", () => {
  it("does not disable any remaining global shortcut", () => {
    expect(shouldDisablePaneSwapShortcut("pane.focusNext", null)).toBe(false);
    expect(shouldDisablePaneSwapShortcut("editor.undo", 1)).toBe(false);
  });
});
