import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "./protocol";
import { CodexClient, onCodexTurnFinished } from "./client";

const transport = vi.hoisted(() => ({
  listener: null as
    | null
    | ((event: {
        payload: { connectionId: number; message: Message };
      }) => void),
  sent: [] as Message[],
  fail: "",
  hold: "",
  connection: 0,
  resource: "初始资源",
  switchError: "",
  catalogPages: false,
  steerError: "",
}));
const thread: Thread = {
  id: "one",
  name: "One",
  cwd: "D:/project",
  preview: "hello",
  turns: [],
  updatedAt: 1,
};
/** 在测试中发出原生形状通知，不启动真实模型。 */
function event(message: Message, connectionId = transport.connection) {
  transport.listener?.({ payload: { connectionId, message } });
}
/** 模拟服务端手动压缩的轮次开始与压缩项开始事件。 */
function startCompactionTurn(turnId = "compact") {
  event({
    method: "turn/started",
    params: {
      threadId: "one",
      turn: { id: turnId, status: "inProgress", items: [] },
    },
  });
  event({
    method: "item/started",
    params: {
      threadId: "one",
      turnId,
      item: { id: `${turnId}-item`, type: "contextCompaction" },
    },
  });
}

/** 模拟压缩项完成，轮次终态仍由独立的 turn/completed 事件确认。 */
function completeCompactionItem(turnId = "compact") {
  event({
    method: "item/completed",
    params: {
      threadId: "one",
      turnId,
      item: { id: `${turnId}-item`, type: "contextCompaction" },
    },
  });
}

/** 发出指定压缩轮次的成功终态，保留客户端已收到的压缩项。 */
function completeCompactionTurn(turnId = "compact") {
  event({
    method: "turn/completed",
    params: {
      threadId: "one",
      turn: { id: turnId, status: "completed", items: [] },
    },
  });
}
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => {
    transport.listener = callback;
    return () => {
      transport.listener = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command, args) => {
    if (command === "codex_agent_start") return ++transport.connection;
    if (command === "codex_agent_ready")
      return {
        resourceAlias: transport.resource,
        provider: "test",
      };
    if (command === "codex_resources_models") {
      if (args.alias !== transport.resource)
        throw new Error("missing or incorrect alias");
      return [{ id: "selected-model" }];
    }
    if (command === "codex_agent_prepare_switch") {
      if (transport.switchError) throw new Error(transport.switchError);
      if (typeof args.resourceAlias !== "string")
        throw new Error("missing resourceAlias");
      transport.resource = args.resourceAlias;
      return;
    }
    if (command === "codex_resources_model") throw new Error("unknown command");
    if (command !== "codex_agent_send") return;
    const message = args.message as Message;
    transport.sent.push(message);
    if (message.method === "turn/steer" && transport.steerError) {
      queueMicrotask(() =>
        event({
          id: message.id,
          error: { code: -32600, message: transport.steerError },
        }),
      );
      return;
    }
    if (message.method === transport.fail) throw new Error("send failed");
    if (
      !message.method ||
      message.id === undefined ||
      message.method === transport.hold
    )
      return;
    let result: unknown = {};
    if (message.method === "thread/list")
      result = message.params?.archived
        ? { data: [], nextCursor: null }
        : transport.catalogPages
          ? message.params?.cursor
            ? { data: [{ ...thread, id: "older" }], nextCursor: null }
            : { data: [thread], nextCursor: "next" }
          : { data: [thread, { ...thread, id: "two" }], nextCursor: null };
    if (message.method === "model/list") result = { data: [] };
    if (message.method === "thread/turns/list")
      result = { data: [], nextCursor: null };
    if (message.method === "thread/fork")
      result = { thread: { ...thread, id: "fork", turns: [] } };
    if (message.method === "thread/start") {
      result = {
        thread: { ...thread, id: "new", model: message.params?.model ?? null },
      };
      event({
        method: "thread/started",
        params: result as Record<string, unknown>,
      });
    }
    if (["thread/read", "thread/resume"].includes(message.method))
      result = { thread: { ...thread, id: message.params?.threadId } };
    if (message.method === "turn/start")
      event({
        method: "turn/started",
        params: {
          threadId: message.params?.threadId,
          turn: { id: "turn", status: "inProgress", items: [] },
        },
      });
    queueMicrotask(() => event({ id: message.id, result }));
  }),
}));

let client: CodexClient;
beforeEach(async () => {
  transport.sent = [];
  transport.fail = "";
  transport.hold = "";
  transport.switchError = "";
  transport.catalogPages = false;
  transport.steerError = "";
  client = new CodexClient();
  await client.connect();
  await client.refreshProject("D:/project");
});
afterEach(async () => {
  await client.dispose();
});

