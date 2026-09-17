import { describe, expect, it } from "vitest";
import { editableLastUser } from "./editLastUser";
import { INITIAL_PI_VIEW_STATE } from "./reducer";
import type { PiMessageItem, PiViewState } from "./types";

const user: PiMessageItem = {
  id: "last-user",
  kind: "message",
  role: "user",
  text: "修改页面",
  thinking: "",
  streaming: false,
};
const idle: PiViewState = {
  ...INITIAL_PI_VIEW_STATE,
  status: "idle",
  items: [user],
};

describe("最后输入编辑资格", () => {
  it.each(["stop", "aborted", "toolUse"] as const)(
    "支持结束原因 %s",
    (stopReason) => {
      expect(
        editableLastUser({
          ...idle,
          items: [
            user,
            {
              ...user,
              id: "assistant",
              role: "assistant",
              stopReason,
            },
          ],
        }),
      ).toBe(user);
    },
  );
  it("立即终止且没有助手消息时仍可编辑", () => {
    expect(editableLastUser(idle)).toBe(user);
  });
  it("终止错误提示不阻断编辑，也不清除提示", () => {
    const view = { ...idle, error: "Request aborted" };
    expect(editableLastUser(view)).toBe(user);
    expect(view.error).toBe("Request aborted");
  });
  it("只返回最后一条输入，不受上一轮助手消息影响", () => {
    expect(
      editableLastUser({
        ...idle,
        items: [
          { ...user, id: "old-user" },
          {
            ...user,
            id: "old-assistant",
            role: "assistant",
            stopReason: "stop",
          },
          user,
        ],
      }),
    ).toBe(user);
  });
  it.each(["starting", "running", "stopping", "stopped", "failed"] as const)(
    "%s 状态不能编辑",
    (status) => {
      expect(editableLastUser({ ...idle, status })).toBeUndefined();
    },
  );
  it("空会话不能编辑", () => {
    expect(editableLastUser({ ...idle, items: [] })).toBeUndefined();
  });
});
