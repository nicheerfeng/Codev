import { describe, expect, it, beforeEach } from "vitest";
import {
  applyUnreadStatusChanges,
  clearUnreadPrefix,
  collectUnreadStatusChanges,
  hasUnreadTask,
  markTaskRead,
  resetUnreadTasks,
  unreadTaskCount,
  unreadTaskId,
} from "./unreadTasks";

describe("unreadTasks", () => {
  beforeEach(() => {
    resetUnreadTasks();
  });

  it("adds Pi and Codex completions and counts them together", () => {
    applyUnreadStatusChanges({
      completed: [unreadTaskId("pi", "a"), unreadTaskId("codex", "b")],
      running: [],
    });
    expect(unreadTaskCount()).toBe(2);
    expect(hasUnreadTask("pi:a")).toBe(true);
    expect(hasUnreadTask("codex:b")).toBe(true);
  });

  it("clears a task when it is opened or running again", () => {
    applyUnreadStatusChanges({
      completed: [unreadTaskId("pi", "a")],
      running: [],
    });
    markTaskRead(unreadTaskId("pi", "a"));
    expect(unreadTaskCount()).toBe(0);
    applyUnreadStatusChanges({
      completed: [unreadTaskId("pi", "a")],
      running: [],
    });
    applyUnreadStatusChanges({
      completed: [],
      running: [unreadTaskId("pi", "a")],
    });
    expect(hasUnreadTask("pi:a")).toBe(false);
  });

  it("clears one plugin prefix without touching the other", () => {
    applyUnreadStatusChanges({
      completed: [unreadTaskId("pi", "a"), unreadTaskId("codex", "b")],
      running: [],
    });
    clearUnreadPrefix("pi:");
    expect(unreadTaskCount()).toBe(1);
    expect(hasUnreadTask("codex:b")).toBe(true);
  });

  it("marks a child complete when first observed already done", () => {
    const previous = new Map<string, string>();
    const first = collectUnreadStatusChanges(
      previous,
      [{ key: "child", status: "complete", child: true }],
      (key) => unreadTaskId("pi", key),
    );
    expect(first.completed).toEqual(["pi:child"]);
    const again = collectUnreadStatusChanges(
      previous,
      [{ key: "child", status: "complete", child: true }],
      (key) => unreadTaskId("pi", key),
    );
    expect(again.completed).toEqual([]);
  });

  it("marks Codex waiting-to-idle as unread", () => {
    const previous = new Map<string, string>([["thread", "waiting"]]);
    const change = collectUnreadStatusChanges(
      previous,
      [{ key: "thread", status: "idle" }],
      (key) => unreadTaskId("codex", key),
    );
    expect(change.completed).toEqual(["codex:thread"]);
  });

  it("does not count idle tasks that were never seen running", () => {
    const previous = new Map<string, string>();
    const change = collectUnreadStatusChanges(
      previous,
      [{ key: "thread", status: "idle" }],
      (key) => unreadTaskId("codex", key),
    );
    expect(change.completed).toEqual([]);
  });
});