describe("Codex native client", () => {
  it("starts a new turn when the old turn ends during resume", async () => {
    client.patch("one", { busy: true, turnId: "old", draft: "continue" });
    transport.hold = "thread/resume";
    const sending = client.send("one");
    await vi.waitFor(() => expect(transport.sent.some((m) => m.method === "thread/resume")).toBe(true));
    event({ method: "turn/completed", params: { threadId: "one", turn: { id: "old", status: "completed", items: [] } } });
    const resume = transport.sent.find((m) => m.method === "thread/resume");
    event({ id: resume?.id, result: { thread } });
    expect(await sending).toBe(true);
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(false);
    expect(transport.sent.filter((m) => m.method === "turn/start")).toHaveLength(1);
  });
  it("starts rejected steer input exactly once after the native turn has ended", async () => {
    client.patch("one", { resumed: true, busy: true, turnId: "old", draft: "continue", images: ["data:image/png;base64,AA=="] });
    transport.steerError = "no active turn to steer";
    expect(await client.send("one")).toBe(true);
    expect(transport.sent.filter((m) => m.method === "turn/steer")).toHaveLength(1);
    expect(transport.sent.filter((m) => m.method === "turn/start")).toHaveLength(1);
    expect(transport.sent.find((m) => m.method === "turn/start")?.params?.input).toContainEqual({ type: "image", url: "data:image/png;base64,AA==" });
    expect(client.getSnapshot().sessions.one).toMatchObject({ draft: "", images: [], error: null });
  });
  it("recovers a stale failed queue from native idle without steering", async () => {
    client.patch("one", { resumed: true, busy: true, turnId: "old", queueError: "Error: no active turn to steer", queue: [{ id: "queued", draft: "next", images: [], attachments: [], directories: [], skills: [] }] });
    await client.retryQueue("one");
    await vi.waitFor(() => expect(client.getSnapshot().sessions.one.queue).toEqual([]));
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(false);
    expect(transport.sent.filter((m) => m.method === "turn/start")).toHaveLength(1);
  });
  it.each(["followUp", "steer"] as const)(
    "压缩期间 %s 进入队列并保留新草稿",
    async (mode) => {
      client.patch("one", { loaded: true, resumed: true });
      const compacting = client.compact("one");
      await vi.waitFor(() =>
        expect(
          transport.sent.some((m) => m.method === "thread/compact/start"),
        ).toBe(true),
      );
      startCompactionTurn();
      client.patch("one", {
        draft: "压缩后执行",
        images: ["data:image/png;base64,AA=="],
      });
      await client.submit("one", mode);
      expect(client.getSnapshot().sessions.one.queue).toHaveLength(1);
      expect(
        transport.sent.some(
          (m) => m.method === "turn/start" || m.method === "turn/steer",
        ),
      ).toBe(false);
      client.patch("one", { draft: "尚未发送的新草稿" });
      completeCompactionItem();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(client.getSnapshot().sessions.one).toMatchObject({
        busy: true,
        turnId: "compact",
        compacting: true,
        compactionNotice: { status: "running" },
      });
      expect(client.getSnapshot().sessions.one.queue).toHaveLength(1);
      expect(
        transport.sent.some(
          (m) => m.method === "turn/start" || m.method === "turn/steer",
        ),
      ).toBe(false);
      if (mode === "steer") {
        const queuedId = client.getSnapshot().sessions.one.queue[0].id;
        await client.queueAction("one", queuedId, "steer");
        expect(
          client.getSnapshot().sessions.one.queueSendingId,
        ).toBeUndefined();
        expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(
          false,
        );
      }
      completeCompactionTurn();
      await compacting;
      await vi.waitFor(() =>
        expect(client.getSnapshot().sessions.one.queue).toHaveLength(0),
      );
      expect(client.getSnapshot().sessions.one.draft).toBe("尚未发送的新草稿");
      expect(
        transport.sent.filter((m) => m.method === "turn/start"),
      ).toHaveLength(1);
      expect(
        transport.sent.find((m) => m.method === "turn/start")?.params?.input,
      ).toContainEqual({ type: "image", url: "data:image/png;base64,AA==" });
    },
  );
  it("keeps an ordinary turn active after automatic compaction and permits steering", async () => {
    client.patch("one", { loaded: true, resumed: true, draft: "first" });
    await client.submit("one");
    startCompactionTurn("turn");
    client.patch("one", { draft: "follow up" });
    await client.submit("one");
    completeCompactionItem("turn");
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: true,
      turnId: "turn",
      compacting: false,
      compactionNotice: { manual: false, status: "done" },
    });
    expect(client.getSnapshot().sessions.one.queue).toHaveLength(1);
    client.patch("one", { draft: "insert now" });
    await client.submit("one", "steer");
    expect(
      transport.sent.filter((m) => m.method === "turn/steer"),
    ).toHaveLength(1);
    expect(
      transport.sent.find((m) => m.method === "turn/steer")?.params,
    ).toMatchObject({ expectedTurnId: "turn" });
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
    completeCompactionTurn("turn");
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toEqual([]),
    );
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(2);
  });
  it("does not overwrite the next turn when compaction finishes before its response", async () => {
    client.patch("one", { loaded: true, resumed: true });
    transport.hold = "thread/compact/start";
    const compacting = client.compact("one");
    startCompactionTurn();
    client.patch("one", { draft: "next" });
    await client.submit("one");
    completeCompactionItem();
    completeCompactionTurn();
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toEqual([]),
    );
    const request = transport.sent.find(
      (m) => m.method === "thread/compact/start",
    );
    event({ id: request?.id, result: {} });
    await compacting;
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: true,
      turnId: "turn",
    });
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(false);
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
  });
  it("preserves queued input and attachments when the compaction turn fails", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client
      .compact("one")
      .catch((error: Error) => error.message);
    startCompactionTurn();
    client.patch("one", {
      draft: "next",
      images: ["data:image/png;base64,AA=="],
    });
    await client.submit("one");
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "compact",
          status: "failed",
          error: { message: "compaction failed" },
          items: [],
        },
      },
    });
    expect(await compacting).toBe("compaction failed");
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: false,
      compacting: false,
      compactionNotice: { status: "failed" },
      queue: [{ draft: "next", images: ["data:image/png;base64,AA=="] }],
    });
    expect(client.getSnapshot().sessions.one.queueError).toBeTruthy();
    expect(
      transport.sent.some(
        (m) => m.method === "turn/start" || m.method === "turn/steer",
      ),
    ).toBe(false);
  });
  it.each(["completion", "request"] as const)(
    "keeps the native compaction turn busy after a %s timeout",
    async (timeout) => {
      client.patch("one", { loaded: true, resumed: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        if (timeout === "request") transport.hold = "thread/compact/start";
        const compacting = client
          .compact("one")
          .catch((error: Error) => error.message);
        startCompactionTurn();
        client.patch("one", { draft: "wait for compaction" });
        await client.submit("one");
        await vi.advanceTimersByTimeAsync(60_001);
        if (timeout === "completion") {
          expect(
            client.getSnapshot().sessions.one.compactionNotice?.status,
          ).toBe("running");
          await vi.advanceTimersByTimeAsync(9 * 60_000);
        }
        expect(await compacting).toContain("超时");
        expect(client.getSnapshot().sessions.one).toMatchObject({
          busy: true,
          turnId: "compact",
          compacting: true,
        });
        client.retryQueue("one");
        client.patch("one", { draft: "another" });
        await client.submit("one", "steer");
        expect(client.getSnapshot().sessions.one.queue).toHaveLength(2);
        expect(
          transport.sent.some(
            (m) => m.method === "turn/start" || m.method === "turn/steer",
          ),
        ).toBe(false);
        completeCompactionTurn();
        await Promise.resolve();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("settles manual compaction from authoritative idle when turn completion is absent", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client.compact("one");
    startCompactionTurn();
    client.patch("one", { draft: "next" });
    await client.submit("one");
    completeCompactionItem();
    event({
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "idle" } },
    });
    await compacting;
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toEqual([]),
    );
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(false);
  });
  it("waits for each repeated manual compaction and resets the previous notice", async () => {
    client.patch("one", { loaded: true, resumed: true });
    for (const turnId of ["first-compact", "second-compact"]) {
      const compacting = client.compact("one");
      startCompactionTurn(turnId);
      completeCompactionItem(turnId);
      expect(client.getSnapshot().sessions.one.compactionNotice).toMatchObject({
        status: "running",
        turnId,
      });
      completeCompactionTurn(turnId);
      await compacting;
      expect(client.getSnapshot().sessions.one).toMatchObject({
        busy: false,
        turnId: null,
        compactionNotice: { status: "done" },
      });
    }
    expect(
      transport.sent.filter((m) => m.method === "thread/compact/start"),
    ).toHaveLength(2);
  });
  it("ends compaction waiting on disconnect and retains the queued images", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client
      .compact("one")
      .catch((error: Error) => error.message);
    startCompactionTurn();
    client.patch("one", {
      draft: "next",
      images: ["data:image/png;base64,AA=="],
    });
    await client.submit("one");
    event({ method: "bridge/closed", params: {} });
    expect(await compacting).toContain("连接已结束");
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: false,
      turnId: null,
      compacting: false,
      compactionNotice: { status: "failed" },
      queue: [{ draft: "next", images: ["data:image/png;base64,AA=="] }],
    });
    expect(
      transport.sent.some(
        (m) => m.method === "turn/start" || m.method === "turn/steer",
      ),
    ).toBe(false);
  });
  it("keeps the failed compaction notice after the final idle event", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client
      .compact("one")
      .catch((error: Error) => error.message);
    startCompactionTurn();
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: {
          id: "compact",
          status: "failed",
          error: { message: "failed" },
          items: [],
        },
      },
    });
    event({
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "idle" } },
    });
    expect(await compacting).toBe("failed");
    expect(client.getSnapshot().sessions.one.compactionNotice?.status).toBe(
      "failed",
    );
  });
  it("settles manual compaction even when only the item carries its turn ID", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client.compact("one");
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "compact",
        item: { id: "compact-item", type: "contextCompaction" },
      },
    });
    client.patch("one", { draft: "next" });
    await client.submit("one");
    completeCompactionItem();
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: true,
      turnId: "compact",
      compacting: true,
    });
    completeCompactionTurn();
    await compacting;
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toEqual([]),
    );
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(false);
  });
  it("ignores late compaction item completion after the turn has already ended", async () => {
    client.patch("one", { loaded: true, resumed: true });
    const compacting = client.compact("one");
    startCompactionTurn();
    completeCompactionTurn();
    await compacting;
    completeCompactionItem();
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: false,
      turnId: null,
      compacting: false,
      compactionNotice: { status: "done" },
    });
    client.patch("one", { draft: "next" });
    await client.submit("one");
    completeCompactionItem();
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: true,
      turnId: "turn",
      compacting: false,
    });
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
  });
  it.each(["remove-all", "keep-local", "image-only"])(
    "编辑图片 %s 按保留列表重发",
    async (mode) => {
      const images = [
        { type: "image" as const, url: "data:image/png;base64,AA==" },
        { type: "localImage" as const, path: "C:/test/keep.png" },
      ];
      const turns = [
        {
          id: "last",
          status: "completed",
          items: [
            {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: "原始输入" }, ...images],
            },
          ],
        },
      ];
      client.patch("one", { loaded: true, thread: { ...thread, turns } });
      await client.editLast(
        "one",
        mode === "image-only" ? "" : "修改文字",
        "user",
        mode === "remove-all" ? [] : [images[1]],
      );
      const input = transport.sent.find((m) => m.method === "turn/start")
        ?.params?.input as Array<{ type: string }>;
      expect(
        input.filter(
          (part) => part.type === "image" || part.type === "localImage",
        ),
      ).toEqual(mode === "remove-all" ? [] : [images[1]]);
      expect(client.getSnapshot().sessions.one.thread.turns).toEqual(turns);
    },
  );
  it("编辑内容全部清空时不分叉", async () => {
    client.patch("one", {
      loaded: true,
      thread: {
        ...thread,
        turns: [
          {
            id: "last",
            status: "completed",
            items: [
              {
                id: "user",
                type: "userMessage",
                content: [{ type: "text", text: "old" }],
              },
            ],
          },
        ],
      },
    });
    await expect(client.editLast("one", "", "user", [])).rejects.toThrow(
      "不能为空",
    );
    expect(transport.sent.some((m) => m.method === "thread/fork")).toBe(false);
  });
  it("reads history pages only for the explicitly selected project", async () => {
    transport.catalogPages = true;
    await client.refresh();
    expect(client.getSnapshot().sessions.older).toBeDefined();
    expect(client.getSnapshot().cursor).toBeNull();
    expect(
      transport.sent.some(
        (m) => m.method === "thread/list" && m.params?.cursor === "next",
      ),
    ).toBe(true);
  });
  it("queues follow-ups without touching other viewports and drains after completion", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", { draft: "second", attachments: ["D:/a.md"] });
    await client.submit("one");
    expect(client.getSnapshot().sessions.one.queue).toHaveLength(1);
    expect(client.getSnapshot().sessions.one.draft).toBe("");
    expect(client.getSnapshot().sessions.two.queue).toHaveLength(0);
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: { id: "turn", status: "completed", items: [] },
      },
    });
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toHaveLength(0),
    );
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(2);
    expect(
      transport.sent.filter((m) => m.method === "turn/start")[1].params?.input,
    ).toContainEqual({
      type: "text",
      text: "- 关联文件 D:/a.md",
      text_elements: [],
    });
  });
  it("retains a failed queue and only retries on user action", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", {
      draft: "queued",
      images: ["data:image/png;base64,AA=="],
    });
    await client.submit("one");
    transport.fail = "turn/start";
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: { id: "turn", status: "completed", items: [] },
      },
    });
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queueError).toBeTruthy(),
    );
    expect(client.getSnapshot().sessions.one.queue[0].images).toHaveLength(1);
    transport.fail = "";
    client.retryQueue("one");
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.one.queue).toHaveLength(0),
    );
  });
  it("keeps stopping through early terminal events without notifying, resending or changing the model", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", { draft: "queued" });
    await client.submit("one");
    await client.selectModel("one", "next-model", "high");
    const finished = vi.fn();
    const unsubscribe = onCodexTurnFinished(finished);
    try {
      vi.spyOn(client, "interrupt").mockImplementationOnce(async () => {
        expect(client.getSnapshot().sessions.one.queue).toEqual([]);
        expect(client.getSnapshot().sessions.one.draft).toBe("queued");
        event({
          method: "thread/status/changed",
          params: { threadId: "one", status: { type: "idle" } },
        });
        expect(client.getSnapshot().sessions.one.stopping).toBe(true);
        // Natural completion can race with the interrupt request.
        event({
          method: "turn/completed",
          params: {
            threadId: "one",
            turn: { id: "turn", status: "completed", items: [] },
          },
        });
        expect(client.getSnapshot().sessions.one.stopping).toBe(true);
        expect(finished).not.toHaveBeenCalled();
        event({
          method: "turn/completed",
          params: {
            threadId: "two",
            turn: { id: "other", status: "completed", items: [] },
          },
        });
        expect(finished).toHaveBeenCalledWith(
          "two",
          expect.objectContaining({ status: "completed" }),
        );
      });
      await client.stopAndRestore("one");
      expect(client.getSnapshot().sessions.one).toMatchObject({
        stopping: false,
        queue: [],
        model: "next-model",
        effort: "high",
        draft: "queued",
      });
      expect(
        transport.sent.filter((message) => message.method === "turn/start"),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
  it("restores stopped follow-ups and attachments alongside newer draft", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", {
      draft: "queued",
      attachments: ["D:/a"],
      directories: ["D:/a"],
    });
    await client.submit("one");
    client.patch("one", { draft: "new draft" });
    await client.stopAndRestore("one");
    const session = client.getSnapshot().sessions.one;
    expect(session.draft).toBe("queued\n\nnew draft");
    expect(session.directories).toEqual(["D:/a"]);
    expect(session.queue).toHaveLength(0);
    expect(session.focusRevision).toBeGreaterThan(0);
  });
  it("keeps a steered queue item visible until the user message appears", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", { draft: "插入这句" });
    await client.submit("one");
    const queuedId = client.getSnapshot().sessions.one.queue[0].id;
    await client.queueAction("one", queuedId, "steer");
    expect(transport.sent.some((m) => m.method === "turn/steer")).toBe(true);
    expect(
      client.getSnapshot().sessions.one.queue.map((item) => item.draft),
    ).toEqual(["插入这句"]);
    expect(client.getSnapshot().sessions.one.queueSendingId).toBe(queuedId);
    await client.queueAction("one", queuedId, "steer");
    await client.queueAction("one", queuedId, "delete");
    expect(
      transport.sent.filter((m) => m.method === "turn/steer"),
    ).toHaveLength(1);
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "turn",
        item: {
          id: "user-inserted",
          type: "userMessage",
          content: [{ type: "text", text: "插入这句" }],
        },
      },
    });
    expect(client.getSnapshot().sessions.one.queue).toHaveLength(0);
    expect(client.getSnapshot().sessions.one.queueSendingId).toBeUndefined();
  });
  it("blocks another steer while an insertion is unconfirmed and accepts native IDs", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", {
      thread: { ...client.getSnapshot().sessions.one.thread, id: "native-one" },
      draft: "insert",
    });
    await client.submit("one");
    const entry = client.getSnapshot().sessions.one.queue[0];
    await client.queueAction("native-one", entry.id, "steer");
    client.patch("one", { draft: "another" });
    await client.submit("one");
    const another = client.getSnapshot().sessions.one.queue[1];
    await expect(
      client.queueAction("native-one", another.id, "steer"),
    ).rejects.toThrow("等待原生确认");
    event({
      method: "item/completed",
      params: {
        threadId: "native-one",
        turnId: "turn",
        item: {
          id: "inserted",
          type: "userMessage",
          content: [{ type: "text", text: "insert" }],
        },
      },
    });
    expect(
      client.getSnapshot().sessions.one.queue.map((item) => item.draft),
    ).toEqual(["another"]);
    expect(client.getSnapshot().sessions.one.queueSendingId).toBeUndefined();
  });
  it("restores unconfirmed input and attachments when interruption completes before its acknowledgement", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    const images = ["data:image/png;base64,AA=="];
    client.patch("one", {
      draft: "insert",
      images,
      attachments: ["D:/a"],
      directories: ["D:/a"],
    });
    await client.submit("one");
    const entry = client.getSnapshot().sessions.one.queue[0];
    await client.queueAction("one", entry.id, "steer");
    client.patch("one", { draft: "new draft" });
    vi.spyOn(client, "interrupt").mockImplementationOnce(async () => {
      event({
        method: "turn/completed",
        params: {
          threadId: "one",
          turn: { id: "turn", status: "interrupted", items: [] },
        },
      });
    });
    await client.stopAndRestore("one");
    const session = client.getSnapshot().sessions.one;
    expect(session.draft).toBe("insert\n\nnew draft");
    expect(session.images).toEqual(images);
    expect(session.attachments).toEqual(["D:/a"]);
    expect(session.directories).toEqual(["D:/a"]);
    expect(session.queue).toEqual([]);
    expect(session.queueSendingId).toBeUndefined();
  });
  it("does not restore an insertion already confirmed by a native user message", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", { draft: "insert" });
    await client.submit("one");
    await client.queueAction(
      "one",
      client.getSnapshot().sessions.one.queue[0].id,
      "steer",
    );
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "turn",
        item: {
          id: "inserted",
          type: "userMessage",
          content: [{ type: "text", text: "insert" }],
        },
      },
    });
    client.patch("one", { draft: "new draft" });
    await client.stopAndRestore("one");
    expect(client.getSnapshot().sessions.one.draft).toBe("new draft");
  });
  it("returns an unconfirmed insertion to the draft at turn end instead of replaying it", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    client.patch("one", { draft: "insert" });
    await client.submit("one");
    await client.queueAction(
      "one",
      client.getSnapshot().sessions.one.queue[0].id,
      "steer",
    );
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: { id: "turn", status: "completed", items: [] },
      },
    });
    const session = client.getSnapshot().sessions.one;
    expect(session.draft).toBe("insert");
    expect(session.queue).toEqual([]);
    expect(session.queueSendingId).toBeUndefined();
    expect(session.queueError).toContain("退回输入框");
    expect(
      transport.sent.filter((m) => m.method === "turn/start"),
    ).toHaveLength(1);
  });
  it("retains the queue when steer fails and restores unconfirmed input on disconnect", async () => {
    client.patch("one", { draft: "first" });
    await client.submit("one");
    const images = ["data:image/png;base64,AA=="];
    client.patch("one", { draft: "insert", images });
    await client.submit("one");
    const entry = client.getSnapshot().sessions.one.queue[0];
    transport.fail = "turn/steer";
    await client.queueAction("one", entry.id, "steer");
    expect(client.getSnapshot().sessions.one.queue).toEqual([entry]);
    expect(client.getSnapshot().sessions.one.queueSendingId).toBeUndefined();
    transport.fail = "";
    await client.queueAction("one", entry.id, "steer");
    event({ method: "bridge/closed" });
    const session = client.getSnapshot().sessions.one;
    expect(session.draft).toBe("insert");
    expect(session.images).toEqual(images);
    expect(session.queue).toEqual([]);
    expect(session.queueSendingId).toBeUndefined();
    expect(client.getSnapshot().connected).toBe(false);
  });
  it("forks before the last turn for edit and keeps the original history", async () => {
    const turns = [
      {
        id: "last",
        status: "interrupted",
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [
              { type: "text", text: "old" },
              { type: "image", url: "data:image/png;base64,AA==" },
            ],
          },
        ],
      },
    ];
    client.patch("one", { loaded: true, thread: { ...thread, turns } });
    const id = await client.editLast("one", "edited", "user", [
      { type: "image", url: "data:image/png;base64,AA==" },
    ]);
    expect(id).toBe("fork");
    expect(
      transport.sent.find((m) => m.method === "thread/fork")?.params,
    ).toMatchObject({ beforeTurnId: "last" });
    expect(client.getSnapshot().sessions.one.thread.turns).toEqual(turns);
    expect(
      transport.sent.find((m) => m.method === "turn/start")?.params?.input,
    ).toContainEqual({ type: "image", url: "data:image/png;base64,AA==" });
  });
  it("removes native threads only after confirmed server success", async () => {
    transport.fail = "thread/delete";
    await expect(client.deleteThread("one")).rejects.toThrow();
    expect(client.getSnapshot().sessions.one).toBeDefined();
    transport.fail = "";
    await client.deleteThread("one");
    expect(client.getSnapshot().sessions.one).toBeUndefined();
  });
  it("archives and deletes using native IDs while retaining the original UI key", async () => {
    client.patch("one", { thread: { ...thread, id: "native-one" } });
    await client.archive("native-one", true);
    expect(client.getSnapshot().sessions.one.archived).toBe(true);
    event({ method: "thread/unarchived", params: { threadId: "native-one" } });
    expect(client.getSnapshot().sessions.one.archived).toBe(false);
    await client.deleteThread("native-one");
    expect(
      transport.sent.find((m) => m.method === "thread/delete")?.params,
    ).toEqual({ threadId: "native-one" });
    expect(client.getSnapshot().sessions.one).toBeUndefined();
    expect(client.getSnapshot().sessions.two).toBeDefined();
  });
  it("applies descendant archive notifications individually and removes deleted descendants", async () => {
    client.patch("two", {
      thread: { ...thread, id: "two", parentThreadId: "one" },
    });
    await client.archive("one", true);
    expect(client.getSnapshot().sessions.two.archived).toBe(false);
    event({ method: "thread/archived", params: { threadId: "two" } });
    expect(client.getSnapshot().sessions.two.archived).toBe(true);
    transport.hold = "thread/delete";
    const pending = client.deleteThread("one");
    event({ method: "thread/deleted", params: { threadId: "one" } });
    event({ method: "thread/deleted", params: { threadId: "two" } });
    await pending;
    expect(client.getSnapshot().pendingRequests).toBe(0);
    expect(client.getSnapshot().order).not.toContain("one");
    expect(client.getSnapshot().sessions.two).toBeUndefined();
  });
  it("rejects stale edit targets and preserves earlier inputs in the same native turn", async () => {
    client.patch("one", {
      loaded: true,
      thread: {
        ...thread,
        turns: [
          {
            id: "last",
            status: "completed",
            items: [
              {
                id: "earlier",
                type: "userMessage",
                content: [{ type: "text", text: "keep this request" }],
              },
              {
                id: "latest",
                type: "userMessage",
                content: [{ type: "text", text: "replace this" }],
              },
            ],
          },
        ],
      },
    });
    await expect(
      client.editLast("one", "edited", "earlier", []),
    ).rejects.toThrow("最后一条");
    expect(
      transport.sent.some((message) => message.method === "thread/fork"),
    ).toBe(false);
    await client.editLast("one", "edited", "latest", []);
    expect(
      transport.sent.find((message) => message.method === "turn/start")?.params
        ?.input,
    ).toEqual([
      { type: "text", text: "keep this request", text_elements: [] },
      { type: "text", text: "edited", text_elements: [] },
    ]);
  });
  it("records native context usage independently for each thread", () => {
    event({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "one",
        tokenUsage: {
          last: { totalTokens: 500 },
          total: { totalTokens: 800 },
          modelContextWindow: 1000,
        },
      },
    });
    expect(client.getSnapshot().sessions.one.tokenUsage?.last.totalTokens).toBe(
      500,
    );
    expect(client.getSnapshot().sessions.two.tokenUsage).toBeNull();
  });
  it("reuses the resource's last model for new threads without overwriting existing threads", async () => {
    await client.selectModel("one", "selected-model", "high");
    const id = await client.create("D:/new-project");
    expect(client.getSnapshot().sessions[id].model).toBe("selected-model");
    expect(client.getSnapshot().sessions[id].effort).toBe("high");
    expect(client.getSnapshot().sessions.two.model).toBe("");
    expect(transport.sent.some((m) => m.method === "thread/start")).toBe(false);
  });
  it("blocks switching with multiple viewports or hidden active threads", async () => {
    client.setMulti(true);
    await expect(client.switchResource("b")).rejects.toThrow("多视口");
    client.setMulti(false);
    event({
      method: "thread/status/changed",
      params: { threadId: "hidden-child", status: { type: "active" } },
    });
    await expect(client.switchResource("b")).rejects.toThrow("1 个任务");
    event({
      method: "thread/status/changed",
      params: { threadId: "hidden-child", status: { type: "idle" } },
    });
    client.patch("one", { draft: "keep draft", resumed: true });
    await client.switchResource("b");
    expect(client.getSnapshot().resourceAlias).toBe("b");
    expect(client.getSnapshot().sessions.one.draft).toBe("keep draft");
    expect(client.getSnapshot().sessions.one.resumed).toBe(false);
  });
  // 子代理完成事件可能晚于父轮次，必须清除子任务运行态并保留归属。
  it("keeps one session when thread started precedes draft materialization", async () => {
    const key = await client.create("D:/project");
    client.patch(key, { draft: "hello" });
    await client.send(key);
    expect(
      Object.values(client.getSnapshot().sessions).filter(
        (session) => session.thread.id === "new",
      ),
    ).toHaveLength(1);
    event({
      method: "turn/completed",
      params: {
        threadId: "new",
        turn: { id: "turn", status: "completed", items: [] },
      },
    });
    expect(client.getSnapshot().sessions[key]).toMatchObject({
      busy: false,
      turnId: null,
      sending: false,
    });
    expect(client.sessionKey("new")).toBe(key);
    expect(client.taskBusy(key)).toBe(false);
    client.patch(client.sessionKey("new"), { draft: "second 第二轮输入" });
    expect(client.getSnapshot().sessions[key].draft).toBe("second 第二轮输入");
    await client.send(client.sessionKey("new"));
    expect(
      transport.sent.filter((message) => message.method === "turn/start"),
    ).toHaveLength(2);
    expect(client.getSnapshot().sessions[key].draft).toBe("");
  });
  // 子代理自己携带的活动消息不能再挂载一个自身子节点。
  it("does not turn a subagent activity echo into a self child", () => {
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "t",
        item: {
          id: "echo",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "one",
          agentPath: "/root/hello",
        },
      },
    });
    expect(
      client.getSnapshot().sessions.one.thread.parentThreadId,
    ).toBeUndefined();
    expect(client.getSnapshot().sessions.one.busy).toBe(false);
  });
  // 子代理活动仅用于展示，运行态由实际线程和轮次事件提供。
  it("reads native metadata instead of inferring parents from activity", async () => {
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "t",
        item: {
          id: "spawn",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/check",
        },
      },
    });
    await vi.waitFor(() =>
      expect(client.getSnapshot().sessions.child).toBeDefined(),
    );
    expect(
      client.getSnapshot().sessions.child.thread.parentThreadId,
    ).toBeUndefined();
    expect(client.taskBusy("one")).toBe(false);
    event({
      method: "item/completed",
      params: {
        threadId: "one",
        turnId: "t",
        item: {
          id: "done",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: "child",
        },
      },
    });
    expect(client.taskBusy("one")).toBe(false);
    expect(client.getSnapshot().sessions.child.turnId).toBeNull();
  });
  // 已结束主线程仍可以停止活动子线程，不能把 interrupt 发给父线程旧轮次。
  it("stops active children when the parent is already idle", async () => {
    event({
      method: "thread/started",
      params: {
        thread: {
          ...thread,
          id: "child",
          source: { subagent: { thread_spawn: { parent_thread_id: "one" } } },
        },
      },
    });
    event({
      method: "turn/started",
      params: {
        threadId: "child",
        turn: { id: "child-turn", items: [], status: "inProgress" },
      },
    });
    await client.stopAndRestore("one");
    expect(
      transport.sent.find((message) => message.method === "turn/interrupt")
        ?.params,
    ).toEqual({ threadId: "child", turnId: "child-turn" });
  });
  // 空闲通知修复漏掉轮次结束事件时的本地运行态。
  it("settles a session from the authoritative idle notification", () => {
    client.patch("one", { busy: true, turnId: "stale", compacting: true });
    event({
      method: "thread/status/changed",
      params: { threadId: "one", status: { type: "idle" } },
    });
    expect(client.getSnapshot().sessions.one).toMatchObject({
      busy: false,
      turnId: null,
      compacting: false,
    });
  });
  it("preserves runtime and drafts when native background verification rejects switching", async () => {
    const connection = transport.connection;
    transport.switchError = "仍有后台终端运行";
    await expect(client.switchResource("b")).rejects.toThrow("后台终端");
    expect(transport.connection).toBe(connection);
    expect(client.getSnapshot().connected).toBe(true);
    expect(client.getSnapshot().switching).toBe(false);
  });
  it("handshakes once and reuses already loaded history", async () => {
    await client.connect();
    await Promise.all([client.load("one"), client.load("one")]);
    await client.load("one");
    expect(
      transport.sent.filter((m) => m.method === "initialize"),
    ).toHaveLength(1);
    expect(
      transport.sent.filter((m) => m.method === "thread/read"),
    ).toHaveLength(1);
  });
  it("routes approvals, deltas and completion to the correct thread", async () => {
    event({
      method: "turn/started",
      params: { threadId: "one", turn: { id: "t", items: [] } },
    });
    event({
      method: "item/started",
      params: {
        threadId: "one",
        turnId: "t",
        item: { id: "r", type: "reasoning", summary: [] },
      },
    });
    event({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "one",
        turnId: "t",
        itemId: "r",
        summaryIndex: 0,
        delta: "First line",
      },
    });
    event({
      id: 4,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "one", turnId: "t", command: "git status" },
    });
    expect(
      client.getSnapshot().sessions.one.thread.turns[0].items[0].summary,
    ).toEqual(["First line"]);
    expect(client.getSnapshot().sessions.two.thread.turns).toEqual([]);
    expect(client.getSnapshot().sessions.one.requests).toHaveLength(1);
    await client.respond("one", 4, { decision: "decline" });
    expect(transport.sent[transport.sent.length - 1]).toEqual({
      id: 4,
      result: { decision: "decline" },
    });
    event({
      method: "turn/completed",
      params: {
        threadId: "one",
        turn: { id: "t", status: "interrupted", items: [] },
      },
    });
    expect(client.getSnapshot().sessions.one.busy).toBe(false);
    expect(
      client.getSnapshot().sessions.one.thread.turns[0].items,
    ).toHaveLength(1);
  });
  it("preserves drafts on failure and resumes before start then steers active turns", async () => {
    client.patch("one", { draft: "hello" });
    transport.fail = "turn/start";
    await client.send("one");
    expect(client.getSnapshot().sessions.one.draft).toBe("hello");
    expect(client.getSnapshot().sessions.one.sending).toBe(false);
    transport.fail = "";
    await client.send("one");
    client.patch("one", { draft: "continue" });
    await client.send("one");
    expect(
      transport.sent.find((m) => m.method === "turn/steer")?.params,
    ).toMatchObject({ threadId: "one", expectedTurnId: "turn" });
    expect(
      transport.sent.filter((m) => m.method === "thread/resume"),
    ).toHaveLength(1);
    await client.interrupt("one");
    expect(transport.sent[transport.sent.length - 1]?.params).toEqual({
      threadId: "one",
      turnId: "turn",
    });
  });
  it("clears busy state on disconnect and ignores old connection events", async () => {
    const old = transport.connection;
    event({ method: "bridge/closed" });
    await client.connect();
    event(
      {
        method: "turn/started",
        params: { threadId: "one", turn: { id: "old" } },
      },
      old,
    );
    expect(client.getSnapshot().sessions.one.busy).toBe(false);
    expect(client.getSnapshot().connected).toBe(true);
  });
  it("returns an explicit unsupported response instead of hanging an unknown server request", () => {
    event({
      id: "unsupported",
      method: "item/tool/call",
      params: { threadId: "one" },
    });
    expect(transport.sent[transport.sent.length - 1]?.error?.code).toBe(-32601);
  });
  it("sends sandbox selection to resume and turn start without changing steering permissions", async () => {
    client.patch("one", { draft: "inspect", sandbox: "read-only" });
    await client.send("one");
    expect(
      transport.sent.find((m) => m.method === "thread/resume")?.params?.sandbox,
    ).toBe("read-only");
    expect(
      transport.sent.find((m) => m.method === "turn/start")?.params
        ?.sandboxPolicy,
    ).toEqual({ type: "readOnly", networkAccess: false });
    expect(client.getSnapshot().sessions.one.effectiveSandbox?.type).toBe(
      "readOnly",
    );
    client.patch("one", { draft: "continue" });
    await client.send("one");
    expect(
      transport.sent.find((m) => m.method === "turn/steer")?.params,
    ).not.toHaveProperty("sandboxPolicy");
  });
});

