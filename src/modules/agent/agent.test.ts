import { describe, expect, it } from "vitest";
import {
  splitUserAttachmentText,
  withAttachmentPrompt,
} from "@/modules/plugins/pi-agent/piAttachments";
import {
  moveDisplayedItem,
  promoteLiveOrder,
} from "@/modules/plugins/sidebarOrder";
import { AgentHostClient } from "./client";
import { resolveContextPercent } from "./ContextViz";
import { splitInlineThinking } from "./inlineThinking";
import { parsePlanEntries } from "./PlanAndRequest";
import {
  consumeFrameForTest,
  mergeView,
  shareMessage,
  useAgentStore,
} from "./store";
import {
  collectTurnFileChanges,
  describeToolCall,
  displayCommand,
  groupProcessSteps,
  summarizeProcessBlock,
} from "./toolFormat";
import { buildTranscriptBlocks } from "./turnTimeline";
import type { AgentMessage, SessionView } from "./types";

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "m1",
    kind: "message",
    role: "assistant",
    text: "hi",
    thinking: "",
    toolName: "",
    toolCallId: "",
    arguments: null,
    status: "completed",
    images: [],
    streaming: false,
    rawKind: "message",
    ...overrides,
  };
}

function makeView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    workspaceId: "w1",
    harnessId: "pi",
    title: "Demo",
    updatedAt: 1,
    archived: false,
    pinned: false,
    readOnly: false,
    imported: false,
    instanceId: "i1",
    revision: 1,
    state: "idle",
    capabilities: {
      supportsResume: true,
      supportsFork: true,
      supportsThinking: true,
      supportsPermission: false,
      supportsImages: true,
      supportsFileMentions: true,
      supportsQueue: true,
      supportsCompaction: true,
      supportsModelSelection: true,
      supportsSkills: true,
      supportsExtensionUi: true,
      supportsContextUsage: true,
    },
    messages: [],
    models: [],
    model: null,
    thinkingLevels: [],
    thinkingLevel: "",
    configOptions: [],
    commands: [],
    pendingRequests: [],
    queue: [],
    context: {},
    historyLoaded: true,
    historyOffset: 0,
    historyAvailable: true,
    truncated: false,
    ...overrides,
  };
}

