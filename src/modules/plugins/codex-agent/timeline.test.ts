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
