import { describe, expect, it } from "vitest";
import {
  applyComposerHeight,
  clampComposerHeight,
  composerHeight,
  COMPOSER_DEFAULT_MAX,
  COMPOSER_MIN_HEIGHT,
  rememberComposer,
  resetComposerHeight,
} from "./composerCaret";

describe("composer height", () => {
  it("does not shrink below the empty composer", () => {
    expect(clampComposerHeight(20, 480)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it("does not grow past the window cap", () => {
    expect(clampComposerHeight(900, 400)).toBe(400);
  });

  it("measures cleared content without the previous dragged height", () => {
    const node = {
      style: { height: "360px", maxHeight: "360px" },
      get scrollHeight() {
        return this.style.height === "auto" ? 48 : 360;
      },
    } as HTMLTextAreaElement;
    applyComposerHeight(node, COMPOSER_DEFAULT_MAX);
    expect(node.style.height).toBe(`${COMPOSER_MIN_HEIGHT}px`);
    expect(node.style.maxHeight).toBe(`${COMPOSER_DEFAULT_MAX}px`);
  });

  it("forgets the dragged cap for a cleared draft and new composers", () => {
    const node = {
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
    } as HTMLTextAreaElement;
    rememberComposer("sent-draft", node, 360);
    resetComposerHeight("sent-draft");
    expect(composerHeight("sent-draft")).toBe(COMPOSER_DEFAULT_MAX);
    expect(composerHeight("new-draft")).toBe(COMPOSER_DEFAULT_MAX);
  });

  it("keeps the default max height at 2.5x the minimum height", () => {
    expect(COMPOSER_DEFAULT_MAX).toBe(Math.round(COMPOSER_MIN_HEIGHT * 2.5));
  });

  it("keeps a dragged height between the bounds", () => {
    expect(clampComposerHeight(240, 480)).toBe(240);
  });
});
