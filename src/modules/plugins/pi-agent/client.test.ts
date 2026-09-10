import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiEventEnvelope } from "./types";

const mock = vi.hoisted(() => ({
  receive: (_event: PiEventEnvelope) => {},
  next: 0,
  stop: vi.fn(),
  close: vi.fn(),
  rejectPrompt: false,
}));
vi.mock("./native", () => ({
  listenPiEvents: vi.fn(async (receive) => {
    mock.receive = receive;
    return mock.stop;
  }),
  startPiAgent: vi.fn(async () => ({ sessionId: ++mock.next, processId: 1 })),
  closePiAgent: (...args: unknown[]) => {
    mock.close(...args);
    return Promise.resolve(true);
  },
  sendPiCommand: vi.fn(async (runtimeId, command) => {
    queueMicrotask(() =>
      mock.receive({
        sessionId: runtimeId,
        stream: "stdout",
        event: {
          type: "response",
          command: command.type,
          id: command.id,
          success: command.type !== "prompt" || !mock.rejectPrompt,
          error: "prompt rejected",
          data:
            command.type === "get_messages"
              ? { messages: [] }
              : command.type === "get_state"
                ? { sessionFile: `session-${runtimeId}.jsonl` }
                : {},
        },
      }),
    );
  }),
}));
import { PiWorkspaceClient } from "./client";

describe("Pi RPC workspace", () => {
  beforeEach(() => {
    mock.next = 0;
    mock.close.mockClear();
    mock.stop.mockClear();
    mock.rejectPrompt = false;
  });
  it("isolates simultaneous threads and never closes one when opening another", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const [one, same] = await Promise.all([
      client.open("one", "D:/one"),
      client.open("one", "D:/one"),
    ]);
    expect(same.runtimeId).toBe(one.runtimeId);
    const two = await client.open("two", "D:/two");
    mock.receive({
      sessionId: one.runtimeId!,
      stream: "stdout",
      event: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "only first",
        },
      },
    });
    expect(one.view.items).toHaveLength(1);
    expect(two.view.items).toHaveLength(0);
    expect(mock.close).not.toHaveBeenCalled();
    client.dispose();
    await Promise.resolve();
    expect(mock.close).toHaveBeenCalledTimes(2);
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
  it("reports rejected commands instead of accepting a failed prompt", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const one = await client.open("one", "D:/one");
    mock.rejectPrompt = true;
    await expect(
      client.request(one, { type: "prompt", message: "test" }),
    ).rejects.toThrow("prompt rejected");
    expect(one.view.error).toBe("prompt rejected");
    client.dispose();
  });
});
