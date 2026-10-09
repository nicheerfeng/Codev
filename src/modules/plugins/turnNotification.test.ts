import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyFinishedThread as notifyPi } from "./pi-agent/piNotify";
import { notifyFinishedThread as notifyCodex } from "./codex-agent/codexNotify";

const native = vi.hoisted(() => ({
  permission: vi.fn(async () => true),
  request: vi.fn(async () => "granted"),
  send: vi.fn(),
  focused: false,
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: native.permission,
  requestPermission: native.request,
  sendNotification: native.send,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isVisible: async () => true,
    isFocused: async () => native.focused,
    isMinimized: async () => false,
  }),
}));

beforeEach(() => {
  native.permission.mockClear();
  native.request.mockClear();
  native.send.mockClear();
  native.focused = false;
});

const thread = { cwd: "D:/project", name: "任务", summary: "结果" };
const plugins = [
  [
    "Pi",
    (outcome: "completed" | "failed" | "interrupted", active = false) =>
      notifyPi({ thread, outcome, piActive: active }),
  ],
  [
    "Codex",
    (outcome: "completed" | "failed" | "interrupted", active = false) =>
      notifyCodex({ thread, outcome, codexActive: active }),
  ],
] as const;

describe.each(plugins)("%s terminal notifications", (_name, notify) => {
  it("does not request permission or notify after an interruption", async () => {
    await notify("interrupted");
    expect(native.permission).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
    expect(native.send).not.toHaveBeenCalled();
  });
  it("still notifies completed and failed turns in the background", async () => {
    await notify("completed");
    await notify("failed");
    expect(native.send).toHaveBeenCalledTimes(2);
    expect(native.send.mock.calls[1][0].body).toContain("执行失败");
  });
  it("keeps the existing foreground suppression", async () => {
    native.focused = true;
    await notify("completed", true);
    expect(native.send).not.toHaveBeenCalled();
  });
});
