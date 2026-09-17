import { describe, expect, it } from "vitest";
import {
  cwdIsLive,
  finishNotificationCopy,
  projectActivity,
  shouldSkipFinishNotification,
  threadIsLive,
} from "./projectActivity";

describe("pi project activity", () => {
  it("treats running, stopping, starting and waiting as live", () => {
    expect(threadIsLive({ cwd: "D:/a", status: "running" })).toBe(true);
    expect(threadIsLive({ cwd: "D:/a", status: "stopping" })).toBe(true);
    expect(threadIsLive({ cwd: "D:/a", status: "starting" })).toBe(true);
    expect(threadIsLive({ cwd: "D:/a", status: "idle", waiting: true })).toBe(
      true,
    );
    expect(threadIsLive({ cwd: "D:/a", status: "idle" })).toBe(false);
    expect(threadIsLive({ cwd: "D:/a", status: "failed" })).toBe(false);
  });

  it("finds live threads in a cwd regardless of other projects", () => {
    const threads = [
      { cwd: "D:/Work/A", status: "idle" as const },
      { cwd: "D:/Work/B", status: "running" as const },
    ];
    expect(cwdIsLive(threads, "D:/Work/A")).toBe(false);
    expect(cwdIsLive(threads, "d:/work/b")).toBe(true);
  });

  it("aggregates live counts and failed flags per project", () => {
    const map = projectActivity([
      { cwd: "D:/Work/A", status: "running" },
      { cwd: "D:/Work/A", status: "idle" },
      { cwd: "D:/Work/B", status: "failed" },
    ]);
    expect(map.get("d:/work/a")).toEqual({ liveCount: 1, failed: false });
    expect(map.get("d:/work/b")).toEqual({ liveCount: 0, failed: true });
  });

  it("skips toast only when the Pi panel is in the foreground", () => {
    expect(
      shouldSkipFinishNotification({
        visible: true,
        focused: true,
        minimized: false,
        piActive: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipFinishNotification({
        visible: true,
        focused: true,
        minimized: false,
        piActive: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipFinishNotification({
        visible: true,
        focused: false,
        minimized: false,
        piActive: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipFinishNotification({
        visible: true,
        focused: true,
        minimized: true,
        piActive: true,
      }),
    ).toBe(false);
  });

  it("writes Chinese copy for completed and failed batches", () => {
    expect(
      finishNotificationCopy({
        name: "trade_agentic",
        count: 2,
        failed: false,
      }),
    ).toEqual({
      title: "Pi · trade_agentic",
      body: "2 个线程已完成",
    });
    expect(
      finishNotificationCopy({ name: "trade_agentic", count: 1, failed: true }),
    ).toEqual({
      title: "Pi · trade_agentic",
      body: "执行失败",
    });
    expect(
      finishNotificationCopy({
        name: "trade_agentic",
        threadName: "修复导出流程",
        summary: "已完成导出修复，并补充了回归测试。",
        count: 1,
        failed: false,
      }),
    ).toEqual({
      title: "Pi · 修复导出流程",
      body: "已完成导出修复，并补充了回归测试。",
    });
  });
});
