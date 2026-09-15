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

  it("writes on scroll and on unbind", () => {
    const node = fakeScroller(0);
    const stop = bindFileScroll(node, "D:/b.py");
    node.scrollTop = 88;
    node.emit();
    expect(recallFileScroll("D:/b.py")).toBe(88);
    node.scrollTop = 120;
    stop();
    expect(recallFileScroll("D:/b.py")).toBe(120);
  });
});
