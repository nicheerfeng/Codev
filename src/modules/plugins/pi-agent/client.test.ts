import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiEventEnvelope, PiModel } from "./types";

const mock = vi.hoisted(() => ({
  receive: (_event: PiEventEnvelope) => {},
  next: 0,
  sessionFiles: new Map<number, string>(),
  stop: vi.fn(),
  close: vi.fn(),
  closeAll: vi.fn(),
  rejectPrompt: false,
  forkText: "原始输入",
  cancelBranch: false,
  rejectModel: false,
  rejectThinking: false,
  availableModels: [
    { provider: "openai", id: "gpt-test", name: "Test" },
  ] as PiModel[],
  runtimeModels: new Map<number, PiModel>(),
}));
vi.mock("./native", () => ({
  listenPiEvents: vi.fn(async (receive) => {
    mock.receive = receive;
    return mock.stop;
  }),
  startPiAgent: vi.fn(async (_cwd: string, path?: string) => {
    const sessionId = ++mock.next;
    mock.sessionFiles.set(sessionId, path ?? `session-${sessionId}.jsonl`);
    if (mock.availableModels[0])
      mock.runtimeModels.set(sessionId, mock.availableModels[0]);
    return { sessionId, processId: 1 };
  }),
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
    model: { provider: "openai", id: "gpt-test", name: "History" },
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
  truncatePiSession: vi.fn(async () => undefined),
  sendPiCommand: vi.fn(async (runtimeId, command) => {
    const selected = mock.availableModels.find(
      (model) =>
        model.provider === command.provider && model.id === command.modelId,
    );
    const success =
      command.type === "prompt"
        ? !mock.rejectPrompt
        : command.type === "set_model"
          ? !mock.rejectModel && !!selected
          : command.type === "set_thinking_level"
            ? !mock.rejectThinking
            : true;
    if (command.type === "set_model" && success && selected)
      mock.runtimeModels.set(runtimeId, selected);
    queueMicrotask(() =>
      mock.receive({
        sessionId: runtimeId,
        stream: "stdout",
        event: {
          type: "response",
          command: command.type,
          id: command.id,
          success,
          error:
            command.type === "set_model"
              ? "model rejected"
              : command.type === "set_thinking_level"
                ? "thinking rejected"
                : "prompt rejected",
          data:
            command.type === "set_model" && selected
              ? {
                  provider: selected.provider,
                  id: selected.id,
                  baseUrl: selected.baseUrl,
                }
              : command.type === "clear_queue"
                ? {
                    steering: [{ text: "排队指令", images: [] }],
                    followUp: [{ text: "后续任务", images: [] }],
                  }
                : command.type === "fork" || command.type === "clone"
                  ? {
                      cancelled: mock.cancelBranch,
                      text: command.type === "fork" ? "原始输入" : "",
                    }
                  : command.type === "get_fork_messages"
                    ? {
                        messages: [
                          { entryId: "entry-last", text: mock.forkText },
                        ],
                      }
                    : command.type === "get_messages"
                      ? { messages: [] }
                      : command.type === "get_available_models"
                        ? {
                            models: mock.availableModels.map(
                              ({ provider, id, name, baseUrl }) => ({
                                provider,
                                id,
                                name,
                                baseUrl,
                              }),
                            ),
                          }
                        : command.type === "get_state"
                          ? {
                              model: mock.runtimeModels.get(runtimeId),
                              sessionFile:
                                mock.sessionFiles.get(runtimeId) ??
                                `session-${runtimeId}.jsonl`,
                            }
                          : {},
        },
      }),
    );
  }),
}));
import { PiWorkspaceClient } from "./client";
import { DEFAULT_PI_THINKING_LEVELS, piViewReducer } from "./reducer";
import * as nativeMocks from "./native";
const defaultNative = {
  models: vi.mocked(nativeMocks.listPiModels).getMockImplementation()!,
  history: vi.mocked(nativeMocks.readPiSession).getMockImplementation()!,
  send: vi.mocked(nativeMocks.sendPiCommand).getMockImplementation()!,
  start: vi.mocked(nativeMocks.startPiAgent).getMockImplementation()!,
};

