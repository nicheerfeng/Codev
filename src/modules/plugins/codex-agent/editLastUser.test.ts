import { describe, expect, it } from "vitest";
import { editableLastUser } from "./editLastUser";
import { sessionFromThread, type Session } from "./protocol";

/** 构造同轮多次输入并带有末尾系统轮次的历史。 */
function session(): Session {
  return {
    ...sessionFromThread({
      id: "one",
      name: null,
      preview: "",
      cwd: "D:/qa",
      updatedAt: 1,
      turns: [
        {
          id: "old",
          status: "completed",
          items: [{ id: "old-user", type: "userMessage", content: [] }],
        },
        {
          id: "last",
          status: "interrupted",
          items: [
            { id: "first-input", type: "userMessage", content: [] },
            { id: "last-input", type: "userMessage", content: [] },
          ],
        },
        {
          id: "system",
          status: "completed",
          items: [{ id: "compact", type: "contextCompaction" }],
        },
      ],
    }),
    loaded: true,
  };
}
describe("Codex 最后输入编辑资格与 Pi 行为对齐", () => {
  it("同轮多次输入只允许最后一条，尾部系统轮次不抢占资格", () => {
    const target = editableLastUser(session());
    expect(target?.turn.id).toBe("last");
    expect(target?.item.id).toBe("last-input");
  });
  it("完成及终止无助手回复时仍可编辑，错误提示不影响空闲输入", () => {
    const view = session();
    view.error = "Request aborted";
    expect(editableLastUser(view)?.item.id).toBe("last-input");
    view.thread.turns[1].status = "completed";
    expect(editableLastUser(view)?.item.id).toBe("last-input");
  });
  it.each(["busy", "sending", "stopping"] as const)(
    "%s 状态不可编辑",
    (key) => {
      expect(editableLastUser({ ...session(), [key]: true })).toBeUndefined();
    },
  );
  it("未加载和空历史不暴露编辑", () => {
    expect(editableLastUser({ ...session(), loaded: false })).toBeUndefined();
    const view = session();
    view.thread.turns = [];
    expect(editableLastUser(view)).toBeUndefined();
  });
});