describe("agent Phase 1 store & transport contracts", () => {
  it("shareMessage detects structured diff, toolKind, isError, and sourceEventId updates", () => {
    const prev = makeMessage({ id: "t1", kind: "toolCall", toolName: "edit" });
    const same = shareMessage(prev, { ...prev });
    expect(same).toBe(prev);

    const withDiff = shareMessage(prev, {
      ...prev,
      diff: { patch: "@@ -1 +1 @@\n-a\n+b" },
      toolKind: "edit",
      isError: false,
    });
    expect(withDiff).not.toBe(prev);
    expect(withDiff.diff).toEqual({ patch: "@@ -1 +1 @@\n-a\n+b" });

    const withSource = shareMessage(prev, { ...prev, sourceEventId: "entry-9" });
    expect(withSource).not.toBe(prev);
    expect(withSource.sourceEventId).toBe("entry-9");
  });

  it("mergeView keeps newer local revision while filling missing messages", () => {
    const m1 = makeMessage({ id: "m1", text: "first" });
    const m2 = makeMessage({ id: "m2", text: "second" });
    const local = makeView({ revision: 5, _messageOrder: ["m1", "m2"], messages: [m1] });
    const stale = makeView({ revision: 3, messages: [m1, m2] });
    const merged = mergeView(local, stale);
    expect(merged.revision).toBe(5);
    expect(merged.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("bumpSend tracks prompt send revisions per session", () => {
    useAgentStore.setState({ sendRevisions: {} });
    expect(useAgentStore.getState().sendRevisions.s1 ?? 0).toBe(0);
    useAgentStore.getState().bumpSend("s1");
    expect(useAgentStore.getState().sendRevisions.s1).toBe(1);
    useAgentStore.getState().bumpSend("s1");
    expect(useAgentStore.getState().sendRevisions.s1).toBe(2);
  });

  it("consumeFrameForTest applies snapshot and session.patch cleanly", () => {
    consumeFrameForTest({
      type: "snapshot",
      snapshot: {
        protocolVersion: 1,
        serverId: "srv-1",
        sequence: 1,
        workspaces: [{ id: "w1", cwd: "/repo", title: "repo" }],
        sessions: [
          {
            id: "s1",
            workspaceId: "w1",
            harnessId: "pi",
            title: "Demo",
            updatedAt: 1,
            archived: false,
            pinned: false,
            readOnly: false,
            imported: false,
            instanceId: "i1",
            revision: 1,
            state: "working",
          },
        ],
        harnesses: [],
      },
    });
    const patchedView = makeView({ revision: 2, state: "working", messages: [makeMessage()] });
    consumeFrameForTest({
      type: "event",
      event: {
        protocolVersion: 1,
        sequence: 2,
        kind: "session.patch",
        sessionId: "s1",
        instanceId: "i1",
        payload: {
          view: patchedView,
          messageOrder: ["m1"],
          messageUpserts: [makeMessage()],
        },
      },
    });
    expect(useAgentStore.getState().views.s1.messages[0]?.text).toBe("hi");
  });

  it("AgentHostClient uses host.resync on sequence gap without tearing down open socket", async () => {
    class MockWebSocket {
      static OPEN = 1;
      static CLOSING = 2;
      readyState = 1;
      sent: string[] = [];
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      closed = false;
      constructor(public url: string, public protocols?: string[]) {
        lastSocket = this;
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
      }
    }
    let lastSocket: MockWebSocket | null = null;
    const origWs = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    try {
      const client = new AgentHostClient();
      const frames: string[] = [];
      client.connect(
        { endpoint: "ws://127.0.0.1:9999/v1/ws", token: "tok" },
        (frame) => frames.push(frame.type),
        () => {},
      );
      expect(lastSocket).not.toBeNull();
      lastSocket!.onmessage?.({
        data: JSON.stringify({
          type: "snapshot",
          snapshot: {
            protocolVersion: 1,
            serverId: "srv",
            sequence: 1,
            workspaces: [],
            sessions: [],
            harnesses: [],
          },
        }),
      });
      // Simulate sequence gap (sequence 5 while expecting 2)
      lastSocket!.onmessage?.({
        data: JSON.stringify({
          type: "event",
          event: { protocolVersion: 1, sequence: 5, kind: "host.changed", payload: {} },
        }),
      });
      expect(lastSocket!.closed).toBe(false);
      expect(lastSocket!.sent.length).toBe(1);
      const req = JSON.parse(lastSocket!.sent[0]);
      expect(req.operation).toBe("host.resync");
      lastSocket!.onmessage?.({
        data: JSON.stringify({
          type: "response",
          requestId: req.requestId,
          ok: true,
          data: {
            protocolVersion: 1,
            serverId: "srv",
            sequence: 5,
            workspaces: [],
            sessions: [],
            harnesses: [],
          },
        }),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(frames).toContain("resync");
      expect(lastSocket!.closed).toBe(false);
      client.disconnect();
    } finally {
      globalThis.WebSocket = origWs;
    }
  });
});

describe("agent Phase 2 semantic formatting & inline thinking", () => {
  it("normalizes tool calls, grep exit-1 empty matches, and shell prefixes", () => {
    expect(displayCommand(`powershell.exe -NoProfile -Command "pnpm cargo test"`)).toBe(
      "pnpm cargo test",
    );
    const grepFail = makeMessage({
      id: "g1",
      kind: "toolCall",
      toolName: "bash",
      arguments: { command: "rg needle src/" },
      status: "error",
      isError: true,
      text: "Command exited with code 1",
    });
    const desc = describeToolCall(grepFail);
    expect(desc.category).toBe("command");
    expect(desc.isGrepEmpty).toBe(true);
    expect(desc.commandText).toBe("rg needle src/");

    const editTool = makeMessage({
      id: "e1",
      kind: "toolCall",
      toolName: "edit",
      arguments: { path: "src/app.ts" },
      diff: { oldText: "a\nb", newText: "a\nc\nd" },
      status: "completed",
    });
    const editDesc = describeToolCall(editTool);
    expect(editDesc.category).toBe("edit");
    expect(editDesc.diff?.adds).toBe(2);
    expect(editDesc.diff?.dels).toBe(1);

    const changes = collectTurnFileChanges([editTool], "/repo");
    expect(changes).toHaveLength(1);
    expect(changes[0].operation).toBe("修改");
    expect(changes[0].path).toBe("/repo/src/app.ts");
  });

  it("deduplicates Windows leading-slash drive paths and extracts diffs from ACP tool arguments", () => {
    const t1 = makeMessage({
      id: "w1",
      kind: "toolCall",
      toolName: "replace_file_content",
      arguments: {
        TargetFile: "d:/repo/src/a.ts",
        TargetContent: "line1\nline2",
        ReplacementContent: "line1\nline2b\nline3",
      },
      status: "completed",
    });
    const t2 = makeMessage({
      id: "w2",
      kind: "toolCall",
      toolName: "multi_replace_file_content",
      arguments: {
        TargetFile: "/d:/repo/src/a.ts",
        ReplacementChunks: [
          { TargetContent: "foo\nbar", ReplacementContent: "foo\nbaz" },
        ],
      },
      status: "completed",
    });
    const changes = collectTurnFileChanges([t1, t2], "d:/repo");
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("d:/repo/src/a.ts");
    expect(changes[0].adds).toBe(3);
    expect(changes[0].dels).toBe(2);
    expect(changes[0].diffText).toContain("+line2b");
    expect(changes[0].diffText).toContain("+baz");
  });

  it("compacts Antigravity ACP file paths and formats line ranges cleanly", () => {
    const agyRead = makeMessage({
      id: "agy-r1",
      kind: "toolCall",
      toolName: "File C:/Users/79988/Desktop/iris-analysis-report/commands.rs",
      toolKind: "read",
      arguments: {
        Path: "C:\\Users\\79988\\Desktop\\iris-analysis-report\\commands.rs",
        StartLine: 1670,
        EndLine: 1795,
      },
      status: "completed",
    });
    const agyReadDesc = describeToolCall(agyRead);
    expect(agyReadDesc.category).toBe("read");
    expect(agyReadDesc.target).toBe("commands.rs #L1670-1795");
    expect(agyReadDesc.title).toBe("读取 commands.rs #L1670-1795");
    expect(agyReadDesc.title).not.toContain("79988");

    const agySearch = makeMessage({
      id: "agy-s1",
      kind: "toolCall",
      toolName: "Search /Users/alice/repo/src",
      toolKind: "search",
      arguments: {
        Query: "applyComposerHeight",
        SearchPath: "d:\\software\\codev-dev\\src\\modules",
      },
      status: "completed",
    });
    const agySearchDesc = describeToolCall(agySearch);
    expect(agySearchDesc.category).toBe("search");
    expect(agySearchDesc.target).toBe('"applyComposerHeight" · modules');
  });

  it("groups explore steps and marks failure recovery", () => {
    const msgs = [
      makeMessage({ id: "t1", kind: "toolCall", toolName: "read", arguments: { path: "a.ts" }, status: "completed" }),
      makeMessage({ id: "t2", kind: "toolCall", toolName: "grep", arguments: { pattern: "foo" }, status: "completed" }),
      makeMessage({ id: "t3", kind: "toolCall", toolName: "bash", arguments: { command: "pnpm build" }, status: "error", isError: true }),
      makeMessage({ id: "t4", kind: "toolCall", toolName: "bash", arguments: { command: "pnpm check-types" }, status: "completed" }),
    ];
    const groups = groupProcessSteps(msgs);
    expect(groups).toHaveLength(3);
    expect(groups[0].kind).toBe("explore");
    expect(groups[2].kind === "single" && groups[2].recoveredAfterFailure).toBe(true);
    expect(summarizeProcessBlock(msgs, false)).toContain("读取 1 · 搜索 1 · 命令 2");
  });

  it("splits leading <think> tags and parses plan entries", () => {
    const split = splitInlineThinking("<think>step 1</think>\nFinal answer", "", false);
    expect(split.thinking).toBe("step 1");
    expect(split.text).toBe("Final answer");

    const plan = parsePlanEntries(JSON.stringify([{ content: "Step A", status: "completed" }]));
    expect(plan?.[0].content).toBe("Step A");
  });
});

describe("agent Phase 3 attachment & sidebar order contracts", () => {
  it("roundtrips attached file chips cleanly through prompt serialization", () => {
    const prompt = withAttachmentPrompt("请检查这两个文件", [
      { kind: "file", path: "/repo/src/a.ts", name: "a.ts" },
      { kind: "dir", path: "/repo/docs", name: "docs" },
    ]);
    const parsed = splitUserAttachmentText(prompt);
    expect(parsed.body).toBe("请检查这两个文件");
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toMatchObject({ kind: "file", path: "/repo/src/a.ts" });
    expect(parsed.attachments[1]).toMatchObject({ kind: "dir", path: "/repo/docs" });
  });

  it("promotes live sessions and reorders displayed items deterministically", () => {
    expect(promoteLiveOrder(["a", "b", "c"], ["c"])).toEqual(["c", "a", "b"]);
    expect(moveDisplayedItem(["a", "b", "c"], ["a", "b", "c"], "c", 0)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("agent Turn timeline aggregation & compact ticker", () => {
  it("folds intermediate thinking, tools, and narratives into one Turn process while keeping final answer standalone", () => {
    const msgs: AgentMessage[] = [
      makeMessage({ id: "u1", role: "user", text: "统计并导出", createdAt: 1000 }),
      makeMessage({ id: "a1", role: "assistant", thinking: "先查看表结构", text: "接下来精确统计。", createdAt: 1500 }),
      makeMessage({ id: "t1", kind: "toolCall", toolName: "bash", arguments: { command: "python stats.py" }, status: "completed", createdAt: 2000 }),
      makeMessage({ id: "a2", role: "assistant", thinking: "读结果", text: "统计已写好。", createdAt: 3000 }),
      makeMessage({ id: "t2", kind: "toolCall", toolName: "edit", arguments: { path: "export.py" }, diff: { oldText: "a", newText: "b" }, status: "completed", createdAt: 4000 }),
      makeMessage({ id: "a3", role: "assistant", thinking: "验证最终交付", text: "已导出完成，共 26,758 条。", createdAt: 5000 }),
    ];

    const blocks = buildTranscriptBlocks(msgs, false, "/repo");
    expect(blocks.map((b) => b.kind)).toEqual(["message", "process", "message"]);

    const proc = blocks[1];
    expect(proc.kind).toBe("process");
    if (proc.kind === "process") {
      expect(proc.running).toBe(false);
      expect(proc.toolCount).toBe(2);
      expect(proc.stepCount).toBe(7);
      expect(proc.fileChanges).toHaveLength(1);
      expect(proc.fileChanges[0].path).toBe("/repo/export.py");
      expect(proc.tickerItems.map((t) => t.verb)).toEqual([
        "思考",
        "说明",
        "命令",
        "思考",
        "说明",
        "修改",
        "思考",
      ]);
      expect(proc.summaryText).toContain("修改 1 · 命令 1");
      expect(proc.summaryText).toContain("变更 1 文件");
    }

    const finalBlock = blocks[2];
    expect(finalBlock.kind).toBe("message");
    if (finalBlock.kind === "message") {
      expect(finalBlock.message.id).toBe("a3");
      expect(finalBlock.hideThinking).toBe(true);
    }
  });

  it("shows immediate live wait ticker right after user prompt while running", () => {
    const blocks = buildTranscriptBlocks(
      [makeMessage({ id: "u1", role: "user", text: "开始分析", createdAt: 2000 })],
      true,
      "/repo",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      kind: "process",
      running: true,
      statusTitle: "等待响应",
    });
  });

  it("omits process block for pure Q&A without thinking or tools", () => {
    const blocks = buildTranscriptBlocks(
      [
        makeMessage({ id: "u1", role: "user", text: "你好" }),
        makeMessage({ id: "a1", role: "assistant", text: "你好，有什么可以帮您？" }),
      ],
      false,
      "/repo",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["message", "message"]);
  });

  it("resolveContextPercent computes percentage from used/size when percent is omitted", () => {
    expect(resolveContextPercent(undefined)).toBeNull();
    expect(resolveContextPercent({ percent: 42.5 })).toBe(42.5);
    expect(resolveContextPercent({ used: 0, size: 1048576 })).toBe(0);
    const pct = resolveContextPercent({ used: 524288, size: 1048576 });
    expect(pct).toBeCloseTo(50, 5);
  });

  it("distinguishes recovered intermediate failures from unresolved failures and merges turnGit stats", () => {
    const recoveredTurn: AgentMessage[] = [
      makeMessage({ id: "u1", role: "user", text: "跑测", createdAt: 1000 }),
      makeMessage({
        id: "t1",
        kind: "toolCall",
        toolName: "bash",
        arguments: { command: "pnpm test" },
        status: "error",
        isError: true,
        createdAt: 1200,
      }),
      makeMessage({
        id: "t2",
        kind: "toolCall",
        toolName: "replace_file_content",
        arguments: {
          TargetFile: "/d:/repo/src/a.ts",
          TargetContent: "x",
          ReplacementContent: "y\nz",
        },
        status: "completed",
        createdAt: 1500,
      }),
      makeMessage({
        id: "t3",
        kind: "toolCall",
        toolName: "bash",
        arguments: { command: "pnpm test" },
        status: "completed",
        createdAt: 2200,
      }),
      makeMessage({ id: "a1", role: "assistant", text: "已修复通过", createdAt: 2500 }),
    ];
    const blocks = buildTranscriptBlocks(recoveredTurn, false, "d:/repo", {
      turnId: "turn-1",
      worktreeRoot: "d:/repo",
      branch: "main",
      baseHeadOid: "abc",
      headOid: "abc",
      newCommits: 0,
      dirtyBefore: 0,
      dirtyAfter: 2,
      changedFiles: [
        { path: "src/a.ts", status: " M", staged: false, untracked: false, additions: 4, deletions: 1 },
        { path: "src/generated.txt", status: "??", staged: false, untracked: true, additions: 10, deletions: 0 },
      ],
    });
    const proc = blocks[1];
    expect(proc.kind).toBe("process");
    if (proc.kind === "process") {
      expect(proc.statusTitle).toBe("已完成（已恢复）");
      expect(proc.fileChanges).toHaveLength(2);
      expect(proc.fileChanges[0]).toMatchObject({ path: "d:/repo/src/a.ts", adds: 4, dels: 1 });
      expect(proc.fileChanges[1]).toMatchObject({ path: "d:/repo/src/generated.txt", adds: 10, dels: 0, operation: "新增" });
    }
  });
});
