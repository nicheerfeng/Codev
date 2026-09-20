import { expect, it } from "vitest";
import { activityLabel, elapsedText, isTool, processLabel } from "./timeline";
import { reduceNotification, sessionFromThread, type Turn } from "./protocol";

it("keeps process status distinct from the raw thinking summary", () => {
  const turn: Turn = {
    id: "t",
    status: "completed",
    items: [],
    startedAt: 100,
    completedAt: 285,
    durationMs: 185000,
  };
  expect(processLabel(turn, false)).toBe("已完成");
  expect(elapsedText(turn, false, 999999)).toBe("3分5秒");
  expect(
    activityLabel({
      id: "r",
      type: "reasoning",
      summary: ["**First line**\nSecond line"],
    }),
  ).toBe("已思考 · First line Second line");
  expect(isTool({ id: "r", type: "reasoning" })).toBe(false);
  expect(isTool({ id: "c", type: "commandExecution" })).toBe(true);
  expect(
    elapsedText(
      { id: "legacy", status: "completed", items: [] },
      false,
      999999,
    ),
  ).toBe("");
});

it("retains server turn timing through streaming item updates", () => {
  let session = sessionFromThread({
    id: "s",
    name: null,
    cwd: "D:/qa",
    preview: "",
    updatedAt: 0,
    turns: [],
  });
  session = reduceNotification(session, "turn/started", {
    turn: { id: "t", status: "inProgress", items: [], startedAt: 100 },
  });
  session = reduceNotification(session, "item/started", {
    turnId: "t",
    item: { id: "m", type: "agentMessage", text: "" },
  });
  session = reduceNotification(session, "turn/completed", {
    turn: {
      id: "t",
      status: "completed",
      items: [],
      completedAt: 110,
      durationMs: 10000,
    },
  });
  expect(session.thread.turns[0].startedAt).toBe(100);
  expect(session.thread.turns[0].durationMs).toBe(10000);
  expect(session.thread.turns[0].items).toHaveLength(1);
});

it("preserves streamed process items when completion contains only the final answer", () => {
  let session = sessionFromThread({ id: "s", name: null, cwd: "D:/qa", preview: "", updatedAt: 0, turns: [{ id: "t", status: "inProgress", items: [
    { id: "tool", type: "commandExecution", command: "pwd", status: "completed" },
    { id: "answer", type: "agentMessage", text: "partial" },
  ] }] });
  session = reduceNotification(session, "turn/completed", { turn: { id: "t", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "final" }] } });
  expect(session.thread.turns[0].items.map(item => item.id)).toEqual(["tool", "answer"]);
  expect(session.thread.turns[0].items[1].text).toBe("final");
});

it("accepts token usage fields from snake-case notifications", () => {
  const session = sessionFromThread({ id: "s", name: null, cwd: "D:/qa", preview: "", updatedAt: 0, turns: [] });
  const next = reduceNotification(session, "thread/tokenUsage/updated", { token_usage: { last: { total_tokens: 4000 }, total: { total_tokens: 8000 }, model_context_window: 100000 } });
  expect(next.tokenUsage).toEqual({ last: { totalTokens: 4000 }, total: { totalTokens: 8000 }, modelContextWindow: 100000 });
});

it("retains text deltas arriving before item start and accumulates subsequent chunks", () => {
  let session = sessionFromThread({ id: "s", name: null, cwd: "D:/qa", preview: "", updatedAt: 0, turns: [] });
  session = reduceNotification(session, "item/agentMessage/delta", { turnId: "t", itemId: "m", delta: "first" });
  expect(session.thread.turns[0].items[0].text).toBe("first");
  session = reduceNotification(session, "item/started", { turnId: "t", item: { id: "m", type: "agentMessage", text: "" } });
  session = reduceNotification(session, "item/agentMessage/delta", { turnId: "t", itemId: "m", delta: " second" });
  expect(session.thread.turns[0].items[0].text).toBe("first second");
});
