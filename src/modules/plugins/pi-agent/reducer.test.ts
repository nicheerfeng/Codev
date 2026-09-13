import { describe, expect, it, vi } from "vitest";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "./reducer";
import type { PiEventEnvelope } from "./types";

/** 构造单元测试使用的 stdout RPC 事件。 */
function rpc(event: Record<string, unknown>): PiEventEnvelope {
  return { sessionId: 1, stream: "stdout", event };
}

describe("piViewReducer", () => {
  it("preserves native timestamps on both input and assistant text blocks", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", timestamp: 1700000000000, content: "input" },
            {
              role: "assistant",
              timestamp: 1700000001000,
              content: [
                { type: "thinking", thinking: "plan" },
                { type: "text", text: "answer" },
              ],
            },
          ],
        },
      }),
    });
    expect(state.items[0]).toMatchObject({ timestamp: 1700000000000 });
    expect(state.items[2]).toMatchObject({
      timestamp: 1700000001000,
      text: "answer",
    });
  });

  it("preserves the assistant stop reason for natural edit eligibility", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "完成" }],
            },
          ],
        },
      }),
    });
    expect(state.items[0]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  it("hydrates ISO record times for thinking, tool calls, and tool results", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              timestamp: "2026-09-11T10:00:00.000Z",
              message: {
                role: "assistant",
                timestamp: "2026-09-11T10:00:01.000Z",
                content: [
                  { type: "thinking", thinking: "plan" },
                  {
                    type: "toolCall",
                    id: "read-1",
                    name: "read",
                    arguments: { path: "a.ts" },
                  },
                ],
              },
            },
            {
              timestamp: "2026-09-11T10:00:03.000Z",
              message: {
                role: "toolResult",
                toolCallId: "read-1",
                toolName: "read",
                content: [{ type: "text", text: "ok" }],
              },
            },
          ],
        },
      }),
    });
    expect(state.items[0]).toMatchObject({ timestamp: 1789120801000 });
    expect(state.items[1]).toMatchObject({ startedAt: 1789120801000 });
    expect(state.items[1]).toMatchObject({ finishedAt: 1789120803000 });
  });
  it("preserves interleaved thinking, text and tools across hydration", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "plan" },
                { type: "text", text: "read first" },
                {
                  type: "toolCall",
                  id: "read-1",
                  name: "read",
                  arguments: { path: "a.ts" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "read-1",
              toolName: "read",
              content: [{ type: "text", text: "file contents" }],
            },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
          ],
        },
      }),
    });
    expect(state.items.map((item) => item.kind)).toEqual([
      "thinking",
      "message",
      "tool",
      "message",
    ]);
    expect(state.items[2]).toMatchObject({
      args: { path: "a.ts" },
      output: "file contents",
      status: "done",
    });
  });

  it("keeps repeated valid deltas and distinct content indexes", () => {
    let state = INITIAL_PI_VIEW_STATE;
    for (const [contentIndex, type, delta] of [
      [0, "thinking_delta", "plan"],
      [1, "text_delta", "ha"],
      [1, "text_delta", "ha"],
    ] as const) {
      state = piViewReducer(state, {
        type: "event",
        payload: rpc({
          type: "message_update",
          assistantMessageEvent: { contentIndex, type, delta },
        }),
      });
    }
    expect(state.items.map((item) => item.kind)).toEqual([
      "thinking",
      "message",
    ]);
    expect(state.items[1]).toMatchObject({ text: "haha" });
  });

  it("waits for settled instead of ending during intermediate agent_end retry", () => {
    let state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({ type: "agent_start" }),
    });
    state = piViewReducer(state, {
      type: "event",
      payload: rpc({ type: "agent_end" }),
    });
    expect(state.status).toBe("running");
    state = piViewReducer(state, {
      type: "event",
      payload: rpc({ type: "agent_settled" }),
    });
    expect(state.status).toBe("idle");
  });

  it("shows native steering and follow-up queues", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "queue_update",
        steering: ["先修复这个"],
        followUp: ["完成后总结", "完成后测试"],
      }),
    });
    expect(state.queue).toEqual({
      steering: ["先修复这个"],
      followUp: ["完成后总结", "完成后测试"],
      pendingCount: 3,
    });
  });

  it("marks a prompt as running before agent_start and keeps trailing blanks off user text", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "prompt",
      text: "先修复拖拽\n\n",
    });
    expect(state.status).toBe("running");
    expect(state.processStartedAt).toEqual(expect.any(Number));
    expect(state.items[0]).toMatchObject({
      role: "user",
      text: "先修复拖拽",
    });
    const started = piViewReducer(state, {
      type: "event",
      payload: rpc({ type: "agent_start" }),
    });
    expect(started.processStartedAt).toBe(state.processStartedAt);
    const hydrated = piViewReducer(started, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_state",
        success: true,
        data: { isStreaming: false },
      }),
    });
    expect(hydrated.status).toBe("running");
  });

  it("resets process timing for a new turn and keeps the previous turn timestamps", () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "prompt",
      text: "第一轮",
    });
    expect(first.processStartedAt).toBe(1_000);
    now = 4_000;
    const settled = piViewReducer(first, {
      type: "event",
      payload: rpc({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "完成" }],
        },
      }),
    });
    const done = piViewReducer(settled, {
      type: "event",
      payload: rpc({ type: "agent_settled" }),
    });
    expect(done.processFinishedAt).toBe(4_000);
    expect(done.items[0]).toMatchObject({ timestamp: 1_000 });
    expect(done.items[1]).toMatchObject({ timestamp: 4_000 });
    now = 9_000;
    const next = piViewReducer(done, { type: "prompt", text: "第二轮" });
    expect(next.processStartedAt).toBe(9_000);
    expect(next.processFinishedAt).toBeUndefined();
    expect(next.items[0]).toMatchObject({ timestamp: 1_000 });
    expect(next.items[1]).toMatchObject({ timestamp: 4_000 });
    clock.mockRestore();
  });

  it("hydrates the native pending queue count from get_state", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_state",
        success: true,
        data: { isStreaming: true, pendingMessageCount: 2 },
      }),
    });
    expect(state.queue.pendingCount).toBe(2);
  });
  it("streams assistant text without selecting editor content", () => {
    const running = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({ type: "agent_start" }),
    });
    const next = piViewReducer(running, {
      type: "event",
      payload: rpc({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "你好" },
      }),
    });
    expect(next.status).toBe("running");
    expect(next.items[0]).toMatchObject({ role: "assistant", text: "你好" });
  });

  it("replaces the streaming draft with the final assistant message", () => {
    const streaming = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      }),
    });
    const next = piViewReducer(streaming, {
      type: "event",
      payload: rpc({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
        },
      }),
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ text: "final", streaming: false });
  });

  it("tracks tool execution by tool call id", () => {
    const started = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
      }),
    });
    const ended = piViewReducer(started, {
      type: "event",
      payload: rpc({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    });
    expect(ended.items).toHaveLength(1);
    expect(ended.items[0]).toMatchObject({
      toolCallId: "call-1",
      status: "done",
    });
  });

  it("hydrates messages and runtime state from command responses", () => {
    const hydrated = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "hello" }] },
      }),
    });
    const state = piViewReducer(hydrated, {
      type: "event",
      payload: rpc({
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionFile: "session.jsonl",
          thinkingLevel: "high",
          model: { provider: "openai", id: "gpt" },
        },
      }),
    });
    expect(state.items[0]).toMatchObject({ role: "user", text: "hello" });
    expect(state.sessionFile).toBe("session.jsonl");
    expect(state.thinkingLevel).toBe("high");
  });

  it("prepends older history pages without replacing the latest messages", () => {
    const latest = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "history",
      messages: [{ id: "u2", role: "user", content: "latest" }],
      offset: 80,
      hasMore: true,
    });
    const older = piViewReducer(latest, {
      type: "history",
      prepend: true,
      messages: [{ id: "u1", role: "user", content: "older" }],
      offset: 10,
      hasMore: false,
    });
    expect(
      older.items.map((item) =>
        item.kind === "message" || item.kind === "thinking" ? item.text : "",
      ),
    ).toEqual(["older", "latest"]);
    expect(older.historyOffset).toBe(10);
    expect(older.historyHasMore).toBe(false);
  });
});
