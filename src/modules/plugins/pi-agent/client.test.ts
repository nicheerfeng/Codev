import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiEventEnvelope } from "./types";

const mock = vi.hoisted(() => ({
  receive: (_event: PiEventEnvelope) => {},
  next: 0,
  stop: vi.fn(),
  close: vi.fn(),
  rejectPrompt: false,
  cancelBranch: false,
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
            command.type === "clear_queue"
              ? { steering: ["排队指令"], followUp: ["后续任务"] }
              : command.type === "fork" || command.type === "clone"
                ? {
                    cancelled: mock.cancelBranch,
                    text: command.type === "fork" ? "原始输入" : "",
                  }
                : command.type === "get_fork_messages"
                  ? { messages: [{ entryId: "entry-last", text: "原始输入" }] }
                : command.type === "get_messages"
                  ? { messages: [] }
                  : command.type === "get_available_models"
                    ? {
                        models: [
                          { provider: "openai", id: "gpt-test", name: "Test" },
                        ],
                      }
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
    mock.cancelBranch = false;
  });
  it("isolates simultaneous threads and never closes one when opening another", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const [one, same] = await Promise.all([
      client.open("one", "D:/one"),
      client.open("one", "D:/one"),
    ]);
    expect(one.runtimeId).toBeNull();
    await client.request(one, { type: "get_state" });
    expect(same.runtimeId).toBe(one.runtimeId);
    const two = await client.open("two", "D:/two");
    await client.request(two, { type: "get_state" });
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
  it("passes the selected streaming behavior to the native prompt RPC", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one");
    await client.request(thread, { type: "get_state" });
    mock.receive({
      sessionId: thread.runtimeId!,
      stream: "stdout",
      event: { type: "agent_start" },
    });
    const native = await import("./native");
    vi.mocked(native.sendPiCommand).mockClear();
    await client.request(thread, {
      type: "prompt",
      message: "排队消息",
      streamingBehavior: "followUp",
    });
    expect(
      vi.mocked(native.sendPiCommand).mock.calls[
        vi.mocked(native.sendPiCommand).mock.calls.length - 1
      ]?.[1],
    ).toMatchObject({
      type: "prompt",
      message: "排队消息",
      streamingBehavior: "followUp",
    });
    client.dispose();
  });
  it("starts model checks in an explicitly ephemeral test mode", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn(), true);
    await client.open("test", "D:/config");
    await client.request(client.threads.get("test")!, { type: "get_state" });
    expect(native.startPiAgent).toHaveBeenLastCalledWith(
      "D:/config",
      undefined,
      true,
    );
    client.dispose();
  });
  it("loads models when a lazy new thread opens its model picker", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("new", "D:/config");
    expect(thread.runtimeId).toBeNull();
    await client.loadModels(thread);
    expect(thread.view.models).toEqual([
      { provider: "openai", id: "gpt-test", name: "Test" },
    ]);
    expect(native.startPiAgent).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("keeps history loading visible until messages return after get_state", async () => {
    const native = await import("./native");
    let release: (() => void) | undefined;
    const original = vi.mocked(native.sendPiCommand).getMockImplementation()!;
    vi.mocked(native.sendPiCommand).mockImplementation(async (id, command) => {
      if (command.type === "get_messages") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(id, command);
    });
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const opening = client.open("history", "D:/one", "history.jsonl");
    const history = await opening;
    const loading = client.request(history, { type: "get_state" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(client.threads.get("history")?.loadingHistory).toBe(true);
    release?.();
    await loading;
    const thread = await opening;
    expect(thread.loadingHistory).toBe(false);
    client.dispose();
    vi.mocked(native.sendPiCommand).mockImplementation(original);
  });
  it("restores queue before abort and leaves other threads untouched", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one");
    const two = await client.open("two", "D:/two");
    await client.request(thread, { type: "get_state" });
    await client.request(two, { type: "get_state" });
    vi.mocked(native.sendPiCommand).mockClear();
    const restored: string[][] = [];
    await client.stopAndRestore(thread, (texts) => {
      restored.push(texts);
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) => cmd.type === "abort"),
      ).toBe(false);
    });
    expect(restored).toEqual([["排队指令", "后续任务"]]);
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.every(([id]) => id === thread.runtimeId),
    ).toBe(true);
    expect(two.view.status).toBe("idle");
    client.dispose();
  });
  it("forks into an independent UI key without overwriting the original transcript", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one");
    await client.request(thread, { type: "get_state" });
    mock.receive({
      sessionId: thread.runtimeId!,
      stream: "stdout",
      event: {
        type: "message_end",
        message: { role: "user", content: "source text" },
      },
    });
    const result = await client.branch(thread);
    expect(result?.text).toBe("");
    expect(result?.thread.key).not.toBe("source");
    expect(client.threads.get("source")?.view.items[0]).toMatchObject({
      text: "source text",
    });
    expect(client.threads.get("source")?.runtimeId).toBeNull();
    mock.receive({
      sessionId: thread.runtimeId!,
      stream: "stdout",
      event: {
        type: "message_end",
        message: { role: "user", content: "new text" },
      },
    });
    expect(client.threads.get("source")?.view.items).toHaveLength(1);
    expect(result?.thread.view.items[0]).toMatchObject({ text: "new text" });
    client.dispose();
  });
  it("leaves the current thread intact when an extension cancels clone", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one");
    await client.request(thread, { type: "get_state" });
    mock.cancelBranch = true;
    expect(await client.branch(thread)).toBeNull();
    expect(thread.key).toBe("source");
    expect(client.threads.size).toBe(1);
    client.dispose();
  });
  it("forks before the last user message and resends the edited text", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one");
    await client.request(thread, { type: "get_state" });
    vi.mocked(native.sendPiCommand).mockClear();
    await expect(client.editLastUser(thread, "修改后的输入")).resolves.toBe(
      true,
    );
    expect(
      vi.mocked(native.sendPiCommand).mock.calls.map(([, command]) => command.type),
    ).toEqual(["get_fork_messages", "fork", "get_messages", "get_state", "get_session_stats", "prompt"]);
    expect(
      vi.mocked(native.sendPiCommand).mock.calls.find(([, command]) => command.type === "fork")?.[1],
    ).toMatchObject({ type: "fork", entryId: "entry-last" });
    expect(
      vi.mocked(native.sendPiCommand).mock.calls.find(([, command]) => command.type === "prompt")?.[1],
    ).toMatchObject({ type: "prompt", message: "修改后的输入" });
    client.dispose();
  });
});
