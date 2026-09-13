import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiEventEnvelope } from "./types";

const mock = vi.hoisted(() => ({
  receive: (_event: PiEventEnvelope) => {},
  next: 0,
  stop: vi.fn(),
  close: vi.fn(),
  closeAll: vi.fn(),
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
  closeAllPiAgents: (...args: unknown[]) => {
    mock.closeAll(...args);
    return Promise.resolve(0);
  },
  listPiModels: vi.fn(async () => [
    { provider: "openai", id: "gpt-test", name: "Test" },
  ]),
  readPiSession: vi.fn(async (path: string, before?: number | null) => ({
    messages: before
      ? [{ id: "older", role: "user", content: "older history" }]
      : [{ id: "latest", role: "user", content: "disk history" }],
    model: { provider: "openai", id: "gpt-history", name: "History" },
    thinkingLevel: "high",
    sessionName: "Disk",
    sessionFile: path,
    oldestOffset: before ? 10 : 80,
    hasMore: !before,
  })),
  clonePiSession: vi.fn(async (path: string) => ({
    path: `${path}.fork.jsonl`,
    id: "fork-1",
    name: null,
  })),
  appendPiSession: vi.fn(async () => undefined),
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
                            {
                              provider: "openai",
                              id: "gpt-test",
                              name: "Test",
                            },
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
  // 延迟压缩期间不发送图片队列，完成后顺序投递且不重载原聊天。
  it("buffers compaction inputs with images and flushes after success without reloading history", async () => {
    const native = await import("./native");
    const original = vi.mocked(native.sendPiCommand).getMockImplementation()!;
    let release!: () => void;
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("compact", "D:/one", "history.jsonl");
      await client.hydrateFromDisk(thread);
      await client.request(thread, { type: "get_state" });
      const items = thread.view.items;
      vi.mocked(native.sendPiCommand).mockClear();
      vi.mocked(native.sendPiCommand).mockImplementation(
        async (id, command) => {
          if (command.type === "compact")
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return original(id, command);
        },
      );
      const operation = client.compact(thread);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(thread.view.compaction?.status).toBe("running");
      const images = [
        { type: "image" as const, data: "image-data", mimeType: "image/png" },
      ];
      client.enqueue(thread, "one", images, "followUp");
      client.enqueue(thread, "two", [], "steer");
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) => cmd.type === "prompt"),
      ).toBe(false);
      release();
      await operation;
      const prompts = vi
        .mocked(native.sendPiCommand)
        .mock.calls.filter(([, cmd]) => cmd.type === "prompt");
      expect(prompts.map(([, cmd]) => cmd.message)).toEqual(["one", "two"]);
      expect(prompts[0][1].images).toEqual(images);
      expect(prompts[1][1].streamingBehavior).toBe("steer");
      expect(thread.view.localQueue).toEqual([]);
      expect(thread.view.compaction?.status).toBe("done");
      expect(thread.view.items).toBe(items);
      client.beginPrompt(thread, "下一轮");
      await client.request(thread, { type: "prompt", message: "下一轮" });
      expect(thread.view.compaction).toBeUndefined();
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) => cmd.type === "get_messages"),
      ).toBe(false);
    } finally {
      release?.();
      vi.mocked(native.sendPiCommand).mockImplementation(original);
      client.dispose();
    }
  });
  // 压缩失败不消耗缓存，退回编辑可完整获取附件。
  it("retains local inputs after failed compaction", async () => {
    const native = await import("./native");
    const original = vi.mocked(native.sendPiCommand).getMockImplementation()!;
    let fail!: (error: Error) => void;
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("failed", "D:/one", "history.jsonl");
      await client.hydrateFromDisk(thread);
      await client.request(thread, { type: "get_state" });
      vi.mocked(native.sendPiCommand).mockImplementation(
        async (id, command) => {
          if (command.type === "compact")
            return new Promise((_, reject) => {
              fail = reject;
            });
          return original(id, command);
        },
      );
      const operation = client.compact(thread);
      const rejected = expect(operation).rejects.toThrow("compact failed");
      await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
      client.enqueue(
        thread,
        "keep",
        [{ type: "image", data: "png", mimeType: "image/png" }],
        "followUp",
      );
      fail(new Error("compact failed"));
      await rejected;
      expect(thread.view.compaction?.status).toBe("failed");
      expect(thread.view.localQueue).toHaveLength(1);
      expect(
        client.removeQueued(thread, thread.view.localQueue![0].id)?.images,
      ).toHaveLength(1);
      expect(thread.view.localQueue).toEqual([]);
    } finally {
      vi.mocked(native.sendPiCommand).mockImplementation(original);
      client.dispose();
    }
  });
  // 新旧自动压缩事件都维持可见状态，发送失败不移除待发送消息。
  it.each(["compaction", "auto_compaction"])(
    "handles %s events and retains a rejected queued prompt",
    async (prefix) => {
      const client = new PiWorkspaceClient(vi.fn(), vi.fn());
      try {
        const thread = await client.open(prefix, "D:/one");
        await client.request(thread, { type: "get_state" });
        mock.receive({
          sessionId: thread.runtimeId!,
          stream: "stdout",
          event: { type: `${prefix}_start` },
        });
        expect(thread.view.compaction?.status).toBe("running");
        client.enqueue(thread, "keep", [], "followUp");
        mock.rejectPrompt = true;
        mock.receive({
          sessionId: thread.runtimeId!,
          stream: "stdout",
          event: {
            type: `${prefix}_end`,
            result: {},
            aborted: false,
            willRetry: false,
          },
        });
        await vi.waitFor(() =>
          expect(thread.view.error).toContain("prompt rejected"),
        );
        expect(thread.view.compaction?.status).toBe("done");
        expect(thread.view.localQueue).toHaveLength(1);
        expect(thread.view.queueSendingId).toBeUndefined();
      } finally {
        client.dispose();
      }
    },
  );
  // runtime 冷启动未完成时也能获取缓存线程并立即进入发送状态。
  it("returns cached history immediately while the runtime is starting", async () => {
    const native = await import("./native");
    let release!: () => void;
    vi.mocked(native.startPiAgent).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { sessionId: ++mock.next, processId: 1 };
    });
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open(
        "history",
        "D:/project",
        "history.jsonl",
      );
      await client.hydrateFromDisk(thread);
      const loading = client.loadCommands(thread);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const cached = await client.open("history", "D:/project");
      client.beginPrompt(cached, "继续");
      expect(cached).toBe(thread);
      expect(thread.view.status).toBe("running");
      expect(thread.view.processStartedAt).toBeTypeOf("number");
      release();
      await loading;
      expect(thread.view.status).toBe("running");
    } finally {
      release?.();
      client.dispose();
    }
  });
  // 首次展开 slash 菜单启动命令读取，已有命令后重复展开不重复请求。
  it("loads native commands before any prompt and reuses the command cache", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("commands", "D:/project");
      vi.mocked(native.sendPiCommand).mockClear();
      await client.loadCommands(thread);
      expect(native.sendPiCommand).toHaveBeenCalledWith(
        thread.runtimeId,
        expect.objectContaining({ type: "get_commands" }),
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, command]) => command.type === "prompt"),
      ).toBe(false);
      thread.view = { ...thread.view, commands: [{ name: "skill:review" }] };
      vi.mocked(native.sendPiCommand).mockClear();
      await client.loadCommands(thread);
      expect(native.sendPiCommand).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
  beforeEach(() => {
    mock.next = 0;
    mock.close.mockClear();
    mock.closeAll.mockClear();
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
    expect(mock.closeAll).toHaveBeenCalledTimes(1);
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
  it("exposes a running process as soon as beginPrompt is called", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one");
    client.beginPrompt(thread, "立刻显示状态\n");
    expect(thread.view.status).toBe("running");
    expect(thread.view.items[0]).toMatchObject({
      role: "user",
      text: "立刻显示状态",
    });
    client.dispose();
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
    vi.mocked(native.listPiModels).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("new", "D:/config");
    expect(thread.runtimeId).toBeNull();
    await client.loadModels(thread);
    expect(thread.view.models).toEqual([
      { provider: "openai", id: "gpt-test", name: "Test" },
    ]);
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(native.listPiModels).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("reloads catalog names from models.json without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    vi.mocked(native.listPiModels).mockClear();
    vi.mocked(native.listPiModels)
      .mockResolvedValueOnce([
        {
          provider: "cp-lite",
          id: "grok-4.6-PSYDO_GROK_SUPER",
        },
      ])
      .mockResolvedValueOnce([
        {
          provider: "cp-lite",
          id: "grok-4.6-PSYDO_GROK_SUPER",
          name: "grok-4.6",
          contextWindow: 500000,
        },
      ]);
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("new", "D:/one");
    await client.loadModels(thread);
    expect(thread.view.model).toMatchObject({
      id: "grok-4.6-PSYDO_GROK_SUPER",
    });
    expect(thread.view.model?.name).toBeUndefined();
    await client.reloadCatalog();
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(native.listPiModels).toHaveBeenCalledTimes(2);
    expect(thread.view.model).toMatchObject({
      id: "grok-4.6-PSYDO_GROK_SUPER",
      name: "grok-4.6",
      contextWindow: 500000,
    });
    client.dispose();
  });
  it("fills idle history context percent from catalog window without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    vi.mocked(native.listPiModels).mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-history",
        name: "History",
        contextWindow: 500000,
      },
    ]);
    vi.mocked(native.readPiSession).mockResolvedValueOnce({
      messages: [{ id: "latest", role: "user", content: "disk history" }],
      model: { provider: "openai", id: "gpt-history", name: "History" },
      thinkingLevel: "high",
      sessionName: "Disk",
      sessionFile: "history.jsonl",
      oldestOffset: 80,
      hasMore: true,
      contextTokens: 27502,
      contextPercent: null,
    });
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("history", "D:/one", "history.jsonl");
    await client.hydrateFromDisk(thread);
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(thread.runtimeId).toBeNull();
    expect(thread.view.contextTokens).toBe(27502);
    expect(thread.view.model).toMatchObject({
      id: "gpt-history",
      contextWindow: 500000,
    });
    expect(thread.view.contextPercent).toBeCloseTo(5.5004, 3);
    client.dispose();
  });
  it("fills idle history percent when JSONL provider does not match catalog", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    vi.mocked(native.listPiModels).mockResolvedValueOnce([
      {
        provider: "cp-lite",
        id: "grok-4.6-PSYDO_GROK_SUPER",
        contextWindow: 500000,
      },
    ]);
    vi.mocked(native.readPiSession).mockResolvedValueOnce({
      messages: [{ id: "latest", role: "user", content: "disk history" }],
      model: {
        provider: "provider",
        id: "grok-4.6-PSYDO_GROK_SUPER",
      },
      thinkingLevel: "high",
      sessionName: "iris-dataset-analysis",
      sessionFile: "history.jsonl",
      oldestOffset: 80,
      hasMore: false,
      contextTokens: 30501,
      contextPercent: null,
    });
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("history", "D:/one", "history.jsonl");
    await client.hydrateFromDisk(thread);
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(thread.view.model).toMatchObject({
      provider: "provider",
      id: "grok-4.6-PSYDO_GROK_SUPER",
      contextWindow: 500000,
    });
    expect(thread.view.contextPercent).toBeCloseTo(6.1002, 3);
    client.dispose();
  });
  it("hydrates history from disk without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("history", "D:/one", "history.jsonl");
    await client.hydrateFromDisk(thread);
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(thread.runtimeId).toBeNull();
    expect(thread.view.items[0]).toMatchObject({
      role: "user",
      text: "disk history",
    });
    expect(thread.view.model).toMatchObject({ id: "gpt-history" });
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
  // 验证回收后发送全程保留消息、运行状态与计时，不触发历史遮罩。
  it("keeps cached messages visible while restarting a runtime to send", async () => {
    const native = await import("./native");
    const changed = vi.fn();
    const client = new PiWorkspaceClient(changed, vi.fn());
    try {
      const thread = await client.open("history", "D:/one/", "history.jsonl");
      await client.hydrateFromDisk(thread);
      await client.request(thread, { type: "get_state" });
      await client.close(thread.key);
      const previousRuntime = mock.next;
      client.beginPrompt(thread, "继续处理");
      const items = thread.view.items;
      const startedAt = thread.view.processStartedAt;
      changed.mockImplementation(() => {
        expect(thread.loadingHistory).toBe(false);
        expect(thread.view.status).toBe("running");
        expect(thread.view.items).toBe(items);
        expect(thread.view.processStartedAt).toBe(startedAt);
      });
      vi.mocked(native.sendPiCommand).mockClear();
      await client.request(thread, { type: "prompt", message: "继续处理" });
      expect(thread.runtimeId).toBeGreaterThan(previousRuntime);
      expect(native.sendPiCommand).toHaveBeenLastCalledWith(
        thread.runtimeId,
        expect.objectContaining({ type: "prompt", message: "继续处理" }),
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, command]) => command.type === "get_messages"),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
  // 验证单条队列操作只影响目标，其他消息继续按原模式入队。
  it.each(["edit", "delete", "steer"] as const)(
    "updates one queued message: %s",
    async (action) => {
      const native = await import("./native");
      const client = new PiWorkspaceClient(vi.fn(), vi.fn());
      try {
        const thread = await client.open("queue", "D:/one");
        await client.request(thread, { type: "get_state" });
        vi.mocked(native.sendPiCommand).mockClear();
        const restore = vi.fn();
        await client.updateQueuedMessage(
          thread,
          "followUp",
          0,
          "后续任务",
          action,
          restore,
        );
        const commands = vi
          .mocked(native.sendPiCommand)
          .mock.calls.map(([, command]) => ({
            type: command.type,
            message: command.message,
          }));
        expect(commands).toEqual([
          { type: "clear_queue", message: undefined },
          ...(action === "steer"
            ? [{ type: "steer", message: "后续任务" }]
            : []),
          { type: "steer", message: "排队指令" },
        ]);
        if (action === "edit")
          expect(restore).toHaveBeenCalledWith(["后续任务"]);
        else expect(restore).not.toHaveBeenCalled();
      } finally {
        client.dispose();
      }
    },
  );
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
  it("forks by copying the session file without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one", "source.jsonl");
    await client.hydrateFromDisk(thread);
    const result = await client.branch(thread, "Demo · 分叉 1");
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(native.clonePiSession).toHaveBeenCalledWith("source.jsonl");
    expect(native.appendPiSession).toHaveBeenCalledWith({
      path: "source.jsonl.fork.jsonl",
      kind: "session_info",
      name: "Demo · 分叉 1",
    });
    expect(result.thread.key).toBe("source.jsonl.fork.jsonl");
    expect(client.threads.get("source")?.runtimeId).toBeNull();
    expect(result.thread.runtimeId).toBeNull();
    client.dispose();
  });
  it("changes model and thinking without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("history", "D:/one", "history.jsonl");
    await client.hydrateFromDisk(thread);
    await client.setModel(thread, "openai", "gpt-new", "New");
    await client.setThinkingLevel(thread, "low");
    await client.rename(thread, "Renamed");
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(native.appendPiSession).toHaveBeenCalledWith({
      path: "history.jsonl",
      kind: "model_change",
      provider: "openai",
      modelId: "gpt-new",
    });
    expect(native.appendPiSession).toHaveBeenCalledWith({
      path: "history.jsonl",
      kind: "thinking_level_change",
      thinkingLevel: "low",
    });
    expect(native.appendPiSession).toHaveBeenCalledWith({
      path: "history.jsonl",
      kind: "session_info",
      name: "Renamed",
    });
    expect(thread.view.model).toMatchObject({ id: "gpt-new" });
    expect(thread.view.thinkingLevel).toBe("low");
    expect(thread.view.sessionName).toBe("Renamed");
    client.dispose();
  });
  it("loads older history pages without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("history", "D:/one", "history.jsonl");
    await client.hydrateFromDisk(thread);
    expect(thread.view.items).toHaveLength(1);
    await client.loadOlderHistory(thread);
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(native.readPiSession).toHaveBeenLastCalledWith("history.jsonl", 80);
    expect(thread.view.items[0]).toMatchObject({ text: "older history" });
    expect(thread.view.items[thread.view.items.length - 1]).toMatchObject({
      text: "disk history",
    });
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
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.map(([, command]) => command.type),
    ).toEqual([
      "get_fork_messages",
      "fork",
      "get_messages",
      "get_state",
      "get_session_stats",
      "prompt",
    ]);
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.find(([, command]) => command.type === "fork")?.[1],
    ).toMatchObject({ type: "fork", entryId: "entry-last" });
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.find(([, command]) => command.type === "prompt")?.[1],
    ).toMatchObject({ type: "prompt", message: "修改后的输入" });
    client.dispose();
  });
});
