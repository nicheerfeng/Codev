import { describe, it, expect } from "vitest";
import { buildTimelineBlocks } from "./timeline";
import { collectProjects, pathKey } from "./organization";
import type { PiTranscriptItem } from "./types";

/** 构造纯文本消息作为过程分组输入。 */
function message(id: string, role: "assistant" | "user"): PiTranscriptItem {
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
    expect(blocks).toHaveLength(4);
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
});
