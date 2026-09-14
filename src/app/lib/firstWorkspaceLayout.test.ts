import { describe, expect, it } from "vitest";
import {
  completeWelcome,
  FILE_TREE_ROOTS_KEY,
  firstLayoutSizes,
  LAYOUT_INITIALIZED_KEY,
  needsFirstLayout,
  shouldShowWelcome,
  SIDEBAR_COLLAPSED_KEY,
  TERMINAL_COLLAPSED_KEY,
  WELCOME_KEY,
  WELCOME_STAMP_KEY,
} from "./firstWorkspaceLayout";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("firstLayoutSizes", () => {
  it("splits a wide window into roughly equal side panels", () => {
    const sizes = firstLayoutSizes(1500);
    expect(sizes.sidebar).toBe(500);
    expect(sizes.terminal).toBe(500);
  });

  it("never shrinks below the panel minimums", () => {
    const sizes = firstLayoutSizes(200);
    expect(sizes.sidebar).toBeGreaterThanOrEqual(220);
    expect(sizes.terminal).toBeGreaterThanOrEqual(220);
  });
});

describe("shouldShowWelcome", () => {
  it("shows the welcome page until it is completed", () => {
    const store = memory();
    expect(shouldShowWelcome(null, store)).toBe(true);
    store.setItem(WELCOME_KEY, "1");
    expect(shouldShowWelcome(null, store)).toBe(true);
    store.setItem(LAYOUT_INITIALIZED_KEY, "1");
    expect(shouldShowWelcome(null, store)).toBe(false);
  });

  it("shows the welcome page again when the install stamp changes", () => {
    const store = memory();
    store.setItem(WELCOME_KEY, "1");
    store.setItem(LAYOUT_INITIALIZED_KEY, "1");
    store.setItem(WELCOME_STAMP_KEY, "0.9.3");
    expect(shouldShowWelcome("0.9.4", store)).toBe(true);
    expect(shouldShowWelcome("0.9.3", store)).toBe(false);
  });

  it("shows welcome again if the three-column layout was never applied", () => {
    const store = memory();
    store.setItem(WELCOME_KEY, "1");
    expect(needsFirstLayout(store)).toBe(true);
    expect(shouldShowWelcome(null, store)).toBe(true);
  });
});

describe("completeWelcome", () => {
  it("marks welcome done, layout initialized, and expands both side panels", () => {
    const store = memory();
    const sizes = completeWelcome("0.9.4", 1500, store);
    expect(store.getItem(WELCOME_KEY)).toBe("1");
    expect(store.getItem(WELCOME_STAMP_KEY)).toBe("0.9.4");
    expect(store.getItem(LAYOUT_INITIALIZED_KEY)).toBe("1");
    expect(store.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("0");
    expect(store.getItem(TERMINAL_COLLAPSED_KEY)).toBe("0");
    expect(store.getItem(FILE_TREE_ROOTS_KEY)).toBeNull();
    expect(sizes.sidebar).toBe(500);
    expect(sizes.terminal).toBe(500);
  });
});