describe("Pi RPC workspace", () => {
  // 同一个 JSONL 的普通路径与 Windows 长路径必须复用同一内存线程。
  it("reuses one thread across Windows session path spellings", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const normal = await client.open(
        "normal-key",
        "D:/project",
        "C:/Users/test/session.jsonl",
      );
      const longPath = await client.open(
        "long-key",
        "D:/project",
        "\\\\?\\C:\\Users\\test\\session.jsonl",
      );
      expect(longPath).toBe(normal);
      expect(client.threads.size).toBe(1);
    } finally {
      client.dispose();
    }
  });
  // 冷历史的展示片段 ID 不可作为原生游标；直接恢复并压缩，保留历史。
  it("compacts cold history without using display IDs as entry cursors", async () => {
    const native = await import("./native");
    const original = vi.mocked(native.sendPiCommand).getMockImplementation()!;
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open(
        "cold-compact",
        "D:/one",
        "history.jsonl",
      );
      await client.hydrateFromDisk(thread);
      thread.view = piViewReducer(thread.view, {
        type: "history",
        messages: [
          {
            id: "e6d9f10d",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "分析" },
                { type: "text", text: "历史回答" },
              ],
            },
          },
        ],
        prepend: false,
        offset: 80,
        hasMore: true,
      });
      const items = thread.view.items;
      expect(items[items.length - 1]?.id).toBe("e6d9f10d:1");
      expect(thread.runtimeId).toBeNull();
      vi.mocked(native.sendPiCommand).mockClear();
      vi.mocked(native.sendPiCommand).mockImplementation(
        async (id, command) => {
          if (command.type === "get_entries")
            throw new Error(`Entry not found: ${command.since}`);
          return original(id, command);
        },
      );
      await client.compact(thread);
      expect(native.startPiAgent).toHaveBeenCalledWith(
        "D:/one",
        "history.jsonl",
        false,
      );
      expect(thread.view.compaction?.status).toBe("done");
      expect(thread.view.items).toBe(items);
      const commands = vi
        .mocked(native.sendPiCommand)
        .mock.calls.map(([, command]) => command.type);
      expect(commands).toContain("compact");
      expect(commands).not.toContain("get_entries");
      expect(commands).not.toContain("get_messages");
      expect(commands).not.toContain("prompt");
    } finally {
      vi.mocked(native.sendPiCommand).mockImplementation(original);
      client.dispose();
    }
  });
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
      const flushed = vi
        .mocked(native.sendPiCommand)
        .mock.calls.filter(([, cmd]) =>
          ["prompt", "steer", "follow_up"].includes(String(cmd.type)),
        );
      expect(flushed.map(([, cmd]) => [cmd.type, cmd.message])).toEqual([
        ["prompt", "one"],
      ]);
      expect(flushed[0][1].images).toEqual(images);
      expect(flushed[0][1].streamingBehavior).toBe("followUp");
      expect(thread.view.localQueue?.map((entry) => entry.text)).toEqual([
        "two",
      ]);
      expect(thread.view.compaction?.status).toBe("done");
      expect(thread.view.items).toBe(items);
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_settled" },
      });
      await vi.waitFor(() => expect(thread.view.localQueue).toEqual([]));
      expect(native.sendPiCommand).toHaveBeenCalledWith(
        thread.runtimeId,
        expect.objectContaining({
          type: "prompt",
          message: "two",
          streamingBehavior: "steer",
        }),
      );
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
      const queuedId = thread.view.localQueue![0].id;
      client.setQueuedBehavior(thread, queuedId, "steer");
      expect(thread.view.localQueue![0].behavior).toBe("steer");
      expect(client.removeQueued(thread, queuedId)?.images).toHaveLength(1);
      expect(thread.view.localQueue).toEqual([]);
    } finally {
      vi.mocked(native.sendPiCommand).mockImplementation(original);
      client.dispose();
    }
  });
  it("keeps running follow-ups in the local queue until the turn settles", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("queue-idle", "D:/one");
      await client.request(thread, { type: "get_state" });
      client.beginPrompt(thread, "进行中");
      const images = [
        { type: "image" as const, data: "png", mimeType: "image/png" },
      ];
      vi.mocked(native.sendPiCommand).mockClear();
      client.enqueue(thread, "随后看图", images, "followUp");
      await client.drainQueue(thread);
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) =>
            ["prompt", "steer", "follow_up"].includes(String(cmd.type)),
          ),
      ).toBe(false);
      expect(thread.view.localQueue).toHaveLength(1);
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_settled" },
      });
      await vi.waitFor(() => expect(thread.view.localQueue).toEqual([]));
      expect(native.sendPiCommand).toHaveBeenCalledWith(
        thread.runtimeId,
        expect.objectContaining({
          type: "prompt",
          message: "随后看图",
          images,
        }),
      );
    } finally {
      client.dispose();
    }
  });
  it("keeps a steered queue item visible until native consumption completes", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("steer-hold", "D:/one");
      await client.request(thread, { type: "get_state" });
      client.beginPrompt(thread, "进行中");
      const queuedId = client.enqueue(thread, "插入这句", [], "followUp");
      await client.sendQueued(thread, queuedId);
      expect(thread.view.localQueue?.map((item) => item.text)).toEqual([
        "插入这句",
      ]);
      expect(thread.view.queueSendingId).toBe(queuedId);
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: {
          type: "queue_update",
          steering: ["插入这句"],
          followUp: [],
        },
      });
      expect(thread.view.localQueue).toHaveLength(1);
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: {
          type: "queue_update",
          steering: [],
          followUp: [],
        },
      });
      expect(thread.view.localQueue).toEqual([]);
      expect(thread.view.queueSendingId).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
  it("does not submit the next queued prompt after the first acknowledgement or while stopping", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("stop-drain", "D:/one");
      await client.request(thread, { type: "get_state" });
      client.enqueue(thread, "first", [], "followUp");
      client.enqueue(thread, "second", [], "followUp");
      vi.mocked(native.sendPiCommand).mockClear();
      await client.drainQueue(thread);
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.filter(([, cmd]) => cmd.type === "prompt")
          .map(([, cmd]) => cmd.message),
      ).toEqual(["first"]);
      thread.view = { ...thread.view, status: "stopping" };
      await client.drainQueue(thread);
      expect(thread.view.localQueue?.map((item) => item.text)).toEqual([
        "second",
      ]);
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.filter(([, cmd]) => cmd.type === "prompt"),
      ).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });
  it("restores local queued images when stopping alongside the native queue", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("stop-images", "D:/one");
      await client.request(thread, { type: "get_state" });
      client.beginPrompt(thread, "进行中");
      const images = [
        { type: "image" as const, data: "png", mimeType: "image/png" },
      ];
      client.enqueue(thread, "待发送图片", images, "followUp");
      const restore = vi.fn();
      await client.stopAndRestore(thread, restore);
      expect(restore).toHaveBeenCalledWith(
        ["排队指令", "后续任务", "待发送图片"],
        images,
      );
      expect(thread.view.localQueue).toEqual([]);
    } finally {
      client.dispose();
    }
  });
  it("keeps images when editing and rebuilding a legacy native queue", async () => {
    const native = await import("./native");
    const original = vi.mocked(native.sendPiCommand).getMockImplementation()!;
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("edit-images", "D:/one");
      await client.request(thread, { type: "get_state" });
      const images = [
        { type: "image" as const, data: "png", mimeType: "image/png" },
      ];
      vi.mocked(native.sendPiCommand).mockImplementation(
        async (id, command) => {
          if (command.type === "clear_queue") {
            queueMicrotask(() =>
              mock.receive({
                sessionId: id,
                stream: "stdout",
                event: {
                  type: "response",
                  id: command.id,
                  command: "clear_queue",
                  success: true,
                  data: {
                    steering: [],
                    follow_up: [
                      {
                        message: "编辑我",
                        images: [{ data: "png", mime_type: "image/png" }],
                      },
                      { message: "保留我", images },
                    ],
                  },
                },
              }),
            );
            return;
          }
          return original(id, command);
        },
      );
      const restore = vi.fn();
      await client.updateQueuedMessage(
        thread,
        "followUp",
        0,
        "编辑我",
        "edit",
        restore,
      );
      expect(restore).toHaveBeenCalledWith(["编辑我"], images);
      expect(native.sendPiCommand).toHaveBeenCalledWith(
        thread.runtimeId,
        expect.objectContaining({
          type: "follow_up",
          message: "保留我",
          images,
        }),
      );
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
  it("does not inject a user prompt after native threshold compaction settles", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("resume-compact", "D:/one");
      await client.request(thread, { type: "get_state" });
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_start" },
      });
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "compaction_start", reason: "threshold" },
      });
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: {
          type: "compaction_end",
          reason: "threshold",
          result: {},
          aborted: false,
          willRetry: false,
        },
      });
      vi.mocked(native.sendPiCommand).mockClear();
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_settled" },
      });
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(native.sendPiCommand)
            .mock.calls.some(([, cmd]) => cmd.type === "get_state"),
        ).toBe(true),
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) => cmd.type === "prompt"),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
  it("does not send a resume prompt after overflow compaction that will retry", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("overflow-compact", "D:/one");
      await client.request(thread, { type: "get_state" });
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_start" },
      });
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: {
          type: "compaction_end",
          reason: "overflow",
          result: {},
          aborted: false,
          willRetry: true,
        },
      });
      vi.mocked(native.sendPiCommand).mockClear();
      mock.receive({
        sessionId: thread.runtimeId!,
        stream: "stdout",
        event: { type: "agent_settled" },
      });
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(native.sendPiCommand)
            .mock.calls.some(([, cmd]) => cmd.type === "get_session_stats"),
        ).toBe(true),
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, cmd]) => cmd.type === "prompt"),
      ).toBe(false);
    } finally {
      client.dispose();
    }
  });
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
    mock.sessionFiles.clear();
    mock.close.mockClear();
    mock.closeAll.mockClear();
    mock.stop.mockClear();
    mock.rejectPrompt = false;
    mock.forkText = "原始输入";
    mock.cancelBranch = false;
    mock.rejectModel = false;
    mock.rejectThinking = false;
    mock.availableModels = [
      { provider: "openai", id: "gpt-test", name: "Test" },
    ];
    mock.runtimeModels.clear();
    vi.mocked(nativeMocks.listPiModels)
      .mockReset()
      .mockImplementation(defaultNative.models);
    vi.mocked(nativeMocks.readPiSession)
      .mockReset()
      .mockImplementation(defaultNative.history);
    vi.mocked(nativeMocks.sendPiCommand)
      .mockReset()
      .mockImplementation(defaultNative.send);
    vi.mocked(nativeMocks.startPiAgent)
      .mockReset()
      .mockImplementation(defaultNative.start);
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
  it("keeps startup snapshots and reloads only the changed resource at an idle boundary", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    mock.availableModels = [
      { provider: "one", id: "model-a" },
      { provider: "two", id: "model-b" },
    ];
    vi.mocked(native.listPiModels)
      .mockResolvedValueOnce([
        {
          provider: "one",
          id: "model-a",
          baseUrl: "https://one.example/v1",
          keyFingerprint: "sha256:a",
        },
        {
          provider: "two",
          id: "model-b",
          baseUrl: "https://two.example/v1",
          keyFingerprint: "sha256:b",
        },
      ])
      .mockResolvedValueOnce([
        {
          provider: "one",
          id: "model-a",
          baseUrl: "https://one.example/v1",
          keyFingerprint: "sha256:a2",
        },
        {
          provider: "two",
          id: "model-b",
          baseUrl: "https://two.example/v1",
          keyFingerprint: "sha256:b",
        },
      ]);
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const first = await client.open("first", "D:/one");
    await client.loadModels(first);
    first.view = {
      ...first.view,
      model: first.view.models.find((model) => model.id === "model-a") ?? null,
    };
    await client.request(first, { type: "get_state" });
    const second = await client.open("second", "D:/two");
    await client.loadModels(second);
    second.view = {
      ...second.view,
      model: second.view.models.find((model) => model.id === "model-b") ?? null,
    };
    await client.request(second, { type: "get_state" });
    const firstBinding = first.runtimeConfig;
    const secondBinding = second.runtimeConfig;
    const previousRuntime = first.runtimeId;
    await client.reloadCatalog();
    expect(first.runtimeConfig).toBe(firstBinding);
    expect(second.runtimeConfig).toBe(secondBinding);
    expect(mock.close).not.toHaveBeenCalled();
    expect(await client.prepareCatalogRuntime(second)).toEqual({
      kind: "unchanged",
    });
    expect(await client.prepareCatalogRuntime(first)).toEqual({
      kind: "runtime-restarted",
      reason: "resource-changed",
    });
    expect(first.runtimeId).not.toBe(previousRuntime);
    expect(second.runtimeConfig).toBe(secondBinding);
    expect(mock.close).toHaveBeenCalledExactlyOnceWith(previousRuntime);
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
      provider: "cp-lite",
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
    expect(thread.view.model).toMatchObject({ id: "gpt-test" });
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
  it("promotes a queued follow-up by index when the displayed text drifts", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("queue", "D:/one");
      await client.request(thread, { type: "get_state" });
      vi.mocked(native.sendPiCommand).mockClear();
      await client.updateQueuedMessage(
        thread,
        "followUp",
        0,
        "后续任务（已改写）",
        "steer",
        vi.fn(),
      );
      const commands = vi
        .mocked(native.sendPiCommand)
        .mock.calls.map(([, command]) => ({
          type: command.type,
          message: command.message,
        }));
      expect(commands).toEqual([
        { type: "clear_queue", message: undefined },
        { type: "steer", message: "后续任务" },
        { type: "steer", message: "排队指令" },
      ]);
    } finally {
      client.dispose();
    }
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
  it("keeps the runtime model after abort and adapts only when selection changed", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      mock.availableModels.push({ provider: "openai", id: "gpt-after-abort" });
      const thread = await client.open("abort-model", "D:/one");
      await client.request(thread, { type: "get_state" });
      const runtimeId = thread.runtimeId;
      const originalBinding = thread.runtimeConfig;
      thread.view.status = "running";
      await client.stopAndRestore(thread, vi.fn());
      expect(thread.runtimeId).toBe(runtimeId);
      expect(thread.runtimeConfig).toBe(originalBinding);

      // 模拟 abort 已收敛到 idle；未改模型时继续发送不得触发同步。
      thread.view.status = "idle";
      vi.mocked(native.sendPiCommand).mockClear();
      await client.request(thread, { type: "prompt", message: "继续" });
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(([, command]) => command.type === "set_model"),
      ).toBe(false);
      expect(thread.runtimeId).toBe(runtimeId);

      thread.view.status = "running";
      await client.setModel(thread, "openai", "gpt-after-abort", "After abort");
      thread.view.status = "idle";
      vi.mocked(native.sendPiCommand).mockClear();
      await client.request(thread, {
        type: "prompt",
        message: "用新模型继续",
      });
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(
            ([, command]) =>
              command.type === "set_model" &&
              command.provider === "openai" &&
              command.modelId === "gpt-after-abort",
          ),
      ).toBe(true);
      expect(thread.runtimeId).toBe(runtimeId);
    } finally {
      client.dispose();
    }
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
  it("forks a settled thread after process_exit without starting a runtime", async () => {
    const native = await import("./native");
    vi.mocked(native.startPiAgent).mockClear();
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one", "source.jsonl");
    await client.hydrateFromDisk(thread);
    thread.view = {
      ...thread.view,
      status: "idle",
      items: [
        {
          id: "u1",
          kind: "message",
          role: "user",
          text: "完成这轮",
          thinking: "",
          streaming: false,
        },
      ],
    };
    thread.view = piViewReducer(thread.view, {
      type: "event",
      payload: {
        sessionId: 1,
        stream: "lifecycle",
        event: { type: "process_exit" },
      },
    });
    expect(thread.view.status).toBe("idle");
    vi.mocked(native.startPiAgent).mockClear();
    const result = await client.branch(thread, "Demo · 分叉 2");
    expect(native.startPiAgent).not.toHaveBeenCalled();
    expect(result.thread.runtimeId).toBeNull();
    client.dispose();
  });
  it("rejects fork while a turn is live or connecting", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("source", "D:/one", "source.jsonl");
    await client.hydrateFromDisk(thread);
    thread.view = { ...thread.view, status: "running" };
    await expect(client.branch(thread)).rejects.toThrow(
      "请先停止当前任务再分叉",
    );
    thread.view = { ...thread.view, status: "starting" };
    await expect(client.branch(thread)).rejects.toThrow(
      "正在连接 Pi，请稍后再分叉",
    );
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
  it("edits in place and keeps the renamed session identity without a fork", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const path = "C:/Users/test/same.jsonl";
      const thread = await client.open(path, "D:/one", path);
      await client.request(thread, { type: "get_state" });
      await client.rename(thread, "Renamed");
      thread.view.items = [
        {
          id: "entry-last",
          kind: "message",
          role: "user",
          text: "原始输入",
          thinking: "",
          streaming: false,
        },
      ];
      vi.mocked(native.sendPiCommand).mockClear();
      vi.mocked(native.truncatePiSession).mockClear();
      vi.mocked(native.clonePiSession).mockClear();
      vi.mocked(native.startPiAgent).mockClear();
      await expect(client.editLastUser(thread, "修改后的输入")).resolves.toBe(
        true,
      );
      expect(native.truncatePiSession).toHaveBeenCalledWith(path, "entry-last");
      expect(native.clonePiSession).not.toHaveBeenCalled();
      expect(native.startPiAgent).toHaveBeenLastCalledWith(
        "D:/one",
        path,
        false,
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(
            ([, command]) =>
              command.type === "fork" || command.type === "clone",
          ),
      ).toBe(false);
      expect(native.sendPiCommand).toHaveBeenLastCalledWith(
        thread.runtimeId,
        expect.objectContaining({ type: "prompt", message: "修改后的输入" }),
      );
      expect(thread.key).toBe(path);
      expect(thread.view.sessionFile).toBe(path);
      expect(thread.view.sessionName).toBe("Renamed");
      expect(client.threads.size).toBe(1);
      expect(
        await client.open(
          "reopened",
          "D:/one",
          "\\\\?\\C:\\Users\\test\\same.jsonl",
        ),
      ).toBe(thread);
      expect(client.threads.size).toBe(1);
    } finally {
      client.dispose();
    }
  });
  it("blocks concurrent requests and another edit while the original session is truncated", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    let release!: () => void;
    try {
      const thread = await client.open("same.jsonl", "D:/one", "same.jsonl");
      await client.request(thread, { type: "get_state" });
      thread.view.items = [
        {
          id: "entry-last",
          kind: "message",
          role: "user",
          text: "原始输入",
          thinking: "",
          streaming: false,
        },
      ];
      vi.mocked(native.truncatePiSession).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const editing = client.editLastUser(thread, "修改后的输入");
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await expect(client.editLastUser(thread, "另一条编辑")).rejects.toThrow(
        "请等待运行结束后再编辑",
      );
      await expect(
        client.request(thread, { type: "prompt", message: "并发输入" }),
      ).rejects.toThrow("正在重新编辑当前轮");
      await client.refreshState(thread);
      expect(thread.runtimeId).toBeNull();
      release();
      await editing;
      expect(thread.view.sessionFile).toBe("same.jsonl");
      expect(client.threads.size).toBe(1);
    } finally {
      release?.();
      client.dispose();
    }
  });
  it("refuses a stale last-user cursor without closing or changing the session", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("same.jsonl", "D:/one", "same.jsonl");
      await client.request(thread, { type: "get_state" });
      thread.view.items = [
        {
          id: "entry-last",
          kind: "message",
          role: "user",
          text: "过期输入",
          thinking: "",
          streaming: false,
        },
      ];
      const items = thread.view.items;
      vi.mocked(native.truncatePiSession).mockClear();
      await expect(client.editLastUser(thread, "修改后的输入")).rejects.toThrow(
        "最后一条输入已变化",
      );
      expect(native.truncatePiSession).not.toHaveBeenCalled();
      expect(mock.close).not.toHaveBeenCalled();
      expect(thread.view.items).toBe(items);
      expect(thread.view.sessionFile).toBe("same.jsonl");
    } finally {
      client.dispose();
    }
  });
  it("retains the original identity and releases the edit lock after a failed truncate", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("same.jsonl", "D:/one", "same.jsonl");
      await client.request(thread, { type: "get_state" });
      thread.view.items = [
        {
          id: "entry-last",
          kind: "message",
          role: "user",
          text: "原始输入",
          thinking: "",
          streaming: false,
        },
      ];
      const items = thread.view.items;
      vi.mocked(native.truncatePiSession).mockRejectedValueOnce(
        new Error("文件已变化"),
      );
      await expect(client.editLastUser(thread, "修改后的输入")).rejects.toThrow(
        "文件已变化",
      );
      expect(thread.view.items).toHaveLength(items.length);
      expect(thread.view.items[0]).toMatchObject(items[0]);
      expect(thread.view.sessionFile).toBe("same.jsonl");
      expect(thread.key).toBe("same.jsonl");
      await expect(client.editLastUser(thread, "再次编辑")).resolves.toBe(true);
      expect(client.threads.size).toBe(1);
    } finally {
      client.dispose();
    }
  });
  it("keeps wide-image edits in the same session when Pi adds an image size note", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("same.jsonl", "D:/one", "same.jsonl");
      await client.request(thread, { type: "get_state" });
      thread.view.items = [
        {
          id: "entry-last",
          kind: "message",
          role: "user",
          text: "原始输入",
          thinking: "",
          streaming: false,
        },
      ];
      mock.forkText =
        "原始输入\n[Image: original 4000x1000, resized to 2000x500]";
      await expect(client.editLastUser(thread, "修改后的输入")).resolves.toBe(
        true,
      );
      expect(native.truncatePiSession).toHaveBeenLastCalledWith(
        "same.jsonl",
        "entry-last",
      );
      expect(thread.view.sessionFile).toBe("same.jsonl");
    } finally {
      client.dispose();
    }
  });
  it("resends an aborted turn with its images after restoring queued text", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("aborted-edit", "D:/one");
    await client.request(thread, { type: "get_state" });
    vi.mocked(native.sendPiCommand).mockClear();
    thread.view.status = "running";
    const restore = vi.fn();
    await client.stopAndRestore(thread, restore);
    if (thread.runtimeId === null) throw new Error("测试线程未启动");
    mock.receive({
      sessionId: thread.runtimeId,
      stream: "stdout",
      event: { type: "agent_settled" },
    });
    expect(restore).toHaveBeenCalledWith(["排队指令", "后续任务"]);
    thread.view.items = [
      {
        id: "entry-last",
        kind: "message",
        role: "user",
        text: "原始输入",
        thinking: "",
        streaming: false,
      },
    ];
    const images = [
      { type: "image" as const, data: "image-data", mimeType: "image/png" },
    ];
    await expect(
      client.editLastUser(thread, "终止后修改", images),
    ).resolves.toBe(true);
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.find(([, command]) => command.type === "prompt")?.[1],
    ).toMatchObject({ type: "prompt", message: "终止后修改", images });
    expect(restore).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("reloads catalog without closing a live runtime", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one");
    await client.request(thread, { type: "get_state" });
    const runtimeId = thread.runtimeId;
    vi.mocked(native.listPiModels).mockResolvedValueOnce([
      { provider: "openai", id: "gpt-new", name: "New" },
    ]);
    await client.reloadCatalog();
    expect(thread.runtimeId).toBe(runtimeId);
    expect(mock.close).not.toHaveBeenCalled();
    expect(thread.view.model).toMatchObject({ id: "gpt-test" });
    client.dispose();
  });
  it("switches to a model in the startup catalog through RPC without restarting", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    mock.availableModels.push({
      provider: "openai",
      id: "gpt-new",
      name: "New",
    });
    vi.mocked(native.listPiModels).mockResolvedValue(mock.availableModels);
    const thread = await client.open("one", "D:/one");
    await client.request(thread, { type: "get_state" });
    await client.setThinkingLevel(thread, "high");
    const previous = thread.runtimeId;
    await client.reloadCatalog();
    thread.view.status = "running";
    await client.setModel(thread, "openai", "gpt-new", "New");
    thread.view.status = "idle";
    mock.close.mockClear();
    vi.mocked(native.sendPiCommand).mockClear();
    await client.request(thread, { type: "prompt", message: "下一轮" });
    // 新期望：不关闭 runtime，使用 set_model RPC 无感切换
    expect(mock.close).not.toHaveBeenCalled();
    expect(thread.runtimeId).toBe(previous);
    // 验证发送了 set_model RPC
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.find(([, command]) => command.type === "set_model"),
    ).toBeTruthy();
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.some(
          ([, command]) =>
            command.type === "set_thinking_level" && command.level === "high",
        ),
    ).toBe(true);
    // 验证仍然发送了 prompt
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.some(([, command]) => command.type === "prompt"),
    ).toBe(true);
    client.dispose();
  });
  it("keeps a fingerprinted model and reuses runtime after state and thinking RPCs", async () => {
    const native = await import("./native");
    const resource = {
      provider: "openai",
      id: "gpt-test",
      baseUrl: "https://example.invalid/v1",
      keyFingerprint: "sha256:key",
      resourceFingerprint: "sha256:request",
    };
    vi.mocked(native.listPiModels).mockResolvedValue([resource]);
    mock.availableModels = [resource];
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("fingerprint", "D:/one");
      await client.loadModels(thread);
      await client.request(thread, { type: "get_state" });
      const binding = thread.runtimeConfig;
      const runtimeId = thread.runtimeId;
      vi.mocked(native.sendPiCommand).mockClear();
      await client.setThinkingLevel(thread, "xhigh");
      await client.request(thread, { type: "get_state" });
      await client.reloadCatalog();
      client.applyCatalogModel(thread, resource);
      expect(await client.prepareCatalogRuntime(thread)).toEqual({
        kind: "unchanged",
      });
      expect(thread.view.model?.resourceFingerprint).toBe(
        resource.resourceFingerprint,
      );
      expect(thread.runtimeConfig).toBe(binding);
      expect(thread.runtimeId).toBe(runtimeId);
      expect(mock.close).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.filter(([, command]) => command.type === "set_model"),
      ).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });

  it("keeps an initialized runtime when startup thinking synchronization fails", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("thinking-start", "D:/one");
      mock.rejectThinking = true;
      await expect(
        client.request(thread, { type: "get_state" }),
      ).rejects.toThrow("thinking rejected");
      expect(thread.runtimeId).not.toBeNull();
      expect(thread.runtimeConfig?.thinkingLevel).toBeNull();
      expect(mock.close).not.toHaveBeenCalled();
      mock.rejectThinking = false;
      expect(await client.prepareCatalogRuntime(thread)).toEqual({
        kind: "unchanged",
      });
      expect(thread.runtimeConfig?.thinkingLevel).toBe("high");
    } finally {
      client.dispose();
    }
  });

  it("records a successful model switch even if its following thinking RPC fails", async () => {
    const native = await import("./native");
    mock.availableModels.push({ provider: "openai", id: "gpt-next" });
    vi.mocked(native.listPiModels).mockResolvedValue(mock.availableModels);
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("thinking-switch", "D:/one");
      await client.request(thread, { type: "get_state" });
      const runtimeId = thread.runtimeId;
      mock.rejectThinking = true;
      await expect(
        client.setModel(thread, "openai", "gpt-next"),
      ).rejects.toThrow("thinking rejected");
      expect(thread.runtimeConfig?.model).toEqual({
        provider: "openai",
        id: "gpt-next",
      });
      expect(thread.runtimeId).toBe(runtimeId);
      expect(mock.close).not.toHaveBeenCalled();
      mock.rejectThinking = false;
      vi.mocked(native.sendPiCommand).mockClear();
      await client.prepareCatalogRuntime(thread);
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.filter(([, command]) => command.type === "set_model"),
      ).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });

  it("reports model RPC failures without closing runtime or advancing its applied selection", async () => {
    const native = await import("./native");
    mock.availableModels.push({ provider: "openai", id: "gpt-next" });
    vi.mocked(native.listPiModels).mockResolvedValue(mock.availableModels);
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("model-failure", "D:/one");
      await client.request(thread, { type: "get_state" });
      const runtimeId = thread.runtimeId;
      mock.rejectModel = true;
      await expect(
        client.setModel(thread, "openai", "gpt-next"),
      ).rejects.toThrow("model rejected");
      expect(thread.runtimeConfig?.model).toEqual({
        provider: "openai",
        id: "gpt-test",
      });
      expect(thread.view.model?.id).toBe("gpt-next");
      expect(thread.runtimeId).toBe(runtimeId);
      expect(mock.close).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("loads newly added models through a single shared runtime replacement", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("added", "D:/one");
      await client.request(thread, { type: "get_state" });
      const runtimeId = thread.runtimeId;
      mock.availableModels.push({ provider: "openai", id: "gpt-added" });
      vi.mocked(native.listPiModels).mockResolvedValue(mock.availableModels);
      await client.reloadCatalog();
      thread.view.status = "running";
      await client.setModel(thread, "openai", "gpt-added");
      thread.view.status = "idle";
      const [one, two] = await Promise.all([
        client.prepareCatalogRuntime(thread),
        client.prepareCatalogRuntime(thread),
      ]);
      expect(one).toEqual({ kind: "runtime-restarted", reason: "model-added" });
      expect(two).toEqual(one);
      expect(mock.close).toHaveBeenCalledExactlyOnceWith(runtimeId);
      expect(thread.runtimeId).not.toBe(runtimeId);
      expect(thread.runtimeConfig?.model?.id).toBe("gpt-added");
    } finally {
      client.dispose();
    }
  });

  it("adapts changed resources before optimistically beginning a queued prompt", async () => {
    const native = await import("./native");
    const original = {
      provider: "openai",
      id: "gpt-test",
      resourceFingerprint: "sha256:old",
    };
    vi.mocked(native.listPiModels).mockResolvedValue([original]);
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    try {
      const thread = await client.open("queued-config", "D:/one");
      await client.loadModels(thread);
      await client.request(thread, { type: "get_state" });
      const runtimeId = thread.runtimeId;
      vi.mocked(native.listPiModels).mockResolvedValue([
        { ...original, resourceFingerprint: "sha256:new" },
      ]);
      await client.reloadCatalog();
      client.enqueue(thread, "next", [], "followUp");
      await client.drainQueue(thread);
      expect(mock.close).toHaveBeenCalledExactlyOnceWith(runtimeId);
      expect(thread.runtimeConfig?.loadedModels[0].resourceFingerprint).toBe(
        "sha256:new",
      );
      expect(
        vi
          .mocked(native.sendPiCommand)
          .mock.calls.some(
            ([id, command]) =>
              id === thread.runtimeId && command.type === "prompt",
          ),
      ).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("does not restart a running runtime after catalog reload", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one");
    await client.request(thread, { type: "get_state" });
    client.beginPrompt(thread, "进行中");
    const previous = thread.runtimeId;
    vi.mocked(native.listPiModels).mockResolvedValueOnce([
      { provider: "openai", id: "gpt-new", name: "New" },
    ]);
    await client.reloadCatalog();
    mock.close.mockClear();
    await client.request(thread, {
      type: "prompt",
      message: "插一句",
      streamingBehavior: "steer",
    });
    expect(mock.close).not.toHaveBeenCalled();
    expect(thread.runtimeId).toBe(previous);
    client.dispose();
  });
  it("does not send set_model to a running runtime", async () => {
    const native = await import("./native");
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("one", "D:/one", "session.jsonl");
    await client.request(thread, { type: "get_state" });
    client.beginPrompt(thread, "进行中");
    vi.mocked(native.sendPiCommand).mockClear();
    vi.mocked(native.appendPiSession).mockClear();
    await client.setModel(thread, "openai", "gpt-new", "New");
    expect(
      vi
        .mocked(native.sendPiCommand)
        .mock.calls.some(([, command]) => command.type === "set_model"),
    ).toBe(false);
    expect(native.appendPiSession).toHaveBeenCalledWith({
      path: thread.view.sessionFile,
      kind: "model_change",
      provider: "openai",
      modelId: "gpt-new",
    });
    client.dispose();
  });
  it("shows the default thinking ladder on a new thread before runtime levels arrive", async () => {
    const client = new PiWorkspaceClient(vi.fn(), vi.fn());
    const thread = await client.open("draft", "D:/one");
    expect(thread.view.thinkingLevel).toBe("high");
    expect(thread.view.thinkingLevels).toEqual(DEFAULT_PI_THINKING_LEVELS);
    client.applyCatalogModel(thread, null);
    expect(thread.view.thinkingLevels).toEqual(DEFAULT_PI_THINKING_LEVELS);
    client.dispose();
  });
});
