import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "./protocol";
import { CodexClient } from "./client";

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
  resource: "native",
  switchError: "",
  catalogPages: false,
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
    if (command === "codex_agent_start") {
      transport.resource = args.resourceId ?? "native";
      return ++transport.connection;
    }
    if (command === "codex_agent_ready")
      return { resourceId: transport.resource, provider: "test", lastModel: { model: "selected-model", effort: "" } };
    if (command === "codex_resources_models") return [{ id: "selected-model" }];
    if (command === "codex_agent_prepare_switch") {
      if (transport.switchError) throw new Error(transport.switchError);
      return;
    }
    if (command !== "codex_agent_send") return;
    const message = args.message as Message;
    transport.sent.push(message);
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
    if (message.method === "thread/start")
      result = {
        thread: { ...thread, id: "new", model: message.params?.model ?? null },
      };
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
  client = new CodexClient();
  await client.connect();
  await client.refreshProject("D:/project");
});
afterEach(async () => {
  await client.dispose();
});

describe("Codex native client", () => {
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
    const id = await client.editLast("one", "edited", "user");
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
    await expect(client.editLast("one", "edited", "earlier")).rejects.toThrow(
      "最后一条",
    );
    expect(
      transport.sent.some((message) => message.method === "thread/fork"),
    ).toBe(false);
    await client.editLast("one", "edited", "latest");
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
    expect(
      transport.sent.find((m) => m.method === "thread/start")?.params?.model,
    ).toBe("selected-model");
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
    expect(client.getSnapshot().resourceId).toBe("b");
    expect(client.getSnapshot().sessions.one.draft).toBe("keep draft");
    expect(client.getSnapshot().sessions.one.resumed).toBe(false);
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
    if (next !== cache) { publications++; cache = next; }
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
  expect(transport.sent.filter(m => m.method === "thread/list")).toHaveLength(0);
  expect(transport.sent.filter(m => m.method === "thread/read")).toHaveLength(1);
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
  expect(transport.sent.some(m => ["thread/list", "thread/read", "thread/turns/list"].includes(m.method ?? ""))).toBe(false);
  expect(client.getSnapshot().order).toEqual([]);
  await client.refreshProject("D:/chosen");
  const calls = transport.sent.filter(m => m.method === "thread/list");
  expect(calls).toHaveLength(1);
  expect(calls[0].params).toMatchObject({ cwd: "D:/chosen", useStateDbOnly: true });
});

it("uses medium for history without effort metadata instead of another thread's effort", async () => {
  await client.selectModel("one", "selected-model", "high");
  await client.load("two");
  expect(client.getSnapshot().sessions.two.model).toBe("selected-model");
  expect(client.getSnapshot().sessions.two.effort).toBe("medium");
});
