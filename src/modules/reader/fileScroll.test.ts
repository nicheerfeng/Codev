import { describe, expect, it } from "vitest";
import {
  bindFileScroll,
  recallFileScroll,
  rememberFileScroll,
} from "./fileScroll";

function fakeScroller(top = 0) {
  const listeners = new Set<() => void>();
  return {
    scrollTop: top,
    addEventListener(_type: "scroll", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "scroll", listener: () => void) {
      listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

describe("file scroll memory", () => {
  it("stores and restores a path's scroll offset", () => {
    rememberFileScroll("D:/a.md", 420);
    expect(recallFileScroll("D:/a.md")).toBe(420);
  });

  it("ignores native zeroing until restore finishes", () => {
    rememberFileScroll("D:/c.py", 400);
    const node = fakeScroller(0);
    let apply = () => {};
    const stop = bindFileScroll(node, "D:/c.py", {
      schedule: (next) => {
        apply = next;
        return () => {};
      },
    });
    node.scrollTop = 0;
    node.emit();
    expect(recallFileScroll("D:/c.py")).toBe(400);
    apply();
    expect(node.scrollTop).toBe(400);
    node.scrollTop = 0;
    node.emit();
    expect(recallFileScroll("D:/c.py")).toBe(0);
    stop();
  });

  it("does not write zero if unbound before restore", () => {
    rememberFileScroll("D:/d.py", 240);
    const node = fakeScroller(0);
    const stop = bindFileScroll(node, "D:/d.py", {
      schedule: () => () => {},
    });
    node.scrollTop = 0;
    stop();
    expect(recallFileScroll("D:/d.py")).toBe(240);
  });
});