it("loads catalog pages with one session-cache publication", async () => {
  transport.catalogPages = true;
  let cache = client.getSnapshot().sessions;
  let publications = 0;
  const unsubscribe = client.subscribe(() => {
    const next = client.getSnapshot().sessions;
    if (next !== cache) {
      publications++;
      cache = next;
    }
  });
  await client.refresh();
  unsubscribe();
  expect(publications).toBe(1);
  expect(client.getSnapshot().sessions.older).toBeDefined();
});

it("refreshes a changed session once without enumerating the catalog", async () => {
  const id = "01a0bcab-e5b8-7ee2-add6-0bebb3d3fc9b";
  const path = `C:/Users/test/.codex/sessions/rollout-${id}.jsonl`;
  transport.sent = [];
  await client.load(id);
  transport.sent = [];
  await client.refreshChanged([path, path]);
  expect(transport.sent.filter((m) => m.method === "thread/list")).toHaveLength(
    0,
  );
  expect(transport.sent.filter((m) => m.method === "thread/read")).toHaveLength(
    1,
  );
  expect(client.getSnapshot().sessions[id]).toBeDefined();
  const cache = client.getSnapshot().sessions;
  await client.refreshChanged([path]);
  expect(client.getSnapshot().sessions).toBe(cache);
});

it("connects without listing or loading any history", async () => {
  await client.dispose();
  client = new CodexClient();
  transport.sent = [];
  await client.connect();
  expect(
    transport.sent.some((m) =>
      ["thread/list", "thread/read", "thread/turns/list"].includes(
        m.method ?? "",
      ),
    ),
  ).toBe(false);
  expect(client.getSnapshot().order).toEqual([]);
  await client.refreshProject("D:/chosen");
  const calls = transport.sent.filter((m) => m.method === "thread/list");
  expect(calls).toHaveLength(1);
  expect(calls[0].params).toMatchObject({
    cwd: "D:/chosen",
    useStateDbOnly: true,
  });
});

it("uses medium for history without effort metadata instead of another thread's effort", async () => {
  await client.selectModel("one", "selected-model", "high");
  await client.load("two");
  expect(client.getSnapshot().sessions.two.model).toBe("selected-model");
  expect(client.getSnapshot().sessions.two.effort).toBe("medium");
});
