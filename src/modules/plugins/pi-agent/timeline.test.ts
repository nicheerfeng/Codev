import { describe, it, expect } from "vitest";
import { buildTimelineBlocks } from "./timeline";
import { collectProjects, nextDraftKey, pathKey } from "./organization";
import type { PiMessageItem } from "./types";

/** 构造纯文本消息作为过程分组输入。 */
function message(id: string, role: "assistant" | "user"): PiMessageItem {
  return {
    id,
    kind: "message",
    role,
    text: id,
    thinking: "",
    streaming: false,
  };
}

describe("Pi turn grouping", () => {
  // 历史过程块不能阻止新一轮在首个模型事件前显示计时占位。
  it("shows an immediate live process after completed history", () => {
    const blocks = buildTimelineBlocks([
      message("old-user", "user"),
      { id: "old-thinking", kind: "thinking", text: "done", streaming: false },
      message("old-answer", "assistant"),
      message("new-user", "user"),
    ], true, { startedAt: 1234 });
    expect(blocks.filter((block) => block.kind === "process")).toHaveLength(2);
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: "process", running: true, startedAt: 1234, label: "处理中" });
    expect(blocks[1]).toMatchObject({ kind: "process", running: false });
  });
  it("groups intermediate narrative and tools once, retaining final answer", () => {
    const blocks = buildTimelineBlocks(
      [
        message("user", "user"),
        { id: "thought", kind: "thinking", text: "plan", streaming: false },
        message("narrative", "assistant"),
        {
          id: "tool",
          kind: "tool",
          toolCallId: "tool",
          name: "read",
          args: {},
          output: "ok",
          status: "done",
        },
        message("final", "assistant"),
      ],
      false,
    );
    expect(blocks.map((item) => item.kind)).toEqual([
      "item",
      "process",
      "item",
    ]);
    expect(blocks[1]).toMatchObject({
      items: [{ id: "thought" }, { id: "narrative" }, { id: "tool" }],
      running: false,
    });
    expect(
      blocks[1].kind === "process" && blocks[1].steps.map((step) => step.kind),
    ).toEqual(["thinking", "narrative", "tool-group"]);
    expect(blocks[2]).toMatchObject({ item: { id: "final" } });
  });
  it("does not merge separate user turns", () => {
    const blocks = buildTimelineBlocks(
      [
        message("u1", "user"),
        message("a1", "assistant"),
        message("u2", "user"),
        message("a2", "assistant"),
      ],
      true,
    );
    expect(blocks).toHaveLength(5);
  });
  it("keeps a streaming assistant response inside the active process", () => {
    const blocks = buildTimelineBlocks(
      [
        message("user", "user"),
        { ...message("draft", "assistant"), streaming: true },
      ],
      true,
    );
    expect(blocks.map((item) => item.kind)).toEqual(["item", "process"]);
    expect(blocks[1]).toMatchObject({
      kind: "process",
      items: [{ id: "draft", streaming: true }],
      running: true,
    });
  });
  it("keeps a visible collapsed process summary before the first stream event", () => {
    const blocks = buildTimelineBlocks([message("u1", "user")], true, {
      startedAt: 1000,
    });
    expect(blocks[blocks.length - 1]).toMatchObject({
      kind: "process",
      running: true,
      label: "处理中",
      items: [],
      startedAt: 1000,
    });
  });
  it("uses user and final assistant timestamps for historical turn duration", () => {
    const blocks = buildTimelineBlocks(
      [
        { ...message("u1", "user"), timestamp: 1789120800000 },
        {
          id: "thinking",
          kind: "thinking",
          text: "plan",
          streaming: false,
          timestamp: 1789120801000,
        },
        { ...message("a1", "assistant"), timestamp: 1789120805000 },
      ],
      false,
    );
    expect(blocks[1]).toMatchObject({
      kind: "process",
      startedAt: 1789120800000,
      finishedAt: 1789120805000,
    });
  });
  it("does not apply live process timing to earlier completed turns", () => {
    const blocks = buildTimelineBlocks(
      [
        { ...message("u1", "user"), timestamp: 1000 },
        {
          id: "t1",
          kind: "thinking",
          text: "old",
          streaming: false,
          timestamp: 1500,
        },
        { ...message("a1", "assistant"), timestamp: 2000 },
        { ...message("u2", "user"), timestamp: 9000 },
        { ...message("a2", "assistant"), timestamp: 9500, streaming: true },
      ],
      true,
      { startedAt: 9000 },
    );
    const processes = blocks.filter((block) => block.kind === "process");
    expect(processes[0]).toMatchObject({
      kind: "process",
      running: false,
      startedAt: 1000,
      finishedAt: 2000,
    });
    expect(processes[1]).toMatchObject({
      kind: "process",
      running: true,
      startedAt: 9000,
      finishedAt: undefined,
    });
  });
  it("keeps completed duration on the current turn instead of collapsing to zero", () => {
    const blocks = buildTimelineBlocks(
      [
        { ...message("u1", "user"), timestamp: 1000 },
        {
          id: "thought",
          kind: "thinking",
          text: "plan",
          streaming: false,
          timestamp: 1400,
        },
        { ...message("a1", "assistant"), timestamp: 1000 },
      ],
      false,
      { startedAt: 1000, finishedAt: 5000 },
    );
    expect(blocks[1]).toMatchObject({
      kind: "process",
      running: false,
      startedAt: 1000,
      finishedAt: 5000,
    });
  });
  it("preserves empty projects and normalizes Windows paths without lowercasing Unix paths", () => {
    expect(
      collectProjects(
        ["D:\\Work\\One", "d:/work/one/", "/Work/One", "/work/one"],
        [],
        [],
      ),
    ).toHaveLength(3);
    expect(collectProjects(["D:/Work/One"], [], ["d:/work/one"])).toEqual([]);
    expect(pathKey("D:\\Work\\One\\")).toBe("d:/work/one");
  });
  it("gives each new thread a unique draft key in the same project", () => {
    const one = nextDraftKey("D:\\Work\\One\\");
    const two = nextDraftKey("d:/work/one");
    expect(one).toMatch(/^draft:d:\/work\/one:[0-9a-f-]{36}$/i);
    expect(two).toMatch(/^draft:d:\/work\/one:[0-9a-f-]{36}$/i);
    expect(one).not.toBe(two);
  });
});
