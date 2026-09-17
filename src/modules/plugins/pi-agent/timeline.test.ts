import { describe, it, expect } from "vitest";
import {
  activitySummary as summaryOf,
  currentActivity,
  buildTimelineBlocks,
  toolSummary,
} from "./timeline";
import {
  collectProjects,
  defaultPiCollapsedKeys,
  isArchivedPath,
  isTemporaryCwd,
  nextDraftKey,
  normalizeOrganization,
  pathKey,
  sessionIdentity,
  visiblePiProjects,
  withArchivedPath,
} from "./organization";
import type { PiMessageItem, PiToolItem, PiTranscriptItem } from "./types";

/** 按产品顺序选择当前记录并生成摘要。 */
function activitySummary(items: PiTranscriptItem[]): string {
  return summaryOf(currentActivity(items));
}

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
  it("keeps the tool action visible beside commands and file targets", () => {
    const tool = (name: string, args: Record<string, unknown>): PiToolItem => ({
      id: `${name}-${JSON.stringify(args)}`,
      kind: "tool",
      toolCallId: name,
      name,
      args,
      output: "ok",
      status: "done",
    });
    const read = tool("read", { path: "D:/work/a.ts", offset: 10, limit: 20 });
    const edit = tool("edit", { path: "D:/work/a.ts" });
    const bash = tool("bash", { command: "rg -n TODO src" });
    expect(toolSummary(read)).toBe("read · D:/work/a.ts · 第 10 行起 · 20 行");
    expect(toolSummary(edit)).toBe("edit · D:/work/a.ts");
    expect(toolSummary(bash)).toBe("bash · rg -n TODO src");
  });

  // 历史过程块不能阻止新一轮在首个模型事件前显示计时占位。
  it("shows an immediate live process after completed history", () => {
    const blocks = buildTimelineBlocks(
      [
        message("old-user", "user"),
        {
          id: "old-thinking",
          kind: "thinking",
          text: "done",
          streaming: false,
        },
        message("old-answer", "assistant"),
        message("new-user", "user"),
      ],
      true,
      { startedAt: 1234 },
    );
    expect(blocks.filter((block) => block.kind === "process")).toHaveLength(2);
    expect(blocks[blocks.length - 1]).toMatchObject({
      kind: "process",
      running: true,
      startedAt: 1234,
      label: "处理中",
    });
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
    ).toEqual(["activity", "narrative", "activity"]);
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
  it("combines alternating thoughts and tools until the next narrative", () => {
    const thought = {
      id: "thought",
      kind: "thinking" as const,
      text: "plan",
      streaming: false,
    };
    const tool: PiToolItem = {
      id: "read",
      kind: "tool",
      toolCallId: "read",
      name: "read",
      args: {},
      output: "ok",
      status: "done",
    };
    const blocks = buildTimelineBlocks(
      [
        message("user", "user"),
        thought,
        tool,
        { ...thought, id: "thought-2" },
        { ...tool, id: "edit", name: "edit" },
        message("progress", "assistant"),
        { ...thought, id: "thought-3" },
        message("final", "assistant"),
      ],
      false,
    );
    expect(blocks[1]).toMatchObject({
      steps: [
        {
          id: "activity-thought",
          kind: "activity",
          items: [
            { id: "thought" },
            { id: "read" },
            { id: "thought-2" },
            { id: "edit" },
          ],
        },
        { kind: "narrative", item: { id: "progress" } },
        { kind: "activity", items: [{ id: "thought-3" }] },
      ],
    });
  });
  it("updates the activity summary without adding status rows", () => {
    const thought = {
      id: "thought",
      kind: "thinking" as const,
      text: "plan",
      streaming: true,
    };
    const tool: PiToolItem = {
      id: "read",
      kind: "tool",
      toolCallId: "read",
      name: "read",
      args: {},
      output: "",
      status: "running",
    };
    expect(activitySummary([thought])).toBe("思考中 · plan");
    expect(activitySummary([thought, tool])).toBe("正在运行 · read");
    expect(
      activitySummary([
        { ...thought, streaming: false },
        { ...tool, status: "done" },
      ]),
    ).toBe("已完成 · read");
    expect(activitySummary([{ ...tool, status: "error" }, thought])).toBe(
      "思考中 · plan",
    );
  });
  it("previews real parameters and retains the thinking beginning with trailing ellipsis", () => {
    const tool: PiToolItem = {
      id: "tool",
      kind: "tool",
      toolCallId: "tool",
      name: "custom.Run",
      args: { payload: "actual data" },
      output: "",
      status: "running",
    };
    const thought = {
      id: "thought",
      kind: "thinking" as const,
      text: `${"旧内容".repeat(100)}\n正在检查最新结果`,
      streaming: true,
    };
    expect(activitySummary([tool, thought])).toBe(
      '正在运行 · custom.Run · {"payload":"actual data"}',
    );
    expect(activitySummary([{ ...tool, status: "done" }, thought])).toMatch(
      /^思考中 · 旧内容/,
    );
    expect(activitySummary([thought])).toBe(
      `思考中 · ${thought.text.slice(0, 160)}…`,
    );
    expect(activitySummary([thought])).not.toContain("\n");
    expect(activitySummary([{ ...tool, status: "error" }])).toContain(
      "执行失败 · custom.Run",
    );
    expect(activitySummary([])).toBe("等待模型响应");
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
    expect(pathKey("\\\\?\\C:\\Users\\me\\.pi\\agent\\")).toBe(
      "c:/users/me/.pi/agent",
    );
    expect(pathKey("//?/C:/Users/me/.pi/agent/")).toBe("c:/users/me/.pi/agent");
    expect(
      sessionIdentity(
        "\\\\?\\C:\\Users\\me\\session.jsonl",
        "draft:c:/users/me:abc",
      ),
    ).toBe("c:/users/me/session.jsonl");
    expect(sessionIdentity("", "draft:c:/users/me:abc")).toBe(
      "draft:c:/users/me:abc",
    );
  });
  it("matches archived sessions after Windows path shape changes", () => {
    const archived = withArchivedPath(
      ["D:\\Users\\me\\.pi\\agent\\sessions\\a.jsonl"],
      "",
      false,
    );
    expect(archived).toEqual(["d:/users/me/.pi/agent/sessions/a.jsonl"]);
    expect(
      isArchivedPath("D:/Users/me/.pi/agent/sessions/a.jsonl", archived),
    ).toBe(true);
    expect(
      isArchivedPath("//?/D:/Users/me/.pi/agent/sessions/A.jsonl", archived),
    ).toBe(true);
    expect(
      isArchivedPath(
        "\\\\?\\D:\\Users\\me\\.pi\\agent\\sessions\\a.jsonl",
        archived,
      ),
    ).toBe(true);
    expect(
      withArchivedPath(
        archived,
        "//?/D:/Users/me/.pi/agent/sessions/A.jsonl",
        true,
      ),
    ).toEqual(["d:/users/me/.pi/agent/sessions/a.jsonl"]);
    expect(
      withArchivedPath(
        archived,
        "//?/D:/Users/me/.pi/agent/sessions/A.jsonl",
        false,
      ),
    ).toEqual([]);
    const org = normalizeOrganization({
      groups: [{ id: " g1 ", name: " " }],
      projectGroups: { "D:\\Work\\One\\": "g1" },
      archived: [
        "D:/Users/me/.pi/agent/sessions/a.jsonl",
        "d:\\users\\me\\.pi\\agent\\sessions\\a.jsonl",
      ],
    });
    expect(org.groups).toEqual([{ id: "g1", name: "g1" }]);
    expect(org.projectGroups).toEqual({ "d:/work/one": "g1" });
    expect(org.archived).toEqual(["d:/users/me/.pi/agent/sessions/a.jsonl"]);
  });
  it("gives each new thread a unique draft key in the same project", () => {
    const one = nextDraftKey("D:\\Work\\One\\");
    const two = nextDraftKey("d:/work/one");
    expect(one).toMatch(/^draft:d:\/work\/one:[0-9a-f-]{36}$/i);
    expect(two).toMatch(/^draft:d:\/work\/one:[0-9a-f-]{36}$/i);
    expect(one).not.toBe(two);
  });
  it("keeps the Pi home directory out of ordinary projects", () => {
    const home = "C:/Users/me/.pi/agent";
    expect(isTemporaryCwd(home, home)).toBe(true);
    expect(
      visiblePiProjects(["D:/Work/One", home, "D:/Work/Two"], home),
    ).toEqual(["D:/Work/One", "D:/Work/Two"]);
    expect(
      defaultPiCollapsedKeys(["D:/Work/One", home], [{ id: "g1" }], home),
    ).toEqual(["group:", "group:temporary", "group:g1", "project:d:/work/one"]);
  });
});
